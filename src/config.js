/**
 * 集中配置：默认值 + 环境变量覆盖（TL;DR：PORT / CONCURRENCY / API_KEY 等）。
 */
import { normalizeProxyUrl } from './utils/proxy.js';

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envInt(name, def) {
  const v = Number(env(name, def));
  return Number.isFinite(v) ? v : def;
}

export const config = {
  // 服务
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 3000),

  // TTS 默认
  defaultProvider: env('DEFAULT_PROVIDER', 'edge'),
  defaultVoice: env('DEFAULT_VOICE', 'zh-CN-XiaoxiaoNeural'),
  defaultFormat: env('DEFAULT_FORMAT', 'mp3'),

  // 每家供应商单独配置出口；留空直连
  edgeProxyUrl: normalizeProxyUrl(env('EDGE_PROXY_URL', ''), 'EDGE_PROXY_URL'),
  mimoProxyUrl: normalizeProxyUrl(env('MIMO_PROXY_URL', ''), 'MIMO_PROXY_URL'),

  // MiMo（小米）官方 API（OpenAI 兼容）
  mimoApiKey: env('MIMO_API_KEY', ''),   // platform.xiaomimimo.com 注册获取
  mimoBaseUrl: env('MIMO_BASE_URL', 'https://api.xiaomimimo.com/v1'),
  mimoModel: env('MIMO_MODEL', 'mimo-v2.5-tts'),   // TTS 模型 ID（以官方文档为准，可改）
  mimoDefaultVoice: env('MIMO_VOICE', ''),    // 默认音色（官方预设，留空则必须显式传 voice）

  // 文本长度限制
  maxTextLengthSync: envInt('MAX_TEXT_LENGTH_SYNC', 1000),
  maxTextLengthAsync: envInt('MAX_TEXT_LENGTH_ASYNC', 10000),

  // 并发与超时
  concurrency: envInt('CONCURRENCY', 16),          // 同步合成并发上限
  acquireTimeoutMs: envInt('ACQUIRE_TIMEOUT_MS', 10000), // 拿不到并发槽的等待时间
  upstreamTimeoutMs: envInt('UPSTREAM_TIMEOUT_MS', 30000), // 上游合成超时
  retries: envInt('UPSTREAM_RETRIES', 1),          // 上游失败自动重试次数

  // 异步任务
  taskTtlMs: envInt('TASK_TTL_MS', 24 * 3600 * 1000),       // 音频保留 24h
  taskCleanupIntervalMs: envInt('TASK_CLEANUP_INTERVAL_MS', 60 * 60 * 1000),
  dataDir: env('DATA_DIR', 'data'),

  // 鉴权（留空 = 不校验）
  apiKey: env('API_KEY', ''),

  // MySQL（管理端用户/会话/调用 token/运行时配置）；留空 = 不启用管理端
  dbHost: env('MYSQL_HOST', ''),
  dbPort: envInt('MYSQL_PORT', 3306),
  dbUser: env('MYSQL_USER', 'root'),
  dbPassword: env('MYSQL_PASSWORD', ''),
  dbName: env('MYSQL_DATABASE', 'read_tts'),
  dbPoolSize: envInt('MYSQL_POOL_SIZE', 5),

  // 管理端：初始管理员（仅首次启动且用户表为空时创建）
  adminUsername: env('ADMIN_USERNAME', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', ''),
  sessionTtlMs: envInt('SESSION_TTL_MS', 7 * 24 * 3600 * 1000), // 登录态有效期 7 天
};