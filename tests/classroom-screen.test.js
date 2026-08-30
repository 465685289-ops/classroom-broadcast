const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'screen.html'), 'utf8');

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
}

test('classroom idle screen keeps the clock and QR card visible on short and narrow displays', () => {
  assert.match(page, /\.idle-clock\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(page, /font-size:\s*clamp\(/);
  assert.match(page, /@media\s*\(max-height:\s*800px\)/);
  const narrowBlock = page.match(/@media\s*\(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(narrowBlock, '缺少窄屏布局');
  assert.doesNotMatch(narrowBlock[1], /\.idle-promo\s*\{[^}]*display:\s*none/s);
  assert.match(page, /\.promo-qr\s*\{[^}]*object-fit:\s*contain/s);
});

test('saved classroom binding reconnects on the first socket connection and exposes bind errors', () => {
  assert.match(page, /socket\.on\('connect',[\s\S]*?if\s*\(savedBind\)\s*\{\s*socket\.emit\('bind-screen',\s*savedBind\)/);
  assert.doesNotMatch(page, /socket\.on\('connect',[\s\S]*?if\s*\(currentClass\)\s*\{\s*socket\.emit\('bind-screen',\s*savedBind\)/);
  assert.match(page, /function\s+showBindPage\s*\(/);
  assert.match(page, /socket\.on\('bind-error',[\s\S]*?showBindPage\(/);
});

test('fullscreen can be entered deliberately and is not consumed by the first page click', () => {
  assert.match(page, /id="fullscreenBtn"/);
  assert.match(page, /function\s+toggleFullscreen\s*\(/);
  assert.match(page, /fullscreenchange/);
  assert.match(page, /function\s+doBind\s*\([\s\S]*?requestClassroomFullscreen\(/);
  assert.doesNotMatch(page, /\{\s*once:\s*true\s*\}/);
});

test('long notices retain a projector-readable font and scroll instead of shrinking indefinitely', () => {
  assert.match(page, /\.speech-bubble\s*\{[^}]*max-height:/s);
  assert.match(page, /\.speech-bubble\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(page, /else\s+el\.style\.fontSize\s*=\s*'30px'/);
  assert.doesNotMatch(page, /else\s+el\.style\.fontSize\s*=\s*'22px'/);
});

test('active broadcast uses the image-2 acoustic stage and a teacher portrait instead of the cartoon loudspeaker body', () => {
  const premiumCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'classroom-screen-premium.css'), 'utf8');
  const stageAsset = path.join(__dirname, '..', 'public', 'assets', 'broadcast-stage-image2-v1.webp');
  assert.match(page, /class="speech-kicker"/);
  assert.match(page, /assistant-portrait/);
  assert.match(page, /assistantImg\.src\s*=\s*getAvatarSrc\(avatarId\)/);
  assert.match(premiumCss, /broadcast-stage-image2-v1\.webp/);
  assert.ok(fs.existsSync(stageAsset), '缺少 image-2 生成的广播舞台素材');
});

test('broadcast quick replies keep only useful acknowledgements', () => {
  assert.match(page, /sendReply\('收到'\)/);
  assert.match(page, /sendReply\('已完成'\)/);
  assert.doesNotMatch(page, /请再发一次/);
});

test('classroom broadcast requests the server voice first and keeps browser speech as fallback', () => {
  const speakBlock = page.match(/function\s+speakText\s*\([\s\S]*?(?=\/\/ 服务器精品语音方案)/);
  assert.ok(speakBlock, '缺少 speakText 实现');
  const calls = [];
  const context = {
    calls,
    ttsRunId: 0,
    stopCurrentTTS() {},
    speakTextFallback(text, repeatCount, onDone, runId) {
      calls.push({ text, repeatCount, onDone, runId });
    }
  };
  vm.runInNewContext(`${speakBlock[0]}; speakText('请保持安静', 2, 'done')`, context);
  assert.deepEqual(calls.map(call => ({ text: call.text, repeatCount: call.repeatCount })), [
    { text: '请保持安静', repeatCount: 2 }
  ]);
  assert.match(page, /xhr\.open\('POST',\s*'\/api\/tts'/);
  assert.match(page, /function\s+speakWithBrowserTTS\s*\(/);
  assert.doesNotMatch(page, /tts\.baidu\.com/);
  assert.doesNotMatch(page, /gainNode\.gain\.value\s*=\s*(?:[2-9]|[1-9]\d)/);
});

test('today count and classroom history survive reloads and reset by day', () => {
  assert.match(page, /function\s+loadScreenState\s*\(/);
  assert.match(page, /function\s+saveScreenState\s*\(/);
  assert.match(page, /screen_state_/);
  assert.match(page, /function\s+ensureCurrentStatsDay\s*\(/);
  assert.match(page, /socket\.on\('bind-success',[\s\S]*?loadScreenState\(/);
  assert.match(page, /notifHistory\.unshift\([\s\S]*?saveScreenState\(/);
});

test('screen page keeps syntactically valid inline JavaScript', () => {
  inlineScripts(page).forEach((source, index) => {
    new vm.Script(source, { filename: `public/screen.html#inline-${index}` });
  });
});
