import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type ClientConfig } from 'pg';
import { hashPassword } from 'better-auth/crypto';

/**
 * This command creates only the database records needed for a reviewer who is
 * still waiting for identity review and authorization.  Activation and any
 * role grant are deliberately separate operations owned by the operator.
 */

const DEPLOYMENT_OPERATOR = 'deployment-operator';
const AUDIT_ACTION = 'pending_account_created';
const PENDING_ACCOUNT_REASON =
  'Reviewer account created pending independent identity verification, MFA setup, and authorization approval.';

const REQUIRED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['user', 'id'],
  ['user', 'name'],
  ['user', 'email'],
  ['user', 'emailVerified'],
  ['user', 'createdAt'],
  ['user', 'updatedAt'],
  ['user', 'twoFactorEnabled'],
  ['account', 'id'],
  ['account', 'accountId'],
  ['account', 'providerId'],
  ['account', 'userId'],
  ['account', 'password'],
  ['account', 'createdAt'],
  ['account', 'updatedAt'],
  ['principal_identities', 'principal_id'],
  ['principal_identities', 'person_id'],
  ['principal_identities', 'status'],
  ['principal_identities', 'created_at'],
  ['principal_identities', 'updated_at'],
  ['principals', 'person_id'],
  ['identity_legacy_import', 'person_id'],
  ['principal_accounts', 'user_id'],
  ['principal_accounts', 'principal_id'],
  ['principal_accounts', 'status'],
  ['principal_accounts', 'linked_at'],
  ['principal_accounts', 'linked_by'],
  ['audit', 'id'],
  ['audit', 'item_id'],
  ['audit', 'actor'],
  ['audit', 'action'],
  ['audit', 'reason'],
  ['audit', 'created_at'],
];

type PgConfig = ClientConfig & Record<string, unknown>;

type PgQueryResult = {
  rows: Array<Record<string, unknown>>;
};

type PgClient = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
};

export type ProvisionReviewerOptions = {
  email: string;
  personId: string;
  databaseConfigFile: string;
  output: string;
};

export type ProvisionReviewerResult = {
  outputPath: string;
  userId: string;
  principalId: string;
  accountId: string;
};

export class ProvisionReviewerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ProvisionReviewerError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ProvisionReviewerError(code);
}

function requireValue(value: string | undefined, code: string) {
  if (value === undefined || value.length === 0) fail(code);
  return value;
}

function normalizedEmail(input: string) {
  const email = input.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    email.includes('\n') ||
    email.includes('\r') ||
    !/^[^\s@]+@[^\s@]+$/.test(email)
  )
    fail('INVALID_EMAIL');
  return email;
}

function normalizedPersonId(input: string) {
  const personId = input.trim();
  if (!/^person_[a-z0-9_-]{3,120}$/.test(personId)) fail('INVALID_PERSON_ID');
  return personId;
}

function randomId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function randomPassword() {
  // 256 bits from the OS CSPRNG, encoded without shell-sensitive characters.
  return randomBytes(32).toString('base64url');
}

function outputPathFor(input: string) {
  const path = resolve(input);
  if (basename(path) === '.' || basename(path) === '..') fail('INVALID_OUTPUT_PATH');
  return path;
}

async function readDatabaseConfig(path: string): Promise<PgConfig> {
  const absolute = resolve(path);
  let metadata;
  try {
    metadata = await stat(absolute);
  } catch {
    fail('DATABASE_CONFIG_UNREADABLE');
  }
  if ((metadata.mode & 0o077) !== 0) fail('DATABASE_CONFIG_NOT_PRIVATE');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, 'utf8'));
  } catch {
    fail('DATABASE_CONFIG_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    fail('DATABASE_CONFIG_INVALID');

  const config = parsed as Record<string, unknown>;
  const hasConnectionString = typeof config.connectionString === 'string';
  const hasHostConfig = typeof config.host === 'string' || typeof config.database === 'string';
  if (!hasConnectionString && !hasHostConfig) fail('DATABASE_CONFIG_INVALID');
  return config as PgConfig;
}

async function createCredentialFile(
  path: string,
  contents: Record<string, unknown>,
): Promise<void> {
  const handle = await open(path, 'wx', 0o600).catch(() => fail('OUTPUT_EXISTS_OR_UNWRITABLE'));
  try {
    await handle.writeFile(JSON.stringify(contents) + '\n', 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
  } catch {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    fail('OUTPUT_WRITE_FAILED');
  }
}

/**
 * Remove a credential file after a failed transaction. If removal is blocked,
 * overwrite it with an unambiguous failure marker that contains no secret.
 */
async function invalidateCredentialFile(path: string) {
  try {
    await rm(path);
    return;
  } catch {
    // A failed cleanup must not leave a usable credential file behind.
  }
  try {
    await writeFile(
      path,
      JSON.stringify({ status: 'failed', message: 'Provisioning transaction failed.' }) + '\n',
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
  } catch {
    // The original error is still reported without exposing the credential.
  }
}

function safeDatabaseError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  if (code === '23505') return 'DATABASE_DUPLICATE';
  if (code === '23503') return 'DATABASE_REFERENCE_ERROR';
  if (code === '40001' || code === '40P01') return 'DATABASE_RETRYABLE';
  return 'DATABASE_ERROR';
}

async function lockProvisioningKeys(client: PgClient, email: string, personId: string) {
  // principal_identities has no UNIQUE(person_id) constraint. Transactional
  // advisory locks close the race between duplicate checks and inserts while
  // keeping all values parameterized.
  const keys = [`email:${email}`, `person:${personId}`].sort();
  for (const key of keys)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
      `wfd:provision-reviewer:${key}`,
    ]);
}

async function assertSchema(client: PgClient) {
  const missing = await client.query(
    `SELECT required.table_name,required.column_name
       FROM (VALUES
         ${REQUIRED_COLUMNS.map(([table, column]) => `('${table}','${column}')`).join(',')}
       ) AS required(table_name,column_name)
       LEFT JOIN information_schema.columns columns
         ON columns.table_schema=current_schema()
        AND columns.table_name=required.table_name
        AND columns.column_name=required.column_name
      WHERE columns.column_name IS NULL
      LIMIT 1`,
  );
  if (missing.rows.length > 0) fail('SCHEMA_INCOMPLETE');
}

async function assertNoExistingAccount(client: PgClient, email: string, personId: string) {
  const existingEmail = await client.query(
    'SELECT id FROM "user" WHERE lower(email)=lower($1) LIMIT 1',
    [email],
  );
  if (existingEmail.rows.length > 0) fail('EMAIL_ALREADY_EXISTS');

  const existingPerson = await client.query(
    `SELECT person_id FROM principal_identities WHERE person_id=$1
     UNION ALL
     SELECT person_id FROM principals WHERE person_id=$1
     UNION ALL
     SELECT person_id FROM identity_legacy_import WHERE person_id=$1
     LIMIT 1`,
    [personId],
  );
  if (existingPerson.rows.length > 0) fail('PERSON_ALREADY_EXISTS');
}

async function provisionWithClient(
  client: PgClient,
  input: {
    email: string;
    personId: string;
    userId: string;
    principalId: string;
    accountId: string;
    passwordHash: string;
    createdAt: Date;
  },
) {
  const { email, personId, userId, principalId, accountId, passwordHash, createdAt } = input;
  await client.query('BEGIN');
  let committed = false;
  try {
    await lockProvisioningKeys(client, email, personId);
    await assertSchema(client);
    await assertNoExistingAccount(client, email, personId);

    await client.query(
      `INSERT INTO "user"
        (id,name,email,"emailVerified","createdAt","updatedAt","twoFactorEnabled")
       VALUES($1,'Pending reviewer',$2,FALSE,$3,$3,FALSE)`,
      [userId, email, createdAt],
    );
    await client.query(
      `INSERT INTO "account"
        (id,"accountId","providerId","userId",password,"createdAt","updatedAt")
       VALUES($1,$2,'credential',$3,$4,$5,$5)`,
      [accountId, userId, userId, passwordHash, createdAt],
    );
    await client.query(
      `INSERT INTO principal_identities
        (principal_id,person_id,status,created_at,updated_at)
       VALUES($1,$2,'pending',$3,$3)`,
      [principalId, personId, createdAt.toISOString()],
    );
    await client.query(
      `INSERT INTO principal_accounts
        (user_id,principal_id,status,linked_at,linked_by)
       VALUES($1,$2,'pending',$3,$4)`,
      [userId, principalId, createdAt.toISOString(), DEPLOYMENT_OPERATOR],
    );
    await client.query(
      `INSERT INTO audit
        (id,item_id,actor,action,reason,created_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        randomId('audit'),
        principalId,
        DEPLOYMENT_OPERATOR,
        AUDIT_ACTION,
        PENDING_ACCOUNT_REASON,
        createdAt.toISOString(),
      ],
    );
    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function provisionReviewer(
  options: ProvisionReviewerOptions,
): Promise<ProvisionReviewerResult> {
  const email = normalizedEmail(options.email);
  const personId = normalizedPersonId(options.personId);
  const outputPath = outputPathFor(options.output);
  const databaseConfig = await readDatabaseConfig(options.databaseConfigFile);
  const password = randomPassword();
  const passwordHash = await hashPassword(password);
  const userId = randomId('user');
  const principalId = randomId('principal');
  const accountId = randomId('account');
  const createdAt = new Date();

  await createCredentialFile(outputPath, {
    version: 1,
    status: 'pending_activation',
    email,
    person_id: personId,
    user_id: userId,
    principal_id: principalId,
    account_id: accountId,
    password,
    created_at: createdAt.toISOString(),
  });

  let client: PgClient | undefined;
  try {
    client = new Client(databaseConfig) as unknown as PgClient;
    await client.connect();
    await provisionWithClient(client, {
      email,
      personId,
      userId,
      principalId,
      accountId,
      passwordHash,
      createdAt,
    });
    return { outputPath, userId, principalId, accountId };
  } catch (error) {
    await invalidateCredentialFile(outputPath);
    if (error instanceof ProvisionReviewerError) throw error;
    const databaseError = new ProvisionReviewerError(safeDatabaseError(error));
    throw databaseError;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

function optionValue(argv: string[], index: number, option: string) {
  const argument = argv[index];
  if (argument === option)
    return requireValue(argv[index + 1], `MISSING_${option.slice(2).toUpperCase()}`);
  if (argument.startsWith(option + '='))
    return requireValue(
      argument.slice(option.length + 1),
      `MISSING_${option.slice(2).toUpperCase()}`,
    );
  return undefined;
}

export function parseArgs(argv: string[]): ProvisionReviewerOptions {
  const values: Partial<ProvisionReviewerOptions> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    const entries: Array<[string, keyof ProvisionReviewerOptions]> = [
      ['--email', 'email'],
      ['--person-id', 'personId'],
      ['--database-config-file', 'databaseConfigFile'],
      ['--output', 'output'],
    ];
    const entry = entries.find(
      ([option]) => argument === option || argument.startsWith(option + '='),
    );
    if (!entry) fail('USAGE');
    const [option, key] = entry;
    const value = optionValue(argv, i, option);
    if (value === undefined) fail('USAGE');
    if (values[key] !== undefined) fail('DUPLICATE_OPTION');
    values[key] = value;
    if (argument === option) i += 1;
  }
  if (!values.email || !values.personId || !values.databaseConfigFile || !values.output)
    fail('USAGE');
  return values as ProvisionReviewerOptions;
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

function safeCliError(error: unknown) {
  if (error instanceof ProvisionReviewerError) return error.code;
  return 'PROVISIONING_FAILED';
}

async function main() {
  try {
    const result = await provisionReviewer(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${result.outputPath}\ncompleted\n`);
  } catch (error) {
    process.stderr.write(`provision-reviewer failed: ${safeCliError(error)}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) void main();
