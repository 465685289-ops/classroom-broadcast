#!/usr/bin/env node
const path = require('path');
const Database = require('better-sqlite3');
const { createShixingPoints } = require('../shixing-points');

const dbFile = process.env.SQLITE_FILE || path.join(__dirname, '..', 'broadcast.db');
const db = new Database(dbFile, { timeout: 10000 });
db.pragma('busy_timeout = 10000');

try {
  const points = createShixingPoints(db);
  const users = db.prepare('SELECT id, username FROM users ORDER BY created_at, id').all();
  let migrated = 0;
  const migrateAll = db.transaction(() => {
    users.forEach(user => {
      const before = db.prepare("SELECT 1 FROM shixing_point_ledger WHERE user_id = ? AND reason = 'legacy_migration'").get(user.id);
      points.ensureMigration(user);
      if (!before) migrated++;
    });
  });
  migrateAll();
  const totalPoints = db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM shixing_point_ledger').get().n;
  console.log(JSON.stringify({ ok: true, users: users.length, migrated, total_points: Number(totalPoints) || 0 }));
} finally {
  db.close();
}
