/**
 * MimoProvider —— 适配器模式：小米 MiMo 官方 API 的适配实现。
 *
 * 官方接入方式（2025-09 主页确认）：
 *   - 开发者控制台：platform.xiaomimimo.com（注册 → 获取 API Key）
 *   - API Base：https://api.xiaomimimo.com/v1（OpenAI 兼容）
 *   - 鉴权：Authorization: Bearer <key>（另带 x-api-key 兼容官方 api-key 头）
 *
 * MiMo TTS 使用 OpenAI 兼容的 chat completions 接口（非 /v1/audio/speech）：
 *   - 端点：POST /v1/chat/completions
 *   - model: mimo-v2.5-tts
 *   - messages: user + assistant（assistant.content 为待合成文本）
 *   - modalities: ["text", "audio"]
 *   - audio: {voice, format}
 *   - 响应：choices[0].message.audio.data（base64 编码音频）
 */
import { Provider } from '../base.js';
import { errors } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { getProxyDispatcher, normalizeProxyUrl } from '../../utils/proxy.js';
import { runtimeMimo } from '../../admin/runtime-config.js';

// response_format 别名 → { format, mime, ext }
const FORMAT_MAP = {
  mp3: { format: 'mp3', mime: 'audio/mpeg', ext: 'mp3' },
  'mp3-96k': { format: 'mp3', mime: 'audio/mpeg', ext: 'mp3' }, // 无 96k 档，回落 mp3
  opus: { format: 'opus', mime: 'audio/opus', ext: 'opus' },
  aac: { format: 'aac', mime: 'audio/aac', ext: 'aac' },
  flac: { format: 'flac', mime: 'audio/flac', ext: 'flac' },
  wav: { format: 'wav', mime: 'audio/wav', ext: 'wav' },
  pcm: { format: 'pcm', mime: 'audio/L16;rate=24000', ext: 'pcm' },
};

// MiMo 官方可用音色
export const MIMO_VOICES = [
  { name: 'mimo_default', display: 'MiMo 默认', gender: '', locale: 'zh-CN' },
  { name: '冰糖', display: '冰糖（女声，甜美）', gender: 'female', locale: 'zh-CN' },
  { name: '茉莉', display: '茉莉（女声，温柔）', gender: 'female', locale: 'zh-CN' },
  { name: '苏打', display: '苏打（女声，活泼）', gender: 'female', locale: 'zh-CN' },
  { name: '白桦', display: '白桦（男声，成熟）', gender: 'male', locale: 'zh-CN' },
  { name: 'Mia', display: 'Mia（女声）', gender: 'female', locale: 'en-US' },
  { name: 'Chloe', display: 'Chloe（女声）', gender: 'female', locale: 'en-US' },
  { name: 'Milo', display: 'Milo（男声）', gender: 'male', locale: 'en-US' },
  { name: 'Dean', display: 'Dean（男声）', gender: 'male', locale: 'en-US' },
];

/** 把统一 rate 参数（+10% / -20% / 数字）转成 OpenAI speed 数字，转不了返回 null */
function parseSpeed(rate) {
  if (rate === undefined || rate === null || rate === '') return null;
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(String(rate).trim());
  if (m) return +(1 + Number(m[1]) / 100).toFixed(3);
  const n = Number(rate);
  return Number.isFinite(n) ? n : null;
}

export class MimoProvider extends Provider {
  constructor(opts = {}) {
    super('mimo');
    // 构造参数仅作为兜底；实际取值在每次请求时从运行时配置读取（管理界面可热改）
    this.injected = {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      defaultVoice: opts.defaultVoice,
    };
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.proxyUrl = normalizeProxyUrl(opts.proxyUrl ?? config.mimoProxyUrl, 'MIMO_PROXY_URL');
    this.fetch = opts.fetch ?? globalThis.fetch; // 测试可注入假 fetch
  }

  /** 每次请求取一次配置：管理界面改完即时生效，无需重启 */
  currentConfig() {
    const rt = runtimeMimo();
    return {
      apiKey: this.injected.apiKey ?? rt.apiKey,
      baseUrl: this.injected.baseUrl ?? rt.baseUrl,
      model: this.injected.model ?? rt.model,
      defaultVoice: this.injected.defaultVoice ?? rt.defaultVoice,
    };
  }

  /** options: { voice, rate, format, token, ... }（pitch/volume 对 OpenAI 风格 TTS 不适用，忽略） */
  async synthesize(text, options = {}) {
    const cfg = this.currentConfig();
    // token 参数优先于配置的 apiKey（允许每次请求用自己的 key）
    const apiKey = options.token || cfg.apiKey;
    if (!apiKey) {
      throw errors.invalidParameter('未配置 MIMO_API_KEY（可在管理界面 /admin 设置，或在请求中传 token）');
    }
    const voice = options.voice || cfg.defaultVoice;
    if (!voice) {
      throw errors.invalidParameter('mimo 需要 voice 音色（官方预设，或配置 MIMO_VOICE）');
    }
    const fmt = FORMAT_MAP[options.format || 'mp3'];
    if (!fmt) {
      throw errors.invalidParameter(
        `mimo 不支持的 format: ${options.format}（支持 mp3/opus/aac/flac/wav/pcm）`
      );
    }

    // MiMo TTS 使用 chat completions 接口
    const body = {
      model: cfg.model,
      messages: [
        { role: 'user', content: '朗读以下文本' },
        { role: 'assistant', content: text },
      ],
      modalities: ['text', 'audio'],
      audio: { voice, format: fmt.format },
    };

    let res;
    try {
      const dispatcher = getProxyDispatcher(this.proxyUrl);
      res = await this.fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      throw errors.upstreamError(`MiMo 请求失败: ${err.message}`);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw errors.upstreamError(`MiMo API ${res.status}: ${detail.slice(0, 200)}`);
    }

    // 解析响应，提取 base64 编码的音频
    let result;
    try {
      result = await res.json();
    } catch {
      throw errors.upstreamError('MiMo 返回无效 JSON');
    }

    const audioData = result?.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
      throw errors.upstreamError('MiMo 响应中未找到音频数据');
    }

    // base64 解码
    const audio = Buffer.from(audioData, 'base64');
    if (!audio.length) throw errors.upstreamError('MiMo 返回空音频');

    const contentType = fmt.mime;
    logger.info('mimo 合成完成', {
      model: this.model, voice, format: fmt.format, bytes: audio.length,
      tokens: result?.usage?.total_tokens,
    });
    return { audio, format: fmt.format, extension: fmt.ext, contentType };
  }

  /** MiMo 官方可用音色列表 */
  async getVoices() {
    return MIMO_VOICES;
  }
}