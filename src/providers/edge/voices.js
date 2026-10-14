/**
 * Edge 发音人：优先在线拉取全量列表，失败回退内置精简清单。
 * 内置清单来自 2026-02 线上 voices/list 真实数据（挑常见语言）。
 */
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { getProxyDispatcher, normalizeProxyUrl } from '../../utils/proxy.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const VOICES_URL =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

// 中文显示名映射：上游只有罗马音（Xiaoxiao），汉字名由社区通用译名维护。
// 覆盖内置清单的语言（中/英/日/韩）；未收录的发音人 display 回退为 name。
export const VOICE_ZH_NAMES = {
  // 简体中文
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云晓',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-liaoning-XiaobeiNeural': '晓北（辽宁）',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮（陕西）',
  // 香港粤语
  'zh-HK-HiuGaaiNeural': '晓佳',
  'zh-HK-HiuMaanNeural': '晓曼',
  'zh-HK-WanLungNeural': '云龙',
  // 台湾国语
  'zh-TW-HsiaoChenNeural': '晓臻',
  'zh-TW-YunJheNeural': '云哲',
  'zh-TW-HsiaoYuNeural': '晓雨',
  // 英文
  'en-US-AriaNeural': '阿里娅',
  'en-US-GuyNeural': '盖伊',
  'en-US-JennyNeural': '珍妮',
  'en-US-AnaNeural': '安娜',
  'en-GB-SoniaNeural': '索妮娅',
  'en-GB-RyanNeural': '瑞安',
  'en-AU-NatashaNeural': '娜塔莎',
  // 日文
  'ja-JP-NanamiNeural': '七海',
  'ja-JP-KeitaNeural': '启太',
  // 韩文
  'ko-KR-SunHiNeural': '善姬',
  'ko-KR-InJoonNeural': '仁准',
  'ko-KR-HyunsuMultilingualNeural': '贤洙（多语言）',
};

// 内置精简清单（兜底用）：{ name, display, gender, locale }
export const BUILTIN_VOICES = [
  // 中文（14）
  { name: 'zh-CN-XiaoxiaoNeural', gender: 'Female', locale: 'zh-CN' },
  { name: 'zh-CN-XiaoyiNeural', gender: 'Female', locale: 'zh-CN' },
  { name: 'zh-CN-YunxiNeural', gender: 'Male', locale: 'zh-CN' },
  { name: 'zh-CN-YunyangNeural', gender: 'Male', locale: 'zh-CN' },
  { name: 'zh-CN-YunjianNeural', gender: 'Male', locale: 'zh-CN' },
  { name: 'zh-CN-YunxiaNeural', gender: 'Male', locale: 'zh-CN' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', gender: 'Female', locale: 'zh-CN' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', gender: 'Female', locale: 'zh-CN' },
  { name: 'zh-HK-HiuGaaiNeural', gender: 'Female', locale: 'zh-HK' },
  { name: 'zh-HK-HiuMaanNeural', gender: 'Female', locale: 'zh-HK' },
  { name: 'zh-HK-WanLungNeural', gender: 'Male', locale: 'zh-HK' },
  { name: 'zh-TW-HsiaoChenNeural', gender: 'Female', locale: 'zh-TW' },
  { name: 'zh-TW-HsiaoYuNeural', gender: 'Female', locale: 'zh-TW' },
  { name: 'zh-TW-YunJheNeural', gender: 'Male', locale: 'zh-TW' },
  // 英文（常用）
  { name: 'en-US-AriaNeural', gender: 'Female', locale: 'en-US' },
  { name: 'en-US-GuyNeural', gender: 'Male', locale: 'en-US' },
  { name: 'en-US-JennyNeural', gender: 'Female', locale: 'en-US' },
  { name: 'en-US-AnaNeural', gender: 'Female', locale: 'en-US' },
  { name: 'en-GB-SoniaNeural', gender: 'Female', locale: 'en-GB' },
  { name: 'en-GB-RyanNeural', gender: 'Male', locale: 'en-GB' },
  { name: 'en-AU-NatashaNeural', gender: 'Female', locale: 'en-AU' },
  // 日 / 韩
  { name: 'ja-JP-NanamiNeural', gender: 'Female', locale: 'ja-JP' },
  { name: 'ja-JP-KeitaNeural', gender: 'Male', locale: 'ja-JP' },
  { name: 'ko-KR-SunHiNeural', gender: 'Female', locale: 'ko-KR' },
  { name: 'ko-KR-InJoonNeural', gender: 'Male', locale: 'ko-KR' },
];

const caches = new Map();
const CACHE_TTL_MS = 3600_000; // 在线清单缓存 1h

/** 统一输出结构：附带中文显示名（未收录则回退原名） */
function withDisplay(v) {
  return {
    name: v.name,
    display: VOICE_ZH_NAMES[v.name] || v.name,
    gender: v.gender,
    locale: v.locale,
    ...(v.friendlyName ? { friendlyName: v.friendlyName } : {}),
  };
}

/**
 * 获取发音人列表：在线优先（缓存 1h），失败回退内置。
 * @returns {Promise<Array<{name, display, gender, locale, friendlyName?}>>}
 */
export async function fetchVoices(force = false, { proxyUrl = config.edgeProxyUrl } = {}) {
  const cacheKey = normalizeProxyUrl(proxyUrl, 'EDGE_PROXY_URL');
  const cached = caches.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.voices;
  let voices;
  try {
    const dispatcher = getProxyDispatcher(cacheKey);
    const res = await fetch(VOICES_URL, {
      signal: AbortSignal.timeout(10_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    voices = list
      .map((v) => withDisplay({
        name: v.ShortName,
        gender: v.Gender,
        locale: v.Locale,
        friendlyName: v.FriendlyName,
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale));
    logger.info('Edge 发音人在线获取成功', { count: voices.length });
  } catch (err) {
    logger.warn('Edge 发音人在线获取失败，回退内置清单', { error: err.message });
    voices = BUILTIN_VOICES.map(withDisplay);
  }
  // 失败也缓存，避免频繁打上游；不同出口不共用缓存。
  caches.set(cacheKey, { voices, at: Date.now() });
  return voices;
}