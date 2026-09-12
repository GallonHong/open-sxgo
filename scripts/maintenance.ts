import { openDatabase } from '../packages/db/src/node';
import { migrate } from '../packages/db/src/migrate';
import { maintainGovernance } from '../packages/governance-policy/src/maintenance';
import { Service } from '../apps/api/src/service';

const { db, sqlite } = openDatabase(process.env.WFD_DB_PATH ?? '.runtime/private/intake.db');
try {
  await migrate(sqlite);
  await new Service(db).maintenance();
  console.log(await maintainGovernance(db));
} finally {
  sqlite.close();
}
