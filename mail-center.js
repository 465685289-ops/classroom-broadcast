'use strict';
// 邮件通知中心：SMTP 传输器 / 管理员通知 / 注册与重置验证码邮件。
const crypto = require('crypto');
const state = require('./state');
const nodemailer = require('nodemailer');
// @WIRE
const {
  MAIL_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_SECURE, SMTP_USER, mailConfigValue
} = require('./platform-config');
function mailConfigured() {
  return !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && MAIL_FROM);
}

let mailTransporter = null;
function getMailTransporter() {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    });
  }
  return mailTransporter;
}

function genResetCode() {
  return ('000000' + crypto.randomInt(0, 1000000)).slice(-6);
}

// ---------- 管理员邮件通知（注册/收款）----------
const ADMIN_NOTIFY_EMAIL = mailConfigValue(['ADMIN_NOTIFY_EMAIL'], 'admin_notify_email', '465685289@qq.com');

const ADMIN_PLAN_LABELS = {
  yearly: '班级广播·半年会员',
  comment_100: '评语·100次', comment_200: '评语·200次',
  essay_50: '作文·50次', essay_100: '作文·100次',
  essay_week: '作文·周卡', essay_month: '作文·月卡', essay_term: '作文·学期卡'
};

// 发不出去只记日志，绝不影响注册/支付主流程
function notifyAdmin(subject, lines) {
  if (!mailConfigured() || !ADMIN_NOTIFY_EMAIL) return;
  getMailTransporter().sendMail({
    from: MAIL_FROM,
    to: ADMIN_NOTIFY_EMAIL,
    subject: subject,
    text: lines.join('\n')
  }).catch(e => console.log('[NOTIFY] 管理员邮件发送失败:', e.message));
}

function notifyAdminNewUser(user) {
  notifyAdmin('🆕 新用户注册：' + user.username, [
    '用户名：' + user.username,
    '称呼：' + (user.display_name || ''),
    '联系方式：' + (user.contact_value || '未填'),
    '时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    '当前总用户数：' + state.store.users.length,
    '',
    '数据仪表盘：https://notice.yingyuzuowen.asia/dashboard.html'
  ]);
}

function notifyAdminPayment(payment, user) {
  const label = ADMIN_PLAN_LABELS[payment.plan] || payment.plan;
  notifyAdmin('💰 收款 ¥' + payment.amount + '：' + label, [
    '用户：' + (user ? user.username : payment.username || ''),
    '套餐：' + label,
    '金额：¥' + payment.amount,
    '时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    '订单号：' + payment.out_trade_no,
    '',
    '数据仪表盘：https://notice.yingyuzuowen.asia/dashboard.html'
  ]);
}

function genericResetCodeMessage() {
  return '如果用户名和邮箱匹配，验证码会发送到你的邮箱。验证码10分钟内有效。';
}

async function sendPasswordResetEmail(email, code) {
  const text = [
    '你正在重置班级广播账号密码。',
    '',
    '验证码：' + code,
    '',
    '验证码10分钟内有效。若不是你本人操作，请忽略这封邮件。'
  ].join('\n');
  await getMailTransporter().sendMail({
    from: MAIL_FROM,
    to: email,
    subject: '班级广播密码重置验证码',
    text
  });
}

async function sendRegistrationEmail(email, code) {
  const text = [
    '你正在注册师行账号。',
    '',
    '验证码：' + code,
    '',
    '验证码10分钟内有效。若不是你本人操作，请忽略这封邮件。'
  ].join('\n');
  await getMailTransporter().sendMail({
    from: MAIL_FROM,
    to: email,
    subject: '师行注册验证码',
    text
  });
}

module.exports = {
  mailConfigured,
  mailTransporter,
  getMailTransporter,
  genResetCode,
  ADMIN_NOTIFY_EMAIL,
  ADMIN_PLAN_LABELS,
  notifyAdmin,
  notifyAdminNewUser,
  notifyAdminPayment,
  genericResetCodeMessage,
  sendPasswordResetEmail,
  sendRegistrationEmail,
};
