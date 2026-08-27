const POINT_COSTS = Object.freeze({
  comment: 25,
  essay: 50,
  english: 50,
  roundtable: 50,
  edulab: 75
});

const POINT_PACKAGES = Object.freeze({
  points_5000: Object.freeze({
    key: 'points_5000',
    label: '5000师行积分',
    points: 5000,
    amount: '9.90',
    first_bonus: 5000
  }),
  points_10000: Object.freeze({
    key: 'points_10000',
    label: '10000师行积分',
    points: 10000,
    amount: '19.90',
    first_bonus: 12000
  })
});

function safeJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function createShixingPoints(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shixing_point_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      product TEXT,
      package_key TEXT,
      out_trade_no TEXT,
      generation_id INTEGER,
      note TEXT,
      created_at TEXT NOT NULL,
      extra_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shixing_points_user
      ON shixing_point_ledger(user_id, created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shixing_points_migration
      ON shixing_point_ledger(user_id) WHERE reason = 'legacy_migration';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shixing_points_essay_migration
      ON shixing_point_ledger(user_id) WHERE reason = 'essay_legacy_migration';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shixing_points_purchase
      ON shixing_point_ledger(out_trade_no) WHERE reason = 'purchase' AND out_trade_no IS NOT NULL;

    CREATE TABLE IF NOT EXISTS shixing_first_topups (
      user_id TEXT PRIMARY KEY,
      out_trade_no TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);

  const tableExistsStmt = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?");
  const balanceStmt = db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM shixing_point_ledger WHERE user_id = ?');
  const migrationStmt = db.prepare("SELECT * FROM shixing_point_ledger WHERE user_id = ? AND reason = 'legacy_migration'");
  const essayMigrationStmt = db.prepare("SELECT * FROM shixing_point_ledger WHERE user_id = ? AND reason = 'essay_legacy_migration'");
  const purchaseStmt = db.prepare("SELECT * FROM shixing_point_ledger WHERE out_trade_no = ? AND reason = 'purchase'");
  const firstTopupStmt = db.prepare('INSERT OR IGNORE INTO shixing_first_topups (user_id, out_trade_no, created_at) VALUES (?, ?, ?)');
  const hasTopupStmt = db.prepare('SELECT 1 AS ok FROM shixing_first_topups WHERE user_id = ?');
  const usernameStmt = tableExists('users') ? db.prepare('SELECT username FROM users WHERE id = ?') : null;
  const insertStmt = db.prepare(`
    INSERT INTO shixing_point_ledger (
      user_id, username, delta, reason, product, package_key,
      out_trade_no, generation_id, note, created_at, extra_json
    ) VALUES (
      @user_id, @username, @delta, @reason, @product, @package_key,
      @out_trade_no, @generation_id, @note, @created_at, @extra_json
    )
  `);

  function tableExists(name) {
    return !!tableExistsStmt.get(name);
  }

  function userInfo(user) {
    if (user && typeof user === 'object') {
      return { id: String(user.id || user.user_id || ''), username: String(user.username || '') };
    }
    const id = String(user || '');
    const row = usernameStmt && id ? usernameStmt.get(id) : null;
    return { id, username: row && row.username || '' };
  }

  function legacySum(table, column, userId) {
    if (!tableExists(table)) return 0;
    const allowed = {
      comment_credit_ledger: 'delta',
      essay_credit_ledger: 'delta',
      roundtable_credit_ledger: 'delta',
      edulab_credit_ledger: 'credits'
    };
    if (allowed[table] !== column) throw new Error('不支持的旧积分表');
    return Number(db.prepare(`SELECT COALESCE(SUM(${column}), 0) AS n FROM ${table} WHERE user_id = ?`).get(userId).n) || 0;
  }

  function legacyHasMathSignup(userId) {
    if (!tableExists('edulab_credit_ledger')) return false;
    return !!db.prepare("SELECT 1 AS ok FROM edulab_credit_ledger WHERE user_id = ? AND reason = 'signup' LIMIT 1").get(userId);
  }

  function historicalPaidTopup(userId) {
    const rows = [];
    if (tableExists('payments')) {
      const row = db.prepare(`
        SELECT out_trade_no, COALESCE(paid_at, created_at) AS happened_at
        FROM payments
        WHERE user_id = ? AND status = 'paid'
          AND (plan LIKE 'comment_%' OR plan LIKE 'rt_%' OR plan LIKE 'points_%')
        ORDER BY COALESCE(paid_at, created_at), out_trade_no
        LIMIT 1
      `).get(userId);
      if (row) rows.push(row);
    }
    if (tableExists('edulab_payments')) {
      const row = db.prepare(`
        SELECT out_trade_no, COALESCE(paid_at, created_at) AS happened_at
        FROM edulab_payments
        WHERE user_id = ? AND status = 'paid'
        ORDER BY COALESCE(paid_at, created_at), out_trade_no
        LIMIT 1
      `).get(userId);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => String(a.happened_at || '').localeCompare(String(b.happened_at || '')));
    return rows[0] || null;
  }

  function ensureHistoricalTopup(userId) {
    if (hasTopupStmt.get(userId)) return;
    const paid = historicalPaidTopup(userId);
    if (paid && paid.out_trade_no) {
      firstTopupStmt.run(userId, paid.out_trade_no, paid.happened_at || new Date().toISOString());
    }
  }

  const ensureMigrationTx = db.transaction((user) => {
    const info = userInfo(user);
    if (!info.id) throw new Error('缺少用户 ID');
    ensureHistoricalTopup(info.id);
    const existing = migrationStmt.get(info.id);
    if (existing) return safeJson(existing.extra_json, {});

    const commentCredits = Math.max(0, 5 + legacySum('comment_credit_ledger', 'delta', info.id));
    const roundtableCredits = Math.max(0, 5 + legacySum('roundtable_credit_ledger', 'delta', info.id));
    const mathLegacy = legacySum('edulab_credit_ledger', 'credits', info.id);
    const mathCredits = Math.max(0, mathLegacy + (legacyHasMathSignup(info.id) ? 0 : 10));
    const details = {
      comment_credits: commentCredits,
      comment_points: commentCredits * POINT_COSTS.comment,
      roundtable_credits: roundtableCredits,
      roundtable_points: roundtableCredits * POINT_COSTS.roundtable,
      edulab_credits: mathCredits,
      edulab_points: mathCredits * POINT_COSTS.edulab
    };
    details.total_points = details.comment_points + details.roundtable_points + details.edulab_points;
    const now = new Date().toISOString();
    insertStmt.run({
      user_id: info.id,
      username: info.username,
      delta: details.total_points,
      reason: 'legacy_migration',
      product: 'all',
      package_key: null,
      out_trade_no: null,
      generation_id: null,
      note: '旧余额按评语25/圆桌50/数学75迁入',
      created_at: now,
      extra_json: JSON.stringify(details)
    });
    return details;
  });

  function ensureMigration(user) {
    const base = ensureMigrationTx(user);
    const essay = ensureEssayMigrationTx(user);
    return { ...base, ...essay };
  }

  // 作文原有“注册送 10 次 + 账本增减”按 50 积分/次迁入共享余额。
  // 单独使用 migration reason，保证已完成前三产品迁移的老用户也能补迁一次。
  const ensureEssayMigrationTx = db.transaction((user) => {
    const info = userInfo(user);
    if (!info.id) throw new Error('缺少用户 ID');
    const existing = essayMigrationStmt.get(info.id);
    if (existing) return safeJson(existing.extra_json, {});
    const essayCredits = Math.max(0, 10 + legacySum('essay_credit_ledger', 'delta', info.id));
    const essayPoints = essayCredits * POINT_COSTS.essay;
    const now = new Date().toISOString();
    insertStmt.run({
      user_id: info.id,
      username: info.username,
      delta: essayPoints,
      reason: 'essay_legacy_migration',
      product: 'essay',
      package_key: null,
      out_trade_no: null,
      generation_id: null,
      note: '作文旧余额按 50 积分/次迁入',
      created_at: now,
      extra_json: JSON.stringify({ essay_credits: essayCredits, essay_points: essayPoints })
    });
    return { essay_credits: essayCredits, essay_points: essayPoints };
  });

  function getBalance(user) {
    const info = userInfo(user);
    ensureMigration(info);
    return Number(balanceStmt.get(info.id).balance) || 0;
  }

  const adjustTx = db.transaction((row) => {
    const info = userInfo({ id: row.user_id, username: row.username });
    const current = getBalance(info);
    const delta = Math.trunc(Number(row.delta) || 0);
    if (current + delta < 0) {
      const err = new Error('师行积分不足');
      err.code = 'SHIXING_POINTS_EXHAUSTED';
      err.balance = current;
      throw err;
    }
    if (delta) {
      insertStmt.run({
        user_id: info.id,
        username: info.username,
        delta,
        reason: row.reason || 'adjustment',
        product: row.product || 'all',
        package_key: row.package_key || null,
        out_trade_no: row.out_trade_no || null,
        generation_id: row.generation_id || null,
        note: row.note || '',
        created_at: row.created_at || new Date().toISOString(),
        extra_json: row.extra_json ? JSON.stringify(row.extra_json) : null
      });
    }
    return Number(balanceStmt.get(info.id).balance) || 0;
  });

  function adjust(row) {
    return { balance: adjustTx(row) };
  }

  function debit(row) {
    const product = String(row.product || '');
    const cost = Math.trunc(Number(row.cost !== undefined ? row.cost : POINT_COSTS[product]) || 0);
    if (cost <= 0) throw new Error('积分消耗必须大于 0');
    return adjust({
      ...row,
      delta: -cost,
      reason: row.reason || 'usage',
      product,
      note: row.note || product + ' 消耗 ' + cost + ' 积分'
    });
  }

  const addPaymentTx = db.transaction((row) => {
    const info = userInfo({ id: row.user_id, username: row.username });
    const pkg = POINT_PACKAGES[String(row.package_key || '')];
    if (!pkg) throw new Error('积分套餐不存在');
    if (!row.out_trade_no) throw new Error('缺少订单号');
    const existing = purchaseStmt.get(row.out_trade_no);
    if (existing) {
      const extra = safeJson(existing.extra_json, {});
      return {
        balance: getBalance(info),
        first_topup: !!extra.first_topup,
        bonus_points: Number(extra.bonus_points) || 0,
        awarded_points: Number(existing.delta) || 0,
        duplicate: true
      };
    }

    getBalance(info);
    const now = row.created_at || new Date().toISOString();
    const firstTopup = firstTopupStmt.run(info.id, row.out_trade_no, now).changes === 1;
    const bonusPoints = firstTopup ? pkg.first_bonus : 0;
    const awardedPoints = pkg.points + bonusPoints;
    insertStmt.run({
      user_id: info.id,
      username: info.username,
      delta: awardedPoints,
      reason: 'purchase',
      product: row.product || 'all',
      package_key: pkg.key,
      out_trade_no: row.out_trade_no,
      generation_id: null,
      note: row.note || ('购买 ' + pkg.points + ' 积分' + (bonusPoints ? '，首充赠 ' + bonusPoints : '')),
      created_at: now,
      extra_json: JSON.stringify({
        paid_points: pkg.points,
        bonus_points: bonusPoints,
        awarded_points: awardedPoints,
        first_topup: firstTopup
      })
    });
    return {
      balance: Number(balanceStmt.get(info.id).balance) || 0,
      first_topup: firstTopup,
      bonus_points: bonusPoints,
      awarded_points: awardedPoints,
      duplicate: false
    };
  });

  function addPayment(row) {
    return addPaymentTx(row);
  }

  const addLegacyPaymentTx = db.transaction((row) => {
    const info = userInfo({ id: row.user_id, username: row.username });
    const product = String(row.product || '');
    const ratio = POINT_COSTS[product];
    const credits = Math.trunc(Number(row.credits) || 0);
    if (!ratio || credits <= 0) throw new Error('旧套餐参数无效');
    if (!row.out_trade_no) throw new Error('缺少订单号');
    const existing = purchaseStmt.get(row.out_trade_no);
    if (existing) {
      const extra = safeJson(existing.extra_json, {});
      return {
        balance: getBalance(info),
        first_topup: !!extra.first_topup,
        bonus_points: 0,
        awarded_points: Number(existing.delta) || 0,
        duplicate: true
      };
    }

    getBalance(info);
    const now = row.created_at || new Date().toISOString();
    const firstTopup = firstTopupStmt.run(info.id, row.out_trade_no, now).changes === 1;
    const awardedPoints = credits * ratio;
    insertStmt.run({
      user_id: info.id,
      username: info.username,
      delta: awardedPoints,
      reason: 'purchase',
      product,
      package_key: row.package_key || '',
      out_trade_no: row.out_trade_no,
      generation_id: null,
      note: row.note || ('旧套餐 ' + credits + ' 次折算为 ' + awardedPoints + ' 积分'),
      created_at: now,
      extra_json: JSON.stringify({
        legacy_package: true,
        legacy_credits: credits,
        paid_points: awardedPoints,
        bonus_points: 0,
        awarded_points: awardedPoints,
        first_topup: firstTopup
      })
    });
    return {
      balance: Number(balanceStmt.get(info.id).balance) || 0,
      first_topup: firstTopup,
      bonus_points: 0,
      awarded_points: awardedPoints,
      duplicate: false
    };
  });

  function addLegacyPayment(row) {
    return addLegacyPaymentTx(row);
  }

  function hasPaidTopup(userId) {
    ensureMigration(String(userId || ''));
    return !!hasTopupStmt.get(String(userId || ''));
  }

  function listLedger(userId, limit) {
    ensureMigration(userId);
    return db.prepare(`
      SELECT * FROM shixing_point_ledger
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(String(userId || ''), Math.max(1, Math.min(Number(limit) || 50, 200))).map(row => ({
      ...row,
      delta: Number(row.delta) || 0,
      extra: safeJson(row.extra_json, {})
    }));
  }

  return {
    ensureMigration,
    getBalance,
    adjust,
    debit,
    addPayment,
    addLegacyPayment,
    hasPaidTopup,
    listLedger
  };
}

module.exports = {
  createShixingPoints,
  POINT_COSTS,
  POINT_PACKAGES
};
