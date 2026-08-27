const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('broadcast creates a unified activation only after the notice is persisted', () => {
  const server = read('server.js');
  const route = server.slice(server.indexOf("app.post('/api/notify'"), server.indexOf("app.post('/api/resend/:id'"));
  assert.match(route, /dbStore\.upsertNotification\(notification\)[\s\S]+activateUnifiedReferral/);
  assert.match(route, /product:\s*'broadcast'/);
  assert.match(route, /source_record_id:\s*'broadcast:'\s*\+\s*notification\.id/);
});

test('math creates a unified activation only after generation and debit succeed', () => {
  const math = read('edulab-product.js');
  const courseware = read('edulab-courseware.js');
  const generate = math.slice(math.indexOf("if(route.endsWith('/generate')"), math.indexOf("if(route.endsWith('/edit')"));
  assert.match(courseware, /db\.transaction[\s\S]+pointStore\.debit[\s\S]+insertGeneration\.run/);
  assert.match(generate, /finalizeGeneration[\s\S]+referrals\.activateReferral/);
  assert.match(generate, /product:\s*'edulab'/);
  assert.match(generate, /source_record_id:/);
});

test('all shared-point payment callbacks use the global first-purchase relationship', () => {
  // refactor: markPaymentPaid 已迁至 payment-engine.js（切片区间相应改为该模块内部）
  const engine = read('payment-engine.js');
  const sharedPayment = engine.slice(engine.indexOf('function markPaymentPaid'), engine.indexOf('module.exports'));
  assert.match(sharedPayment, /rewardUnifiedPurchaseForPayment/);
  assert.doesNotMatch(sharedPayment, /if \(payment\.source_product === 'comment'\) rewardCommentReferralOnPurchase/);
  assert.doesNotMatch(sharedPayment, /if \(payment\.source_product === 'essay'\) rewardEssayReferralOnPurchase/);

  const math = read('edulab-product.js');
  const callbackStart = math.indexOf("if(route.endsWith('/pay/notify')");
  const callback = math.slice(callbackStart, math.indexOf("\n  send(res, 404", callbackStart));
  assert.match(callback, /referrals\.rewardFirstPurchase/);
  assert.match(callback, /source_product:'edulab'/);
});
