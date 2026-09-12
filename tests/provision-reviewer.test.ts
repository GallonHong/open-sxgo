import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { verifyPassword } from 'better-auth/crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { migratePostgres } from '../packages/db/src/pg-migrate';
import {
  parseArgs,
  provisionReviewer,
  type ProvisionReviewerOptions,
} from '../scripts/provision-reviewer';

const postgresUrl = process.env.TEST_POSTGRES_URL;

type TestContext = {
  admin: Pool;
  schema: string;
  directory: string;
  configPath: string;
};

const postgresTests = describe.skipIf(!postgresUrl);

postgresTests('provision-reviewer', () => {
  let context: TestContext;

  beforeEach(async () => {
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    const schema = `provision_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const setup = new Client({
      connectionString: postgresUrl,
      options: `-c search_path=${schema},public`,
    });
    try {
      await setup.connect();
      await migratePostgres(setup);
    } finally {
      await setup.end().catch(() => undefined);
    }
    const directory = await mkdtemp(join(tmpdir(), 'wfd-provision-reviewer-'));
    const configPath = join(directory, 'pgconfig.json');
    await writeFile(
      configPath,
      JSON.stringify({
        connectionString: postgresUrl,
        options: `-c search_path=${schema},public`,
      }) + '\n',
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    context = { admin, schema, directory, configPath };
  });

  afterEach(async () => {
    await context.admin.query(`DROP SCHEMA "${context.schema}" CASCADE`);
    await context.admin.end();
    await rm(context.directory, { recursive: true, force: true });
  });

  function options(email: string, personId: string, name: string): ProvisionReviewerOptions {
    return {
      email,
      personId,
      databaseConfigFile: context.configPath,
      output: join(context.directory, name),
    };
  }

  async function query<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
    const client = new Client({
      connectionString: postgresUrl,
      options: `-c search_path=${context.schema},public`,
    });
    await client.connect();
    try {
      return await client.query<T>(text, values);
    } finally {
      await client.end();
    }
  }

  async function credentials(path: string) {
    return JSON.parse(await readFile(path, 'utf8')) as {
      status: string;
      email: string;
      person_id: string;
      user_id: string;
      principal_id: string;
      account_id: string;
      password: string;
    };
  }

  it('creates only pending records and writes a private Better Auth credential file', async () => {
    const result = await provisionReviewer(
      options('reviewer@example.invalid', 'person_review_01', 'credentials.json'),
    );
    const output = await credentials(result.outputPath);
    expect(output).toMatchObject({
      status: 'pending_activation',
      email: 'reviewer@example.invalid',
      person_id: 'person_review_01',
      user_id: result.userId,
      principal_id: result.principalId,
      account_id: result.accountId,
    });
    expect(output.password).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const metadata = await stat(result.outputPath);
    expect(metadata.mode & 0o077).toBe(0);

    const user = await query<{
      id: string;
      name: string;
      email: string;
      emailVerified: boolean;
      twoFactorEnabled: boolean;
    }>('SELECT id,name,email,"emailVerified","twoFactorEnabled" FROM "user" WHERE id=$1', [
      result.userId,
    ]);
    expect(user.rows).toEqual([
      {
        id: result.userId,
        name: 'Pending reviewer',
        email: 'reviewer@example.invalid',
        emailVerified: false,
        twoFactorEnabled: false,
      },
    ]);

    const account = await query<{
      id: string;
      accountId: string;
      providerId: string;
      userId: string;
      password: string;
    }>('SELECT id,"accountId","providerId","userId",password FROM "account" WHERE id=$1', [
      result.accountId,
    ]);
    expect(account.rows).toHaveLength(1);
    expect(account.rows[0]).toMatchObject({
      id: result.accountId,
      accountId: result.userId,
      providerId: 'credential',
      userId: result.userId,
    });
    expect(account.rows[0]?.password).not.toBe(output.password);
    expect(
      await verifyPassword({ hash: account.rows[0]!.password, password: output.password }),
    ).toBe(true);

    const identity = await query<{
      principal_id: string;
      person_id: string;
      status: string;
    }>('SELECT principal_id,person_id,status FROM principal_identities WHERE principal_id=$1', [
      result.principalId,
    ]);
    expect(identity.rows).toEqual([
      { principal_id: result.principalId, person_id: 'person_review_01', status: 'pending' },
    ]);
    const binding = await query<{
      user_id: string;
      principal_id: string;
      status: string;
      linked_by: string;
    }>('SELECT user_id,principal_id,status,linked_by FROM principal_accounts WHERE user_id=$1', [
      result.userId,
    ]);
    expect(binding.rows).toEqual([
      {
        user_id: result.userId,
        principal_id: result.principalId,
        status: 'pending',
        linked_by: 'deployment-operator',
      },
    ]);

    const audit = await query<{
      item_id: string;
      actor: string;
      action: string;
      reason: string;
    }>('SELECT item_id,actor,action,reason FROM audit WHERE item_id=$1', [result.principalId]);
    expect(audit.rows).toEqual([
      {
        item_id: result.principalId,
        actor: 'deployment-operator',
        action: 'pending_account_created',
        reason:
          'Reviewer account created pending independent identity verification, MFA setup, and authorization approval.',
      },
    ]);
    expect(
      (await query('SELECT user_id FROM principals WHERE user_id=$1', [result.userId])).rows,
    ).toEqual([]);
    expect(
      (await query('SELECT grant_id FROM role_grants WHERE principal_id=$1', [result.principalId]))
        .rows,
    ).toEqual([]);
  });

  it('rejects existing email or person without resetting records or leaving credentials', async () => {
    const first = await provisionReviewer(
      options('duplicate@example.invalid', 'person_duplicate_01', 'first.json'),
    );
    const firstCredentials = await credentials(first.outputPath);

    const duplicateEmail = options(
      'DUPLICATE@example.invalid',
      'person_duplicate_02',
      'duplicate-email.json',
    );
    await expect(provisionReviewer(duplicateEmail)).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_EXISTS',
    });
    await expect(stat(duplicateEmail.output)).rejects.toBeDefined();

    const duplicatePerson = options(
      'other@example.invalid',
      'person_duplicate_01',
      'duplicate-person.json',
    );
    await expect(provisionReviewer(duplicatePerson)).rejects.toMatchObject({
      code: 'PERSON_ALREADY_EXISTS',
    });
    await expect(stat(duplicatePerson.output)).rejects.toBeDefined();

    await query('INSERT INTO principals(user_id,person_id,roles) VALUES($1,$2,$3)', [
      first.userId,
      'person_legacy_01',
      '[]',
    ]);
    const duplicateLegacyPerson = options(
      'legacy@example.invalid',
      'person_legacy_01',
      'duplicate-legacy-person.json',
    );
    await expect(provisionReviewer(duplicateLegacyPerson)).rejects.toMatchObject({
      code: 'PERSON_ALREADY_EXISTS',
    });
    await expect(stat(duplicateLegacyPerson.output)).rejects.toBeDefined();

    const users = await query<{ id: string; email: string }>('SELECT id,email FROM "user"');
    expect(users.rows).toEqual([{ id: first.userId, email: firstCredentials.email }]);
    expect((await query('SELECT principal_id FROM role_grants')).rows).toEqual([]);
  });

  it('rolls back all rows and invalidates the output when a later insert fails', async () => {
    await query('DROP TABLE audit');
    const attempt = options('rollback@example.invalid', 'person_rollback_01', 'rollback.json');

    await expect(provisionReviewer(attempt)).rejects.toMatchObject({ code: 'SCHEMA_INCOMPLETE' });
    await expect(stat(attempt.output)).rejects.toBeDefined();
    expect(
      (await query('SELECT id FROM "user" WHERE email=$1', ['rollback@example.invalid'])).rows,
    ).toEqual([]);
    expect(
      (
        await query('SELECT principal_id FROM principal_identities WHERE person_id=$1', [
          'person_rollback_01',
        ])
      ).rows,
    ).toEqual([]);
    expect((await query('SELECT user_id FROM principal_accounts')).rows).toEqual([]);
  });
});

describe('provision-reviewer argument boundary', () => {
  it('requires explicit generic inputs and accepts separated or equals options', () => {
    expect(
      parseArgs([
        '--email=reviewer@example.invalid',
        '--person-id',
        'person_01',
        '--database-config-file=config.json',
        '--output',
        'credentials.json',
      ]),
    ).toEqual({
      email: 'reviewer@example.invalid',
      personId: 'person_01',
      databaseConfigFile: 'config.json',
      output: 'credentials.json',
    });
    expect(() => parseArgs(['--email', 'reviewer@example.invalid'])).toThrow('USAGE');
    expect(() => parseArgs(['--email', 'reviewer@example.invalid', '--unknown', 'x'])).toThrow(
      'USAGE',
    );
    expect(() =>
      parseArgs([
        '--email',
        'one@example.invalid',
        '--email=two@example.invalid',
        '--person-id',
        'person_01',
        '--database-config-file',
        'config.json',
        '--output',
        'credentials.json',
      ]),
    ).toThrow('DUPLICATE_OPTION');
  });
});
