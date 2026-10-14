/**
 * POST /v1/tts 与 GET /v1/tts —— 统一合成入口（默认同步），两者参数一致。
 *
 * 兼容两种调用风格：
 *   POST body（JSON）：{ text, voice, mode, rate, pitch, format, ... }
 *   GET  query：?text=...&voiceName=...&format=...&rate=&pitch=&volume=&token=
 *     - 发音人参数支持 voiceName / voice 两个名字（voiceName 优先）
 *     - rate / pitch / volume / token 允许传空串，空串按未传处理（用默认值）
 *
 * mode=sync（默认）：直接返回音频（output=stream 默认）或 base64。
 * mode=async：返回 taskId，走任务流程。
 */
import { randomUUID } from 'node:crypto';
import { errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const MODES = ['sync', 'async'];
const OUTPUTS = ['stream', 'base64'];

// MiMo 官方音色名列表（用于自动识别 provider）
const MIMO_VOICES = new Set([
  'mimo_default', '冰糖', '茉莉', '苏打', '白桦',
  'Mia', 'Chloe', 'Milo', 'Dean',
]);

/** 根据 voiceName 自动推断 provider；显式传了 provider 时优先使用 */
function detectProvider(voiceName, explicitProvider, defaultProvider) {
  if (explicitProvider) return explicitProvider;
  if (voiceName && MIMO_VOICES.has(voiceName)) return 'mimo';
  return defaultProvider;
}

/** 合并 query + body（body 优先）、做别名/空串归一，产出干净的参数对象 */
function pickParams(req) {
  const query = req.query || {};
  const body = req.body || {};
  const merged = { ...query, ...body };
  return {
    text: typeof merged.text === 'string' ? merged.text.trim() : '',
    mode: merged.mode || 'sync',
    provider: merged.provider || undefined,
    // 发音人：voiceName 与 voice 都认（voiceName 优先）
    voice: merged.voiceName || merged.voice || undefined,
    rate: merged.rate || undefined,
    pitch: merged.pitch || undefined,
    volume: merged.volume || undefined,
    format: merged.format || undefined,
    language: merged.language || undefined,
    output: merged.output || 'stream',
    requestId: merged.requestId || undefined,
    token: merged.token || undefined, // 调用方透传令牌，仅日志记录/可选鉴权，不参与合成
    responseField: merged.responseField || merged.playData || undefined, // 自定义响应字段名（如 ResponseData）
  };
}

export default async function ttsRoutes(app) {
  const { config, createProvider, semaphore, taskManager } = app.services;

  async function handleTts(req, reply, p) {
    const requestId = p.requestId || randomUUID();
    const startedAt = Date.now();

    // ---- 参数校验（手写，直观） ----
    const text = p.text;
    if (!text) throw errors.invalidParameter('text 必填且不能为空');

    const mode = p.mode;
    if (!MODES.includes(mode)) throw errors.invalidParameter(`mode 只能是 ${MODES.join('/')}`);

    const maxLen = mode === 'async' ? config.maxTextLengthAsync : config.maxTextLengthSync;
    if (text.length > maxLen) {
      throw errors.textTooLong(
        `文本长度 ${text.length} 超过上限 ${maxLen}${mode === 'sync' ? '，长文本可改用 mode=async' : ''}`
      );
    }

    const output = p.output;
    if (!OUTPUTS.includes(output)) throw errors.invalidParameter(`output 只能是 ${OUTPUTS.join('/')}`);

    // ---- 供应商（自动识别：MiMo 音色 → mimo，其余 → 默认） ----
    const providerName = detectProvider(p.voice, p.provider, config.defaultProvider);
    const provider = createProvider(providerName);

    const options = {
      voice: p.voice, // 缺省时由各 provider 用自己的默认音色
      rate: p.rate,
      pitch: p.pitch,
      volume: p.volume,
      format: p.format,
      language: p.language,
      token: p.token, // 透传给 provider，供上游鉴权（如 mimo API key）
    };

    // ---- 同步 ----
    if (mode === 'sync') {
      // 拿并发槽；超时 = 忙
      const release = await semaphore.acquire(config.acquireTimeoutMs).catch(() => null);
      if (!release) throw errors.rateLimited();
      try {
        const result = await provider.synthesize(text, options);
        logger.debug('tts 同步合成完成', {
          requestId, provider: provider.name, voice: options.voice, mode,
          format: result.format, bytes: result.audio.length, ms: Date.now() - startedAt,
        });
        if (output === 'base64') {
          // 支持自定义响应字段名（适配不同客户端 parser）
          const audioData = result.audio.toString('base64');
          if (p.responseField) {
            return { [p.responseField]: audioData };
          }
          return {
            audioBase64: audioData,
            format: result.format,
            extension: result.extension,
            bytes: result.audio.length,
            requestId,
          };
        }
        reply.header('Content-Type', result.contentType);
        reply.header('Content-Disposition', `attachment; filename="tts-${requestId}.${result.extension}"`);
        return reply.send(result.audio);
      } finally {
        release();
      }
    }

    // ---- 异步 ----
    const taskId = taskManager.submit({ provider: provider.name, text, ...options, requestId });
    logger.info('tts 异步任务已提交', { requestId, provider: provider.name, voice: options.voice, taskId });
    reply.code(202);
    return { taskId, status: 'pending', pollUrl: `/v1/tts/tasks/${taskId}` };
  }

  // 同一套处理逻辑，POST（JSON body）与 GET（query 参数）都支持
  app.post('/v1/tts', async (req, reply) => handleTts(req, reply, pickParams(req)));
  app.get('/v1/tts', async (req, reply) => handleTts(req, reply, pickParams(req)));
}