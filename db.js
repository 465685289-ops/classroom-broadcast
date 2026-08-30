const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { addMembershipDays, getMembershipStatus } = require('./learning-membership');
const { createShixingPoints, POINT_COSTS } = require('./shixing-points');
const { createUnifiedReferrals } = require('./unified-referrals');
const classroomPoints = require('./classroom-points');
const { normalizeClassTimetable } = require('./class-timetable');
const { normalizeBroadcastMode } = require('./broadcast-notification');

const SQLITE_FILE = process.env.SQLITE_FILE || path.join(__dirname, 'broadcast.db');
const LEGACY_JSON_FILE = process.env.LEGACY_JSON_FILE || path.join(__dirname, 'data.json');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');

const db = new Database(SQLITE_FILE);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
let shixingPoints;
let unifiedReferrals;

const FREE_COMMENT_CREDITS = 5;
const FREE_ESSAY_CREDITS = 10;
const FREE_ROUNDTABLE_CREDITS = 5;

function emptyStore() {
  return {
    users: [],
    classes: [],
    notifications: [],
    replies: [],
    messages: [],
    bulletins: [],
    payments: [],
    feedback: [],
    feature_subscriptions: [],
    password_reset_requests: [],
    nextNotifId: 1,
    nextMessageId: 1,
    nextBulletinId: 1
  };
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function jsonString(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function backupLegacyJson(reason) {
  if (!fs.existsSync(LEGACY_JSON_FILE)) return '';
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `data-json-${reason}-${stamp}.json`);
  fs.copyFileSync(LEGACY_JSON_FILE, file);
  return file;
}

function readLegacyJson() {
  const raw = fs.readFileSync(LEGACY_JSON_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    backupLegacyJson('parse-failed');
    throw new Error('data.json 无法解析，已备份原文件。请先从备份恢复数据后再启动服务。');
  }
}

function ensureStoreShape(data) {
  const store = data || emptyStore();
  if (!Array.isArray(store.users)) store.users = [];
  if (!Array.isArray(store.classes)) store.classes = [];
  if (!Array.isArray(store.notifications)) store.notifications = [];
  if (!Array.isArray(store.replies)) store.replies = [];
  if (!Array.isArray(store.messages)) store.messages = [];
  if (!Array.isArray(store.bulletins)) store.bulletins = [];
  if (!Array.isArray(store.payments)) store.payments = [];
  if (!Array.isArray(store.feedback)) store.feedback = [];
  if (!Array.isArray(store.feature_subscriptions)) store.feature_subscriptions = [];
  if (!Array.isArray(store.password_reset_requests)) store.password_reset_requests = [];
  if (!store.nextNotifId) store.nextNotifId = nextId(store.notifications);
  if (!store.nextMessageId) store.nextMessageId = nextId(store.messages);
  if (!store.nextBulletinId) store.nextBulletinId = nextId(store.bulletins);
  return store;
}

function nextId(rows) {
  return (rows || []).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      teacher_code TEXT,
      contact_type TEXT,
      contact_value TEXT,
      registration_email TEXT,
      minutes_per_notice INTEGER DEFAULT 3,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      plan TEXT,
      plan_expires TEXT,
      token TEXT,
      avatar TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      grade TEXT,
      bind_code TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS class_members (
      class_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (class_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      class_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      signature TEXT,
      sender_name TEXT,
      student_name TEXT,
      repeat_count INTEGER,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id TEXT NOT NULL,
      class_name TEXT,
      reply_text TEXT NOT NULL,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT,
      title TEXT,
      body TEXT,
      read_at TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS bulletins (
      id INTEGER PRIMARY KEY,
      class_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT,
      content TEXT,
      sender_name TEXT,
      expires_at TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS class_students (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      student_no TEXT,
      seat_row INTEGER,
      seat_col INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS class_score_rules (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      delta INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS class_score_periods (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      status TEXT NOT NULL DEFAULT 'current',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS class_score_ledger (
      id TEXT PRIMARY KEY,
      client_operation_id TEXT NOT NULL UNIQUE,
      class_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      period_id TEXT NOT NULL,
      rule_id TEXT,
      rule_name_snapshot TEXT NOT NULL,
      delta INTEGER NOT NULL,
      source TEXT NOT NULL,
      actor_user_id TEXT,
      batch_id TEXT,
      reversal_of_id TEXT,
      client_created_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      out_trade_no TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      plan TEXT,
      plan_days INTEGER,
      credits INTEGER DEFAULT 0,
      amount TEXT,
      status TEXT,
      created_at TEXT,
      provider_order_no TEXT,
      provider_pay_no TEXT,
      paid_at TEXT,
      plan_expires TEXT,
      error TEXT,
      provider_response_json TEXT,
      notify_payload_json TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      contact_value TEXT,
      status TEXT,
      requested_at TEXT,
      handled_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      email TEXT,
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      token_hash TEXT,
      token_salt TEXT,
      attempts INTEGER DEFAULT 0,
      expires_at TEXT NOT NULL,
      verified_at TEXT,
      used_at TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS registration_email_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      request_ip TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      category TEXT,
      content TEXT NOT NULL,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS feature_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      feature_key TEXT NOT NULL,
      feature_name TEXT,
      created_at TEXT,
      extra_json TEXT,
      UNIQUE(user_id, feature_key)
    );

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      summary TEXT NOT NULL,
      note TEXT,
      ip_hash TEXT,
      created_at TEXT NOT NULL,
      extra_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created
      ON admin_audit_logs(created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS conversion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_hash TEXT NOT NULL,
      user_id TEXT,
      product TEXT NOT NULL,
      event_name TEXT NOT NULL,
      path TEXT,
      source TEXT,
      referrer_host TEXT,
      device TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversion_event_created
      ON conversion_events(event_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversion_product_created
      ON conversion_events(product, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversion_visitor_created
      ON conversion_events(visitor_hash, created_at DESC);

    CREATE TABLE IF NOT EXISTS comment_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      student_name TEXT,
      school_stage TEXT,
      performance TEXT,
      style TEXT,
      tags_json TEXT,
      min_len INTEGER,
      max_len INTEGER,
      comment TEXT NOT NULL,
      model TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS comment_credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      package_key TEXT,
      out_trade_no TEXT,
      generation_id INTEGER,
      note TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS comment_rosters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      name TEXT NOT NULL,
      student_count INTEGER DEFAULT 0,
      students_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT,
      updated_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS essay_gradings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      subject TEXT NOT NULL DEFAULT 'chinese',
      request_id TEXT,
      student_name TEXT,
      genre TEXT,
      grade_level TEXT,
      score_type TEXT,
      essay_text TEXT,
      result TEXT NOT NULL,
      model TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS essay_classes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'chinese',
      name TEXT NOT NULL,
      grade TEXT,
      school_year TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS essay_students (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'chinese',
      class_id TEXT NOT NULL,
      name TEXT NOT NULL,
      student_no TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS essay_rubric_templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'chinese',
      name TEXT NOT NULL,
      dimensions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS essay_assignments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'chinese',
      class_id TEXT,
      rubric_id TEXT,
      title TEXT NOT NULL,
      material TEXT,
      requirements TEXT,
      min_words INTEGER,
      max_words INTEGER,
      genre TEXT,
      grade_level TEXT,
      score_type TEXT,
      rubric_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS essay_submissions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'chinese',
      assignment_id TEXT NOT NULL,
      student_id TEXT,
      student_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      share_token TEXT NOT NULL UNIQUE,
      current_version INTEGER NOT NULL DEFAULT 1,
      current_grading_id INTEGER,
      returned_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS essay_revisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      essay_text TEXT NOT NULL,
      source TEXT,
      grading_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(submission_id, version_no)
    );

    CREATE TABLE IF NOT EXISTS essay_reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      submission_id TEXT,
      grading_id INTEGER,
      status TEXT NOT NULL DEFAULT 'review',
      score_override TEXT,
      summary_override TEXT,
      annotations_json TEXT,
      finalized_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS essay_credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      package_key TEXT,
      out_trade_no TEXT,
      grading_id INTEGER,
      card_code TEXT,
      note TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS essay_cards (
      code TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      batch_note TEXT,
      status TEXT NOT NULL DEFAULT 'unused',
      created_at TEXT,
      used_at TEXT,
      used_by TEXT,
      used_by_username TEXT
    );

    CREATE TABLE IF NOT EXISTS essay_time_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      plan_label TEXT,
      days INTEGER NOT NULL,
      daily_limit INTEGER NOT NULL,
      starts_at TEXT,
      expires_at TEXT NOT NULL,
      out_trade_no TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS learning_memberships (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      plan_key TEXT,
      plan_label TEXT,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS learning_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      tool_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_saved (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      tool_key TEXT NOT NULL,
      title TEXT,
      input TEXT,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_checkins (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
    );

    CREATE TABLE IF NOT EXISTS essay_referrals (
      invitee_user_id TEXT PRIMARY KEY,
      inviter_user_id TEXT NOT NULL,
      invitee_username TEXT,
      created_at TEXT,
      grading_rewarded_at TEXT,
      purchase_rewarded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_referrals (
      product TEXT NOT NULL,
      invitee_user_id TEXT NOT NULL,
      inviter_user_id TEXT NOT NULL,
      invitee_username TEXT,
      created_at TEXT,
      usage_rewarded_at TEXT,
      purchase_rewarded_at TEXT,
      PRIMARY KEY (product, invitee_user_id)
    );

    CREATE TABLE IF NOT EXISTS roundtable_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      topic TEXT,
      at_targets TEXT,
      transcript TEXT,
      speak_count INTEGER DEFAULT 0,
      model TEXT,
      created_at TEXT,
      finished_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS roundtable_credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      package_key TEXT,
      out_trade_no TEXT,
      generation_id INTEGER,
      card_code TEXT,
      note TEXT,
      created_at TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS roundtable_cards (
      code TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      batch_note TEXT,
      status TEXT NOT NULL DEFAULT 'unused',
      created_at TEXT,
      used_at TEXT,
      used_by TEXT,
      used_by_username TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_classes_user ON classes(user_id);
    CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_class ON notifications(class_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bulletins_class ON bulletins(class_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_class_students_active ON class_students(class_id, archived, seat_row, seat_col, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_class_students_number ON class_students(class_id, student_no) WHERE student_no IS NOT NULL AND student_no != '';
    CREATE INDEX IF NOT EXISTS idx_class_score_rules_active ON class_score_rules(class_id, active, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_class_score_periods_status ON class_score_periods(class_id, status, starts_at DESC);
    CREATE INDEX IF NOT EXISTS idx_class_score_ledger_class ON class_score_ledger(class_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_class_score_ledger_student ON class_score_ledger(class_id, student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_class_score_ledger_period ON class_score_ledger(class_id, period_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_class_score_ledger_reversal ON class_score_ledger(reversal_of_id) WHERE reversal_of_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_status ON password_reset_requests(status, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user ON password_reset_codes(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_password_reset_codes_lookup ON password_reset_codes(username, email, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_registration_email_codes_lookup ON registration_email_codes(email, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_registration_email_codes_ip ON registration_email_codes(request_ip, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feature_subscriptions_feature ON feature_subscriptions(feature_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comment_generations_user ON comment_generations(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comment_credit_user ON comment_credit_ledger(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_credit_payment ON comment_credit_ledger(out_trade_no) WHERE out_trade_no IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_comment_rosters_user ON comment_rosters(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_gradings_user ON essay_gradings(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_classes_user ON essay_classes(user_id, archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_students_class ON essay_students(user_id, class_id, archived, name);
    CREATE INDEX IF NOT EXISTS idx_essay_rubrics_user ON essay_rubric_templates(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_assignments_class ON essay_assignments(user_id, class_id, archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_submissions_assignment ON essay_submissions(user_id, assignment_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_submissions_student ON essay_submissions(user_id, student_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_revisions_submission ON essay_revisions(submission_id, version_no);
    CREATE INDEX IF NOT EXISTS idx_essay_reviews_submission ON essay_reviews(user_id, submission_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_credit_user ON essay_credit_ledger(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_credit_payment ON essay_credit_ledger(out_trade_no) WHERE out_trade_no IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_credit_card ON essay_credit_ledger(card_code) WHERE card_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_essay_cards_status ON essay_cards(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_time_plans_user ON essay_time_plans(user_id, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_usage_user ON learning_usage(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_saved_user ON learning_saved(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_history_user ON learning_history(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_time_plans_order ON essay_time_plans(out_trade_no) WHERE out_trade_no IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_essay_referrals_inviter ON essay_referrals(inviter_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_app_referrals_inviter ON app_referrals(product, inviter_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_roundtable_gen_user ON roundtable_generations(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_roundtable_credit_user ON roundtable_credit_ledger(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roundtable_credit_payment ON roundtable_credit_ledger(out_trade_no) WHERE out_trade_no IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roundtable_credit_card ON roundtable_credit_ledger(card_code) WHERE card_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_roundtable_cards_status ON roundtable_cards(status, created_at DESC);
  `);
  ensureColumn('users', 'contact_type', 'TEXT');
  ensureColumn('users', 'contact_value', 'TEXT');
  ensureColumn('users', 'registration_email', 'TEXT');
  ensureColumn('users', 'minutes_per_notice', 'INTEGER DEFAULT 3');
  ensureColumn('users', 'token_expires', 'TEXT');
  ensureColumn('classes', 'management_enabled', 'INTEGER DEFAULT 0');
  ensureColumn('classes', 'points_sound_enabled', 'INTEGER DEFAULT 0');
  ensureColumn('classes', 'archived_at', 'TEXT');
  ensureColumn('essay_gradings', 'subject', "TEXT NOT NULL DEFAULT 'chinese'");
  ensureColumn('essay_gradings', 'request_id', 'TEXT');
  ensureColumn('essay_classes', 'subject', "TEXT NOT NULL DEFAULT 'chinese'");
  ensureColumn('essay_students', 'subject', "TEXT NOT NULL DEFAULT 'chinese'");
  ensureColumn('essay_rubric_templates', 'subject', "TEXT NOT NULL DEFAULT 'chinese'");
  ensureColumn('essay_assignments', 'subject', "TEXT NOT NULL DEFAULT 'chinese'");
  ensureColumn('essay_submissions', 'subject', "TEXT NOT NULL DEFAULT 'chinese'");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_registration_email ON users(registration_email) WHERE registration_email IS NOT NULL');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_essay_classes_subject ON essay_classes(user_id, subject, archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_students_subject ON essay_students(user_id, subject, class_id, archived, name);
    CREATE INDEX IF NOT EXISTS idx_essay_assignments_subject ON essay_assignments(user_id, subject, class_id, archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_essay_submissions_subject ON essay_submissions(user_id, subject, assignment_id, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_grading_request ON essay_gradings(user_id, subject, request_id) WHERE request_id IS NOT NULL;
  `);
  ensureColumn('payments', 'credits', 'INTEGER DEFAULT 0');
}

function ensureColumn(table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = rows.some(row => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableCount(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function isDatabaseEmpty() {
  return ['users', 'classes', 'notifications', 'replies', 'messages', 'bulletins', 'payments', 'feedback', 'feature_subscriptions', 'password_reset_requests']
    .every(table => tableCount(table) === 0);
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function setCounter(key, value) {
  setMeta(key, Number(value) || 1);
}

function loadUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at, username').all().map(row => ({
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    teacher_code: row.teacher_code,
    contact_type: row.contact_type || '',
    contact_value: row.contact_value || '',
    registration_email: row.registration_email || '',
    minutes_per_notice: Number(row.minutes_per_notice) || 3,
    password_hash: row.password_hash,
    password_salt: row.password_salt,
    plan: row.plan,
    plan_expires: row.plan_expires,
    token: row.token,
    token_expires: row.token_expires || null,
    avatar: row.avatar || undefined,
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadClasses() {
  const memberRows = db.prepare('SELECT class_id, user_id FROM class_members ORDER BY rowid').all();
  const memberMap = {};
  memberRows.forEach(row => {
    if (!memberMap[row.class_id]) memberMap[row.class_id] = [];
    memberMap[row.class_id].push(row.user_id);
  });
  return db.prepare('SELECT * FROM classes WHERE archived_at IS NULL ORDER BY created_at, name').all().map(row => {
    const extra = safeJsonParse(row.extra_json, {});
    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      grade: row.grade,
      bind_code: row.bind_code,
      member_ids: memberMap[row.id] || [],
      management_enabled: Number(row.management_enabled) === 1,
      points_sound_enabled: Number(row.points_sound_enabled) === 1,
      archived_at: row.archived_at || null,
      created_at: row.created_at,
      timetable: normalizeClassTimetable(extra.timetable)
    };
  });
}

function loadNotifications() {
  return db.prepare('SELECT * FROM notifications ORDER BY id').all().map(row => {
    const extra = safeJsonParse(row.extra_json, {});
    return {
      id: row.id,
      class_id: row.class_id,
      user_id: row.user_id,
      content: row.content,
      signature: row.signature || '',
      sender_name: row.sender_name || '',
      student_name: row.student_name || '',
      repeat_count: row.repeat_count || 1,
      broadcast_mode: normalizeBroadcastMode(extra.broadcast_mode),
      created_at: row.created_at
    };
  });
}

function loadReplies() {
  return db.prepare('SELECT * FROM replies ORDER BY id').all().map(row => ({
    id: row.id,
    class_id: row.class_id,
    class_name: row.class_name || '',
    reply_text: row.reply_text,
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadMessages() {
  return db.prepare('SELECT * FROM messages ORDER BY id').all().map(row => ({
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    read_at: row.read_at,
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadBulletins() {
  return db.prepare('SELECT * FROM bulletins ORDER BY id').all().map(row => ({
    id: row.id,
    class_id: row.class_id,
    user_id: row.user_id,
    title: row.title,
    content: row.content,
    sender_name: row.sender_name,
    expires_at: row.expires_at,
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadPayments() {
  return db.prepare('SELECT * FROM payments ORDER BY created_at').all().map(row => ({
    out_trade_no: row.out_trade_no,
    user_id: row.user_id,
    username: row.username,
    plan: row.plan,
    plan_days: row.plan_days,
    credits: Number(row.credits) || 0,
    amount: row.amount,
    status: row.status,
    created_at: row.created_at,
    provider_order_no: row.provider_order_no || undefined,
    provider_pay_no: row.provider_pay_no || undefined,
    paid_at: row.paid_at || undefined,
    plan_expires: row.plan_expires || undefined,
    error: row.error || undefined,
    provider_response: safeJsonParse(row.provider_response_json, undefined),
    notify_payload: safeJsonParse(row.notify_payload_json, undefined),
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadPasswordResetRequests() {
  return db.prepare('SELECT * FROM password_reset_requests ORDER BY id').all().map(row => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    contact_value: row.contact_value || '',
    status: row.status || 'pending',
    requested_at: row.requested_at,
    handled_at: row.handled_at || null,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadFeedback() {
  return db.prepare('SELECT * FROM feedback ORDER BY id').all().map(row => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    category: row.category || '功能建议',
    content: row.content,
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadFeatureSubscriptions() {
  return db.prepare('SELECT * FROM feature_subscriptions ORDER BY id').all().map(row => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    feature_key: row.feature_key,
    feature_name: row.feature_name || '',
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function loadStore() {
  const notifications = loadNotifications();
  const messages = loadMessages();
  const bulletins = loadBulletins();
  return {
    users: loadUsers(),
    classes: loadClasses(),
    notifications,
    replies: loadReplies(),
    messages,
    bulletins,
    payments: loadPayments(),
    feedback: loadFeedback(),
    feature_subscriptions: loadFeatureSubscriptions(),
    password_reset_requests: loadPasswordResetRequests(),
    nextNotifId: Number(getMeta('nextNotifId')) || nextId(notifications),
    nextMessageId: Number(getMeta('nextMessageId')) || nextId(messages),
    nextBulletinId: Number(getMeta('nextBulletinId')) || nextId(bulletins)
  };
}

function insertAdminAuditLog(row) {
  const result = db.prepare(`
    INSERT INTO admin_audit_logs (
      action, target_type, target_id, summary, note, ip_hash, created_at, extra_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(row.action || 'admin_action'),
    row.target_type ? String(row.target_type) : null,
    row.target_id ? String(row.target_id) : null,
    String(row.summary || '管理员操作'),
    row.note ? String(row.note).slice(0, 500) : null,
    row.ip_hash ? String(row.ip_hash) : null,
    row.created_at || new Date().toISOString(),
    row.extra_json ? JSON.stringify(row.extra_json) : null
  );
  return Number(result.lastInsertRowid);
}

function listAdminAuditLogs(limit) {
  return db.prepare('SELECT * FROM admin_audit_logs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(row => ({ ...row, extra: safeJsonParse(row.extra_json, {}) }));
}

function recordConversionEvent(row) {
  const createdAt = row.created_at || new Date().toISOString();
  if (row.event_name === 'page_view') {
    const duplicateSince = new Date(Date.parse(createdAt) - 30 * 60 * 1000).toISOString();
    const duplicate = db.prepare(`
      SELECT id FROM conversion_events
      WHERE visitor_hash = ? AND product = ? AND event_name = 'page_view'
        AND COALESCE(path, '') = COALESCE(?, '') AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(row.visitor_hash, row.product, row.path || null, duplicateSince);
    if (duplicate) return { id: Number(duplicate.id), inserted: false };
  }
  const result = db.prepare(`
    INSERT INTO conversion_events (
      visitor_hash, user_id, product, event_name, path, source, referrer_host, device, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.visitor_hash,
    row.user_id || null,
    row.product,
    row.event_name,
    row.path || null,
    row.source || 'direct',
    row.referrer_host || null,
    row.device || 'desktop',
    createdAt
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

function getConversionReport(days) {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const since = new Date(Date.now() - (safeDays - 1) * 86400000).toISOString().slice(0, 10);
  const summaryRow = db.prepare(`
    SELECT
      SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS page_views,
      COUNT(DISTINCT CASE WHEN event_name = 'page_view' THEN visitor_hash END) AS unique_visitors,
      SUM(CASE WHEN event_name = 'product_click' THEN 1 ELSE 0 END) AS product_clicks,
      SUM(CASE WHEN event_name = 'auth_prompt' THEN 1 ELSE 0 END) AS auth_prompts,
      SUM(CASE WHEN event_name = 'code_request' THEN 1 ELSE 0 END) AS code_requests,
      SUM(CASE WHEN event_name = 'registration_success' THEN 1 ELSE 0 END) AS registrations,
      SUM(CASE WHEN event_name = 'login_success' THEN 1 ELSE 0 END) AS logins
    FROM conversion_events WHERE created_at >= ?
  `).get(since);
  const numeric = value => Number(value) || 0;
  const summary = {
    page_views: numeric(summaryRow.page_views),
    unique_visitors: numeric(summaryRow.unique_visitors),
    product_clicks: numeric(summaryRow.product_clicks),
    auth_prompts: numeric(summaryRow.auth_prompts),
    code_requests: numeric(summaryRow.code_requests),
    registrations: numeric(summaryRow.registrations),
    logins: numeric(summaryRow.logins)
  };
  summary.visit_to_code_rate = summary.unique_visitors ? Math.round(summary.code_requests * 10000 / summary.unique_visitors) / 100 : 0;
  summary.visit_to_register_rate = summary.unique_visitors ? Math.round(summary.registrations * 10000 / summary.unique_visitors) / 100 : 0;

  const products = db.prepare(`
    SELECT product,
      SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS page_views,
      COUNT(DISTINCT CASE WHEN event_name = 'page_view' THEN visitor_hash END) AS unique_visitors,
      SUM(CASE WHEN event_name = 'product_click' THEN 1 ELSE 0 END) AS product_clicks,
      SUM(CASE WHEN event_name = 'auth_prompt' THEN 1 ELSE 0 END) AS auth_prompts,
      SUM(CASE WHEN event_name = 'code_request' THEN 1 ELSE 0 END) AS code_requests,
      SUM(CASE WHEN event_name = 'registration_success' THEN 1 ELSE 0 END) AS registrations,
      SUM(CASE WHEN event_name = 'login_success' THEN 1 ELSE 0 END) AS logins
    FROM conversion_events WHERE created_at >= ?
    GROUP BY product ORDER BY unique_visitors DESC, page_views DESC
  `).all(since).map(row => ({
    product: row.product,
    page_views: numeric(row.page_views),
    unique_visitors: numeric(row.unique_visitors),
    product_clicks: numeric(row.product_clicks),
    auth_prompts: numeric(row.auth_prompts),
    code_requests: numeric(row.code_requests),
    registrations: numeric(row.registrations),
    logins: numeric(row.logins)
  }));

  const sources = db.prepare(`
    SELECT COALESCE(NULLIF(source, ''), 'direct') AS source,
      COUNT(*) AS page_views,
      COUNT(DISTINCT visitor_hash) AS unique_visitors
    FROM conversion_events
    WHERE created_at >= ? AND event_name = 'page_view'
    GROUP BY COALESCE(NULLIF(source, ''), 'direct')
    ORDER BY unique_visitors DESC, page_views DESC LIMIT 20
  `).all(since).map(row => ({
    source: row.source,
    page_views: numeric(row.page_views),
    unique_visitors: numeric(row.unique_visitors)
  }));

  const dailyRows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date,
      SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS page_views,
      COUNT(DISTINCT CASE WHEN event_name = 'page_view' THEN visitor_hash END) AS unique_visitors,
      SUM(CASE WHEN event_name = 'code_request' THEN 1 ELSE 0 END) AS code_requests,
      SUM(CASE WHEN event_name = 'registration_success' THEN 1 ELSE 0 END) AS registrations
    FROM conversion_events WHERE created_at >= ?
    GROUP BY substr(created_at, 1, 10)
  `).all(since);
  const dailyMap = Object.fromEntries(dailyRows.map(row => [row.date, row]));
  const daily = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const row = dailyMap[date] || {};
    daily.push({
      date,
      page_views: numeric(row.page_views),
      unique_visitors: numeric(row.unique_visitors),
      code_requests: numeric(row.code_requests),
      registrations: numeric(row.registrations)
    });
  }
  return { days: safeDays, summary, products, sources, daily };
}

ensureSchema();

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, username, display_name, teacher_code, contact_type, contact_value, registration_email, minutes_per_notice, password_hash, password_salt, plan, plan_expires, token, token_expires, avatar, created_at, extra_json)
  VALUES (@id, @username, @display_name, @teacher_code, @contact_type, @contact_value, @registration_email, @minutes_per_notice, @password_hash, @password_salt, @plan, @plan_expires, @token, @token_expires, @avatar, @created_at, @extra_json)
  ON CONFLICT(id) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name,
    teacher_code = excluded.teacher_code,
    contact_type = excluded.contact_type,
    contact_value = excluded.contact_value,
    registration_email = excluded.registration_email,
    minutes_per_notice = excluded.minutes_per_notice,
    password_hash = excluded.password_hash,
    password_salt = excluded.password_salt,
    plan = excluded.plan,
    plan_expires = excluded.plan_expires,
    token = excluded.token,
    token_expires = excluded.token_expires,
    avatar = excluded.avatar,
    created_at = excluded.created_at,
    extra_json = excluded.extra_json
`);

function upsertUser(user) {
  insertUserStmt.run({
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    teacher_code: user.teacher_code || null,
    contact_type: user.contact_type || null,
    contact_value: user.contact_value || null,
    registration_email: user.registration_email || null,
    minutes_per_notice: Number(user.minutes_per_notice) || 3,
    password_hash: user.password_hash,
    password_salt: user.password_salt,
    plan: user.plan || 'trial',
    plan_expires: user.plan_expires || null,
    token: user.token || null,
    token_expires: user.token_expires || null,
    avatar: user.avatar || null,
    created_at: user.created_at || new Date().toISOString(),
    extra_json: null
  });
}

const upsertClassTx = db.transaction((cls) => {
  db.prepare(`
    INSERT INTO classes (id, user_id, name, grade, bind_code, created_at, extra_json)
    VALUES (@id, @user_id, @name, @grade, @bind_code, @created_at, @extra_json)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      name = excluded.name,
      grade = excluded.grade,
      bind_code = excluded.bind_code,
      created_at = excluded.created_at,
      extra_json = excluded.extra_json
  `).run({
    id: cls.id,
    user_id: cls.user_id,
    name: cls.name,
    grade: cls.grade || 'junior',
    bind_code: cls.bind_code,
    created_at: cls.created_at || new Date().toISOString(),
    extra_json: cls.timetable ? jsonString({ timetable: normalizeClassTimetable(cls.timetable) }) : null
  });
  db.prepare('DELETE FROM class_members WHERE class_id = ?').run(cls.id);
  const insertMember = db.prepare('INSERT OR IGNORE INTO class_members (class_id, user_id) VALUES (?, ?)');
  (cls.member_ids || []).forEach(userId => {
    if (userId && userId !== cls.user_id) insertMember.run(cls.id, userId);
  });
});

function upsertClass(cls) {
  upsertClassTx(cls);
}

function saveClassTimetable(classId, timetable) {
  const row = db.prepare('SELECT id, extra_json FROM classes WHERE id = ?').get(classId);
  if (!row) throw new Error('班级不存在');
  const normalized = normalizeClassTimetable(timetable);
  const extra = safeJsonParse(row.extra_json, {});
  db.prepare('UPDATE classes SET extra_json = ? WHERE id = ?')
    .run(jsonString({ ...extra, timetable: normalized }), classId);
  return normalized;
}

const deleteClassTx = db.transaction((classId) => {
  db.prepare('DELETE FROM class_members WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM notifications WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM bulletins WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM class_score_ledger WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM class_score_periods WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM class_score_rules WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM class_students WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM classes WHERE id = ?').run(classId);
});

function deleteClass(classId) {
  deleteClassTx(classId);
}

function classHasManagementHistory(classId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM class_students WHERE class_id = ?) AS students,
      (SELECT COUNT(*) FROM class_score_periods WHERE class_id = ?) AS periods,
      (SELECT COUNT(*) FROM class_score_ledger WHERE class_id = ?) AS ledger
  `).get(classId, classId, classId);
  return !!row && (Number(row.students) > 0 || Number(row.periods) > 0 || Number(row.ledger) > 0);
}

function archiveClass(classId, archivedAt) {
  const timestamp = archivedAt || new Date().toISOString();
  const result = db.prepare(`
    UPDATE classes
    SET archived_at = ?, management_enabled = 0, points_sound_enabled = 0
    WHERE id = ?
  `).run(timestamp, classId);
  if (!result.changes) throw new Error('班级不存在');
  return getClassManagement(classId);
}

function classManagementRow(row) {
  if (!row) return null;
  return {
    class_id: row.id,
    enabled: Number(row.management_enabled) === 1,
    sound_enabled: Number(row.points_sound_enabled) === 1,
    archived_at: row.archived_at || null
  };
}

function getClassManagement(classId) {
  return classManagementRow(db.prepare(`
    SELECT id, management_enabled, points_sound_enabled, archived_at
    FROM classes WHERE id = ?
  `).get(classId));
}

function setClassManagement(classId, patch) {
  const current = getClassManagement(classId);
  if (!current) throw new Error('班级不存在');
  const enabled = patch && patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0);
  const soundEnabled = patch && patch.sound_enabled !== undefined ? (patch.sound_enabled ? 1 : 0) : (current.sound_enabled ? 1 : 0);
  db.prepare(`
    UPDATE classes SET management_enabled = ?, points_sound_enabled = ? WHERE id = ?
  `).run(enabled, soundEnabled, classId);
  return getClassManagement(classId);
}

function mapClassStudent(row) {
  if (!row) return null;
  return {
    id: row.id,
    class_id: row.class_id,
    name: row.name,
    student_no: row.student_no || '',
    seat_row: row.seat_row === null ? null : Number(row.seat_row),
    seat_col: row.seat_col === null ? null : Number(row.seat_col),
    archived: Number(row.archived) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function createClassStudent(input) {
  const normalized = classroomPoints.normalizeStudentInput(input);
  const now = input.updated_at || input.created_at || new Date().toISOString();
  const row = {
    id: input.id || crypto.randomUUID(),
    class_id: input.class_id,
    ...normalized,
    archived: input.archived ? 1 : 0,
    created_at: input.created_at || now,
    updated_at: now
  };
  if (!db.prepare('SELECT id FROM classes WHERE id = ?').get(row.class_id)) throw new Error('班级不存在');
  db.prepare(`
    INSERT INTO class_students (
      id, class_id, name, student_no, seat_row, seat_col, archived, created_at, updated_at
    ) VALUES (
      @id, @class_id, @name, @student_no, @seat_row, @seat_col, @archived, @created_at, @updated_at
    )
  `).run(row);
  return getClassStudent(row.class_id, row.id);
}

function getClassStudent(classId, studentId) {
  return mapClassStudent(db.prepare('SELECT * FROM class_students WHERE class_id = ? AND id = ?').get(classId, studentId));
}

function listClassStudents(classId, options = {}) {
  const includeArchived = !!options.include_archived;
  return db.prepare(`
    SELECT * FROM class_students
    WHERE class_id = ? ${includeArchived ? '' : 'AND archived = 0'}
    ORDER BY CASE WHEN seat_row IS NULL THEN 1 ELSE 0 END, seat_row, seat_col, name
  `).all(classId).map(mapClassStudent);
}

function updateClassStudent(classId, studentId, patch) {
  const current = getClassStudent(classId, studentId);
  if (!current) throw new Error('学生不存在');
  const normalized = classroomPoints.normalizeStudentInput({
    name: patch.name === undefined ? current.name : patch.name,
    student_no: patch.student_no === undefined ? current.student_no : patch.student_no,
    seat_row: patch.seat_row === undefined ? current.seat_row : patch.seat_row,
    seat_col: patch.seat_col === undefined ? current.seat_col : patch.seat_col
  });
  const archived = patch.archived === undefined ? current.archived : !!patch.archived;
  db.prepare(`
    UPDATE class_students SET
      name = ?, student_no = ?, seat_row = ?, seat_col = ?, archived = ?, updated_at = ?
    WHERE class_id = ? AND id = ?
  `).run(
    normalized.name,
    normalized.student_no,
    normalized.seat_row,
    normalized.seat_col,
    archived ? 1 : 0,
    patch.updated_at || new Date().toISOString(),
    classId,
    studentId
  );
  return getClassStudent(classId, studentId);
}

function mapClassScoreRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    class_id: row.class_id,
    name: row.name,
    delta: Number(row.delta),
    sort_order: Number(row.sort_order) || 0,
    active: Number(row.active) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function saveClassScoreRule(input) {
  const normalized = classroomPoints.normalizeRuleInput(input);
  const now = input.updated_at || input.created_at || new Date().toISOString();
  const row = {
    id: input.id || crypto.randomUUID(),
    class_id: input.class_id,
    ...normalized,
    sort_order: Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : 0,
    created_at: input.created_at || now,
    updated_at: now
  };
  if (!db.prepare('SELECT id FROM classes WHERE id = ?').get(row.class_id)) throw new Error('班级不存在');
  db.prepare(`
    INSERT INTO class_score_rules (
      id, class_id, name, delta, sort_order, active, created_at, updated_at
    ) VALUES (
      @id, @class_id, @name, @delta, @sort_order, @active, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      delta = excluded.delta,
      sort_order = excluded.sort_order,
      active = excluded.active,
      updated_at = excluded.updated_at
  `).run(row);
  return getClassScoreRule(row.class_id, row.id);
}

function getClassScoreRule(classId, ruleId) {
  return mapClassScoreRule(db.prepare('SELECT * FROM class_score_rules WHERE class_id = ? AND id = ?').get(classId, ruleId));
}

function listClassScoreRules(classId, options = {}) {
  return db.prepare(`
    SELECT * FROM class_score_rules
    WHERE class_id = ? ${options.include_inactive ? '' : 'AND active = 1'}
    ORDER BY sort_order, CASE WHEN delta > 0 THEN 0 ELSE 1 END, ABS(delta), name
  `).all(classId).map(mapClassScoreRule);
}

function mapClassScorePeriod(row) {
  if (!row) return null;
  return {
    id: row.id,
    class_id: row.class_id,
    name: row.name,
    starts_at: row.starts_at,
    ends_at: row.ends_at || null,
    status: row.status,
    created_at: row.created_at
  };
}

function ensureCurrentClassScorePeriod(classId, nowValue) {
  const existing = db.prepare(`
    SELECT * FROM class_score_periods WHERE class_id = ? AND status = 'current'
    ORDER BY starts_at DESC LIMIT 1
  `).get(classId);
  if (existing) return mapClassScorePeriod(existing);
  if (!db.prepare('SELECT id FROM classes WHERE id = ?').get(classId)) throw new Error('班级不存在');
  const now = new Date(nowValue || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('积分周期时间无效');
  const createdAt = now.toISOString();
  const month = now.getUTCMonth() + 1;
  const termName = `${now.getUTCFullYear()}年${month >= 2 && month <= 7 ? '春季' : '秋季'}学期`;
  const row = {
    id: crypto.randomUUID(),
    class_id: classId,
    name: termName,
    starts_at: createdAt,
    ends_at: null,
    status: 'current',
    created_at: createdAt
  };
  db.prepare(`
    INSERT INTO class_score_periods (id, class_id, name, starts_at, ends_at, status, created_at)
    VALUES (@id, @class_id, @name, @starts_at, @ends_at, @status, @created_at)
  `).run(row);
  return mapClassScorePeriod(row);
}

function startClassScorePeriod(classId, input = {}) {
  if (!db.prepare('SELECT id FROM classes WHERE id = ?').get(classId)) throw new Error('班级不存在');
  const name = String(input.name || '').trim().slice(0, 50);
  if (!name) throw new Error('请输入学期名称');
  const startsAtDate = new Date(input.starts_at || input.created_at || Date.now());
  if (Number.isNaN(startsAtDate.getTime())) throw new Error('学期开始时间无效');
  const startsAt = startsAtDate.toISOString();
  const createdAtDate = new Date(input.created_at || startsAt);
  if (Number.isNaN(createdAtDate.getTime())) throw new Error('学期创建时间无效');
  const row = {
    id: input.id || crypto.randomUUID(),
    class_id: classId,
    name,
    starts_at: startsAt,
    ends_at: null,
    status: 'current',
    created_at: createdAtDate.toISOString()
  };
  const run = db.transaction(() => {
    db.prepare(`
      UPDATE class_score_periods
      SET status = 'ended', ends_at = ?
      WHERE class_id = ? AND status = 'current'
    `).run(startsAt, classId);
    db.prepare(`
      INSERT INTO class_score_periods (id, class_id, name, starts_at, ends_at, status, created_at)
      VALUES (@id, @class_id, @name, @starts_at, @ends_at, @status, @created_at)
    `).run(row);
  });
  run();
  return mapClassScorePeriod(db.prepare('SELECT * FROM class_score_periods WHERE id = ?').get(row.id));
}

function listClassScorePeriods(classId) {
  return db.prepare(`
    SELECT * FROM class_score_periods WHERE class_id = ?
    ORDER BY CASE WHEN status = 'current' THEN 0 ELSE 1 END, starts_at DESC
  `).all(classId).map(mapClassScorePeriod);
}

function mapClassScoreEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_operation_id: row.client_operation_id,
    class_id: row.class_id,
    student_id: row.student_id,
    student_name: row.student_name || undefined,
    period_id: row.period_id,
    rule_id: row.rule_id || null,
    rule_name_snapshot: row.rule_name_snapshot,
    delta: Number(row.delta),
    source: row.source,
    actor_user_id: row.actor_user_id || null,
    batch_id: row.batch_id || null,
    reversal_of_id: row.reversal_of_id || null,
    client_created_at: row.client_created_at,
    created_at: row.created_at
  };
}

const insertClassScoreEntryStmt = db.prepare(`
  INSERT INTO class_score_ledger (
    id, client_operation_id, class_id, student_id, period_id, rule_id,
    rule_name_snapshot, delta, source, actor_user_id, batch_id, reversal_of_id,
    client_created_at, created_at
  ) VALUES (
    @id, @client_operation_id, @class_id, @student_id, @period_id, @rule_id,
    @rule_name_snapshot, @delta, @source, @actor_user_id, @batch_id, @reversal_of_id,
    @client_created_at, @created_at
  )
`);

const appendClassScoreEntriesTx = db.transaction((entries) => entries.map(input => {
  const existing = db.prepare('SELECT * FROM class_score_ledger WHERE client_operation_id = ?').get(input.client_operation_id);
  if (existing) return mapClassScoreEntry(existing);
  const student = db.prepare('SELECT id FROM class_students WHERE id = ? AND class_id = ? AND archived = 0').get(input.student_id, input.class_id);
  if (!student) throw new Error('学生不存在或已归档');
  const period = db.prepare('SELECT id FROM class_score_periods WHERE id = ? AND class_id = ?').get(input.period_id, input.class_id);
  if (!period) throw new Error('积分周期不存在');
  if (!Number.isInteger(Number(input.delta)) || Number(input.delta) === 0 || Math.abs(Number(input.delta)) > 100) {
    throw new Error('积分分值无效');
  }
  classroomPoints.normalizeScoreSource(input.source);
  const row = {
    ...input,
    actor_user_id: input.actor_user_id || null,
    batch_id: input.batch_id || null,
    reversal_of_id: input.reversal_of_id || null
  };
  insertClassScoreEntryStmt.run(row);
  return mapClassScoreEntry(row);
}));

function appendClassScoreEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('没有可保存的积分记录');
  return appendClassScoreEntriesTx(entries);
}

function getClassScoreEntry(classId, entryId) {
  return mapClassScoreEntry(db.prepare('SELECT * FROM class_score_ledger WHERE class_id = ? AND id = ?').get(classId, entryId));
}

const reverseClassScoreEntryTx = db.transaction((input) => {
  const retried = db.prepare('SELECT * FROM class_score_ledger WHERE client_operation_id = ?').get(input.client_operation_id);
  if (retried) return mapClassScoreEntry(retried);
  const original = db.prepare('SELECT * FROM class_score_ledger WHERE class_id = ? AND id = ?').get(input.class_id, input.entry_id);
  if (!original) throw new Error('原积分记录不存在');
  if (original.reversal_of_id) throw new Error('撤销记录不能再次撤销');
  if (db.prepare('SELECT id FROM class_score_ledger WHERE reversal_of_id = ?').get(original.id)) {
    throw new Error('该积分记录已经撤销');
  }
  const reversal = classroomPoints.buildReversalEntry(original, input);
  insertClassScoreEntryStmt.run(reversal);
  return mapClassScoreEntry(reversal);
});

function reverseClassScoreEntry(input) {
  return reverseClassScoreEntryTx(input);
}

function classScoreLedgerWhere(filters) {
  const where = ['l.class_id = @class_id'];
  const params = { class_id: filters.class_id };
  if (filters.period_id) {
    where.push('l.period_id = @period_id');
    params.period_id = filters.period_id;
  }
  if (filters.student_id) {
    where.push('l.student_id = @student_id');
    params.student_id = filters.student_id;
  }
  if (filters.source) {
    where.push('l.source = @source');
    params.source = classroomPoints.normalizeScoreSource(filters.source);
  }
  if (filters.direction === 'positive') where.push('l.delta > 0');
  if (filters.direction === 'negative') where.push('l.delta < 0');
  if (filters.from) {
    where.push('l.created_at >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    where.push('l.created_at < @to');
    params.to = filters.to;
  }
  return { where, params };
}

function listClassScoreLedger(filters) {
  const built = classScoreLedgerWhere(filters || {});
  const limit = Math.min(Math.max(Number(filters && filters.limit) || 100, 1), 500);
  return db.prepare(`
    SELECT l.*, s.name AS student_name
    FROM class_score_ledger l
    JOIN class_students s ON s.id = l.student_id
    WHERE ${built.where.join(' AND ')}
    ORDER BY l.created_at DESC, l.rowid DESC
    LIMIT @limit
  `).all({ ...built.params, limit }).map(mapClassScoreEntry);
}

function getClassScoreLeaderboard(filters) {
  const params = { class_id: filters.class_id };
  const join = ['l.class_id = s.class_id', 'l.student_id = s.id'];
  if (filters.period_id) {
    join.push('l.period_id = @period_id');
    params.period_id = filters.period_id;
  }
  if (filters.from) {
    join.push('l.created_at >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    join.push('l.created_at < @to');
    params.to = filters.to;
  }
  return db.prepare(`
    SELECT
      s.id AS student_id,
      s.name AS student_name,
      s.seat_row,
      s.seat_col,
      COALESCE(SUM(l.delta), 0) AS score,
      COUNT(l.id) AS entry_count
    FROM class_students s
    LEFT JOIN class_score_ledger l ON ${join.join(' AND ')}
    WHERE s.class_id = @class_id AND s.archived = 0
    GROUP BY s.id, s.name, s.seat_row, s.seat_col
    ORDER BY score DESC, s.name COLLATE NOCASE
  `).all(params).map(row => ({
    student_id: row.student_id,
    student_name: row.student_name,
    seat_row: row.seat_row === null ? null : Number(row.seat_row),
    seat_col: row.seat_col === null ? null : Number(row.seat_col),
    score: Number(row.score) || 0,
    entry_count: Number(row.entry_count) || 0
  }));
}

const insertNotificationStmt = db.prepare(`
  INSERT INTO notifications (id, class_id, user_id, content, signature, sender_name, student_name, repeat_count, created_at, extra_json)
  VALUES (@id, @class_id, @user_id, @content, @signature, @sender_name, @student_name, @repeat_count, @created_at, @extra_json)
  ON CONFLICT(id) DO UPDATE SET
    class_id = excluded.class_id,
    user_id = excluded.user_id,
    content = excluded.content,
    signature = excluded.signature,
    sender_name = excluded.sender_name,
    student_name = excluded.student_name,
    repeat_count = excluded.repeat_count,
    created_at = excluded.created_at,
    extra_json = excluded.extra_json
`);

function upsertNotification(row) {
  insertNotificationStmt.run({
    id: row.id,
    class_id: row.class_id,
    user_id: row.user_id,
    content: row.content,
    signature: row.signature || '',
    sender_name: row.sender_name || '',
    student_name: row.student_name || '',
    repeat_count: Number(row.repeat_count) || 1,
    created_at: row.created_at || new Date().toISOString(),
    extra_json: jsonString({ broadcast_mode: normalizeBroadcastMode(row.broadcast_mode) })
  });
}

function pruneNotifications(limit) {
  db.prepare(`
    DELETE FROM notifications
    WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT ?)
  `).run(limit);
}

const insertReplyStmt = db.prepare(`
  INSERT INTO replies (class_id, class_name, reply_text, created_at, extra_json)
  VALUES (@class_id, @class_name, @reply_text, @created_at, @extra_json)
`);

function insertReply(row) {
  const result = insertReplyStmt.run({
    class_id: row.class_id,
    class_name: row.class_name || '',
    reply_text: row.reply_text,
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
  row.id = result.lastInsertRowid;
  return row;
}

function pruneReplies(limit) {
  db.prepare(`
    DELETE FROM replies
    WHERE id NOT IN (SELECT id FROM replies ORDER BY id DESC LIMIT ?)
  `).run(limit);
}

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (id, user_id, type, title, body, read_at, created_at, extra_json)
  VALUES (@id, @user_id, @type, @title, @body, @read_at, @created_at, @extra_json)
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    type = excluded.type,
    title = excluded.title,
    body = excluded.body,
    read_at = excluded.read_at,
    created_at = excluded.created_at,
    extra_json = excluded.extra_json
`);

function upsertMessage(row) {
  insertMessageStmt.run({
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    read_at: row.read_at || null,
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
}

function markMessagesRead(userId, ids, readAt) {
  if (ids && ids.length) {
    const stmt = db.prepare('UPDATE messages SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id = ?');
    const tx = db.transaction(() => ids.forEach(id => stmt.run(readAt, userId, id)));
    tx();
    return;
  }
  db.prepare('UPDATE messages SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(readAt, userId);
}

function pruneMessages(limit) {
  db.prepare(`
    DELETE FROM messages
    WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)
  `).run(limit);
}

const insertBulletinStmt = db.prepare(`
  INSERT INTO bulletins (id, class_id, user_id, title, content, sender_name, expires_at, created_at, extra_json)
  VALUES (@id, @class_id, @user_id, @title, @content, @sender_name, @expires_at, @created_at, @extra_json)
  ON CONFLICT(id) DO UPDATE SET
    class_id = excluded.class_id,
    user_id = excluded.user_id,
    title = excluded.title,
    content = excluded.content,
    sender_name = excluded.sender_name,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    extra_json = excluded.extra_json
`);

function upsertBulletin(row) {
  insertBulletinStmt.run({
    id: row.id,
    class_id: row.class_id,
    user_id: row.user_id,
    title: row.title,
    content: row.content,
    sender_name: row.sender_name,
    expires_at: row.expires_at,
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
}

function deleteBulletin(id) {
  db.prepare('DELETE FROM bulletins WHERE id = ?').run(id);
}

function pruneBulletins(limit) {
  db.prepare(`
    DELETE FROM bulletins
    WHERE id NOT IN (SELECT id FROM bulletins ORDER BY id DESC LIMIT ?)
  `).run(limit);
}

const insertPaymentStmt = db.prepare(`
  INSERT INTO payments (
    out_trade_no, user_id, username, plan, plan_days, credits, amount, status, created_at,
    provider_order_no, provider_pay_no, paid_at, plan_expires, error,
    provider_response_json, notify_payload_json, extra_json
  )
  VALUES (
    @out_trade_no, @user_id, @username, @plan, @plan_days, @credits, @amount, @status, @created_at,
    @provider_order_no, @provider_pay_no, @paid_at, @plan_expires, @error,
    @provider_response_json, @notify_payload_json, @extra_json
  )
  ON CONFLICT(out_trade_no) DO UPDATE SET
    user_id = excluded.user_id,
    username = excluded.username,
    plan = excluded.plan,
    plan_days = excluded.plan_days,
    credits = excluded.credits,
    amount = excluded.amount,
    status = excluded.status,
    created_at = excluded.created_at,
    provider_order_no = excluded.provider_order_no,
    provider_pay_no = excluded.provider_pay_no,
    paid_at = excluded.paid_at,
    plan_expires = excluded.plan_expires,
    error = excluded.error,
    provider_response_json = excluded.provider_response_json,
    notify_payload_json = excluded.notify_payload_json,
    extra_json = excluded.extra_json
`);

function upsertPayment(row) {
  const paymentExtra = {};
  if (row.source_product) paymentExtra.source_product = row.source_product;
  insertPaymentStmt.run({
    out_trade_no: row.out_trade_no,
    user_id: row.user_id,
    username: row.username || '',
    plan: row.plan || 'yearly',
    plan_days: Number(row.plan_days) || null,
    credits: Number(row.credits) || 0,
    amount: row.amount || '',
    status: row.status || 'created',
    created_at: row.created_at || new Date().toISOString(),
    provider_order_no: row.provider_order_no || null,
    provider_pay_no: row.provider_pay_no || null,
    paid_at: row.paid_at || null,
    plan_expires: row.plan_expires || null,
    error: row.error || null,
    provider_response_json: jsonString(row.provider_response),
    notify_payload_json: jsonString(row.notify_payload),
    extra_json: Object.keys(paymentExtra).length ? jsonString(paymentExtra) : null
  });
}

const insertPasswordResetRequestStmt = db.prepare(`
  INSERT INTO password_reset_requests (user_id, username, contact_value, status, requested_at, handled_at, extra_json)
  VALUES (@user_id, @username, @contact_value, @status, @requested_at, @handled_at, @extra_json)
`);

function insertPasswordResetRequest(row) {
  const result = insertPasswordResetRequestStmt.run({
    user_id: row.user_id,
    username: row.username || '',
    contact_value: row.contact_value || '',
    status: row.status || 'pending',
    requested_at: row.requested_at || new Date().toISOString(),
    handled_at: row.handled_at || null,
    extra_json: null
  });
  row.id = result.lastInsertRowid;
  return row;
}

function markPasswordResetRequestHandled(id, handledAt) {
  db.prepare('UPDATE password_reset_requests SET status = ?, handled_at = ? WHERE id = ?')
    .run('handled', handledAt || new Date().toISOString(), id);
}

function mapPasswordResetCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    email: row.email || '',
    code_hash: row.code_hash,
    code_salt: row.code_salt,
    token_hash: row.token_hash || '',
    token_salt: row.token_salt || '',
    attempts: Number(row.attempts) || 0,
    expires_at: row.expires_at,
    verified_at: row.verified_at || null,
    used_at: row.used_at || null,
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  };
}

const insertPasswordResetCodeStmt = db.prepare(`
  INSERT INTO password_reset_codes (
    user_id, username, email, code_hash, code_salt, token_hash, token_salt,
    attempts, expires_at, verified_at, used_at, created_at, extra_json
  )
  VALUES (
    @user_id, @username, @email, @code_hash, @code_salt, @token_hash, @token_salt,
    @attempts, @expires_at, @verified_at, @used_at, @created_at, @extra_json
  )
`);

function insertPasswordResetCode(row) {
  const result = insertPasswordResetCodeStmt.run({
    user_id: row.user_id,
    username: row.username || '',
    email: row.email || '',
    code_hash: row.code_hash,
    code_salt: row.code_salt,
    token_hash: row.token_hash || null,
    token_salt: row.token_salt || null,
    attempts: Number(row.attempts) || 0,
    expires_at: row.expires_at,
    verified_at: row.verified_at || null,
    used_at: row.used_at || null,
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
  row.id = result.lastInsertRowid;
  return row;
}

function getRecentPasswordResetCode(userId, sinceIso) {
  return mapPasswordResetCode(db.prepare(`
    SELECT * FROM password_reset_codes
    WHERE user_id = ? AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, sinceIso));
}

function getLatestPasswordResetCode(username, email) {
  return mapPasswordResetCode(db.prepare(`
    SELECT * FROM password_reset_codes
    WHERE username = ? AND email = ? AND used_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(username, email));
}

function incrementPasswordResetCodeAttempts(id) {
  db.prepare('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

function markPasswordResetCodeVerified(id, tokenHash, tokenSalt, verifiedAt) {
  db.prepare(`
    UPDATE password_reset_codes
    SET token_hash = ?, token_salt = ?, verified_at = ?
    WHERE id = ?
  `).run(tokenHash, tokenSalt, verifiedAt || new Date().toISOString(), id);
}

function listVerifiedPasswordResetCodes(username, email) {
  return db.prepare(`
    SELECT * FROM password_reset_codes
    WHERE username = ? AND email = ? AND token_hash IS NOT NULL AND used_at IS NULL
    ORDER BY verified_at DESC, created_at DESC
    LIMIT 5
  `).all(username, email).map(mapPasswordResetCode);
}

function markPasswordResetCodeUsed(id, usedAt) {
  db.prepare('UPDATE password_reset_codes SET used_at = ? WHERE id = ?')
    .run(usedAt || new Date().toISOString(), id);
}

function prunePasswordResetCodes(limit) {
  db.prepare(`
    DELETE FROM password_reset_codes
    WHERE id NOT IN (SELECT id FROM password_reset_codes ORDER BY id DESC LIMIT ?)
  `).run(limit);
}

function mapRegistrationEmailCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    request_ip: row.request_ip,
    code_hash: row.code_hash,
    code_salt: row.code_salt,
    attempts: Number(row.attempts) || 0,
    expires_at: row.expires_at,
    used_at: row.used_at || null,
    created_at: row.created_at
  };
}

const insertRegistrationEmailCodeStmt = db.prepare(`
  INSERT INTO registration_email_codes (
    email, request_ip, code_hash, code_salt, attempts, expires_at, used_at, created_at
  ) VALUES (
    @email, @request_ip, @code_hash, @code_salt, @attempts, @expires_at, @used_at, @created_at
  )
`);

function insertRegistrationEmailCode(row) {
  const result = insertRegistrationEmailCodeStmt.run({
    email: row.email,
    request_ip: row.request_ip,
    code_hash: row.code_hash,
    code_salt: row.code_salt,
    attempts: Number(row.attempts) || 0,
    expires_at: row.expires_at,
    used_at: row.used_at || null,
    created_at: row.created_at || new Date().toISOString()
  });
  row.id = result.lastInsertRowid;
  return row;
}

function getRecentRegistrationEmailCode(email, sinceIso) {
  return mapRegistrationEmailCode(db.prepare(`
    SELECT * FROM registration_email_codes
    WHERE email = ? AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(email, sinceIso));
}

function getLatestRegistrationEmailCode(email) {
  return mapRegistrationEmailCode(db.prepare(`
    SELECT * FROM registration_email_codes
    WHERE email = ? AND used_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(email));
}

function countRegistrationEmailCodesByIp(requestIp, sinceIso) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM registration_email_codes
    WHERE request_ip = ? AND created_at >= ?
  `).get(requestIp, sinceIso).count) || 0;
}

function incrementRegistrationEmailCodeAttempts(id) {
  db.prepare('UPDATE registration_email_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

function markRegistrationEmailCodeUsed(id, usedAt) {
  return db.prepare('UPDATE registration_email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .run(usedAt || new Date().toISOString(), id).changes > 0;
}

function deleteRegistrationEmailCode(id) {
  db.prepare('DELETE FROM registration_email_codes WHERE id = ?').run(id);
}

function pruneRegistrationEmailCodes(limit) {
  db.prepare(`
    DELETE FROM registration_email_codes
    WHERE id NOT IN (SELECT id FROM registration_email_codes ORDER BY id DESC LIMIT ?)
  `).run(limit);
}

const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedback (user_id, username, display_name, category, content, created_at, extra_json)
  VALUES (@user_id, @username, @display_name, @category, @content, @created_at, @extra_json)
`);

function insertFeedback(row) {
  const result = insertFeedbackStmt.run({
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    category: row.category || '功能建议',
    content: row.content,
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
  row.id = result.lastInsertRowid;
  return row;
}

function listFeedback(limit) {
  return db.prepare(`
    SELECT * FROM feedback
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit || 50).map(row => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    category: row.category || '功能建议',
    content: row.content,
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

const upsertFeatureSubscriptionStmt = db.prepare(`
  INSERT INTO feature_subscriptions (user_id, username, display_name, feature_key, feature_name, created_at, extra_json)
  VALUES (@user_id, @username, @display_name, @feature_key, @feature_name, @created_at, @extra_json)
  ON CONFLICT(user_id, feature_key) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name,
    feature_name = excluded.feature_name
`);

function upsertFeatureSubscription(row) {
  upsertFeatureSubscriptionStmt.run({
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    feature_key: row.feature_key,
    feature_name: row.feature_name || '',
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
  const saved = db.prepare('SELECT * FROM feature_subscriptions WHERE user_id = ? AND feature_key = ?')
    .get(row.user_id, row.feature_key);
  return {
    id: saved.id,
    user_id: saved.user_id,
    username: saved.username || '',
    display_name: saved.display_name || '',
    feature_key: saved.feature_key,
    feature_name: saved.feature_name || '',
    created_at: saved.created_at,
    ...safeJsonParse(saved.extra_json, {})
  };
}

function listFeatureSubscriptions(limit) {
  return db.prepare(`
    SELECT * FROM feature_subscriptions
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit || 200).map(row => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    feature_key: row.feature_key,
    feature_name: row.feature_name || '',
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

function listFeatureSubscriptionStats() {
  const rows = db.prepare(`
    SELECT feature_key, feature_name, COUNT(*) AS total, MAX(created_at) AS latest_at
    FROM feature_subscriptions
    GROUP BY feature_key, feature_name
    ORDER BY total DESC, latest_at DESC
  `).all();
  return rows.map(row => ({
    feature_key: row.feature_key,
    feature_name: row.feature_name || '',
    total: Number(row.total) || 0,
    latest_at: row.latest_at || ''
  }));
}

function getCommentCreditBalance(userId) {
  return shixingPoints.getBalance(userId);
}

function listCommentCreditLedger(userId, limit) {
  return shixingPoints.listLedger(userId, limit || 30);
}

function addCommentCreditsForPayment(row) {
  return shixingPoints.addLegacyPayment({ ...row, product: 'comment' }).balance;
}

function adjustCommentCredits(row) {
  try {
    return shixingPoints.adjust({
      ...row,
      delta: (Number(row.delta) || 0) * POINT_COSTS.comment,
      reason: 'admin_adjustment',
      product: 'comment',
      note: row.note || '管理员调整评语额度'
    }).balance;
  } catch (e) {
    if (e.code === 'SHIXING_POINTS_EXHAUSTED') {
      e.code = 'NEGATIVE_COMMENT_BALANCE';
      e.message = '师行积分不能小于 0';
    }
    throw e;
  }
}

function mapCommentGeneration(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    student_name: row.student_name || '',
    school_stage: row.school_stage || '',
    performance: row.performance || '',
    style: row.style || '',
    tags: safeJsonParse(row.tags_json, []),
    min_len: Number(row.min_len) || null,
    max_len: Number(row.max_len) || null,
    comment: row.comment,
    model: row.model || '',
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  };
}

const insertCommentGenerationAndDebitTx = db.transaction((row) => {
  const balance = getCommentCreditBalance(row.user_id);
  if (balance < POINT_COSTS.comment) {
    const err = new Error('COMMENT_CREDITS_EXHAUSTED');
    err.code = 'COMMENT_CREDITS_EXHAUSTED';
    throw err;
  }
  const result = db.prepare(`
    INSERT INTO comment_generations (
      user_id, username, student_name, school_stage, performance, style,
      tags_json, min_len, max_len, comment, model, created_at, extra_json
    )
    VALUES (
      @user_id, @username, @student_name, @school_stage, @performance, @style,
      @tags_json, @min_len, @max_len, @comment, @model, @created_at, @extra_json
    )
  `).run({
    user_id: row.user_id,
    username: row.username || '',
    student_name: row.student_name || '',
    school_stage: row.school_stage || '',
    performance: row.performance || '',
    style: row.style || '',
    tags_json: jsonString(row.tags || []),
    min_len: Number(row.min_len) || null,
    max_len: Number(row.max_len) || null,
    comment: row.comment,
    model: row.model || '',
    created_at: row.created_at || new Date().toISOString(),
    extra_json: jsonString(Object.assign(
      {},
      row.extra_json && typeof row.extra_json === 'object' ? row.extra_json : {},
      { concrete_note: row.concrete_note || '' }
    ))
  });
  const generationId = Number(result.lastInsertRowid);
  const debit = shixingPoints.debit({
    user_id: row.user_id,
    username: row.username || '',
    reason: 'generation',
    product: 'comment',
    generation_id: generationId,
    note: row.student_name || '',
    created_at: row.created_at || new Date().toISOString()
  });
  const referralReward = unifiedReferrals.activateReferral({
    invitee_user_id: row.user_id,
    product: 'comment',
    source_record_id: 'comment:' + generationId,
    device_hash: row.device_hash || '',
    created_at: row.created_at || new Date().toISOString()
  });
  return {
    generation: mapCommentGeneration(db.prepare('SELECT * FROM comment_generations WHERE id = ?').get(generationId)),
    balance: shixingPoints.getBalance(row.user_id),
    referral_reward: referralReward
  };
});

function insertCommentGenerationAndDebit(row) {
  return insertCommentGenerationAndDebitTx(row);
}

function listCommentGenerations(userId, limit) {
  return db.prepare(`
    SELECT * FROM comment_generations
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, limit || 50).map(mapCommentGeneration);
}

function mapCommentRoster(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    name: row.name || '',
    student_count: Number(row.student_count) || 0,
    students: safeJsonParse(row.students_json, []),
    source: row.source || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...safeJsonParse(row.extra_json, {})
  };
}

const upsertCommentRosterStmt = db.prepare(`
  INSERT INTO comment_rosters (
    id, user_id, username, name, student_count, students_json,
    source, created_at, updated_at, extra_json
  )
  VALUES (
    @id, @user_id, @username, @name, @student_count, @students_json,
    @source, @created_at, @updated_at, @extra_json
  )
  ON CONFLICT(id) DO UPDATE SET
    username = excluded.username,
    name = excluded.name,
    student_count = excluded.student_count,
    students_json = excluded.students_json,
    source = excluded.source,
    updated_at = excluded.updated_at,
    extra_json = excluded.extra_json
  WHERE comment_rosters.user_id = excluded.user_id
`);

function upsertCommentRoster(row) {
  const now = new Date().toISOString();
  const result = upsertCommentRosterStmt.run({
    id: row.id || null,
    user_id: row.user_id,
    username: row.username || '',
    name: row.name || '未命名花名册',
    student_count: Number(row.student_count) || 0,
    students_json: jsonString(row.students || []),
    source: row.source || '',
    created_at: row.created_at || now,
    updated_at: row.updated_at || now,
    extra_json: null
  });
  const id = row.id || Number(result.lastInsertRowid);
  return mapCommentRoster(db.prepare('SELECT * FROM comment_rosters WHERE id = ? AND user_id = ?').get(id, row.user_id));
}

function listCommentRosters(userId, limit) {
  return db.prepare(`
    SELECT * FROM comment_rosters
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(userId, limit || 30).map(mapCommentRoster);
}

function getCommentRoster(userId, id) {
  return mapCommentRoster(db.prepare('SELECT * FROM comment_rosters WHERE user_id = ? AND id = ?').get(userId, id));
}

function deleteCommentRoster(userId, id) {
  return db.prepare('DELETE FROM comment_rosters WHERE user_id = ? AND id = ?').run(userId, id).changes;
}

function getCommentAdminStats() {
  const totalGenerations = db.prepare('SELECT COUNT(*) AS n FROM comment_generations').get().n;
  const totalRosters = db.prepare('SELECT COUNT(*) AS n FROM comment_rosters').get().n;
  const consumedCredits = db.prepare("SELECT COALESCE(SUM(-delta), 0) AS n FROM shixing_point_ledger WHERE product = 'comment' AND reason = 'generation'").get().n;
  const purchasedCredits = db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM shixing_point_ledger WHERE reason = 'purchase'").get().n;
  const activeUsers = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM comment_generations').get().n;
  return {
    total_generations: Number(totalGenerations) || 0,
    total_rosters: Number(totalRosters) || 0,
    consumed_credits: Number(consumedCredits) || 0,
    purchased_credits: Number(purchasedCredits) || 0,
    active_comment_users: Number(activeUsers) || 0
  };
}

function listCommentAdminUsage(limit) {
  return db.prepare(`
    SELECT
      u.id AS user_id,
      u.username,
      u.display_name,
      u.contact_value,
      COALESCE(g.total_generations, 0) AS total_generations,
      g.latest_generation_at,
      COALESCE(r.roster_count, 0) AS roster_count,
      COALESCE(l.ledger_sum, 0) AS ledger_sum,
      COALESCE(l.purchased_points, 0) AS purchased_credits
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS total_generations, MAX(created_at) AS latest_generation_at
      FROM comment_generations
      GROUP BY user_id
    ) g ON g.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS roster_count
      FROM comment_rosters
      GROUP BY user_id
    ) r ON r.user_id = u.id
    LEFT JOIN (
      SELECT
        user_id,
        SUM(delta) AS ledger_sum,
        SUM(CASE WHEN reason = 'purchase' THEN delta ELSE 0 END) AS purchased_points
      FROM shixing_point_ledger
      GROUP BY user_id
    ) l ON l.user_id = u.id
    WHERE COALESCE(g.total_generations, 0) > 0
       OR COALESCE(r.roster_count, 0) > 0
       OR COALESCE(l.purchased_points, 0) != 0
    ORDER BY COALESCE(g.latest_generation_at, u.created_at) DESC
    LIMIT ?
  `).all(limit || 100).map(row => ({
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    contact_value: row.contact_value || '',
    total_generations: Number(row.total_generations) || 0,
    latest_generation_at: row.latest_generation_at || '',
    roster_count: Number(row.roster_count) || 0,
    purchased_credits: Number(row.purchased_credits) || 0,
    balance: Number(row.ledger_sum) || 0
  }));
}

// ==================== 作文批改（essay）====================

function getEssayCreditBalance(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS delta_total
    FROM essay_credit_ledger
    WHERE user_id = ?
  `).get(userId);
  return FREE_ESSAY_CREDITS + (Number(row && row.delta_total) || 0);
}

function listEssayCreditLedger(userId, limit) {
  return db.prepare(`
    SELECT * FROM essay_credit_ledger
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, limit || 30).map(row => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    delta: Number(row.delta) || 0,
    reason: row.reason,
    package_key: row.package_key || '',
    out_trade_no: row.out_trade_no || '',
    grading_id: row.grading_id || null,
    card_code: row.card_code || '',
    note: row.note || '',
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  }));
}

const addEssayCreditsForPaymentTx = db.transaction((row) => {
  const existing = db.prepare('SELECT id FROM essay_credit_ledger WHERE out_trade_no = ?').get(row.out_trade_no);
  if (existing) return getEssayCreditBalance(row.user_id);
  db.prepare(`
    INSERT INTO essay_credit_ledger (user_id, username, delta, reason, package_key, out_trade_no, grading_id, card_code, note, created_at, extra_json)
    VALUES (@user_id, @username, @delta, @reason, @package_key, @out_trade_no, @grading_id, @card_code, @note, @created_at, @extra_json)
  `).run({
    user_id: row.user_id,
    username: row.username || '',
    delta: Number(row.credits) || 0,
    reason: 'purchase',
    package_key: row.package_key || '',
    out_trade_no: row.out_trade_no,
    grading_id: null,
    card_code: null,
    note: row.note || '',
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
  return getEssayCreditBalance(row.user_id);
});

function addEssayCreditsForPayment(row) {
  return addEssayCreditsForPaymentTx(row);
}

const adjustEssayCreditsTx = db.transaction((row) => {
  const delta = Number(row.delta) || 0;
  const current = getEssayCreditBalance(row.user_id);
  const next = current + delta;
  if (next < 0) {
    const err = new Error('作文批改次数不能小于 0');
    err.code = 'NEGATIVE_ESSAY_BALANCE';
    err.balance = current;
    throw err;
  }
  db.prepare(`
    INSERT INTO essay_credit_ledger (user_id, username, delta, reason, package_key, out_trade_no, grading_id, card_code, note, created_at, extra_json)
    VALUES (@user_id, @username, @delta, @reason, @package_key, @out_trade_no, @grading_id, @card_code, @note, @created_at, @extra_json)
  `).run({
    user_id: row.user_id,
    username: row.username || '',
    delta,
    reason: 'admin_adjustment',
    package_key: '',
    out_trade_no: null,
    grading_id: null,
    card_code: null,
    note: row.note || '',
    created_at: row.created_at || new Date().toISOString(),
    extra_json: null
  });
  return next;
});

function adjustEssayCredits(row) {
  return adjustEssayCreditsTx(row);
}

function normalizeEssaySubject(value) {
  return String(value || '').toLowerCase() === 'english' ? 'english' : 'chinese';
}

function mapEssayGrading(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    subject: normalizeEssaySubject(row.subject),
    request_id: row.request_id || '',
    student_name: row.student_name || '',
    genre: row.genre || '',
    grade_level: row.grade_level || '',
    score_type: row.score_type || '',
    essay_text: row.essay_text || '',
    result: row.result,
    model: row.model || '',
    created_at: row.created_at,
    ...safeJsonParse(row.extra_json, {})
  };
}

const insertEssayGradingAndDebitTx = db.transaction((row) => {
  const subject = normalizeEssaySubject(row.subject);
  const requestId = String(row.request_id || '').trim().slice(0, 100) || null;
  if (requestId) {
    const existing = db.prepare('SELECT * FROM essay_gradings WHERE user_id=? AND subject=? AND request_id=?').get(row.user_id, subject, requestId);
    if (existing) {
      return {
        grading: mapEssayGrading(existing),
        balance: shixingPoints.getBalance(row.user_id),
        referral_reward: null,
        duplicate: true
      };
    }
  }
  const pointProduct = subject === 'english' ? 'english' : 'essay';
  const pointCost = POINT_COSTS[pointProduct] || POINT_COSTS.essay;
  // skip_debit = 旧会员卡生效期内批改，不扣积分；其余统一扣师行积分。
  if (!row.skip_debit) {
    const balance = shixingPoints.getBalance(row.user_id);
    if (balance < pointCost) {
      const err = new Error('ESSAY_POINTS_EXHAUSTED');
      err.code = 'ESSAY_POINTS_EXHAUSTED';
      err.balance = balance;
      throw err;
    }
  }
  const result = db.prepare(`
    INSERT INTO essay_gradings (
      user_id, username, subject, request_id, student_name, genre, grade_level, score_type,
      essay_text, result, model, created_at, extra_json
    )
    VALUES (
      @user_id, @username, @subject, @request_id, @student_name, @genre, @grade_level, @score_type,
      @essay_text, @result, @model, @created_at, @extra_json
    )
  `).run({
    user_id: row.user_id,
    username: row.username || '',
    subject,
    request_id: requestId,
    student_name: row.student_name || '',
    genre: row.genre || '',
    grade_level: row.grade_level || '',
    score_type: row.score_type || '',
    essay_text: String(row.essay_text || '').slice(0, 8000),
    result: row.result,
    model: row.model || '',
    created_at: row.created_at || new Date().toISOString(),
    extra_json: row.extra_json && typeof row.extra_json === 'object' ? jsonString(row.extra_json) : null
  });
  const gradingId = Number(result.lastInsertRowid);
  if (!row.skip_debit) {
    shixingPoints.debit({
      user_id: row.user_id,
      username: row.username || '',
      reason: 'grading',
      product: pointProduct,
      cost: pointCost,
      generation_id: gradingId,
      note: row.student_name || '',
      created_at: row.created_at || new Date().toISOString()
    });
  }
  const referralReward = unifiedReferrals.activateReferral({
    invitee_user_id: row.user_id,
    product: pointProduct,
    source_record_id: pointProduct + ':' + gradingId,
    device_hash: row.device_hash || '',
    created_at: row.created_at || new Date().toISOString()
  });
  return {
    grading: mapEssayGrading(db.prepare('SELECT * FROM essay_gradings WHERE id = ?').get(gradingId)),
    balance: shixingPoints.getBalance(row.user_id),
    referral_reward: referralReward,
    duplicate: false
  };
});

function insertEssayGradingAndDebit(row) {
  return insertEssayGradingAndDebitTx(row);
}

function listEssayGradings(userId, limit, subject) {
  const normalizedSubject = normalizeEssaySubject(subject);
  return db.prepare(`
    SELECT * FROM essay_gradings
    WHERE user_id = ? AND subject = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, normalizedSubject, limit || 50).map(mapEssayGrading);
}

function getEssayGradingByRequest(userId, subject, requestId) {
  const normalized = String(requestId || '').trim();
  if (!normalized) return null;
  return mapEssayGrading(db.prepare('SELECT * FROM essay_gradings WHERE user_id=? AND subject=? AND request_id=?').get(userId, normalizeEssaySubject(subject), normalized));
}

function essayWorkflowId(prefix) {
  return prefix + '_' + crypto.randomBytes(10).toString('hex');
}

function mapEssayClass(row) {
  if (!row) return null;
  return { ...row, subject: normalizeEssaySubject(row.subject), archived: !!row.archived };
}

function createEssayClass(row) {
  const now = new Date().toISOString();
  const item = {
    id: essayWorkflowId('ecl'), user_id: row.user_id, subject: normalizeEssaySubject(row.subject), name: String(row.name || '').trim().slice(0, 60),
    grade: String(row.grade || '').trim().slice(0, 30), school_year: String(row.school_year || '').trim().slice(0, 30),
    archived: 0, created_at: now, updated_at: now
  };
  db.prepare(`INSERT INTO essay_classes (id,user_id,subject,name,grade,school_year,archived,created_at,updated_at)
    VALUES (@id,@user_id,@subject,@name,@grade,@school_year,@archived,@created_at,@updated_at)`).run(item);
  return mapEssayClass(db.prepare('SELECT * FROM essay_classes WHERE id = ? AND user_id = ?').get(item.id, row.user_id));
}

function listEssayClasses(userId, includeArchived, subject) {
  const sql = 'SELECT * FROM essay_classes WHERE user_id = ? AND subject = ?' + (includeArchived ? '' : ' AND archived = 0') + ' ORDER BY updated_at DESC, name';
  return db.prepare(sql).all(userId, normalizeEssaySubject(subject)).map(mapEssayClass);
}

function updateEssayClass(userId, id, patch) {
  const current = db.prepare('SELECT * FROM essay_classes WHERE id = ? AND user_id = ?').get(id, userId);
  if (!current) return null;
  db.prepare(`UPDATE essay_classes SET name=?, grade=?, school_year=?, archived=?, updated_at=? WHERE id=? AND user_id=?`).run(
    String(patch.name == null ? current.name : patch.name).trim().slice(0, 60),
    String(patch.grade == null ? current.grade : patch.grade).trim().slice(0, 30),
    String(patch.school_year == null ? current.school_year : patch.school_year).trim().slice(0, 30),
    patch.archived == null ? current.archived : (patch.archived ? 1 : 0), new Date().toISOString(), id, userId
  );
  return mapEssayClass(db.prepare('SELECT * FROM essay_classes WHERE id = ? AND user_id = ?').get(id, userId));
}

function mapEssayStudent(row) {
  if (!row) return null;
  return { ...row, subject: normalizeEssaySubject(row.subject), archived: !!row.archived };
}

function createEssayStudent(row) {
  const subject = normalizeEssaySubject(row.subject);
  const ownsClass = db.prepare('SELECT id FROM essay_classes WHERE id = ? AND user_id = ? AND subject = ?').get(row.class_id, row.user_id, subject);
  if (!ownsClass) return null;
  const now = new Date().toISOString();
  const item = { id: essayWorkflowId('est'), user_id: row.user_id, subject, class_id: row.class_id,
    name: String(row.name || '').trim().slice(0, 40), student_no: String(row.student_no || '').trim().slice(0, 40),
    archived: 0, created_at: now, updated_at: now };
  db.prepare(`INSERT INTO essay_students (id,user_id,subject,class_id,name,student_no,archived,created_at,updated_at)
    VALUES (@id,@user_id,@subject,@class_id,@name,@student_no,@archived,@created_at,@updated_at)`).run(item);
  return mapEssayStudent(db.prepare('SELECT * FROM essay_students WHERE id = ? AND user_id = ?').get(item.id, row.user_id));
}

function listEssayStudents(userId, classId, includeArchived, subject) {
  let sql = 'SELECT * FROM essay_students WHERE user_id = ? AND subject = ?';
  const args = [userId, normalizeEssaySubject(subject)];
  if (classId) { sql += ' AND class_id = ?'; args.push(classId); }
  if (!includeArchived) sql += ' AND archived = 0';
  sql += ' ORDER BY name, student_no';
  return db.prepare(sql).all(...args).map(mapEssayStudent);
}

function updateEssayStudent(userId, id, patch) {
  const current = db.prepare('SELECT * FROM essay_students WHERE id = ? AND user_id = ?').get(id, userId);
  if (!current) return null;
  db.prepare('UPDATE essay_students SET name=?, student_no=?, archived=?, updated_at=? WHERE id=? AND user_id=?').run(
    String(patch.name == null ? current.name : patch.name).trim().slice(0, 40),
    String(patch.student_no == null ? current.student_no : patch.student_no).trim().slice(0, 40),
    patch.archived == null ? current.archived : (patch.archived ? 1 : 0), new Date().toISOString(), id, userId
  );
  return mapEssayStudent(db.prepare('SELECT * FROM essay_students WHERE id = ? AND user_id = ?').get(id, userId));
}

function copyEssayClassRoster(userId, sourceClassId, targetName) {
  const source = db.prepare("SELECT * FROM essay_classes WHERE id=? AND user_id=? AND subject='chinese' AND archived=0").get(sourceClassId, userId);
  if (!source) return null;
  const sourceStudents = db.prepare("SELECT * FROM essay_students WHERE user_id=? AND class_id=? AND subject='chinese' AND archived=0 ORDER BY name").all(userId, sourceClassId);
  return db.transaction(() => {
    const target = createEssayClass({
      user_id: userId,
      subject: 'english',
      name: String(targetName || source.name).trim().slice(0, 60),
      grade: source.grade,
      school_year: source.school_year
    });
    sourceStudents.forEach(student => createEssayStudent({
      user_id: userId,
      subject: 'english',
      class_id: target.id,
      name: student.name,
      student_no: student.student_no
    }));
    return { class: target, student_count: sourceStudents.length };
  })();
}

function mapEssayRubric(row) {
  if (!row) return null;
  return { id: row.id, user_id: row.user_id, subject: normalizeEssaySubject(row.subject), name: row.name, dimensions: safeJsonParse(row.dimensions_json, []), created_at: row.created_at, updated_at: row.updated_at };
}

function saveEssayRubric(row) {
  const now = new Date().toISOString();
  const dimensions = (Array.isArray(row.dimensions) ? row.dimensions : []).slice(0, 12).map(d => ({
    name: String(d && d.name || '').trim().slice(0, 20), weight: Math.max(0, Math.min(100, Number(d && d.weight) || 0))
  })).filter(d => d.name);
  const item = { id: row.id || essayWorkflowId('erb'), user_id: row.user_id, subject: normalizeEssaySubject(row.subject), name: String(row.name || '').trim().slice(0, 60), dimensions_json: jsonString(dimensions), created_at: now, updated_at: now };
  db.prepare(`INSERT INTO essay_rubric_templates (id,user_id,subject,name,dimensions_json,created_at,updated_at)
    VALUES (@id,@user_id,@subject,@name,@dimensions_json,@created_at,@updated_at)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, dimensions_json=excluded.dimensions_json, updated_at=excluded.updated_at
    WHERE essay_rubric_templates.user_id=excluded.user_id AND essay_rubric_templates.subject=excluded.subject`).run(item);
  return mapEssayRubric(db.prepare('SELECT * FROM essay_rubric_templates WHERE id=? AND user_id=?').get(item.id, row.user_id));
}

function listEssayRubrics(userId, subject) {
  return db.prepare('SELECT * FROM essay_rubric_templates WHERE user_id=? AND subject=? ORDER BY updated_at DESC').all(userId, normalizeEssaySubject(subject)).map(mapEssayRubric);
}

function mapEssayAssignment(row) {
  if (!row) return null;
  return { ...row, min_words: Number(row.min_words) || 0, max_words: Number(row.max_words) || 0,
    subject: normalizeEssaySubject(row.subject), archived: !!row.archived, rubric: safeJsonParse(row.rubric_json, { dimensions: [] }) };
}

function createEssayAssignment(row) {
  const subject = normalizeEssaySubject(row.subject);
  if (row.class_id && !db.prepare('SELECT id FROM essay_classes WHERE id=? AND user_id=? AND subject=?').get(row.class_id, row.user_id, subject)) return null;
  const rubric = row.rubric_id ? db.prepare('SELECT * FROM essay_rubric_templates WHERE id=? AND user_id=? AND subject=?').get(row.rubric_id, row.user_id, subject) : null;
  const now = new Date().toISOString();
  const item = {
    id: essayWorkflowId('eas'), user_id: row.user_id, subject, class_id: row.class_id || null, rubric_id: rubric ? rubric.id : null,
    title: String(row.title || '').trim().slice(0, 120), material: String(row.material || '').trim().slice(0, 5000),
    requirements: String(row.requirements || '').trim().slice(0, 3000), min_words: Math.max(0, Number(row.min_words) || 0),
    max_words: Math.max(0, Number(row.max_words) || 0), genre: String(row.genre || '记叙文').slice(0, 20),
    grade_level: String(row.grade_level || '初二').slice(0, 20), score_type: String(row.score_type || '满分100分').slice(0, 20),
    rubric_json: jsonString(rubric ? { dimensions: safeJsonParse(rubric.dimensions_json, []) } : { dimensions: Array.isArray(row.dimensions) ? row.dimensions : [] }),
    status: String(row.status || 'active').slice(0, 30), archived: 0, created_at: now, updated_at: now
  };
  db.prepare(`INSERT INTO essay_assignments (id,user_id,subject,class_id,rubric_id,title,material,requirements,min_words,max_words,genre,grade_level,score_type,rubric_json,status,archived,created_at,updated_at)
    VALUES (@id,@user_id,@subject,@class_id,@rubric_id,@title,@material,@requirements,@min_words,@max_words,@genre,@grade_level,@score_type,@rubric_json,@status,@archived,@created_at,@updated_at)`).run(item);
  return mapEssayAssignment(db.prepare('SELECT * FROM essay_assignments WHERE id=? AND user_id=?').get(item.id, row.user_id));
}

function listEssayAssignments(userId, classId, includeArchived, subject) {
  let sql = 'SELECT * FROM essay_assignments WHERE user_id=? AND subject=?'; const args = [userId, normalizeEssaySubject(subject)];
  if (classId) { sql += ' AND class_id=?'; args.push(classId); }
  if (!includeArchived) sql += ' AND archived=0';
  sql += ' ORDER BY updated_at DESC';
  return db.prepare(sql).all(...args).map(mapEssayAssignment);
}

function getEssayAssignment(userId, id, subject) {
  if (subject) return mapEssayAssignment(db.prepare('SELECT * FROM essay_assignments WHERE id=? AND user_id=? AND subject=?').get(id, userId, normalizeEssaySubject(subject)));
  return mapEssayAssignment(db.prepare('SELECT * FROM essay_assignments WHERE id=? AND user_id=?').get(id, userId));
}

function updateEssayAssignment(userId, id, patch) {
  const current = getEssayAssignment(userId, id); if (!current) return null;
  const merged = { ...current, ...patch };
  db.prepare(`UPDATE essay_assignments SET class_id=?,title=?,material=?,requirements=?,min_words=?,max_words=?,genre=?,grade_level=?,score_type=?,rubric_json=?,status=?,archived=?,updated_at=? WHERE id=? AND user_id=?`).run(
    merged.class_id || null, String(merged.title || '').slice(0,120), String(merged.material || '').slice(0,5000), String(merged.requirements || '').slice(0,3000),
    Math.max(0,Number(merged.min_words)||0), Math.max(0,Number(merged.max_words)||0), String(merged.genre||'').slice(0,20), String(merged.grade_level||'').slice(0,20), String(merged.score_type||'').slice(0,20),
    jsonString(merged.rubric || {dimensions:[]}), String(merged.status||'active').slice(0,30), merged.archived ? 1 : 0, new Date().toISOString(), id, userId
  );
  return getEssayAssignment(userId, id);
}

function mapEssaySubmission(row) {
  if (!row) return null;
  return { ...row, subject: normalizeEssaySubject(row.subject), current_version: Number(row.current_version)||1, current_grading_id: row.current_grading_id || null, archived: !!row.archived };
}

function createEssaySubmission(row) {
  const assignment = getEssayAssignment(row.user_id, row.assignment_id); if (!assignment) return null;
  let student = null;
  if (row.student_id) student = db.prepare('SELECT * FROM essay_students WHERE id=? AND user_id=? AND subject=?').get(row.student_id, row.user_id, assignment.subject);
  if (row.student_id && !student) return null;
  if (student && assignment.class_id && student.class_id !== assignment.class_id) return null;
  const now = new Date().toISOString();
  const item = { id: essayWorkflowId('esu'), user_id: row.user_id, subject: assignment.subject, assignment_id: row.assignment_id,
    student_id: student ? student.id : null, student_name: student ? student.name : String(row.student_name||'').trim().slice(0,40),
    status: 'pending', share_token: crypto.randomBytes(24).toString('hex'), current_version: 1, current_grading_id: null,
    returned_at: null, archived: 0, created_at: now, updated_at: now };
  const text = String(row.essay_text || '').trim().slice(0, 8000); if (!text) return null;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO essay_submissions (id,user_id,subject,assignment_id,student_id,student_name,status,share_token,current_version,current_grading_id,returned_at,archived,created_at,updated_at)
      VALUES (@id,@user_id,@subject,@assignment_id,@student_id,@student_name,@status,@share_token,@current_version,@current_grading_id,@returned_at,@archived,@created_at,@updated_at)`).run(item);
    db.prepare('INSERT INTO essay_revisions (id,user_id,submission_id,version_no,essay_text,source,grading_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(essayWorkflowId('erv'), row.user_id, item.id, 1, text, 'teacher', null, now);
  }); tx();
  return mapEssaySubmission(db.prepare('SELECT * FROM essay_submissions WHERE id=? AND user_id=?').get(item.id, row.user_id));
}

function listEssayRevisions(userId, submissionId) {
  return db.prepare('SELECT * FROM essay_revisions WHERE user_id=? AND submission_id=? ORDER BY version_no').all(userId, submissionId).map(r => ({...r, version_no:Number(r.version_no)||1}));
}

function getEssaySubmission(userId, id) {
  const submission = mapEssaySubmission(db.prepare('SELECT * FROM essay_submissions WHERE id=? AND user_id=?').get(id,userId));
  if (!submission) return null;
  const assignment = getEssayAssignment(userId, submission.assignment_id);
  const student = submission.student_id ? mapEssayStudent(db.prepare('SELECT * FROM essay_students WHERE id=? AND user_id=?').get(submission.student_id,userId)) : null;
  const reviewRow = db.prepare('SELECT * FROM essay_reviews WHERE user_id=? AND submission_id=? ORDER BY updated_at DESC LIMIT 1').get(userId,id);
  const review = reviewRow ? {...reviewRow, annotations:safeJsonParse(reviewRow.annotations_json,[])} : null;
  return { submission, assignment, student, revisions:listEssayRevisions(userId,id), review };
}

function getEssaySubmissionByShareToken(token) {
  const row = db.prepare('SELECT * FROM essay_submissions WHERE share_token=? AND archived=0').get(String(token||''));
  if (!row) return null;
  return getEssaySubmission(row.user_id,row.id);
}

function addEssayRevisionByToken(token, essayText) {
  const detail = getEssaySubmissionByShareToken(token); if (!detail) return null;
  if (!detail.review || detail.review.status !== 'finalized') return { error:'老师尚未完成定稿，请稍后再提交修改稿' };
  const text = String(essayText||'').trim().slice(0,8000); if (text.length < 20) return { error:'作文内容过短' };
  const next = detail.submission.current_version + 1; const now = new Date().toISOString();
  const revision = {id:essayWorkflowId('erv'),user_id:detail.submission.user_id,submission_id:detail.submission.id,version_no:next,essay_text:text,source:'student',grading_id:null,created_at:now};
  const tx=db.transaction(()=>{
    db.prepare('INSERT INTO essay_revisions (id,user_id,submission_id,version_no,essay_text,source,grading_id,created_at) VALUES (@id,@user_id,@submission_id,@version_no,@essay_text,@source,@grading_id,@created_at)').run(revision);
    db.prepare("UPDATE essay_submissions SET current_version=?, status='revision_submitted', updated_at=? WHERE id=?").run(next,now,detail.submission.id);
  }); tx(); return revision;
}

function saveEssayReview(row) {
  const detail=getEssaySubmission(row.user_id,row.submission_id); if(!detail) return null;
  const now=new Date().toISOString();
  const existing=db.prepare('SELECT * FROM essay_reviews WHERE user_id=? AND submission_id=? ORDER BY updated_at DESC LIMIT 1').get(row.user_id,row.submission_id);
  const item={id:existing?existing.id:essayWorkflowId('erw'),user_id:row.user_id,submission_id:row.submission_id,grading_id:row.grading_id||detail.submission.current_grading_id||null,
    status:String(row.status||'review'),score_override:String(row.score_override||'').slice(0,20),summary_override:String(row.summary_override||'').slice(0,4000),annotations_json:jsonString(Array.isArray(row.annotations)?row.annotations:[]),
    finalized_at:row.status==='finalized'?(existing&&existing.finalized_at||now):null,created_at:existing?existing.created_at:now,updated_at:now};
  db.prepare(`INSERT INTO essay_reviews (id,user_id,submission_id,grading_id,status,score_override,summary_override,annotations_json,finalized_at,created_at,updated_at)
    VALUES (@id,@user_id,@submission_id,@grading_id,@status,@score_override,@summary_override,@annotations_json,@finalized_at,@created_at,@updated_at)
    ON CONFLICT(id) DO UPDATE SET grading_id=excluded.grading_id,status=excluded.status,score_override=excluded.score_override,summary_override=excluded.summary_override,annotations_json=excluded.annotations_json,finalized_at=excluded.finalized_at,updated_at=excluded.updated_at`).run(item);
  const submissionStatus=row.status==='finalized'?'returned':'review';
  db.prepare('UPDATE essay_submissions SET status=?, returned_at=?, updated_at=? WHERE id=? AND user_id=?').run(submissionStatus,row.status==='finalized'?now:null,now,row.submission_id,row.user_id);
  return {...item,annotations:safeJsonParse(item.annotations_json,[])};
}

function attachEssayGradingToSubmission(userId, submissionId, gradingId, revisionNo) {
  const detail=getEssaySubmission(userId,submissionId); if(!detail) return null; const now=new Date().toISOString();
  db.prepare("UPDATE essay_submissions SET current_grading_id=?, current_version=?, status='review', updated_at=? WHERE id=? AND user_id=?").run(gradingId,revisionNo||detail.submission.current_version,now,submissionId,userId);
  db.prepare('UPDATE essay_revisions SET grading_id=? WHERE submission_id=? AND version_no=? AND user_id=?').run(gradingId,submissionId,revisionNo||detail.submission.current_version,userId);
  return getEssaySubmission(userId,submissionId);
}

function listEssayWorkflowHistory(userId, filters) {
  filters=filters||{};
  const subject=normalizeEssaySubject(filters.subject);
  const workflow=db.prepare(`SELECT s.*, a.title assignment_title, a.class_id, c.name class_name, st.student_no
    FROM essay_submissions s JOIN essay_assignments a ON a.id=s.assignment_id
    LEFT JOIN essay_classes c ON c.id=a.class_id LEFT JOIN essay_students st ON st.id=s.student_id WHERE s.user_id=? AND s.subject=?`).all(userId,subject).map(mapEssaySubmission);
  const linkedIds=new Set(workflow.map(x=>Number(x.current_grading_id)||0));
  const legacy=listEssayGradings(userId,300,subject).filter(g=>!linkedIds.has(Number(g.id))).map(g=>({
    ...g,id:'grading:'+g.id,grading_id:g.id,legacy:true,assignment_id:'',assignment_title:'历史批改',class_id:'',class_name:'未分班',student_id:'',student_no:'',status:g.review_status||'review',updated_at:g.created_at,archived:!!g.archived
  }));
  let items=workflow.concat(legacy).filter(x=>{
    if(!filters.archived&&x.archived)return false;
    if(filters.class_id&&x.class_id!==filters.class_id)return false;
    if(filters.assignment_id&&x.assignment_id!==filters.assignment_id)return false;
    if(filters.student_id&&x.student_id!==filters.student_id)return false;
    if(filters.status&&x.status!==filters.status)return false;
    if(filters.date_from&&String(x.created_at||'')<filters.date_from)return false;
    if(filters.date_to&&String(x.created_at||'')>filters.date_to+'T23:59:59.999Z')return false;
    if(filters.q){const hay=[x.student_name,x.assignment_title,x.student_no].join(' ').toLowerCase();if(!hay.includes(String(filters.q).toLowerCase()))return false;}
    return true;
  }).sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
  const total=items.length,limit=Math.max(1,Math.min(100,Number(filters.limit)||30)),offset=Math.max(0,Number(filters.offset)||0);
  return {items:items.slice(offset,offset+limit),total};
}

function updateEssaySubmission(userId,id,patch){
  const detail=getEssaySubmission(userId,id); if(!detail)return null; const s=detail.submission;
  db.prepare('UPDATE essay_submissions SET status=?,archived=?,updated_at=? WHERE id=? AND user_id=?').run(String(patch.status||s.status).slice(0,30),patch.archived==null?(s.archived?1:0):(patch.archived?1:0),new Date().toISOString(),id,userId);
  return getEssaySubmission(userId,id);
}

function deleteEssaySubmission(userId,id){
  const row=db.prepare('SELECT id FROM essay_submissions WHERE id=? AND user_id=?').get(id,userId);if(!row)return false;
  db.transaction(()=>{db.prepare('DELETE FROM essay_reviews WHERE submission_id=? AND user_id=?').run(id,userId);db.prepare('DELETE FROM essay_revisions WHERE submission_id=? AND user_id=?').run(id,userId);db.prepare('DELETE FROM essay_submissions WHERE id=? AND user_id=?').run(id,userId);})();
  return true;
}

function updateEssayGradingRecord(userId,id,patch){
  const row=db.prepare('SELECT * FROM essay_gradings WHERE id=? AND user_id=?').get(id,userId);if(!row)return null;
  const extra=safeJsonParse(row.extra_json,{});if(patch.archived!=null)extra.archived=!!patch.archived;if(patch.review_status)extra.review_status=String(patch.review_status);
  db.prepare('UPDATE essay_gradings SET extra_json=? WHERE id=? AND user_id=?').run(jsonString(extra),id,userId);
  return mapEssayGrading(db.prepare('SELECT * FROM essay_gradings WHERE id=? AND user_id=?').get(id,userId));
}

function deleteEssayGradingRecord(userId,id){return db.prepare('DELETE FROM essay_gradings WHERE id=? AND user_id=?').run(id,userId).changes>0;}

function getEssayStudentTrend(userId,studentId){
  return db.prepare(`SELECT g.created_at,g.extra_json FROM essay_submissions s JOIN essay_gradings g ON g.id=s.current_grading_id WHERE s.user_id=? AND s.student_id=? ORDER BY g.created_at`).all(userId,studentId).map(r=>{
    const payload=safeJsonParse(r.extra_json,{});const essay=payload.essay||payload.english||{};return {score:Number(essay.total_100)||0,label:String(r.created_at||'').slice(5,10).replace('-','/'),created_at:r.created_at,student_id:studentId};
  }).filter(x=>x.score>0);
}

function getEssayAssignmentReport(userId, assignmentId) {
  const assignment=getEssayAssignment(userId,assignmentId); if(!assignment)return null;
  const rows=db.prepare(`SELECT s.*, g.extra_json, rw.score_override, rw.annotations_json FROM essay_submissions s LEFT JOIN essay_gradings g ON g.id=s.current_grading_id LEFT JOIN essay_reviews rw ON rw.submission_id=s.id AND rw.user_id=s.user_id WHERE s.user_id=? AND s.assignment_id=? AND s.archived=0`).all(userId,assignmentId);
  const scores=[],dimTotals={},issueCounts=new Map(),good=[],bad=[];
  rows.forEach(r=>{const payload=safeJsonParse(r.extra_json,{});const essay=payload.essay||payload.english;if(!essay)return;const teacherScore=parseFloat(String(r.score_override||'').match(/\d+(?:\.\d+)?/)?.[0]||'');const fullScore=Number(essay.full_score)||100;if(Number.isFinite(teacherScore))scores.push(assignment.subject==='english'&&fullScore>0?Math.round(teacherScore/fullScore*100):teacherScore);else if(Number.isFinite(Number(essay.total_100)))scores.push(Number(essay.total_100));
    (essay.dimensions||[]).forEach(d=>{const x=dimTotals[d.name]||(dimTotals[d.name]={sum:0,n:0});x.sum+=Number(d.score)||0;x.n++;});
    const annotations=safeJsonParse(r.annotations_json,null)||essay.annotations||[];(annotations||[]).filter(a=>a.status!=='deleted').forEach(a=>{const comment=String(a.comment||a.explanation_zh||'');const key=String(a.category||comment.replace(/[，。；：！？].*$/,'').slice(0,22));if(key)issueCounts.set(key,(issueCounts.get(key)||0)+1);const quote=String(a.para||a.quote||'');if((a.category==='亮点'||/亮点|生动|具体|精彩/.test(comment))&&quote)good.push(quote);if(a.category!=='亮点'&&quote)bad.push(quote);});});
  const buckets=[{label:'90-100',min:90,max:101},{label:'80-89',min:80,max:90},{label:'70-79',min:70,max:80},{label:'60-69',min:60,max:70},{label:'60以下',min:0,max:60}];
  const dimensions=Object.entries(dimTotals).map(([name,x])=>({name,average:Math.round(x.sum/x.n)})).sort((a,b)=>a.average-b.average);
  return {assignment,submission_count:rows.length,graded_count:scores.length,average_score:scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):0,
    score_distribution:buckets.map(b=>({label:b.label,count:scores.filter(x=>x>=b.min&&x<b.max).length})),dimensions,
    common_issues:[...issueCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([text,count])=>({text,count})),good_sentences:[...new Set(good)].slice(0,6),problem_sentences:[...new Set(bad)].slice(0,6),
    teaching_suggestion:dimensions.length?'建议下一节'+(assignment.subject==='english'?'英语写作':'作文')+'课优先讲解“'+dimensions[0].name+'”，结合共性问题做一次短讲与当堂修改。':'完成批改后，这里会根据全班共性问题生成下一节'+(assignment.subject==='english'?'英语写作':'作文')+'课建议。'};
}

function generateEssayCardCode(credits) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) suffix += alphabet[bytes[i] % alphabet.length];
  return 'ZUOWEN-' + credits + '-' + suffix;
}

const createEssayCardsTx = db.transaction((count, credits, note) => {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO essay_cards (code, credits, batch_note, status, created_at)
    VALUES (?, ?, ?, 'unused', ?)
  `);
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code;
    do {
      code = generateEssayCardCode(credits);
    } while (db.prepare('SELECT code FROM essay_cards WHERE code = ?').get(code));
    insert.run(code, credits, note || '', now);
    codes.push(code);
  }
  return codes;
});

function createEssayCards(count, credits, note) {
  return createEssayCardsTx(count, credits, note);
}

function listEssayCards(status, limit) {
  const rows = status
    ? db.prepare('SELECT * FROM essay_cards WHERE status = ? ORDER BY created_at DESC, code LIMIT ?').all(status, limit || 200)
    : db.prepare('SELECT * FROM essay_cards ORDER BY created_at DESC, code LIMIT ?').all(limit || 200);
  return rows.map(row => ({
    code: row.code,
    credits: Number(row.credits) || 0,
    batch_note: row.batch_note || '',
    status: row.status,
    created_at: row.created_at,
    used_at: row.used_at || '',
    used_by: row.used_by || '',
    used_by_username: row.used_by_username || ''
  }));
}

const redeemEssayCardTx = db.transaction((code, user) => {
  const card = db.prepare('SELECT * FROM essay_cards WHERE code = ?').get(code);
  if (!card) {
    const err = new Error('卡密不存在，请检查输入是否正确');
    err.code = 'CARD_NOT_FOUND';
    throw err;
  }
  if (card.status !== 'unused') {
    const err = new Error('该卡密已被使用');
    err.code = 'CARD_USED';
    throw err;
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE essay_cards
    SET status = 'used', used_at = ?, used_by = ?, used_by_username = ?
    WHERE code = ? AND status = 'unused'
  `).run(now, user.id, user.username || '', code);
  db.prepare(`
    INSERT INTO essay_credit_ledger (user_id, username, delta, reason, package_key, out_trade_no, grading_id, card_code, note, created_at, extra_json)
    VALUES (@user_id, @username, @delta, @reason, @package_key, @out_trade_no, @grading_id, @card_code, @note, @created_at, @extra_json)
  `).run({
    user_id: user.id,
    username: user.username || '',
    delta: Number(card.credits) || 0,
    reason: 'card',
    package_key: null,
    out_trade_no: null,
    grading_id: null,
    card_code: code,
    note: '卡密兑换 ' + card.credits + ' 次',
    created_at: now,
    extra_json: null
  });
  return {
    credits: Number(card.credits) || 0,
    balance: getEssayCreditBalance(user.id)
  };
});

function redeemEssayCard(code, user) {
  return redeemEssayCardTx(code, user);
}

// ---- 会员卡（时间卡）----
function getActiveEssayPlan(userId) {
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT * FROM essay_time_plans
    WHERE user_id = ? AND expires_at > ?
    ORDER BY expires_at DESC
    LIMIT 1
  `).get(userId, now);
  if (!row) return null;
  return {
    plan_key: row.plan_key,
    plan_label: row.plan_label || '',
    daily_limit: Number(row.daily_limit) || 0,
    expires_at: row.expires_at
  };
}

const addEssayPlanForPaymentTx = db.transaction((row) => {
  const existing = db.prepare('SELECT id FROM essay_time_plans WHERE out_trade_no = ?').get(row.out_trade_no);
  if (existing) return getActiveEssayPlan(row.user_id);
  const now = new Date();
  // 已有未到期会员则从其到期日顺延
  const current = getActiveEssayPlan(row.user_id);
  const base = current && new Date(current.expires_at) > now ? new Date(current.expires_at) : now;
  const expires = new Date(base.getTime() + Number(row.days) * 86400000);
  db.prepare(`
    INSERT INTO essay_time_plans (user_id, plan_key, plan_label, days, daily_limit, starts_at, expires_at, out_trade_no, created_at)
    VALUES (@user_id, @plan_key, @plan_label, @days, @daily_limit, @starts_at, @expires_at, @out_trade_no, @created_at)
  `).run({
    user_id: row.user_id,
    plan_key: row.plan_key,
    plan_label: row.plan_label || '',
    days: Number(row.days) || 0,
    daily_limit: Number(row.daily_limit) || 60,
    starts_at: base.toISOString(),
    expires_at: expires.toISOString(),
    out_trade_no: row.out_trade_no,
    created_at: now.toISOString()
  });
  return getActiveEssayPlan(row.user_id);
});

function addEssayPlanForPayment(row) {
  return addEssayPlanForPaymentTx(row);
}

function countEssayGradings(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM essay_gradings WHERE user_id = ?').get(userId).n;
}

function countEssayGradingsToday(userId) {
  const dayStart = new Date().toISOString().slice(0, 10);
  return db.prepare('SELECT COUNT(*) AS n FROM essay_gradings WHERE user_id = ? AND created_at >= ?').get(userId, dayStart).n;
}

// ---- 邀请裂变 ----
function bindEssayReferral(inviteeUserId, inviteeUsername, inviterUserId) {
  const existing = db.prepare('SELECT invitee_user_id FROM essay_referrals WHERE invitee_user_id = ?').get(inviteeUserId);
  if (existing) return false;
  db.prepare(`
    INSERT INTO essay_referrals (invitee_user_id, inviter_user_id, invitee_username, created_at)
    VALUES (?, ?, ?, ?)
  `).run(inviteeUserId, inviterUserId, inviteeUsername || '', new Date().toISOString());
  return true;
}

function getEssayReferral(inviteeUserId) {
  return db.prepare('SELECT * FROM essay_referrals WHERE invitee_user_id = ?').get(inviteeUserId) || null;
}

function listEssayReferralsByInviter(inviterUserId, limit) {
  return db.prepare(`
    SELECT * FROM essay_referrals
    WHERE inviter_user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(inviterUserId, limit || 100).map(row => ({
    invitee_username: row.invitee_username || '',
    created_at: row.created_at,
    grading_rewarded: !!row.grading_rewarded_at,
    purchase_rewarded: !!row.purchase_rewarded_at
  }));
}

// 通用：给邀请人发奖励并标记，已标记则返回 null（防重复）
const rewardEssayReferralTx = db.transaction((inviteeUserId, rewardField, credits, note) => {
  const row = db.prepare('SELECT * FROM essay_referrals WHERE invitee_user_id = ?').get(inviteeUserId);
  if (!row || row[rewardField]) return null;
  const now = new Date().toISOString();
  db.prepare('UPDATE essay_referrals SET ' + rewardField + ' = ? WHERE invitee_user_id = ?').run(now, inviteeUserId);
  const points = Math.max(0, Number(credits) || 0) * POINT_COSTS.essay;
  const adjusted = shixingPoints.adjust({
    user_id: row.inviter_user_id,
    username: '',
    delta: points,
    reason: 'referral',
    product: 'essay',
    note: note,
    created_at: now
  });
  return {
    inviter_user_id: row.inviter_user_id,
    invitee_username: row.invitee_username || '',
    points,
    balance: adjusted.balance
  };
});

function rewardEssayReferralGrading(inviteeUserId, credits) {
  return rewardEssayReferralTx(inviteeUserId, 'grading_rewarded_at', credits, '邀请好友完成批改奖励');
}

function rewardEssayReferralPurchase(inviteeUserId, credits) {
  return rewardEssayReferralTx(inviteeUserId, 'purchase_rewarded_at', credits, '邀请好友首次付费奖励');
}

// ---- 通用邀请（广播/评语共用，product 区分）----
function bindAppReferral(product, inviteeUserId, inviteeUsername, inviterUserId) {
  const existing = db.prepare('SELECT invitee_user_id FROM app_referrals WHERE product = ? AND invitee_user_id = ?').get(product, inviteeUserId);
  if (existing) return false;
  db.prepare(`
    INSERT INTO app_referrals (product, invitee_user_id, inviter_user_id, invitee_username, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(product, inviteeUserId, inviterUserId, inviteeUsername || '', new Date().toISOString());
  return true;
}

function getAppReferral(product, inviteeUserId) {
  return db.prepare('SELECT * FROM app_referrals WHERE product = ? AND invitee_user_id = ?').get(product, inviteeUserId) || null;
}

function listAppReferralsByInviter(product, inviterUserId, limit) {
  return db.prepare(`
    SELECT * FROM app_referrals
    WHERE product = ? AND inviter_user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(product, inviterUserId, limit || 100).map(row => ({
    invitee_username: row.invitee_username || '',
    created_at: row.created_at,
    usage_rewarded: !!row.usage_rewarded_at,
    purchase_rewarded: !!row.purchase_rewarded_at
  }));
}

// 原子认领奖励标记：成功返回行（含 inviter），已领过返回 null。奖励发放由调用方完成。
function claimAppReferralReward(product, inviteeUserId, rewardField) {
  if (rewardField !== 'usage_rewarded_at' && rewardField !== 'purchase_rewarded_at') return null;
  const row = db.prepare('SELECT * FROM app_referrals WHERE product = ? AND invitee_user_id = ?').get(product, inviteeUserId);
  if (!row || row[rewardField]) return null;
  const result = db.prepare(
    'UPDATE app_referrals SET ' + rewardField + ' = ? WHERE product = ? AND invitee_user_id = ? AND ' + rewardField + ' IS NULL'
  ).run(new Date().toISOString(), product, inviteeUserId);
  if (!result.changes) return null;
  return {
    inviter_user_id: row.inviter_user_id,
    invitee_username: row.invitee_username || ''
  };
}

// 未付费邀请人的"使用类奖励"已领笔数（封顶用）
function countAppReferralUsageRewards(product, inviterUserId) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM app_referrals WHERE product = ? AND inviter_user_id = ? AND usage_rewarded_at IS NOT NULL'
  ).get(product, inviterUserId).n;
}

function countCommentGenerations(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM comment_generations WHERE user_id = ?').get(userId).n;
}

function hasCommentPurchase(userId) {
  return shixingPoints.hasPaidTopup(userId);
}

function addCommentReferralCredits(userId, username, credits, note) {
  return shixingPoints.adjust({
    user_id: userId,
    username: username || '',
    delta: (Number(credits) || 0) * POINT_COSTS.comment,
    reason: 'referral',
    product: 'comment',
    note: note || '邀请奖励',
    created_at: new Date().toISOString()
  }).balance;
}

// ---- 仪表盘统计 ----
const DAILY_COUNT_TABLES = {
  essay_gradings: 'essay_gradings',
  comment_generations: 'comment_generations',
  learning_usage: 'learning_usage'
};

// 最近 N 天每日条数：[{date:'2026-06-01', n:3}, ...]，缺的日期补 0
function dailyCounts(tableKey, days) {
  const table = DAILY_COUNT_TABLES[tableKey];
  if (!table) return [];
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM ${table} WHERE created_at >= ? GROUP BY d`
  ).all(since);
  const map = {};
  rows.forEach(r => { map[r.d] = r.n; });
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, n: map[d] || 0 });
  }
  return out;
}

function countRowsSince(tableKey, sinceIso) {
  const table = DAILY_COUNT_TABLES[tableKey];
  if (!table) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at >= ?`).get(sinceIso).n;
}

function getEssayActivePlanUserCount() {
  return db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM essay_time_plans WHERE expires_at > ?')
    .get(new Date().toISOString()).n;
}

function getAppReferralStats(product) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN usage_rewarded_at IS NOT NULL THEN 1 ELSE 0 END) AS usage_rewarded,
           SUM(CASE WHEN purchase_rewarded_at IS NOT NULL THEN 1 ELSE 0 END) AS purchase_rewarded
    FROM app_referrals WHERE product = ?
  `).get(product);
  return {
    total: Number(row.total) || 0,
    usage_rewarded: Number(row.usage_rewarded) || 0,
    purchase_rewarded: Number(row.purchase_rewarded) || 0
  };
}

function getEssayReferralStats() {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN grading_rewarded_at IS NOT NULL THEN 1 ELSE 0 END) AS usage_rewarded,
           SUM(CASE WHEN purchase_rewarded_at IS NOT NULL THEN 1 ELSE 0 END) AS purchase_rewarded
    FROM essay_referrals
  `).get();
  return {
    total: Number(row.total) || 0,
    usage_rewarded: Number(row.usage_rewarded) || 0,
    purchase_rewarded: Number(row.purchase_rewarded) || 0
  };
}

function getEssayAdminStats() {
  const today = new Date().toISOString().slice(0, 10);
  const totalGradings = db.prepare("SELECT COUNT(*) AS n FROM essay_gradings WHERE subject='chinese'").get().n;
  const todayGradings = db.prepare("SELECT COUNT(*) AS n FROM essay_gradings WHERE subject='chinese' AND created_at>=?").get(today).n;
  const consumedCredits = db.prepare("SELECT COALESCE(SUM(-delta), 0) AS n FROM essay_credit_ledger WHERE reason = 'grading'").get().n;
  const purchasedCredits = db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM essay_credit_ledger WHERE reason = 'purchase'").get().n;
  const cardCredits = db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM essay_credit_ledger WHERE reason = 'card'").get().n;
  const activeUsers = db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM essay_gradings WHERE subject='chinese'").get().n;
  const unusedCards = db.prepare("SELECT COUNT(*) AS n FROM essay_cards WHERE status = 'unused'").get().n;
  const usedCards = db.prepare("SELECT COUNT(*) AS n FROM essay_cards WHERE status = 'used'").get().n;
  return {
    total_gradings: Number(totalGradings) || 0,
    gradings_today: Number(todayGradings) || 0,
    consumed_credits: Number(consumedCredits) || 0,
    purchased_credits: Number(purchasedCredits) || 0,
    card_credits: Number(cardCredits) || 0,
    active_essay_users: Number(activeUsers) || 0,
    unused_cards: Number(unusedCards) || 0,
    used_cards: Number(usedCards) || 0
  };
}

function getEnglishAdminStats() {
  const today = new Date().toISOString().slice(0, 10);
  const total = db.prepare("SELECT COUNT(*) AS n FROM essay_gradings WHERE subject='english'").get().n;
  const users = db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM essay_gradings WHERE subject='english'").get().n;
  const todayCount = db.prepare("SELECT COUNT(*) AS n FROM essay_gradings WHERE subject='english' AND created_at>=?").get(today).n;
  const consumed = db.prepare("SELECT COALESCE(SUM(-delta),0) AS n FROM shixing_point_ledger WHERE product='english' AND delta<0").get().n;
  const classes = db.prepare("SELECT COUNT(*) AS n FROM essay_classes WHERE subject='english' AND archived=0").get().n;
  const assignments = db.prepare("SELECT COUNT(*) AS n FROM essay_assignments WHERE subject='english' AND archived=0").get().n;
  return {
    total_gradings: Number(total) || 0,
    active_users: Number(users) || 0,
    gradings_today: Number(todayCount) || 0,
    consumed_points: Number(consumed) || 0,
    classes: Number(classes) || 0,
    assignments: Number(assignments) || 0
  };
}

function listEssayAdminUsage(limit) {
  return db.prepare(`
    SELECT
      u.id AS user_id,
      u.username,
      u.display_name,
      u.contact_value,
      COALESCE(g.total_gradings, 0) AS total_gradings,
      g.latest_grading_at,
      COALESCE(l.ledger_sum, 0) AS ledger_sum,
      COALESCE(l.purchased_credits, 0) AS purchased_credits
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS total_gradings, MAX(created_at) AS latest_grading_at
      FROM essay_gradings
      GROUP BY user_id
    ) g ON g.user_id = u.id
    LEFT JOIN (
      SELECT
        user_id,
        SUM(delta) AS ledger_sum,
        SUM(CASE WHEN reason = 'purchase' THEN delta ELSE 0 END) AS purchased_credits
      FROM essay_credit_ledger
      GROUP BY user_id
    ) l ON l.user_id = u.id
    WHERE COALESCE(g.total_gradings, 0) > 0
       OR COALESCE(l.ledger_sum, 0) != 0
    ORDER BY COALESCE(g.latest_grading_at, u.created_at) DESC
    LIMIT ?
  `).all(limit || 100).map(row => ({
    user_id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || '',
    contact_value: row.contact_value || '',
    total_gradings: Number(row.total_gradings) || 0,
    latest_grading_at: row.latest_grading_at || '',
    purchased_credits: Number(row.purchased_credits) || 0,
    balance: FREE_ESSAY_CREDITS + (Number(row.ledger_sum) || 0)
  }));
}

function getLearningMembership(userId) {
  return db.prepare('SELECT * FROM learning_memberships WHERE user_id = ?').get(userId) || null;
}

function getLearningMembershipStatus(user, now = new Date()) {
  const membership = getLearningMembership(user.id);
  const paid = getMembershipStatus(membership, now);
  if (paid.active) return { ...paid, source: 'membership', planLabel: membership.plan_label || '学习会员' };
  const trialEnd = new Date(new Date(user.created_at).getTime() + 7 * 24 * 60 * 60 * 1000);
  if (trialEnd > now) return { active: true, expiresAt: trialEnd.toISOString(), source: 'trial', planLabel: '7天体验' };
  return { active: false, expiresAt: paid.expiresAt, source: null, planLabel: '' };
}

function renewLearningMembership({ user_id, username, days, plan_key, plan_label, note, now = new Date() }) {
  const current = getLearningMembership(user_id);
  const expiresAt = addMembershipDays(current && current.expires_at, days, now);
  db.prepare(`
    INSERT INTO learning_memberships (user_id, username, plan_key, plan_label, expires_at, updated_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username, plan_key = excluded.plan_key, plan_label = excluded.plan_label,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at, note = excluded.note
  `).run(user_id, username || '', plan_key || 'manual', plan_label || '学习会员', expiresAt, now.toISOString(), note || '');
  return getLearningMembership(user_id);
}

function countLearningUsageToday(userId, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return Number(db.prepare('SELECT COUNT(*) AS n FROM learning_usage WHERE user_id = ? AND created_at >= ?').get(userId, start).n) || 0;
}

function insertLearningUsage(userId, toolKey, createdAt = new Date().toISOString()) {
  db.prepare('INSERT INTO learning_usage (user_id, tool_key, created_at) VALUES (?, ?, ?)').run(userId, toolKey, createdAt);
}

// ----- 金句本（收藏） -----
function listLearningSaved(userId, type) {
  if (type && type !== 'all') {
    return db.prepare('SELECT id, type, title, content, created_at FROM learning_saved WHERE user_id = ? AND type = ? ORDER BY id DESC').all(userId, type);
  }
  return db.prepare('SELECT id, type, title, content, created_at FROM learning_saved WHERE user_id = ? ORDER BY id DESC').all(userId);
}

function addLearningSaved(userId, { type, title, content }, createdAt = new Date().toISOString()) {
  const text = String(content || '').trim();
  if (!text) return null;
  const exist = db.prepare('SELECT * FROM learning_saved WHERE user_id = ? AND content = ?').get(userId, text);
  if (exist) return exist;
  const info = db.prepare('INSERT INTO learning_saved (user_id, type, title, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, String(type || 'note'), String(title || '').slice(0, 120), text, createdAt);
  return db.prepare('SELECT * FROM learning_saved WHERE id = ?').get(info.lastInsertRowid);
}

function deleteLearningSaved(userId, id) {
  return db.prepare('DELETE FROM learning_saved WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

function countLearningSaved(userId) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM learning_saved WHERE user_id = ?').get(userId).n) || 0;
}

// ----- 生成历史 -----
function insertLearningHistory(userId, { tool_key, title, input, result }, createdAt = new Date().toISOString()) {
  db.prepare('INSERT INTO learning_history (user_id, tool_key, title, input, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, String(tool_key || ''), String(title || '').slice(0, 120), String(input || '').slice(0, 4000), String(result || ''), createdAt);
  // 每位用户最多保留最近 100 条
  db.prepare(`DELETE FROM learning_history WHERE user_id = ? AND id NOT IN (
    SELECT id FROM learning_history WHERE user_id = ? ORDER BY id DESC LIMIT 100
  )`).run(userId, userId);
}

function listLearningHistory(userId, limit = 50) {
  return db.prepare('SELECT id, tool_key, title, input, result, created_at FROM learning_history WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(Number(limit) || 50, 100));
}

function countLearningHistory(userId) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM learning_history WHERE user_id = ?').get(userId).n) || 0;
}

// ----- 打卡 -----
function learningDayString(now = new Date()) {
  // 以东八区日期为准
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shanghai.toISOString().slice(0, 10);
}

function recordLearningCheckin(userId, now = new Date()) {
  const day = learningDayString(now);
  const info = db.prepare('INSERT OR IGNORE INTO learning_checkins (user_id, day, created_at) VALUES (?, ?, ?)')
    .run(userId, day, now.toISOString());
  return info.changes > 0; // true=今天首次打卡
}

function hasCheckedInToday(userId, now = new Date()) {
  const day = learningDayString(now);
  return !!db.prepare('SELECT 1 FROM learning_checkins WHERE user_id = ? AND day = ?').get(userId, day);
}

function countLearningCheckins(userId) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM learning_checkins WHERE user_id = ?').get(userId).n) || 0;
}

function learningCheckinStreak(userId, now = new Date()) {
  const rows = db.prepare('SELECT day FROM learning_checkins WHERE user_id = ? ORDER BY day DESC LIMIT 90').all(userId);
  const days = new Set(rows.map(r => r.day));
  if (!days.size) return 0;
  let streak = 0;
  let cursor = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  // 若今天还没打卡，从昨天开始算连续
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// ----- 后台统计 -----
function getLearningAdminStats(now = new Date()) {
  const totalUsage = db.prepare('SELECT COUNT(*) AS n FROM learning_usage').get().n;
  const activeUsers = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM learning_usage').get().n;
  const savedTotal = db.prepare('SELECT COUNT(*) AS n FROM learning_saved').get().n;
  const checkinToday = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM learning_checkins WHERE day = ?').get(learningDayString(now)).n;
  const activeMembers = db.prepare('SELECT COUNT(*) AS n FROM learning_memberships WHERE expires_at > ?').get(now.toISOString()).n;
  return {
    total_usage: Number(totalUsage) || 0,
    active_users: Number(activeUsers) || 0,
    saved_total: Number(savedTotal) || 0,
    checkin_today: Number(checkinToday) || 0,
    active_members: Number(activeMembers) || 0
  };
}

// ----- 成长体系（由真实数据计算，幂等可靠） -----
const LEARNING_LEVEL_TITLES = ['书童', '秀才', '举人', '进士', '探花', '榜眼', '状元', '翰林', '大学士', '文豪', '文宗', '文圣'];

function learningTodayToolSet(userId, now = new Date()) {
  const start = new Date(learningDayString(now) + 'T00:00:00+08:00').toISOString();
  const rows = db.prepare('SELECT DISTINCT tool_key FROM learning_usage WHERE user_id = ? AND created_at >= ?').all(userId, start);
  return new Set(rows.map(r => r.tool_key));
}

function getLearningGrowth(user, now = new Date()) {
  const userId = user.id;
  const saves = countLearningSaved(userId);
  const generations = countLearningHistory(userId);
  const checkinDays = countLearningCheckins(userId);
  const streak = learningCheckinStreak(userId, now);
  const exp = checkinDays * 50 + generations * 10 + saves * 10;
  const checkedInToday = hasCheckedInToday(userId, now);
  const todayTools = learningTodayToolSet(userId, now);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const weekSaves = Number(db.prepare('SELECT COUNT(*) AS n FROM learning_saved WHERE user_id = ? AND created_at >= ?').get(userId, weekAgo).n) || 0;
  const weekGen = Number(db.prepare("SELECT COUNT(*) AS n FROM learning_usage WHERE user_id = ? AND created_at >= ? AND tool_key != 'ocr'").get(userId, weekAgo).n) || 0;
  const dailyTasks = [
    { id: 't1', name: '每日打卡', exp: 50, link: 'checkin', done: checkedInToday },
    { id: 't2', name: '用“名师思路”构思一次', exp: 10, link: 'guide', done: todayTools.has('guide') },
    { id: 't3', name: '做一次“作文诊断”', exp: 10, link: 'review', done: todayTools.has('review') || todayTools.has('polish') },
    { id: 't4', name: '练一次“微写作”', exp: 10, link: 'practice', done: todayTools.has('practice') }
  ];
  const weeklyTasks = [
    { id: 'w1', name: '本周收藏 5 条金句', target: 5, progress: Math.min(weekSaves, 5), done: weekSaves >= 5 },
    { id: 'w2', name: '本周生成 8 次', target: 8, progress: Math.min(weekGen, 8), done: weekGen >= 8 }
  ];

  // 升到第 L 级累计所需经验 = 100 * (L-1) * L / 2
  let level = 1;
  while (100 * level * (level + 1) / 2 <= exp) level++;
  const levelBase = 100 * (level - 1) * level / 2;     // 当前等级起点
  const levelSpan = 100 * level;                        // 升下一级所需跨度
  const currentExp = exp - levelBase;

  const achievements = [
    { id: 'a1', name: '初出茅庐', desc: '完成首次创作', icon: 'fa-solid fa-egg', unlocked: generations >= 1 || saves >= 1 || checkinDays >= 1 },
    { id: 'a2', name: '笔耕不辍', desc: '连续打卡 3 天', icon: 'fa-solid fa-fire', unlocked: streak >= 3 },
    { id: 'a3', name: '素材达人', desc: '收藏 10 条金句', icon: 'fa-solid fa-box-open', unlocked: saves >= 10 },
    { id: 'a4', name: '文思泉涌', desc: '累计生成 5 次', icon: 'fa-solid fa-feather-pointed', unlocked: generations >= 5 },
    { id: 'a5', name: '持之以恒', desc: '累计打卡 7 天', icon: 'fa-solid fa-calendar-check', unlocked: checkinDays >= 7 },
    { id: 'a6', name: '著作等身', desc: '累计生成 20 次', icon: 'fa-solid fa-book', unlocked: generations >= 20 }
  ];

  return {
    level,
    title: LEARNING_LEVEL_TITLES[level - 1] || '文圣',
    exp,
    currentExp,
    levelSpan,
    stats: { saves, generations, checkinDays, streak },
    checkedInToday,
    achievements,
    dailyTasks,
    weeklyTasks
  };
}

const replaceStoreTx = db.transaction((data) => {
  const store = ensureStoreShape(data);
  db.prepare('DELETE FROM password_reset_codes').run();
  db.prepare('DELETE FROM password_reset_requests').run();
  db.prepare('DELETE FROM feature_subscriptions').run();
  db.prepare('DELETE FROM feedback').run();
  db.prepare('DELETE FROM class_members').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM bulletins').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM replies').run();
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM classes').run();
  db.prepare('DELETE FROM users').run();

  store.users.forEach(upsertUser);
  store.classes.forEach(upsertClass);
  store.notifications.forEach(upsertNotification);
  store.replies.forEach(insertReply);
  store.messages.forEach(upsertMessage);
  store.bulletins.forEach(upsertBulletin);
  store.payments.forEach(upsertPayment);
  store.feedback.forEach(insertFeedback);
  store.feature_subscriptions.forEach(upsertFeatureSubscription);
  store.password_reset_requests.forEach(insertPasswordResetRequest);
  setCounter('nextNotifId', store.nextNotifId);
  setCounter('nextMessageId', store.nextMessageId);
  setCounter('nextBulletinId', store.nextBulletinId);
});

function replaceStore(data) {
  replaceStoreTx(data);
}

function initialize() {
  ensureSchema();
  if (isDatabaseEmpty() && !getMeta('migrated_from_json_at') && fs.existsSync(LEGACY_JSON_FILE)) {
    const legacy = ensureStoreShape(readLegacyJson());
    const backupPath = backupLegacyJson('before-sqlite');
    replaceStore(legacy);
    setMeta('legacy_json_backup', backupPath);
    setMeta('migrated_from_json_at', new Date().toISOString());
    console.log('[DB] 已从 data.json 迁移到 SQLite，旧文件备份：' + backupPath);
  }
}

initialize();
shixingPoints = createShixingPoints(db);
unifiedReferrals = createUnifiedReferrals(db, shixingPoints);

const registerUserWithReferralTx = db.transaction((user, referral) => {
  upsertUser(user);
  if (!referral || !referral.inviter_user_id) return { bound: false };
  const result = unifiedReferrals.bindReferral({
    invitee_user_id: user.id,
    inviter_user_id: referral.inviter_user_id,
    invite_code: referral.invite_code || '',
    source_product: referral.source_product || 'shixing',
    device_hash: referral.device_hash || null,
    bound_at: user.created_at
  });
  return { bound: !!result.created, referral: result.referral };
});

function registerUserWithReferral(user, referral) {
  return registerUserWithReferralTx(user, referral || null);
}

function findUnifiedInviterByCode(code) {
  return unifiedReferrals.findInviterByCode(code);
}

function getUnifiedReferralByInvitee(userId) {
  return unifiedReferrals.getReferralByInvitee(userId);
}

function bindUnifiedReferral(row) {
  return unifiedReferrals.bindReferral(row);
}

function activateUnifiedReferral(row) {
  return unifiedReferrals.activateReferral(row);
}

function rewardUnifiedFirstPurchase(row) {
  return unifiedReferrals.rewardFirstPurchase(row);
}

function reverseUnifiedFirstPurchaseReward(row) {
  return unifiedReferrals.reverseFirstPurchaseReward(row);
}

function getUnifiedReferralCenter(userId) {
  return unifiedReferrals.getReferralCenter(userId);
}

function getUnifiedReferralAdminStats() {
  return unifiedReferrals.getAdminStats();
}

function recordUnifiedReferralClick(row) {
  return unifiedReferrals.recordClick(row);
}

function listUnifiedReferralPending(limit) {
  return unifiedReferrals.listPendingEvents(limit);
}

function reviewUnifiedReferralEvent(row) {
  return unifiedReferrals.reviewEvent(row);
}

function migrateUnifiedReferrals(options) {
  return unifiedReferrals.migrateLegacyReferrals(options);
}

function getShixingPointBalance(userId) {
  return shixingPoints.getBalance(userId);
}

function listShixingPointLedger(userId, limit) {
  return shixingPoints.listLedger(userId, limit);
}

function addShixingPointsForPayment(row) {
  return shixingPoints.addPayment(row);
}

function adjustShixingPoints(row) {
  return shixingPoints.adjust(row).balance;
}

function hasShixingPointTopup(userId) {
  return shixingPoints.hasPaidTopup(userId);
}

function migrateShixingPoints(user) {
  return shixingPoints.ensureMigration(user);
}

// ==================== 思想圆桌 roundtable ====================
function getRoundtableCreditBalance(userId) {
  return shixingPoints.getBalance(userId);
}

function listRoundtableCreditLedger(userId, limit) {
  return shixingPoints.listLedger(userId, limit || 30);
}

function addRoundtableCreditsForPayment(row) {
  return shixingPoints.addLegacyPayment({ ...row, product: 'roundtable' }).balance;
}

function adjustRoundtableCredits(row) {
  try {
    return shixingPoints.adjust({
      ...row,
      delta: (Number(row.delta) || 0) * POINT_COSTS.roundtable,
      reason: row.reason || 'admin_adjustment',
      product: 'roundtable',
      note: row.note || '管理员调整圆桌额度'
    }).balance;
  } catch (e) {
    if (e.code === 'SHIXING_POINTS_EXHAUSTED') {
      e.code = 'NEGATIVE_ROUNDTABLE_BALANCE';
      e.message = '师行积分不能小于 0';
    }
    throw e;
  }
}

function mapRoundtableGeneration(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username || '',
    topic: row.topic || '',
    at_targets: row.at_targets || '',
    transcript: safeJsonParse(row.transcript, []),
    speak_count: Number(row.speak_count) || 0,
    created_at: row.created_at,
    finished_at: row.finished_at || null
  };
}

// 开一个新话题：扣 1 次，建一条对话记录
const startRoundtableGenerationTx = db.transaction((row) => {
  const balance = getRoundtableCreditBalance(row.user_id);
  if (balance < POINT_COSTS.roundtable) {
    const err = new Error('ROUNDTABLE_CREDITS_EXHAUSTED');
    err.code = 'ROUNDTABLE_CREDITS_EXHAUSTED';
    throw err;
  }
  const now = row.created_at || new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO roundtable_generations (user_id, username, topic, at_targets, transcript, speak_count, model, created_at, extra_json)
    VALUES (@user_id, @username, @topic, @at_targets, @transcript, 0, @model, @created_at, @extra_json)
  `).run({
    user_id: row.user_id,
    username: row.username || '',
    topic: String(row.topic || '').slice(0, 2000),
    at_targets: String(row.at_targets || '').slice(0, 200),
    transcript: jsonString([{ role: 'user', name: '你', text: String(row.topic || '') }]),
    model: row.model || '',
    created_at: now,
    extra_json: null
  });
  const generationId = Number(result.lastInsertRowid);
  const debit = shixingPoints.debit({
    user_id: row.user_id,
    username: row.username || '',
    reason: 'topic',
    product: 'roundtable',
    generation_id: generationId,
    note: String(row.topic || '').slice(0, 100),
    created_at: now
  });
  const referralReward = unifiedReferrals.activateReferral({
    invitee_user_id: row.user_id,
    product: 'roundtable',
    source_record_id: 'roundtable:' + generationId,
    device_hash: row.device_hash || '',
    created_at: now
  });
  return { generation_id: generationId, balance: shixingPoints.getBalance(row.user_id), referral_reward: referralReward };
});
function startRoundtableGeneration(row) { return startRoundtableGenerationTx(row); }

// 校验话题归属 + 限制每个话题的发言调用次数，防止白嫖 key
function touchRoundtableGeneration(generationId, userId, maxCalls) {
  const row = db.prepare('SELECT * FROM roundtable_generations WHERE id = ? AND user_id = ?').get(generationId, userId);
  if (!row) { const err = new Error('话题不存在'); err.code = 'GEN_NOT_FOUND'; throw err; }
  const ageMs = Date.now() - Date.parse(row.created_at || 0);
  if (ageMs > 30 * 60 * 1000) { const err = new Error('话题已过期，请重新开始'); err.code = 'GEN_EXPIRED'; throw err; }
  if (Number(row.speak_count) >= (maxCalls || 24)) { const err = new Error('本话题发言次数已达上限'); err.code = 'GEN_LIMIT'; throw err; }
  db.prepare('UPDATE roundtable_generations SET speak_count = speak_count + 1 WHERE id = ?').run(generationId);
  return row;
}

function saveRoundtableTranscript(generationId, userId, transcript) {
  db.prepare('UPDATE roundtable_generations SET transcript = ?, finished_at = ? WHERE id = ? AND user_id = ?')
    .run(jsonString(transcript || []), new Date().toISOString(), generationId, userId);
}

function listRoundtableGenerations(userId, limit) {
  return db.prepare(`
    SELECT * FROM roundtable_generations WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(userId, limit || 50).map(mapRoundtableGeneration);
}

function countRoundtableGenerations(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM roundtable_generations WHERE user_id = ?').get(userId).n;
}

function generateRoundtableCardCode(credits) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) suffix += alphabet[bytes[i] % alphabet.length];
  return 'ROUND-' + credits + '-' + suffix;
}

const createRoundtableCardsTx = db.transaction((count, credits, note) => {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO roundtable_cards (code, credits, batch_note, status, created_at)
    VALUES (?, ?, ?, 'unused', ?)
  `);
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code;
    do { code = generateRoundtableCardCode(credits); } while (db.prepare('SELECT code FROM roundtable_cards WHERE code = ?').get(code));
    insert.run(code, credits, note || '', now);
    codes.push(code);
  }
  return codes;
});
function createRoundtableCards(count, credits, note) { return createRoundtableCardsTx(count, credits, note); }

function listRoundtableCards(status, limit) {
  const rows = status
    ? db.prepare('SELECT * FROM roundtable_cards WHERE status = ? ORDER BY created_at DESC, code LIMIT ?').all(status, limit || 200)
    : db.prepare('SELECT * FROM roundtable_cards ORDER BY created_at DESC, code LIMIT ?').all(limit || 200);
  return rows.map(row => ({
    code: row.code, credits: Number(row.credits) || 0, batch_note: row.batch_note || '',
    status: row.status, created_at: row.created_at, used_at: row.used_at || '',
    used_by: row.used_by || '', used_by_username: row.used_by_username || ''
  }));
}

const redeemRoundtableCardTx = db.transaction((code, user) => {
  const card = db.prepare('SELECT * FROM roundtable_cards WHERE code = ?').get(code);
  if (!card) { const err = new Error('卡密不存在，请检查输入是否正确'); err.code = 'CARD_NOT_FOUND'; throw err; }
  if (card.status !== 'unused') { const err = new Error('该卡密已被使用'); err.code = 'CARD_USED'; throw err; }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE roundtable_cards SET status = 'used', used_at = ?, used_by = ?, used_by_username = ?
    WHERE code = ? AND status = 'unused'
  `).run(now, user.id, user.username || '', code);
  const points = (Number(card.credits) || 0) * POINT_COSTS.roundtable;
  const added = shixingPoints.adjust({
    user_id: user.id, username: user.username || '', delta: points,
    reason: 'card', product: 'roundtable', note: '卡密兑换 ' + points + ' 积分', created_at: now,
    extra_json: { card_code: code, legacy_credits: Number(card.credits) || 0 }
  });
  return { credits: Number(card.credits) || 0, points, balance: added.balance };
});
function redeemRoundtableCard(code, user) { return redeemRoundtableCardTx(code, user); }

function listRoundtableAdminUsage(limit) {
  return db.prepare('SELECT * FROM roundtable_generations ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit || 100).map(mapRoundtableGeneration);
}

function getRoundtableAdminStats() {
  const totalTopics = db.prepare('SELECT COUNT(*) AS n FROM roundtable_generations').get().n;
  const users = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM roundtable_generations').get().n;
  const purchased = db.prepare("SELECT COALESCE(SUM(delta),0) AS n FROM roundtable_credit_ledger WHERE reason='purchase'").get().n;
  const consumed = db.prepare("SELECT COALESCE(SUM(-delta),0) AS n FROM roundtable_credit_ledger WHERE reason='topic'").get().n;
  const cardCredits = db.prepare("SELECT COALESCE(SUM(delta),0) AS n FROM roundtable_credit_ledger WHERE reason='card'").get().n;
  return { total_topics: totalTopics, active_users: users, purchased_credits: purchased, consumed_credits: consumed, card_credits: cardCredits };
}

function sqliteTableExists(name) {
  return !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function getEdulabAdminStats() {
  if (!sqliteTableExists('edulab_generations')) {
    return { total_generations: 0, active_users: 0, generations_today: 0, paid_orders: 0, revenue: 0 };
  }
  const today = new Date().toISOString().slice(0, 10);
  const total = db.prepare('SELECT COUNT(*) AS n FROM edulab_generations').get().n;
  const users = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM edulab_generations').get().n;
  const todayCount = db.prepare('SELECT COUNT(*) AS n FROM edulab_generations WHERE created_at >= ?').get(today).n;
  let paidOrders = 0;
  let revenue = 0;
  if (sqliteTableExists('edulab_payments')) {
    const paid = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount AS REAL)), 0) AS revenue FROM edulab_payments WHERE status = 'paid'").get();
    paidOrders = Number(paid.n) || 0;
    revenue = Number(paid.revenue) || 0;
  }
  return {
    total_generations: Number(total) || 0,
    active_users: Number(users) || 0,
    generations_today: Number(todayCount) || 0,
    paid_orders: paidOrders,
    revenue
  };
}

function listEdulabAdminPayments(limit) {
  if (!sqliteTableExists('edulab_payments')) return [];
  return db.prepare('SELECT * FROM edulab_payments ORDER BY COALESCE(paid_at, created_at) DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(row => ({ ...row, source_product: 'edulab', username: '' }));
}

function getSharedPointAdminStats() {
  const row = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS current_balance,
           COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS granted,
           COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS consumed,
           COUNT(DISTINCT user_id) AS users
    FROM shixing_point_ledger
  `).get();
  return {
    current_balance: Number(row.current_balance) || 0,
    granted: Number(row.granted) || 0,
    consumed: Number(row.consumed) || 0,
    users: Number(row.users) || 0
  };
}

module.exports = {
  SQLITE_FILE,
  LEGACY_JSON_FILE,
  BACKUP_DIR,
  loadStore,
  loadClasses,
  insertAdminAuditLog,
  listAdminAuditLogs,
  recordConversionEvent,
  getConversionReport,
  registerUserWithReferral,
  replaceStore,
  backupLegacyJson,
  setCounter,
  upsertUser,
  upsertClass,
  saveClassTimetable,
  deleteClass,
  classHasManagementHistory,
  archiveClass,
  getClassManagement,
  setClassManagement,
  createClassStudent,
  getClassStudent,
  listClassStudents,
  updateClassStudent,
  saveClassScoreRule,
  getClassScoreRule,
  listClassScoreRules,
  ensureCurrentClassScorePeriod,
  startClassScorePeriod,
  listClassScorePeriods,
  appendClassScoreEntries,
  getClassScoreEntry,
  reverseClassScoreEntry,
  listClassScoreLedger,
  getClassScoreLeaderboard,
  upsertNotification,
  pruneNotifications,
  insertReply,
  pruneReplies,
  upsertMessage,
  markMessagesRead,
  pruneMessages,
  upsertBulletin,
  deleteBulletin,
  pruneBulletins,
  upsertPayment,
  insertPasswordResetRequest,
  markPasswordResetRequestHandled,
  insertPasswordResetCode,
  getRecentPasswordResetCode,
  getLatestPasswordResetCode,
  incrementPasswordResetCodeAttempts,
  markPasswordResetCodeVerified,
  listVerifiedPasswordResetCodes,
  markPasswordResetCodeUsed,
  prunePasswordResetCodes,
  insertRegistrationEmailCode,
  getRecentRegistrationEmailCode,
  getLatestRegistrationEmailCode,
  countRegistrationEmailCodesByIp,
  incrementRegistrationEmailCodeAttempts,
  markRegistrationEmailCodeUsed,
  deleteRegistrationEmailCode,
  pruneRegistrationEmailCodes,
  insertFeedback,
  listFeedback,
  upsertFeatureSubscription,
  listFeatureSubscriptions,
  listFeatureSubscriptionStats,
  getCommentCreditBalance,
  listCommentCreditLedger,
  addCommentCreditsForPayment,
  adjustCommentCredits,
  insertCommentGenerationAndDebit,
  listCommentGenerations,
  upsertCommentRoster,
  listCommentRosters,
  getCommentRoster,
  deleteCommentRoster,
  getCommentAdminStats,
  listCommentAdminUsage,
  getEssayCreditBalance,
  listEssayCreditLedger,
  addEssayCreditsForPayment,
  adjustEssayCredits,
  insertEssayGradingAndDebit,
  listEssayGradings,
  getEssayGradingByRequest,
  createEssayClass,
  listEssayClasses,
  updateEssayClass,
  createEssayStudent,
  listEssayStudents,
  updateEssayStudent,
  copyEssayClassRoster,
  saveEssayRubric,
  listEssayRubrics,
  createEssayAssignment,
  listEssayAssignments,
  getEssayAssignment,
  updateEssayAssignment,
  createEssaySubmission,
  getEssaySubmission,
  getEssaySubmissionByShareToken,
  addEssayRevisionByToken,
  saveEssayReview,
  attachEssayGradingToSubmission,
  listEssayWorkflowHistory,
  updateEssaySubmission,
  deleteEssaySubmission,
  updateEssayGradingRecord,
  deleteEssayGradingRecord,
  getEssayStudentTrend,
  getEssayAssignmentReport,
  createEssayCards,
  listEssayCards,
  redeemEssayCard,
  getEssayAdminStats,
  getEnglishAdminStats,
  listEssayAdminUsage,
  getActiveEssayPlan,
  addEssayPlanForPayment,
  countEssayGradings,
  countEssayGradingsToday,
  bindEssayReferral,
  getEssayReferral,
  listEssayReferralsByInviter,
  rewardEssayReferralGrading,
  rewardEssayReferralPurchase,
  bindAppReferral,
  getAppReferral,
  listAppReferralsByInviter,
  claimAppReferralReward,
  countAppReferralUsageRewards,
  countCommentGenerations,
  hasCommentPurchase,
  addCommentReferralCredits,
  dailyCounts,
  countRowsSince,
  getEssayActivePlanUserCount,
  getLearningMembership,
  getLearningMembershipStatus,
  renewLearningMembership,
  countLearningUsageToday,
  insertLearningUsage,
  listLearningSaved,
  addLearningSaved,
  deleteLearningSaved,
  countLearningSaved,
  insertLearningHistory,
  listLearningHistory,
  countLearningHistory,
  recordLearningCheckin,
  hasCheckedInToday,
  countLearningCheckins,
  learningCheckinStreak,
  getLearningGrowth,
  getLearningAdminStats,
  getAppReferralStats,
  getEssayReferralStats,
  findUnifiedInviterByCode,
  getUnifiedReferralByInvitee,
  bindUnifiedReferral,
  activateUnifiedReferral,
  rewardUnifiedFirstPurchase,
  reverseUnifiedFirstPurchaseReward,
  getUnifiedReferralCenter,
  getUnifiedReferralAdminStats,
  recordUnifiedReferralClick,
  listUnifiedReferralPending,
  reviewUnifiedReferralEvent,
  migrateUnifiedReferrals,
  getEdulabAdminStats,
  listEdulabAdminPayments,
  getSharedPointAdminStats,
  getRoundtableCreditBalance,
  getShixingPointBalance,
  listShixingPointLedger,
  addShixingPointsForPayment,
  adjustShixingPoints,
  hasShixingPointTopup,
  migrateShixingPoints,
  listRoundtableCreditLedger,
  addRoundtableCreditsForPayment,
  adjustRoundtableCredits,
  startRoundtableGeneration,
  touchRoundtableGeneration,
  saveRoundtableTranscript,
  listRoundtableGenerations,
  countRoundtableGenerations,
  createRoundtableCards,
  listRoundtableCards,
  redeemRoundtableCard,
  listRoundtableAdminUsage,
  getRoundtableAdminStats
};
