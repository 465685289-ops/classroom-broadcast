#!/usr/bin/env node
const path = require('path');
const Database = require('better-sqlite3');
const { createShixingPoints } = require('../shixing-points');
const { createUnifiedReferrals } = require('../unified-referrals');

const dbFile = process.env.SQLITE_FILE || path.join(__dirname, '..', 'broadcast.db');
const apply = process.argv.includes('--apply');
const db = new Database(dbFile, { timeout: 10000 });
db.pragma('busy_timeout = 10000');

try {
  const points = createShixingPoints(db);
  const referrals = createUnifiedReferrals(db, points);
  const report = referrals.migrateLegacyReferrals({ dry_run: !apply });
  console.log(JSON.stringify({ ok: true, mode: apply ? 'apply' : 'dry-run', database: dbFile, ...report }));
} finally {
  db.close();
}
