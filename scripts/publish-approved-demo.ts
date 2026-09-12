import { openDatabase } from '../packages/db/src/node';
import { publishApprovedDemo } from '../packages/builder/src/approved-demo';
const { db, sqlite } = openDatabase('.runtime/private/intake.db');
try {
  console.log(JSON.stringify(await publishApprovedDemo(db, '.runtime/approved-demo')));
} finally {
  sqlite.close();
}
