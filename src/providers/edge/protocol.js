/**
 * Edge「大声朗读」协议层：连接 + Sec-MS-GEC + speech.config + SSML + 音频收集。
 * 参考社区实现（msedge-tts 2.0.7）逆向而来的消息格式，自研实现，仅依赖 ws。
 *
 * 2026-10 起旧端点 speech.platform.bing.com 对合成 WebSocket 返回 403，
 * 微软 Edge 155 已改用 api.msedgeservices.com（见 rany2/edge-tts PR #491）。
 * 该端点接受同一个 token，但参数名为 Ocp-Apim-Subscription-Key。
 * 音色列表仍由旧端点提供，见 voices.js。
 */
import WebSocket from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import { errors } from '../../utils/errors.js';
import { getWebSocketProxyAgent } from '../../utils/proxy.js';

const WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-143.0.3650.96';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const DELIM = '\r\n\r\n';
const AUDIO_DELIM = 'Path:audio\r\n';

/**
 * 生成 Sec-MS-GEC 签名：
 *   ticks = unix秒 + 11644473600（换算成 Windows FILETIME）
 *   向下取整到 5 分钟（300s），再乘 10^7 得到 FILETIME 计数
 *   SHA-256(`${计数}${token}`) 转大写 hex
 * nowMs 可注入以便测试。
 */
export function generateSecMsGec(token = TRUSTED_CLIENT_TOKEN, nowMs = Date.now()) {
  const ticks = Math.floor(nowMs / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const windowsTicks = rounded * 10000000;
  const hash = createHash('sha256').update(`${windowsTicks}${token}`).digest('hex');
  return hash.toUpperCase();
}

/** 组装 WebSocket 连接地址（每次连接换新的 ConnectionId 和签名） */
export function buildWsUrl(nowMs = Date.now()) {
  const qs = new URLSearchParams({
    // 新端点沿用同一个 token，参数名是 Ocp-Apim-Subscription-Key
    'Ocp-Apim-Subscription-Key': TRUSTED_CLIENT_TOKEN,
    'Sec-MS-GEC': generateSecMsGec(TRUSTED_CLIENT_TOKEN, nowMs),
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
    ConnectionId: randomUUID(),
  });
  return `${WSS_URL}?${qs.toString()}`;
}

/** 连接建立后先发这条消息，声明输出音频格式 */
function buildSpeechConfig(format) {
  const payload = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: 'false',
            wordBoundaryEnabled: 'false',
          },
          outputFormat: format,
        },
      },
    },
  };
  return `Content-Type:application/json; charset=utf-8\r\nPath:speech.config${DELIM}${JSON.stringify(payload)}`;
}

function escapeXml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

/** 组装 SSML 合成请求 */
function buildSsmlRequest({ voice, lang, text, rate, pitch, volume }) {
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
    `<voice name="${voice}">` +
    `<prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${escapeXml(text)}</prosody>` +
    `</voice></speak>`;
  return `X-RequestId:${randomUUID()}\r\nContent-Type:application/ssml+xml\r\nPath:ssml${DELIM}${ssml}`;
}

/**
 * 单次合成。
 * @param {object} params
 * @param {string} params.voice 发音人 shortName
 * @param {string} params.lang  语言（xml:lang）
 * @param {string} params.text  文本
 * @param {string} params.rate  如 +0% / +10%
 * @param {string} params.pitch 如 +0Hz
 * @param {string} params.volume 如 +0%
 * @param {string} params.format 完整输出格式串
 * @param {string} params.contentType 对应 MIME
 * @param {number} params.timeoutMs 超时
 * @returns {Promise<{audio: Buffer, contentType: string}>}
 * 失败抛 retryable 的 502 错误（上游问题），由上层重试。
 */
export function synthesizeAudio({
  voice, lang, text, rate, pitch, volume, format, contentType, timeoutMs, proxyUrl = '',
}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildWsUrl(), {
      headers: { 'User-Agent': USER_AGENT, Origin: ORIGIN },
      handshakeTimeout: timeoutMs,
      agent: getWebSocketProxyAgent(proxyUrl),
    });
    const chunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      ws.terminate(); // 触发 close，但 settled 已置位不会再 reject
      settle(() => reject(errors.upstreamTimeout(`上游合成超时（${timeoutMs}ms）`)));
    }, timeoutMs);

    // settle 保证只结算一次：成功/失败/超时互斥
    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    ws.on('open', () => {
      ws.send(buildSpeechConfig(format));
      ws.send(buildSsmlRequest({ voice, lang, text, rate, pitch, volume }));
    });

    ws.on('message', (data) => {
      const buf = Buffer.from(data);
      const head = buf.toString('utf8', 0, Math.min(buf.length, 512));

      if (head.includes('Path:turn.end')) {
        // 合成结束，拼接所有音频块
        settle(() => {
          ws.close();
          resolve({ audio: Buffer.concat(chunks), contentType });
        });
      } else if (head.includes(AUDIO_DELIM)) {
        // 音频块：header 在 'Path:audio\r\n' 之前，之后全是对应音频字节
        const idx = buf.indexOf(AUDIO_DELIM);
        chunks.push(buf.subarray(idx + AUDIO_DELIM.length));
      }
      // turn.start / response 等消息直接忽略
    });

    ws.on('error', (err) =>
      settle(() => reject(errors.upstreamError(`Edge TTS 连接失败: ${err.message}`)))
    );

    ws.on('close', () => {
      // 没收到 turn.end 就关闭 = 音频不完整，按失败处理（可重试）
      settle(() => reject(errors.upstreamError('上游连接提前关闭，音频可能不完整')));
    });
  });
}