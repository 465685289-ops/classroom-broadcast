'use strict';
// 平台静态配置层：全部环境变量 / JSON 配置文件解析出的常量。
// 优先级：真实环境变量 > secrets.env 注入的 env > 本地 JSON 配置 > 内置默认值。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 在任何配置常量求值前加载本机私有密钥；已有环境变量永远优先，不会被覆盖。
function loadSecretsEnv() {
  const secretsPath = process.env.SECRETS_FILE
    || path.join(os.homedir(), '.config', 'classroom-broadcast', 'secrets.env');
  try {
    for (const raw of fs.readFileSync(secretsPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (e) {
    // 文件不存在是常态；生产环境通常由 systemd 直接注入环境变量。
  }
}

loadSecretsEnv();

function loadPaymentConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'payment-config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

function loadMailConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'mail-config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

function loadCommentConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'comment-config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

function loadEssayConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'essay-config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

const PAYMENT_CONFIG = loadPaymentConfig();
const MAIL_CONFIG = loadMailConfig();
const COMMENT_CONFIG = loadCommentConfig();
const ESSAY_CONFIG = loadEssayConfig();
function configValue(envName, fileName, fallback) {
  const value = process.env[envName] !== undefined ? process.env[envName] : PAYMENT_CONFIG[fileName];
  return String(value === undefined || value === null ? fallback : value).trim();
}

function commentConfigValue(envName, fileName, fallback) {
  const value = process.env[envName] !== undefined ? process.env[envName] : COMMENT_CONFIG[fileName];
  return String(value === undefined || value === null ? fallback : value).trim();
}

function essayConfigValue(envName, fileName, fallback) {
  const value = process.env[envName] !== undefined ? process.env[envName] : ESSAY_CONFIG[fileName];
  return String(value === undefined || value === null ? fallback : value).trim();
}

function mailConfigValue(envNames, fileName, fallback) {
  for (let i = 0; i < envNames.length; i++) {
    const value = process.env[envNames[i]];
    if (value !== undefined) return String(value).trim();
  }
  const value = MAIL_CONFIG[fileName];
  return String(value === undefined || value === null ? fallback : value).trim();
}

function mailConfigBool(envNames, fileName, fallback) {
  const value = mailConfigValue(envNames, fileName, fallback ? 'true' : 'false').toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'change-me-in-production';
const FREE_TRIAL_DAYS = 3;
// 2026-06：由 365 天改为 180 天（¥9.9/半年）。只影响新购买，老用户已写入的到期日不变
const PAID_PLAN_DAYS = 180;
const YEARLY_PLAN_PRICE = configValue('YEARLY_PLAN_PRICE', 'yearly_plan_price', '9.90');
const PUBLIC_BASE_URL = configValue('PUBLIC_BASE_URL', 'public_base_url', '').replace(/\/+$/, '');
const COMMENT_BASE_URL = commentConfigValue('COMMENT_BASE_URL', 'comment_base_url', '').replace(/\/+$/, '');
const DEEPSEEK_API_KEY = commentConfigValue('DEEPSEEK_API_KEY', 'deepseek_api_key', '');
const DEEPSEEK_MODEL = commentConfigValue('DEEPSEEK_MODEL', 'deepseek_model', 'deepseek-v4-flash') || 'deepseek-v4-flash';
const TENCENT_TTS_SECRET_ID = String(process.env.TENCENT_TTS_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || '').trim();
const TENCENT_TTS_SECRET_KEY = String(process.env.TENCENT_TTS_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || '').trim();
const TENCENT_TTS_REGION = String(process.env.TENCENT_TTS_REGION || 'ap-guangzhou').trim() || 'ap-guangzhou';
const configuredTtsVoiceType = parseInt(process.env.TENCENT_TTS_VOICE_TYPE || '101001', 10);
const TENCENT_TTS_VOICE_TYPE = Number.isSafeInteger(configuredTtsVoiceType) && configuredTtsVoiceType > 0
  ? configuredTtsVoiceType
  : 101001;
const YUNGOU_MCH_ID = configValue('YUNGOU_MCH_ID', 'yungou_mch_id', '');
const YUNGOU_PAY_KEY = configValue('YUNGOU_PAY_KEY', 'yungou_pay_key', '');
const YUNGOU_APP_ID = configValue('YUNGOU_APP_ID', 'yungou_app_id', '');
const YUNGOU_API_HOST = 'api.pay.yungouos.com';
const LEGACY_COMMENT_PACKAGES = {
  comment_100: { key: 'comment_100', label: '100次评语生成', credits: 100, amount: '6.90' },
  comment_200: { key: 'comment_200', label: '200次评语生成', credits: 200, amount: '9.90' }
};
// ---- 思想圆桌 roundtable ----
const LEGACY_ROUNDTABLE_PACKAGES = {
  rt_60: { key: 'rt_60', label: '60次圆桌讨论', credits: 60, amount: '9.90' },
  rt_150: { key: 'rt_150', label: '150次圆桌讨论', credits: 150, amount: '19.90' }
};
const ROUNDTABLE_CARD_ENABLED = configValue('ROUNDTABLE_CARD_ENABLED', 'roundtable_card_enabled', 'true') === 'true';
const ROUNDTABLE_BASE_URL = configValue('ROUNDTABLE_BASE_URL', 'roundtable_base_url', '').replace(/\/+$/, '');
const ROUNDTABLE_SPEAK_CAP = 24; // 单个话题最多发言调用次数，防止白嫖 key
const ESSAY_BASE_URL = essayConfigValue('ESSAY_BASE_URL', 'essay_base_url', '').replace(/\/+$/, '');
const ENGLISH_BASE_URL = essayConfigValue('ENGLISH_BASE_URL', 'english_base_url', 'https://notice.yingyuzuowen.asia').replace(/\/+$/, '');
const QWEN_API_KEY = essayConfigValue('QWEN_API_KEY', 'qwen_api_key', '');
const QWEN_OCR_MODEL = essayConfigValue('QWEN_OCR_MODEL', 'qwen_ocr_model', 'qwen-vl-max') || 'qwen-vl-max';
const MINIMAX_API_KEYS = essayConfigValue('MINIMAX_API_KEYS', 'minimax_api_keys', '').split(/[,\s]+/).filter(Boolean);
const MINIMAX_MODEL = essayConfigValue('MINIMAX_MODEL', 'minimax_model', 'MiniMax-M2.7') || 'MiniMax-M2.7';
const FREE_ESSAY_CREDITS = 10;
const ESSAY_OCR_DAILY_LIMIT = 300;
// 套餐金额必须 ≤ ESSAY_PAY_MAX（essay-config.json 可调；2026-06-12 商户限额解除后已调到 100）
const ESSAY_PAY_MAX = parseFloat(essayConfigValue('ESSAY_PAY_MAX', 'essay_pay_max', '10')) || 10;
// 旧作文次数包已停售；剩余次数会按 50 积分/次迁入师行共享积分。
const ESSAY_PACKAGES = {};
// 闲鱼卡密兑换通道开关（默认关，闲鱼有流量时把 essay-config.json 的 essay_card_enabled 设为 true 即可恢复）
const ESSAY_CARD_ENABLED = essayConfigValue('ESSAY_CARD_ENABLED', 'essay_card_enabled', 'false') === 'true';
// 会员卡：有效期内每天最多批 daily_limit 篇，不扣次数
const ESSAY_TIME_PACKAGES = {
  essay_week: { key: 'essay_week', label: '周卡', days: 7, daily_limit: 60, amount: '8.80' },
  essay_month: { key: 'essay_month', label: '月卡', days: 30, daily_limit: 60, amount: '19.90' },
  essay_term: { key: 'essay_term', label: '学期卡', days: 120, daily_limit: 60, amount: '49.90' }
};
// 邀请裂变：好友完成3次批改奖10次，好友首次付费再奖30次
const ESSAY_REFERRAL_GRADING_THRESHOLD = 3;
const ESSAY_REFERRAL_GRADING_REWARD = 10;
const ESSAY_REFERRAL_PURCHASE_REWARD = 30;
const LEARNING_BASE_URL = essayConfigValue('LEARNING_BASE_URL', 'learning_base_url', '').replace(/\/+$/, '');
const LEARNING_MODEL = commentConfigValue('LEARNING_MODEL', 'learning_model', 'deepseek-v4-flash') || 'deepseek-v4-flash';
const LEARNING_DAILY_LIMIT = 40;
const LEARNING_PACKAGES = {
  learning_half_year: { key: 'learning_half_year', label: '学期卡（半年）', days: 180, amount: '9.90' },
  learning_year: { key: 'learning_year', label: '年卡', days: 365, amount: '17.80' }
};
// 评语邀请：好友生成3条奖20次，好友首次付费奖50次；未付费邀请人使用类奖励最多2笔
const COMMENT_REFERRAL_USAGE_THRESHOLD = 3;
const COMMENT_REFERRAL_USAGE_CREDITS = 20;
const COMMENT_REFERRAL_PURCHASE_CREDITS = 50;
const COMMENT_REFERRAL_UNPAID_USAGE_CAP = 2;
// 广播邀请：好友发出首条通知奖5天，好友开通半年奖30天；未付费邀请人使用类奖励最多3笔
const BROADCAST_REFERRAL_USAGE_DAYS = 5;
const BROADCAST_REFERRAL_PURCHASE_DAYS = 30;
const BROADCAST_REFERRAL_UNPAID_USAGE_CAP = 3;
const LEGACY_PREMIUM_PLAN = 'life' + 'time';
const SMTP_HOST = mailConfigValue(['SMTP_HOST', 'MAIL_SMTP_HOST'], 'host', '');
const SMTP_PORT = parseInt(mailConfigValue(['SMTP_PORT', 'MAIL_SMTP_PORT'], 'port', '465'), 10) || 465;
const SMTP_SECURE = mailConfigBool(['SMTP_SECURE', 'MAIL_SMTP_SECURE'], 'secure', SMTP_PORT === 465);
const SMTP_USER = mailConfigValue(['SMTP_USER', 'MAIL_SMTP_USER'], 'user', '');
const SMTP_PASS = mailConfigValue(['SMTP_PASS', 'MAIL_SMTP_PASS'], 'pass', '');
const MAIL_FROM = mailConfigValue(['MAIL_FROM'], 'from', SMTP_USER ? '班级广播 <' + SMTP_USER + '>' : '');
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const RESET_CODE_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;
const REGISTRATION_CODE_COOLDOWN_MS = 60 * 1000;
const REGISTRATION_CODE_MAX_ATTEMPTS = 5;
const REGISTRATION_CODE_IP_HOURLY_LIMIT = 10;
const AUTH_COOKIE_NAME = 'shixing_auth';
const ADMIN_COOKIE_NAME = 'shixing_admin';
const ANALYTICS_COOKIE_NAME = 'shixing_vid';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 登录有效期30天，活跃用户自动续期
const INVITE_COOKIE_NAME = 'shixing_ref';
const DEVICE_COOKIE_NAME = 'shixing_device';
const INVITE_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_COOKIE_SECRET = process.env.INVITE_COOKIE_SECRET || crypto.createHash('sha256').update('shixing-referral:' + ADMIN_PASS).digest('hex');
const ANALYTICS_HASH_SALT = process.env.ANALYTICS_HASH_SALT || crypto.createHash('sha256').update('shixing-analytics:' + ADMIN_PASS).digest('hex');
const ADMIN_PASS_IS_DEFAULT = !process.env.ADMIN_PASS;
if (ADMIN_PASS_IS_DEFAULT) {
  console.warn('[SECURITY] 未设置 ADMIN_PASS 环境变量，管理后台接口已禁用。请设置后重启。');
}
const ROADMAP_FEATURES = {
  scheduled_broadcast: '定时广播',
  screen_themes: '大屏主题切换',
  mini_app: '微信小程序 / 手机 APP',
  school_broadcast: '年级 / 全校广播',
  ai_notice: 'AI 写通知',
  custom_voice: '自定义播报声音'
};

module.exports = {
  loadSecretsEnv,
  loadPaymentConfig,
  loadMailConfig,
  loadCommentConfig,
  loadEssayConfig,
  PAYMENT_CONFIG,
  MAIL_CONFIG,
  COMMENT_CONFIG,
  ESSAY_CONFIG,
  configValue,
  commentConfigValue,
  essayConfigValue,
  mailConfigValue,
  mailConfigBool,
  PORT,
  ADMIN_PASS,
  FREE_TRIAL_DAYS,
  PAID_PLAN_DAYS,
  YEARLY_PLAN_PRICE,
  PUBLIC_BASE_URL,
  COMMENT_BASE_URL,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL,
  TENCENT_TTS_SECRET_ID,
  TENCENT_TTS_SECRET_KEY,
  TENCENT_TTS_REGION,
  TENCENT_TTS_VOICE_TYPE,
  YUNGOU_MCH_ID,
  YUNGOU_PAY_KEY,
  YUNGOU_APP_ID,
  YUNGOU_API_HOST,
  LEGACY_COMMENT_PACKAGES,
  LEGACY_ROUNDTABLE_PACKAGES,
  ROUNDTABLE_CARD_ENABLED,
  ROUNDTABLE_BASE_URL,
  ROUNDTABLE_SPEAK_CAP,
  ESSAY_BASE_URL,
  ENGLISH_BASE_URL,
  QWEN_API_KEY,
  QWEN_OCR_MODEL,
  MINIMAX_API_KEYS,
  MINIMAX_MODEL,
  FREE_ESSAY_CREDITS,
  ESSAY_OCR_DAILY_LIMIT,
  ESSAY_PAY_MAX,
  ESSAY_PACKAGES,
  ESSAY_CARD_ENABLED,
  ESSAY_TIME_PACKAGES,
  ESSAY_REFERRAL_GRADING_THRESHOLD,
  ESSAY_REFERRAL_GRADING_REWARD,
  ESSAY_REFERRAL_PURCHASE_REWARD,
  LEARNING_BASE_URL,
  LEARNING_MODEL,
  LEARNING_DAILY_LIMIT,
  LEARNING_PACKAGES,
  COMMENT_REFERRAL_USAGE_THRESHOLD,
  COMMENT_REFERRAL_USAGE_CREDITS,
  COMMENT_REFERRAL_PURCHASE_CREDITS,
  COMMENT_REFERRAL_UNPAID_USAGE_CAP,
  BROADCAST_REFERRAL_USAGE_DAYS,
  BROADCAST_REFERRAL_PURCHASE_DAYS,
  BROADCAST_REFERRAL_UNPAID_USAGE_CAP,
  LEGACY_PREMIUM_PLAN,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
  RESET_CODE_TTL_MS,
  RESET_TOKEN_TTL_MS,
  RESET_CODE_COOLDOWN_MS,
  RESET_CODE_MAX_ATTEMPTS,
  REGISTRATION_CODE_TTL_MS,
  REGISTRATION_CODE_COOLDOWN_MS,
  REGISTRATION_CODE_MAX_ATTEMPTS,
  REGISTRATION_CODE_IP_HOURLY_LIMIT,
  AUTH_COOKIE_NAME,
  ADMIN_COOKIE_NAME,
  ANALYTICS_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  AUTH_TOKEN_TTL_MS,
  INVITE_COOKIE_NAME,
  DEVICE_COOKIE_NAME,
  INVITE_COOKIE_MAX_AGE_MS,
  INVITE_COOKIE_SECRET,
  ANALYTICS_HASH_SALT,
  ADMIN_PASS_IS_DEFAULT,
  ROADMAP_FEATURES,
};
