'use strict';

const crypto = require('crypto');

class TencentTtsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TencentTtsError';
    this.code = code;
    this.requestId = details.requestId || '';
    if (details.cause) this.cause = details.cause;
  }
}

function defaultClientFactory(config) {
  const { tts } = require('tencentcloud-sdk-nodejs-tts');
  return new tts.v20190823.Client(config);
}

function normalizedTtsText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new TencentTtsError('TTS_TEXT_EMPTY', '播报内容不能为空');
  if (Array.from(text).length > 150) {
    throw new TencentTtsError('TTS_TEXT_TOO_LONG', '播报内容最多150个汉字');
  }
  return text;
}

function decodeProviderAudio(value, requestId) {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TencentTtsError('TTS_PROVIDER_INVALID_RESPONSE', '精品语音服务返回了无效音频', { requestId });
  }
  const audio = Buffer.from(encoded, 'base64');
  if (!audio.length) {
    throw new TencentTtsError('TTS_PROVIDER_INVALID_RESPONSE', '精品语音服务返回了无效音频', { requestId });
  }
  return audio;
}

function createTencentTtsSynthesizer(options = {}) {
  const secretId = String(options.secretId || '').trim();
  const secretKey = String(options.secretKey || '').trim();
  const region = String(options.region || 'ap-guangzhou').trim() || 'ap-guangzhou';
  const parsedVoiceType = parseInt(options.voiceType, 10);
  const voiceType = Number.isSafeInteger(parsedVoiceType) && parsedVoiceType > 0 ? parsedVoiceType : 101001;
  const clientFactory = options.clientFactory || defaultClientFactory;
  const sessionId = options.sessionId || (() => crypto.randomUUID());
  let client = null;

  return async function synthesizeTencentTts(value) {
    if (!secretId || !secretKey) {
      throw new TencentTtsError('TTS_NOT_CONFIGURED', '精品语音暂未配置');
    }
    const text = normalizedTtsText(value);
    if (!client) {
      client = clientFactory({
        credential: { secretId, secretKey },
        region,
        profile: {
          httpProfile: {
            endpoint: 'tts.tencentcloudapi.com',
            reqMethod: 'POST',
            reqTimeout: 10
          }
        }
      });
    }

    const params = {
      Text: text,
      SessionId: sessionId(),
      VoiceType: voiceType,
      Codec: 'mp3',
      SampleRate: 16000,
      Speed: 0,
      Volume: 0,
      ModelType: 1,
      PrimaryLanguage: 1
    };

    let response;
    try {
      response = await client.TextToVoice(params);
    } catch (error) {
      throw new TencentTtsError('TTS_PROVIDER_ERROR', '精品语音合成失败', {
        requestId: error && (error.requestId || error.request_id),
        cause: error
      });
    }
    const requestId = String(response && response.RequestId || '');
    return {
      audio: decodeProviderAudio(response && response.Audio, requestId),
      requestId
    };
  };
}

module.exports = {
  TencentTtsError,
  normalizedTtsText,
  createTencentTtsSynthesizer,
};
