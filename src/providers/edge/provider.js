/**
 * EdgeProvider —— 适配器模式。
 * 把 Edge 的 WebSocket 协议封装成统一 Provider 接口（synthesize / getVoices），
 * 调用方看到的只有标准结果 { audio, format, contentType, extension }，感知不到协议差异。
 */
import { Provider } from '../base.js';
import { synthesizeAudio } from './protocol.js';
import { fetchVoices, BUILTIN_VOICES } from './voices.js';
import { withRetries } from '../../utils/retry.js';
import { errors } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { normalizeProxyUrl } from '../../utils/proxy.js';

// 格式别名 → 完整输出格式串
const FORMAT_ALIASES = {
  mp3: 'audio-24khz-48kbitrate-mono-mp3',
  'mp3-96k': 'audio-24khz-96kbitrate-mono-mp3',
  ogg: 'ogg-24khz-16bit-mono-opus',
  webm: 'webm-24khz-16bit-mono-opus',
};

// 已知完整格式 → MIME / 扩展名
const FORMAT_INFO = {
  'audio-24khz-48kbitrate-mono-mp3': { mime: 'audio/mpeg', ext: 'mp3' },
  'audio-24khz-96kbitrate-mono-mp3': { mime: 'audio/mpeg', ext: 'mp3' },
  'ogg-24khz-16bit-mono-opus': { mime: 'audio/ogg', ext: 'ogg' },
  'webm-24khz-16bit-mono-opus': { mime: 'audio/webm', ext: 'webm' },
};

const VALID_FORMAT_RE = /^(audio|ogg|webm|riff|raw)-/;

/** 把用户传的格式别名/完整串解析成 { format, mime, ext }，非法则报 400 */
export function resolveFormat(input) {
  const full = FORMAT_ALIASES[input] || input;
  const known = FORMAT_INFO[full];
  if (known) return { format: full, ...known };
  if (VALID_FORMAT_RE.test(full)) {
    // 未知但结构合法的格式：透传给上游，尽力猜测 mime/ext
    let mime = 'application/octet-stream';
    let ext = 'bin';
    if (full.includes('mp3')) { mime = 'audio/mpeg'; ext = 'mp3'; }
    else if (full.startsWith('ogg')) { mime = 'audio/ogg'; ext = 'ogg'; }
    else if (full.startsWith('webm')) { mime = 'audio/webm'; ext = 'webm'; }
    else if (full.startsWith('riff')) { mime = 'audio/wav'; ext = 'wav'; }
    logger.warn('使用未知完整格式', { format: full });
    return { format: full, mime, ext };
  }
  throw errors.invalidParameter(`不支持的 format: ${input}`);
}

/**
 * 发音人宽松校验：内置清单命中即放行；否则只拦明显非格式/带危险字符的输入（防 SSML 注入），
 * 完整名单（在线 322 个）交给上游校验，避免因清单未加载误杀合法 voice。
 * 支持地区子标签发音人，如 zh-CN-shaanxi-XiaoniNeural、zh-CN-liaoning-XiaobeiNeural。
 */
function isKnownVoice(name) {
  if (BUILTIN_VOICES.some((v) => v.name === name)) return true;
  return /^[A-Za-z]{2,3}-[A-Za-z]{2,3}-[A-Za-z0-9-]+Neural$/.test(name);
}

export class EdgeProvider extends Provider {
  constructor(opts = {}) {
    super('edge');
    this.retries = opts.retries ?? config.retries;
    this.timeoutMs = opts.timeoutMs ?? config.upstreamTimeoutMs;
    this.defaultFormat = opts.defaultFormat ?? config.defaultFormat;
    this.proxyUrl = normalizeProxyUrl(opts.proxyUrl ?? config.edgeProxyUrl, 'EDGE_PROXY_URL');
  }

  /** options: { voice, rate, pitch, volume, format, language } */
  async synthesize(text, options = {}) {
    const { format, mime, ext } = resolveFormat(options.format || this.defaultFormat);
    const voice = options.voice || config.defaultVoice;
    if (!isKnownVoice(voice)) {
      throw errors.invalidParameter(`voice 格式不正确: ${voice}（应为如 ${config.defaultVoice}）`);
    }

    // 语言：显式传的优先，否则从 voice 名推断（如 zh-CN-XiaoxiaoNeural → zh-CN）
    const lang = options.language || /^[a-z]{2}-[A-Z]{2}/.exec(voice)?.[0];
    if (!lang) throw errors.invalidParameter(`无法从 voice 推断语言: ${voice}`);

    const result = await withRetries(
      () =>
        synthesizeAudio({
          voice,
          lang,
          text,
          rate: options.rate || '+0%',
          pitch: options.pitch || '+0Hz',
          volume: options.volume || '+0%',
          format,
          contentType: mime,
          timeoutMs: this.timeoutMs,
          proxyUrl: this.proxyUrl,
        }),
      {
        retries: this.retries,
        onRetry: (attempt, err, delay) =>
          logger.warn('上游合成失败，准备重试', { provider: 'edge', attempt, error: err.message, delay }),
      }
    );

    return { audio: result.audio, format, extension: ext, contentType: result.contentType };
  }

  async getVoices() {
    return fetchVoices(false, { proxyUrl: this.proxyUrl });
  }
}