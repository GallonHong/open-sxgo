import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { openDatabase } from '../packages/db/src/node';
import { migrate } from '../packages/db/src/migrate';
import {
  assignCase,
  type Capability,
  type GrantScope,
} from '../packages/identity-permissions/src/index';

/**
 * Seeds a disposable, explicitly demo-only governance database. It is kept
 * separate from intake.db so a local demo cannot accidentally grant or reuse
 * production identity state.
 */
const dbPath = resolve(process.env.WFD_GOVERNANCE_DEMO_DB ?? '.runtime/private/governance-demo.db');
const credentialPath = resolve(
  process.env.WFD_GOVERNANCE_DEMO_CREDENTIALS ??
    `${dirname(dbPath)}/governance-demo-credentials.txt`,
);
const modePath = resolve(
  process.env.WFD_GOVERNANCE_DEMO_MODE ?? `${dirname(dbPath)}/governance-demo-mode.json`,
);
const intakePath = resolve(process.env.WFD_INTAKE_DB ?? '.runtime/private/intake.db');
if (dbPath === intakePath) throw new Error('DEMO_DATABASE_MUST_BE_SEPARATE');

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

async function first<T>(
  db: { all<T>(sql: string, params?: unknown[]): Promise<T[]> },
  sql: string,
  params: unknown[] = [],
) {
  const [row] = await db.all<T>(sql, params);
  return row;
}

const now = new Date();
const issuedAt = now.toISOString();
const expiresAt = new Date(now.getTime() + 7 * 86400_000).toISOString();
const caseId = 'case_governance_demo';
const scope = (values: Partial<GrantScope>): GrantScope => ({
  source_types: [],
  regions: [],
  labor_rule_fields: [],
  contribution_domains: [],
  contribution_ids: [],
  policy_ids: [],
  role_ids: [],
  company_ids: [],
  qualification_ids: [],
  source_ids: [],
  proposal_ids: [],
  incident_ids: [],
  release_ids: [],
  code_paths: [],
  node_ids: [],
  case_ids: [],
  ...values,
});
const members: {
  userId: string;
  email: string;
  personId: string;
  principalId: string;
  grantId: string;
  capabilities: Capability[];
  scope: GrantScope;
}[] = [
  {
    userId: 'demo_governance_one',
    email: 'governance.one@example.invalid',
    personId: 'person_demo_governance_one',
    principalId: 'principal_demo_governance_one',
    grantId: 'grant_demo_governance_one',
    capabilities: ['case.submit_decision'],
    scope: scope({ case_ids: [caseId] }),
  },
  {
    userId: 'demo_governance_two',
    email: 'governance.two@example.invalid',
    personId: 'person_demo_governance_two',
    principalId: 'principal_demo_governance_two',
    grantId: 'grant_demo_governance_two',
    capabilities: ['case.independent_review'],
    scope: scope({ case_ids: [caseId] }),
  },
  {
    userId: 'demo_governance_three',
    email: 'governance.three@example.invalid',
    personId: 'person_demo_governance_three',
    principalId: 'principal_demo_governance_three',
    grantId: 'grant_demo_governance_three',
    capabilities: ['source.fetch'],
    scope: scope({ source_ids: ['source_governance_demo'] }),
  },
];

await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
const databaseExisted = await pathExists(dbPath);
const { db, sqlite } = openDatabase(dbPath);
try {
  try {
    await migrate(sqlite);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MIGRATION_CHANGED:'))
      throw new Error(
        `${error.message}; existing demo database was preserved. Set WFD_GOVERNANCE_DEMO_DB to a new path and run again.`,
      );
    throw error;
  }
  const passwords = new Map<string, string>();
  const queries: { sql: string; params: unknown[] }[] = [];
  for (const member of members) {
    const accountId = member.userId;
    const existingUser = await first<{ id: string; email: string }>(
      db,
      'SELECT id,email FROM user WHERE id=?',
      [member.userId],
    );
    if (existingUser && existingUser.email !== member.email)
      throw new Error('DEMO_USER_ID_COLLISION: ' + member.userId);
    const emailOwner = await first<{ id: string }>(db, 'SELECT id FROM user WHERE email=?', [
      member.email,
    ]);
    if (emailOwner && emailOwner.id !== member.userId)
      throw new Error('DEMO_EMAIL_COLLISION: ' + member.email);

    const existingAccount = await first<{ id: string; userId: string }>(
      db,
      `SELECT id,userId FROM account
        WHERE id=? OR (providerId='credential' AND accountId=?)
        LIMIT 1`,
      [`account_demo_${member.userId}`, accountId],
    );
    if (existingAccount && existingAccount.userId !== member.userId)
      throw new Error('DEMO_ACCOUNT_BINDING_COLLISION: ' + member.userId);

    let password: string | undefined;
    if (!existingUser) {
      password = crypto.randomUUID() + crypto.randomUUID();
      queries.push({
        sql: 'INSERT OR IGNORE INTO user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES(?,?,?,?,?,?,?)',
        params: [member.userId, member.personId, member.email, 1, now.getTime(), now.getTime(), 0],
      });
    }
    if (!existingAccount) {
      password ??= crypto.randomUUID() + crypto.randomUUID();
      passwords.set(member.email, password);
      queries.push({
        sql: 'INSERT OR IGNORE INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
        params: [
          `account_demo_${member.userId}`,
          accountId,
          'credential',
          member.userId,
          await hashPassword(password),
          now.getTime(),
          now.getTime(),
        ],
      });
    }

    const existingIdentity = await first<{ person_id: string }>(
      db,
      'SELECT person_id FROM principal_identities WHERE principal_id=?',
      [member.principalId],
    );
    if (existingIdentity && existingIdentity.person_id !== member.personId)
      throw new Error('DEMO_PRINCIPAL_PERSON_COLLISION: ' + member.principalId);
    const existingBinding = await first<{ principal_id: string }>(
      db,
      'SELECT principal_id FROM principal_accounts WHERE user_id=?',
      [member.userId],
    );
    if (existingBinding && existingBinding.principal_id !== member.principalId)
      throw new Error('DEMO_ACCOUNT_PRINCIPAL_COLLISION: ' + member.userId);
    const existingGrant = await first<{ principal_id: string; person_id: string }>(
      db,
      'SELECT principal_id,person_id FROM role_grants WHERE grant_id=?',
      [member.grantId],
    );
    if (
      existingGrant &&
      (existingGrant.principal_id !== member.principalId ||
        existingGrant.person_id !== member.personId)
    )
      throw new Error('DEMO_GRANT_BINDING_COLLISION: ' + member.grantId);

    queries.push(
      {
        sql: 'INSERT OR IGNORE INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        params: [
          member.principalId,
          member.personId,
          'active',
          JSON.stringify({ demo: true }),
          issuedAt,
          issuedAt,
        ],
      },
      {
        sql: 'INSERT OR IGNORE INTO principal_accounts(user_id,principal_id,status,linked_at,linked_by,account_revision) VALUES(?,?,?,?,?,?)',
        params: [member.userId, member.principalId, 'active', issuedAt, 'demo_seed', 1],
      },
      {
        sql: `INSERT OR IGNORE INTO role_grants
          (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          member.grantId,
          member.principalId,
          member.personId,
          'demo_reviewer',
          JSON.stringify(member.capabilities),
          JSON.stringify(member.scope),
          issuedAt,
          issuedAt,
          expiresAt,
          'demo-policy-v1',
          'demo-seed-only',
          1,
          'active',
          'not_revoked',
          issuedAt,
          issuedAt,
        ],
      },
    );
  }
  const existingCase = await first<{ submission_id: string }>(
    db,
    'SELECT submission_id FROM review_cases WHERE id=?',
    [caseId],
  );
  if (existingCase && existingCase.submission_id !== 'submission_governance_demo')
    throw new Error('DEMO_CASE_COLLISION: ' + caseId);
  queries.push({
    sql: 'INSERT OR IGNORE INTO review_cases(id,submission_id,current_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    params: [caseId, 'submission_governance_demo', 0, 'open', issuedAt, issuedAt],
  });
  await db.batch(queries);

  for (const [member, stage] of [
    [members[0], 'primary'],
    [members[1], 'secondary'],
  ] as const) {
    const existingAssignment = await first<{
      principal_id: string;
      person_id: string;
      grant_id: string;
      status: string;
    }>(
      db,
      `SELECT principal_id,person_id,grant_id,status FROM case_assignments
        WHERE case_id=? AND candidate_revision=? AND stage=? LIMIT 1`,
      [caseId, 1, stage],
    );
    if (existingAssignment) {
      if (
        existingAssignment.principal_id !== member.principalId ||
        existingAssignment.person_id !== member.personId ||
        existingAssignment.grant_id !== member.grantId
      )
        throw new Error('DEMO_ASSIGNMENT_BINDING_COLLISION: ' + stage);
      continue;
    }
    const currentCase = await first<{ current_revision: number; state: string }>(
      db,
      'SELECT current_revision,state FROM review_cases WHERE id=?',
      [caseId],
    );
    // A later run must never rewind an actively edited case. It leaves the
    // existing workflow for the operator to inspect instead of overwriting it.
    if (!currentCase || currentCase.current_revision !== 0 || currentCase.state !== 'open')
      continue;
    await assignCase(db, {
      case_id: caseId,
      candidate_revision: 1,
      stage,
      principal_id: member.principalId,
      person_id: member.personId,
      grant_id: member.grantId,
      expires_at: expiresAt,
      expected_case_revision: 0,
    });
  }

  const existingCredentialFile = (await pathExists(credentialPath))
    ? await readFile(credentialPath, 'utf8')
    : '';
  const newCredentialLines = members.flatMap((member) => {
    const password = passwords.get(member.email);
    if (!password || existingCredentialFile.includes(`邮箱：${member.email}`)) return [];
    return [`邮箱：${member.email}`, `初始密码：${password}`];
  });
  if (!existingCredentialFile) {
    await writeFile(
      credentialPath,
      [
        '封闭治理演示凭据；三个成员均为虚构，不代表真实独立人员。',
        `数据库：${dbPath}`,
        ...members.flatMap((member) => [
          `邮箱：${member.email}`,
          `初始密码：${passwords.get(member.email) ?? '本次未生成（已有账号未覆盖）'}`,
        ]),
        '登录后必须完成 TOTP/WebAuthn 流程；请勿用于生产。',
      ].join('\n') + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  } else if (newCredentialLines.length) {
    await appendFile(credentialPath, '\n' + newCredentialLines.join('\n') + '\n');
  }
  await chmod(credentialPath, 0o600);

  if (!(await pathExists(modePath))) {
    await writeFile(
      modePath,
      JSON.stringify(
        {
          mode: 'demo',
          database: dbPath,
          production_release_enabled: false,
          production_keys_created: false,
          expires_at: expiresAt,
        },
        null,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  }
  await chmod(modePath, 0o600);
  await chmod(dbPath, 0o600);
  console.log(
    `${databaseExisted ? '已保留并复用' : '已创建'}封闭治理演示数据库：${dbPath}；凭据仅保存于 ${credentialPath}（未写入日志）。`,
  );
} finally {
  sqlite.close();
  if (await pathExists(dbPath)) await chmod(dbPath, 0o600);
}
