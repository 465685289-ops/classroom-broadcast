const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

function loadTencentTts() {
  return require('../tencent-tts');
}

function loadTtsRoutes() {
  return require('../tts-routes');
}

test('platform config loads Tencent credentials from the private secrets file before exporting constants', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-tts-config-'));
  const secretsFile = path.join(tempDir, 'secrets.env');
  fs.writeFileSync(secretsFile, [
    'TENCENT_TTS_SECRET_ID=secret-id-from-file',
    'TENCENT_TTS_SECRET_KEY=secret-key-from-file',
    'TENCENT_TTS_VOICE_TYPE=101001'
  ].join('\n'));
  try {
    const env = { ...process.env, SECRETS_FILE: secretsFile };
    delete env.TENCENT_TTS_SECRET_ID;
    delete env.TENCENT_TTS_SECRET_KEY;
    delete env.TENCENT_TTS_VOICE_TYPE;
    const result = childProcess.spawnSync(process.execPath, ['-e', [
      "const c = require('./platform-config');",
      "process.stdout.write(JSON.stringify([c.TENCENT_TTS_SECRET_ID, c.TENCENT_TTS_SECRET_KEY, c.TENCENT_TTS_VOICE_TYPE]));"
    ].join('')], {
      cwd: path.join(__dirname, '..'),
      env,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['secret-id-from-file', 'secret-key-from-file', 101001]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function startTtsApp(options, classes = [{ id: 'class-1', bind_code: 'ABC123' }]) {
  const state = require('../state');
  const previousStore = state.store;
  state.store = { classes, users: [] };
  const app = express();
  app.use(express.json());
  loadTtsRoutes().installTtsRoutes(app, options);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      state.store = previousStore;
    }
  };
}

test('Tencent TTS sends the purchased premium voice contract and decodes MP3 audio', async () => {
  const calls = [];
  const { createTencentTtsSynthesizer } = loadTencentTts();
  const synthesize = createTencentTtsSynthesizer({
    secretId: 'test-secret-id',
    secretKey: 'test-secret-key',
    region: 'ap-guangzhou',
    voiceType: 101001,
    sessionId: () => 'session-fixed',
    clientFactory(config) {
      assert.deepEqual(config, {
        credential: { secretId: 'test-secret-id', secretKey: 'test-secret-key' },
        region: 'ap-guangzhou',
        profile: { httpProfile: { endpoint: 'tts.tencentcloudapi.com', reqMethod: 'POST', reqTimeout: 10 } }
      });
      return {
        async TextToVoice(params) {
          calls.push(params);
          return {
            Audio: Buffer.from('fake-mp3-audio').toString('base64'),
            SessionId: params.SessionId,
            RequestId: 'request-1'
          };
        }
      };
    }
  });

  const result = await synthesize('请第一小组到操场集合。');

  assert.deepEqual(calls, [{
    Text: '请第一小组到操场集合。',
    SessionId: 'session-fixed',
    VoiceType: 101001,
    Codec: 'mp3',
    SampleRate: 16000,
    Speed: 0,
    Volume: 0,
    ModelType: 1,
    PrimaryLanguage: 1
  }]);
  assert.equal(result.audio.toString(), 'fake-mp3-audio');
  assert.equal(result.requestId, 'request-1');
});

test('Tencent TTS rejects malformed provider audio without exposing credentials', async () => {
  const { createTencentTtsSynthesizer } = loadTencentTts();
  const synthesize = createTencentTtsSynthesizer({
    secretId: 'secret-id-must-not-leak',
    secretKey: 'secret-key-must-not-leak',
    region: 'ap-guangzhou',
    voiceType: 101001,
    clientFactory: () => ({ TextToVoice: async () => ({ Audio: '', RequestId: 'bad-request' }) })
  });

  await assert.rejects(
    () => synthesize('测试播报'),
    error => {
      assert.equal(error.code, 'TTS_PROVIDER_INVALID_RESPONSE');
      assert.doesNotMatch(error.message, /secret-id-must-not-leak|secret-key-must-not-leak/);
      return true;
    }
  );
});

test('TTS route requires a valid classroom binding and enforces Tencent text length', async () => {
  const app = await startTtsApp({
    configured: true,
    synthesize: async () => ({ audio: Buffer.from('unused') }),
    voiceType: 101001
  });
  try {
    const unauthorized = await fetch(`${app.url}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '测试播报' })
    });
    assert.equal(unauthorized.status, 401);

    const tooLong = await fetch(`${app.url}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '好'.repeat(151), bind_code: 'abc123' })
    });
    assert.equal(tooLong.status, 413);
    assert.deepEqual(await tooLong.json(), { error: '播报内容最多150个汉字' });
  } finally {
    await app.close();
  }
});

test('TTS route returns MP3 and caches identical text without a second provider call', async () => {
  let calls = 0;
  const app = await startTtsApp({
    configured: true,
    voiceType: 101001,
    synthesize: async text => {
      calls++;
      return { audio: Buffer.from(`mp3:${text}`), requestId: 'request-1' };
    }
  });
  try {
    const request = () => fetch(`${app.url}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '请安静自习。', bind_code: 'ABC123' })
    });
    const first = await request();
    const second = await request();

    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'audio/mpeg');
    assert.equal(first.headers.get('cache-control'), 'private, max-age=86400');
    assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'mp3:请安静自习。');
    assert.equal(Buffer.from(await second.arrayBuffer()).toString(), 'mp3:请安静自习。');
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('TTS route reports missing server credentials without leaking configuration details', async () => {
  const app = await startTtsApp({
    configured: false,
    synthesize: async () => { throw new Error('must not call provider'); },
    voiceType: 101001
  });
  try {
    const response = await fetch(`${app.url}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '测试播报', bind_code: 'ABC123' })
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: '精品语音暂未配置' });
  } finally {
    await app.close();
  }
});
