import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hashPassword } from 'better-auth/crypto';
import { openDatabase } from '../packages/db/src/node';
import { migrate } from '../packages/db/src/migrate';
const [email, personId] = process.argv.slice(2);
if (!email || !personId || !/^person_[a-z0-9_-]+$/.test(personId)) {
  console.error('Usage: pnpm auth:invite <email> <person_unique_id>');
  process.exit(1);
}
await mkdir('.runtime/private', { recursive: true, mode: 0o700 });
const { db, sqlite } = openDatabase('.runtime/private/intake.db');
await migrate(sqlite);
const password = crypto.randomUUID() + crypto.randomUUID(),
  userId = crypto.randomUUID(),
  now = Date.now();
await db.batch([
  {
    sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES(?,?,?,?,?,?,?)',
    params: [userId, personId, email, 1, now, now, 0],
  },
  {
    sql: 'INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
    params: [
      crypto.randomUUID(),
      userId,
      'credential',
      userId,
      await hashPassword(password),
      now,
      now,
    ],
  },
  {
    sql: 'INSERT INTO principals VALUES(?,?,?,?,?,?)',
    params: [
      userId,
      personId,
      JSON.stringify(['reviewer', 'suppressor', 'builder', 'operator', 'governor']),
      JSON.stringify(['*']),
      '[]',
      1,
    ],
  },
]);
const path = '.runtime/private/invitation-' + personId + '.txt';
await writeFile(
  path,
  `本地封闭演示账号；不可作为生产独立人员核验依据。\n邮箱：${email}\n初始密码：${password}\n登录后必须绑定 TOTP。\n`,
  { mode: 0o600 },
);
sqlite.close();
console.log('邀请凭据已保存到 ' + path + '（未输出到日志）。');
