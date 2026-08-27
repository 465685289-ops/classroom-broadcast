const REFERRAL_REWARDS = Object.freeze({
  activation_inviter_points: 500,
  activation_invitee_points: 500,
  first_purchase_points: 1500,
  first_purchase_broadcast_days: 30,
  activation_monthly_auto_limit: 10,
  device_auto_limit_7d: 2
});

function createUnifiedReferrals(db, pointStore) {
  if (!db || !pointStore) throw new Error('统一邀请模块缺少数据库或积分账本');

  db.exec(`
    CREATE TABLE IF NOT EXISTS global_referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invitee_user_id TEXT NOT NULL UNIQUE,
      inviter_user_id TEXT NOT NULL,
      invite_code TEXT,
      source_product TEXT,
      device_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      bound_at TEXT NOT NULL,
      legacy_conflict_json TEXT,
      extra_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_global_referrals_inviter
      ON global_referrals(inviter_user_id, bound_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS referral_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      source_product TEXT,
      source_record_id TEXT,
      purchase_type TEXT,
      device_hash TEXT,
      status TEXT NOT NULL,
      risk_reason TEXT,
      inviter_reward_points INTEGER NOT NULL DEFAULT 0,
      invitee_reward_points INTEGER NOT NULL DEFAULT 0,
      inviter_reward_days INTEGER NOT NULL DEFAULT 0,
      invitee_rewarded_at TEXT,
      broadcast_expires_at TEXT,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      reversed_at TEXT,
      extra_json TEXT,
      UNIQUE(referral_id, event_type)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_events_source
      ON referral_events(source_record_id)
      WHERE source_record_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_referral_events_status
      ON referral_events(status, event_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS referral_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      click_token TEXT NOT NULL UNIQUE,
      inviter_user_id TEXT NOT NULL,
      invite_code TEXT NOT NULL,
      source_product TEXT,
      device_hash TEXT,
      ip_hash TEXT,
      clicked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_referral_clicks_inviter
      ON referral_clicks(inviter_user_id, clicked_at DESC);
  `);

  const userStmt = db.prepare('SELECT id, username, display_name, teacher_code, plan, plan_expires, created_at FROM users WHERE id = ?');
  const codeStmt = db.prepare('SELECT id, username, display_name, teacher_code, plan, plan_expires, created_at FROM users WHERE upper(teacher_code) = upper(?)');
  const referralStmt = db.prepare('SELECT * FROM global_referrals WHERE invitee_user_id = ?');
  const referralIdStmt = db.prepare('SELECT * FROM global_referrals WHERE id = ?');
  const eventStmt = db.prepare('SELECT * FROM referral_events WHERE referral_id = ? AND event_type = ?');
  const eventIdStmt = db.prepare('SELECT * FROM referral_events WHERE id = ?');
  const purchaseSourceStmt = db.prepare("SELECT * FROM referral_events WHERE event_type = 'first_purchase' AND source_record_id = ?");
  const balanceStmt = db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM shixing_point_ledger WHERE user_id = ?');

  const insertReferralStmt = db.prepare(`
    INSERT INTO global_referrals (
      invitee_user_id, inviter_user_id, invite_code, source_product,
      device_hash, status, bound_at, legacy_conflict_json, extra_json
    ) VALUES (
      @invitee_user_id, @inviter_user_id, @invite_code, @source_product,
      @device_hash, @status, @bound_at, @legacy_conflict_json, @extra_json
    )
  `);
  const insertEventStmt = db.prepare(`
    INSERT INTO referral_events (
      referral_id, event_type, source_product, source_record_id, purchase_type,
      device_hash, status, risk_reason, inviter_reward_points,
      invitee_reward_points, inviter_reward_days, invitee_rewarded_at,
      broadcast_expires_at, created_at, approved_at, reversed_at, extra_json
    ) VALUES (
      @referral_id, @event_type, @source_product, @source_record_id, @purchase_type,
      @device_hash, @status, @risk_reason, @inviter_reward_points,
      @invitee_reward_points, @inviter_reward_days, @invitee_rewarded_at,
      @broadcast_expires_at, @created_at, @approved_at, @reversed_at, @extra_json
    )
  `);
  const insertClickStmt = db.prepare(`
    INSERT OR IGNORE INTO referral_clicks (
      click_token, inviter_user_id, invite_code, source_product,
      device_hash, ip_hash, clicked_at, expires_at
    ) VALUES (
      @click_token, @inviter_user_id, @invite_code, @source_product,
      @device_hash, @ip_hash, @clicked_at, @expires_at
    )
  `);

  function nowIso(value) {
    const parsed = value ? new Date(value) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  function publicEvent(row) {
    if (!row) return null;
    return {
      ...row,
      duplicate: false,
      inviter_reward_points: Number(row.inviter_reward_points) || 0,
      invitee_reward_points: Number(row.invitee_reward_points) || 0,
      inviter_reward_days: Number(row.inviter_reward_days) || 0
    };
  }

  function getReferralByInvitee(inviteeUserId) {
    return referralStmt.get(String(inviteeUserId || '')) || null;
  }

  function findInviterByCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    return normalized ? (codeStmt.get(normalized) || null) : null;
  }

  function recordClick(row) {
    const clickedAt = nowIso(row && row.clicked_at);
    const expiresAt = nowIso(row && row.expires_at || Date.parse(clickedAt) + 7 * 86400000);
    const clickToken = String(row && row.click_token || '').trim();
    const inviterUserId = String(row && row.inviter_user_id || '').trim();
    const inviteCode = String(row && row.invite_code || '').trim().toUpperCase();
    if (!clickToken || !inviterUserId || !inviteCode) throw new Error('邀请点击缺少必要字段');
    const result = insertClickStmt.run({
      click_token: clickToken,
      inviter_user_id: inviterUserId,
      invite_code: inviteCode,
      source_product: String(row.source_product || 'shixing'),
      device_hash: row.device_hash || null,
      ip_hash: row.ip_hash || null,
      clicked_at: clickedAt,
      expires_at: expiresAt
    });
    return { created: result.changes > 0, click_token: clickToken };
  }

  const bindReferralTx = db.transaction((row) => {
    const inviteeId = String(row.invitee_user_id || '');
    const inviterId = String(row.inviter_user_id || '');
    if (!inviteeId || !inviterId) {
      const err = new Error('邀请关系缺少用户');
      err.code = 'REFERRAL_USER_REQUIRED';
      throw err;
    }
    if (inviteeId === inviterId) {
      const err = new Error('不能邀请自己');
      err.code = 'REFERRAL_SELF_INVITE';
      throw err;
    }
    if (!userStmt.get(inviteeId) || !userStmt.get(inviterId)) {
      const err = new Error('邀请用户不存在');
      err.code = 'REFERRAL_USER_NOT_FOUND';
      throw err;
    }
    const existing = referralStmt.get(inviteeId);
    if (existing) {
      if (existing.inviter_user_id === inviterId) {
        return { created: false, reason: 'already_bound', referral: existing };
      }
      const err = new Error('该账号已绑定其他邀请人');
      err.code = 'REFERRAL_ALREADY_BOUND';
      err.referral = existing;
      throw err;
    }
    const info = {
      invitee_user_id: inviteeId,
      inviter_user_id: inviterId,
      invite_code: String(row.invite_code || '').trim().toUpperCase(),
      source_product: String(row.source_product || 'shixing'),
      device_hash: row.device_hash || null,
      status: 'active',
      bound_at: nowIso(row.bound_at),
      legacy_conflict_json: row.legacy_conflict_json || null,
      extra_json: row.extra_json ? JSON.stringify(row.extra_json) : null
    };
    const result = insertReferralStmt.run(info);
    return { created: true, referral: referralIdStmt.get(Number(result.lastInsertRowid)) };
  });

  function bindReferral(row) {
    return bindReferralTx(row || {});
  }

  function monthRange(iso) {
    const d = new Date(iso);
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
    return { start, end };
  }

  function activationRisk(referral, deviceHash, createdAt) {
    if (deviceHash) {
      const since = new Date(Date.parse(createdAt) - 7 * 86400000).toISOString();
      const sameDevice = db.prepare(`
        SELECT COUNT(*) AS n FROM referral_events
        WHERE event_type = 'activation' AND device_hash = ? AND created_at >= ?
      `).get(deviceHash, since).n;
      if (Number(sameDevice) >= REFERRAL_REWARDS.device_auto_limit_7d) return 'device_7d_limit';
    }
    const range = monthRange(createdAt);
    const approved = db.prepare(`
      SELECT COUNT(*) AS n
      FROM referral_events e
      JOIN global_referrals r ON r.id = e.referral_id
      WHERE e.event_type = 'activation' AND e.status = 'approved'
        AND r.inviter_user_id = ? AND e.created_at >= ? AND e.created_at < ?
    `).get(referral.inviter_user_id, range.start, range.end).n;
    if (Number(approved) >= REFERRAL_REWARDS.activation_monthly_auto_limit) return 'inviter_monthly_limit';
    return '';
  }

  const activateReferralTx = db.transaction((row) => {
    const referral = referralStmt.get(String(row.invitee_user_id || ''));
    if (!referral) return { eligible: false, reason: 'not_referred' };
    const existing = eventStmt.get(referral.id, 'activation');
    if (existing) return {
      ...publicEvent(existing),
      inviter_user_id: referral.inviter_user_id,
      invitee_user_id: referral.invitee_user_id,
      duplicate: true
    };
    const createdAt = nowIso(row.created_at);
    const deviceHash = String(row.device_hash || referral.device_hash || '') || null;
    const riskReason = activationRisk(referral, deviceHash, createdAt);
    const isMonthlyHold = riskReason === 'inviter_monthly_limit';
    let inviteeRewardedAt = null;
    if (!riskReason || isMonthlyHold) {
      pointStore.adjust({
        user_id: referral.invitee_user_id,
        delta: REFERRAL_REWARDS.activation_invitee_points,
        reason: 'referral_activation_invitee',
        product: row.product || 'all',
        note: '受邀好友首次有效使用奖励',
        created_at: createdAt
      });
      inviteeRewardedAt = createdAt;
    }
    if (!riskReason) {
      pointStore.adjust({
        user_id: referral.inviter_user_id,
        delta: REFERRAL_REWARDS.activation_inviter_points,
        reason: 'referral_activation_inviter',
        product: row.product || 'all',
        note: '邀请好友首次有效使用奖励',
        created_at: createdAt
      });
    }
    const status = riskReason ? 'pending' : 'approved';
    const result = insertEventStmt.run({
      referral_id: referral.id,
      event_type: 'activation',
      source_product: String(row.product || 'all'),
      source_record_id: row.source_record_id ? String(row.source_record_id) : null,
      purchase_type: null,
      device_hash: deviceHash,
      status,
      risk_reason: riskReason || null,
      inviter_reward_points: riskReason ? 0 : REFERRAL_REWARDS.activation_inviter_points,
      invitee_reward_points: inviteeRewardedAt ? REFERRAL_REWARDS.activation_invitee_points : 0,
      inviter_reward_days: 0,
      invitee_rewarded_at: inviteeRewardedAt,
      broadcast_expires_at: null,
      created_at: createdAt,
      approved_at: status === 'approved' ? createdAt : null,
      reversed_at: null,
      extra_json: null
    });
    return {
      ...publicEvent(eventIdStmt.get(Number(result.lastInsertRowid))),
      inviter_user_id: referral.inviter_user_id,
      invitee_user_id: referral.invitee_user_id
    };
  });

  function activateReferral(row) {
    return activateReferralTx(row || {});
  }

  function extendBroadcastDays(userId, days, createdAt) {
    const user = userStmt.get(userId);
    if (!user) throw new Error('邀请人不存在');
    const current = user.plan_expires ? Date.parse(user.plan_expires) : 0;
    const at = Date.parse(createdAt);
    const base = current && current > at ? current : at;
    const expires = new Date(base + days * 86400000).toISOString();
    db.prepare("UPDATE users SET plan = 'yearly', plan_expires = ? WHERE id = ?").run(expires, userId);
    return expires;
  }

  const rewardFirstPurchaseTx = db.transaction((row) => {
    const referral = referralStmt.get(String(row.invitee_user_id || ''));
    if (!referral) return { eligible: false, reason: 'not_referred' };
    const existing = eventStmt.get(referral.id, 'first_purchase');
    if (existing) return {
      ...publicEvent(existing),
      inviter_user_id: referral.inviter_user_id,
      invitee_user_id: referral.invitee_user_id,
      duplicate: true
    };
    const createdAt = nowIso(row.created_at);
    const purchaseType = row.purchase_type === 'broadcast' ? 'broadcast' : 'points';
    let rewardPoints = 0;
    let rewardDays = 0;
    let broadcastExpiresAt = null;
    if (purchaseType === 'broadcast') {
      rewardDays = REFERRAL_REWARDS.first_purchase_broadcast_days;
      broadcastExpiresAt = extendBroadcastDays(referral.inviter_user_id, rewardDays, createdAt);
    } else {
      rewardPoints = REFERRAL_REWARDS.first_purchase_points;
      pointStore.adjust({
        user_id: referral.inviter_user_id,
        delta: rewardPoints,
        reason: 'referral_first_purchase_inviter',
        product: row.source_product || 'all',
        note: '邀请好友首次付费奖励',
        created_at: createdAt
      });
    }
    const result = insertEventStmt.run({
      referral_id: referral.id,
      event_type: 'first_purchase',
      source_product: String(row.source_product || purchaseType),
      source_record_id: row.source_record_id ? String(row.source_record_id) : null,
      purchase_type: purchaseType,
      device_hash: null,
      status: 'approved',
      risk_reason: null,
      inviter_reward_points: rewardPoints,
      invitee_reward_points: 0,
      inviter_reward_days: rewardDays,
      invitee_rewarded_at: null,
      broadcast_expires_at: broadcastExpiresAt,
      created_at: createdAt,
      approved_at: createdAt,
      reversed_at: null,
      extra_json: null
    });
    return {
      ...publicEvent(eventIdStmt.get(Number(result.lastInsertRowid))),
      inviter_user_id: referral.inviter_user_id,
      invitee_user_id: referral.invitee_user_id
    };
  });

  function rewardFirstPurchase(row) {
    return rewardFirstPurchaseTx(row || {});
  }

  const reverseFirstPurchaseTx = db.transaction((row) => {
    const event = purchaseSourceStmt.get(String(row.source_record_id || ''));
    if (!event) return { eligible: false, reason: 'purchase_reward_not_found' };
    const referral = referralIdStmt.get(event.referral_id);
    if (!referral) return { eligible: false, reason: 'referral_not_found' };
    if (event.status === 'reversed') {
      return {
        ...publicEvent(event),
        inviter_user_id: referral.inviter_user_id,
        invitee_user_id: referral.invitee_user_id,
        duplicate: true
      };
    }
    if (event.status !== 'approved') {
      return {
        ...publicEvent(event),
        inviter_user_id: referral.inviter_user_id,
        invitee_user_id: referral.invitee_user_id,
        duplicate: false
      };
    }
    const reversedAt = nowIso(row.created_at);
    let broadcastExpiresAt = event.broadcast_expires_at || null;
    if (Number(event.inviter_reward_points) > 0) {
      try {
        pointStore.adjust({
          user_id: referral.inviter_user_id,
          delta: -Number(event.inviter_reward_points),
          reason: 'referral_first_purchase_reversal',
          product: event.source_product || 'all',
          note: row.reason || '好友订单退款，撤回邀请奖励',
          created_at: reversedAt
        });
      } catch (e) {
        if (e.code !== 'SHIXING_POINTS_EXHAUSTED') throw e;
        db.prepare("UPDATE referral_events SET status = 'reversal_pending', risk_reason = 'insufficient_balance' WHERE id = ?").run(event.id);
        return {
          ...publicEvent(eventIdStmt.get(event.id)),
          inviter_user_id: referral.inviter_user_id,
          invitee_user_id: referral.invitee_user_id
        };
      }
    }
    if (Number(event.inviter_reward_days) > 0) {
      const inviter = userStmt.get(referral.inviter_user_id);
      const current = inviter && inviter.plan_expires ? Date.parse(inviter.plan_expires) : 0;
      const next = current ? current - Number(event.inviter_reward_days) * 86400000 : Date.parse(reversedAt);
      broadcastExpiresAt = new Date(next).toISOString();
      db.prepare('UPDATE users SET plan_expires = ? WHERE id = ?').run(broadcastExpiresAt, referral.inviter_user_id);
    }
    db.prepare(`
      UPDATE referral_events
      SET status = 'reversed', reversed_at = ?, broadcast_expires_at = ?
      WHERE id = ?
    `).run(reversedAt, broadcastExpiresAt, event.id);
    return {
      ...publicEvent(eventIdStmt.get(event.id)),
      inviter_user_id: referral.inviter_user_id,
      invitee_user_id: referral.invitee_user_id
    };
  });

  function reverseFirstPurchaseReward(row) {
    return reverseFirstPurchaseTx(row || {});
  }

  const reviewEventTx = db.transaction((row) => {
    const event = eventIdStmt.get(Number(row.event_id));
    if (!event) {
      const err = new Error('邀请事件不存在');
      err.code = 'REFERRAL_EVENT_NOT_FOUND';
      throw err;
    }
    if (event.status !== 'pending') return { ...publicEvent(event), duplicate: true };
    const decision = String(row.decision || '');
    if (decision !== 'approve' && decision !== 'reject') throw new Error('审核决定必须为 approve 或 reject');
    const referral = referralIdStmt.get(event.referral_id);
    const reviewedAt = nowIso(row.reviewed_at);
    const extra = JSON.stringify({ reviewer: String(row.reviewer || 'admin'), note: String(row.note || ''), reviewed_at: reviewedAt });
    if (decision === 'reject') {
      db.prepare("UPDATE referral_events SET status = 'rejected', extra_json = ? WHERE id = ?").run(extra, event.id);
      return publicEvent(eventIdStmt.get(event.id));
    }
    let inviteePoints = Number(event.invitee_reward_points) || 0;
    let inviteeRewardedAt = event.invitee_rewarded_at || null;
    if (!inviteePoints) {
      pointStore.adjust({
        user_id: referral.invitee_user_id,
        delta: REFERRAL_REWARDS.activation_invitee_points,
        reason: 'referral_activation_invitee_review',
        product: event.source_product || 'all',
        note: '受邀首次使用奖励人工审核通过',
        created_at: reviewedAt
      });
      inviteePoints = REFERRAL_REWARDS.activation_invitee_points;
      inviteeRewardedAt = reviewedAt;
    }
    pointStore.adjust({
      user_id: referral.inviter_user_id,
      delta: REFERRAL_REWARDS.activation_inviter_points,
      reason: 'referral_activation_inviter_review',
      product: event.source_product || 'all',
      note: '邀请首次使用奖励人工审核通过',
      created_at: reviewedAt
    });
    db.prepare(`
      UPDATE referral_events
      SET status = 'approved', risk_reason = NULL,
          inviter_reward_points = ?, invitee_reward_points = ?,
          invitee_rewarded_at = ?, approved_at = ?, extra_json = ?
      WHERE id = ?
    `).run(REFERRAL_REWARDS.activation_inviter_points, inviteePoints, inviteeRewardedAt, reviewedAt, extra, event.id);
    return publicEvent(eventIdStmt.get(event.id));
  });

  function reviewEvent(row) {
    return reviewEventTx(row || {});
  }

  function listPendingEvents(limit) {
    return db.prepare(`
      SELECT e.*, r.inviter_user_id, r.invitee_user_id,
             inviter.username AS inviter_username, invitee.username AS invitee_username
      FROM referral_events e
      JOIN global_referrals r ON r.id = e.referral_id
      LEFT JOIN users inviter ON inviter.id = r.inviter_user_id
      LEFT JOIN users invitee ON invitee.id = r.invitee_user_id
      WHERE e.status = 'pending'
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100))).map(publicEvent);
  }

  function tableExists(name) {
    return !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  function legacyRows() {
    const rows = [];
    if (tableExists('app_referrals')) {
      db.prepare('SELECT * FROM app_referrals ORDER BY created_at').all().forEach(row => rows.push({
        product: row.product,
        invitee_user_id: row.invitee_user_id,
        inviter_user_id: row.inviter_user_id,
        invitee_username: row.invitee_username || '',
        created_at: row.created_at,
        activated: !!row.usage_rewarded_at,
        paid: !!row.purchase_rewarded_at
      }));
    }
    if (tableExists('essay_referrals')) {
      db.prepare('SELECT * FROM essay_referrals ORDER BY created_at').all().forEach(row => rows.push({
        product: 'essay',
        invitee_user_id: row.invitee_user_id,
        inviter_user_id: row.inviter_user_id,
        invitee_username: row.invitee_username || '',
        created_at: row.created_at,
        activated: !!row.grading_rewarded_at,
        paid: !!row.purchase_rewarded_at
      }));
    }
    return rows;
  }

  function legacyGroups() {
    const groups = new Map();
    legacyRows().forEach(row => {
      if (!groups.has(row.invitee_user_id)) groups.set(row.invitee_user_id, []);
      groups.get(row.invitee_user_id).push(row);
    });
    return [...groups.entries()].map(([invitee, rows]) => {
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return {
        invitee_user_id: invitee,
        rows,
        chosen: rows[0],
        conflict: new Set(rows.map(row => row.inviter_user_id)).size > 1,
        activated: rows.some(row => row.activated),
        paid: rows.some(row => row.paid)
      };
    });
  }

  const migrateLegacyTx = db.transaction((groups) => {
    let inserted = 0;
    groups.forEach(group => {
      if (referralStmt.get(group.invitee_user_id)) return;
      const conflicts = group.conflict ? group.rows.map(row => ({
        product: row.product,
        inviter_user_id: row.inviter_user_id,
        created_at: row.created_at
      })) : null;
      const bound = bindReferralTx({
        invitee_user_id: group.invitee_user_id,
        inviter_user_id: group.chosen.inviter_user_id,
        invite_code: (userStmt.get(group.chosen.inviter_user_id) || {}).teacher_code || '',
        source_product: group.chosen.product,
        bound_at: group.chosen.created_at,
        legacy_conflict_json: conflicts ? JSON.stringify(conflicts) : null
      });
      if (!bound.created) return;
      inserted++;
      if (group.activated) insertEventStmt.run({
        referral_id: bound.referral.id,
        event_type: 'activation',
        source_product: 'legacy',
        source_record_id: 'legacy-activation:' + group.invitee_user_id,
        purchase_type: null,
        device_hash: null,
        status: 'approved',
        risk_reason: null,
        inviter_reward_points: 0,
        invitee_reward_points: 0,
        inviter_reward_days: 0,
        invitee_rewarded_at: null,
        broadcast_expires_at: null,
        created_at: nowIso(group.chosen.created_at),
        approved_at: nowIso(group.chosen.created_at),
        reversed_at: null,
        extra_json: JSON.stringify({ legacy: true })
      });
      if (group.paid) insertEventStmt.run({
        referral_id: bound.referral.id,
        event_type: 'first_purchase',
        source_product: 'legacy',
        source_record_id: 'legacy-purchase:' + group.invitee_user_id,
        purchase_type: 'legacy',
        device_hash: null,
        status: 'approved',
        risk_reason: null,
        inviter_reward_points: 0,
        invitee_reward_points: 0,
        inviter_reward_days: 0,
        invitee_rewarded_at: null,
        broadcast_expires_at: null,
        created_at: nowIso(group.chosen.created_at),
        approved_at: nowIso(group.chosen.created_at),
        reversed_at: null,
        extra_json: JSON.stringify({ legacy: true })
      });
    });
    return inserted;
  });

  function migrateLegacyReferrals(options) {
    const groups = legacyGroups();
    const report = {
      relationships: groups.length,
      conflicts: groups.filter(group => group.conflict).length,
      activated: groups.filter(group => group.activated).length,
      paid: groups.filter(group => group.paid).length,
      inserted: 0
    };
    if (!options || options.dry_run !== false) return report;
    report.inserted = migrateLegacyTx(groups);
    return report;
  }

  function getReferralCenter(inviterUserId) {
    const inviter = userStmt.get(inviterUserId);
    const invitees = db.prepare(`
      SELECT r.*, u.username AS invitee_username
      FROM global_referrals r
      LEFT JOIN users u ON u.id = r.invitee_user_id
      WHERE r.inviter_user_id = ?
      ORDER BY r.bound_at DESC, r.id DESC
    `).all(inviterUserId).map(row => {
      const activation = eventStmt.get(row.id, 'activation');
      const purchase = eventStmt.get(row.id, 'first_purchase');
      return {
        invitee_user_id: row.invitee_user_id,
        invitee_username: row.invitee_username || '',
        source_product: row.source_product || '',
        bound_at: row.bound_at,
        activation_status: activation ? activation.status : 'waiting',
        purchase_status: purchase ? purchase.status : 'waiting',
        risk_reason: activation && activation.risk_reason || purchase && purchase.risk_reason || ''
      };
    });
    const earned = db.prepare(`
      SELECT COALESCE(SUM(e.inviter_reward_points), 0) AS points,
             COALESCE(SUM(e.inviter_reward_days), 0) AS days
      FROM referral_events e
      JOIN global_referrals r ON r.id = e.referral_id
      WHERE r.inviter_user_id = ? AND e.status = 'approved'
    `).get(inviterUserId);
    return {
      code: inviter && inviter.teacher_code || '',
      invitees,
      invited_count: invitees.length,
      earned_points: Number(earned.points) || 0,
      earned_days: Number(earned.days) || 0
    };
  }

  function getAdminStats() {
    const eventRows = db.prepare(`
      SELECT event_type, status, COUNT(*) AS n
      FROM referral_events GROUP BY event_type, status
    `).all();
    const events = {
      activation: { approved: 0, pending: 0, rejected: 0, reversed: 0 },
      first_purchase: { approved: 0, pending: 0, rejected: 0, reversed: 0 }
    };
    eventRows.forEach(row => {
      if (!events[row.event_type]) events[row.event_type] = {};
      events[row.event_type][row.status] = Number(row.n) || 0;
    });
    return {
      relationships: Number(db.prepare('SELECT COUNT(*) AS n FROM global_referrals').get().n) || 0,
      clicks: Number(db.prepare('SELECT COUNT(*) AS n FROM referral_clicks').get().n) || 0,
      events
    };
  }

  return {
    bindReferral,
    activateReferral,
    rewardFirstPurchase,
    reverseFirstPurchaseReward,
    getReferralByInvitee,
    findInviterByCode,
    recordClick,
    getReferralCenter,
    getAdminStats,
    listPendingEvents,
    reviewEvent,
    migrateLegacyReferrals
  };
}

module.exports = {
  REFERRAL_REWARDS,
  createUnifiedReferrals
};
