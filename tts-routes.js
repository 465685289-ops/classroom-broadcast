'use strict';

const crypto = require('crypto');
const { findUserByToken } = require('./auth-core');
const { authTokenFromReq } = require('./http-utils');
const {
  TENCENT_TTS_REGION,
  TENCENT_TTS_SECRET_ID,
  TENCENT_TTS_SECRET_KEY,
  TENCENT_TTS_VOICE_TYPE
} = require('./platform-config');
const state = require('./state');
const { createTencentTtsSynthesizer, normalizedTtsText } = require('./tencent-tts');

const TTS_RATE_LIMIT = 20;
const TTS_RATE_WINDOW_MS = 60 * 1000;
const TTS_CACHE_LIMIT = 200;

function createRateLimiter() {
  const records = new Map();
  return function rateLimited(ip) {
    const now = Date.now();
    const record = records.get(ip);
    if (!record || now - record.first >= TTS_RATE_WINDOW_MS) {
      if (records.size > 5000) records.clear();
      records.set(ip, { first: now, count: 1 });
      return false;
    }
    record.count++;
    return record.count > TTS_RATE_LIMIT;
  };
}

function cacheKey(voiceType, text) {
  return crypto.createHash('sha256').update(String(voiceType) + '\n' + text).digest('hex');
}

function installTtsRoutes(app, overrides = {}) {
  const configured = overrides.configured !== undefined
    ? !!overrides.configured
    : !!(TENCENT_TTS_SECRET_ID && TENCENT_TTS_SECRET_KEY);
  const voiceType = overrides.voiceType || TENCENT_TTS_VOICE_TYPE;
  const synthesize = overrides.synthesize || createTencentTtsSynthesizer({
    secretId: TENCENT_TTS_SECRET_ID,
    secretKey: TENCENT_TTS_SECRET_KEY,
    region: TENCENT_TTS_REGION,
    voiceType
  });
  const rateLimited = createRateLimiter();
  const audioCache = new Map();
  const pending = new Map();

  function cachedAudio(key) {
    if (!audioCache.has(key)) return null;
    const audio = audioCache.get(key);
    audioCache.delete(key);
    audioCache.set(key, audio);
    return audio;
  }

  function rememberAudio(key, audio) {
    if (audioCache.has(key)) audioCache.delete(key);
    audioCache.set(key, audio);
    while (audioCache.size > TTS_CACHE_LIMIT) {
      audioCache.delete(audioCache.keys().next().value);
    }
  }

  app.post('/api/tts', async (req, res) => {
    if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ error: '播报请求过于频繁，请稍后再试' });

    const store = state.store || { classes: [], users: [] };
    const bindCode = String(req.body && req.body.bind_code || '').trim().toUpperCase();
    const boundClass = bindCode && Array.isArray(store.classes)
      ? store.classes.find(row => row.bind_code === bindCode)
      : null;
    const authedUser = boundClass ? null : findUserByToken(authTokenFromReq(req));
    if (!boundClass && !authedUser) return res.status(401).json({ error: '教室端未绑定或登录已失效' });

    let text;
    try {
      text = normalizedTtsText(req.body && req.body.text);
    } catch (error) {
      if (error.code === 'TTS_TEXT_EMPTY') return res.status(400).json({ error: error.message });
      if (error.code === 'TTS_TEXT_TOO_LONG') return res.status(413).json({ error: error.message });
      return res.status(400).json({ error: '播报内容不正确' });
    }
    if (!configured) return res.status(503).json({ error: '精品语音暂未配置' });

    const key = cacheKey(voiceType, text);
    let audio = cachedAudio(key);
    try {
      if (!audio) {
        let work = pending.get(key);
        if (!work) {
          work = Promise.resolve(synthesize(text)).then(result => {
            if (!result || !Buffer.isBuffer(result.audio) || !result.audio.length) {
              const error = new Error('provider returned empty audio');
              error.code = 'TTS_PROVIDER_INVALID_RESPONSE';
              throw error;
            }
            rememberAudio(key, result.audio);
            return result.audio;
          }).finally(() => pending.delete(key));
          pending.set(key, work);
        }
        audio = await work;
      }
    } catch (error) {
      console.warn('[TTS] 腾讯云合成失败', error && error.code ? error.code : 'TTS_PROVIDER_ERROR');
      const status = error && error.code === 'TTS_NOT_CONFIGURED' ? 503 : 502;
      return res.status(status).json({ error: status === 503 ? '精品语音暂未配置' : '精品语音暂时不可用' });
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(audio);
  });
}

module.exports = {
  installTtsRoutes,
};
