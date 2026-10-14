/**
 * 运行时配置：数据库里的 app_config 覆盖环境变量。
 *
 * 读取顺序：数据库 > 环境变量 > 代码默认值。
 * 启动时加载一次进内存，管理界面修改后立即热更新，无需重启。
 */
import { getPool, isDbEnabled } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { normalizeProxyUrl } from '../utils/proxy.js';

/** 可在管理界面修改的配置项：key → { env 默认值, 校验/归一化 } */
export const CONFIG_SCHEMA = {
  MIMO_BASE_URL: {
    label: 'MiMo API 地址',
    description: '小米 MiMo 官方接口的基地址（OpenAI 兼容）',
    default: () => config.mimoBaseUrl,
    normalize: (v) => {
      const s = String(v ?? '').trim();
      if (!s) return '';
      const u = new URL(s);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('必须是 http/https 地址');
      return s.replace(/\/+$/, '');
    },
  },
  MIMO_API_KEY: {
    label: 'MiMo API Key',
    description: 'platform.xiaomimimo.com 注册获取；留空则 MiMo 不可用',
    default: () => config.mimoApiKey,
    normalize: (v) => String(v ?? '').trim(),
    secret: true,
  },
  MIMO_MODEL: {
    label: 'MiMo 模型 ID',
    description: 'TTS 模型名，以官方文档为准',
    default: () => config.mimoModel,
    normalize: (v) => String(v ?? '').trim(),
  },
  MIMO_VOICE: {
    label: 'MiMo 默认音色',
    description: '留空则请求必须显式传 voice',
    default: () => config.mimoDefaultVoice,
    normalize: (v) => String(v ?? '').trim(),
  },
};

// 内存态：键 → 当前生效值；只存数据库里显式设置过的项
let overrides = new Map();

/** 取生效值：数据库覆盖优先，其次环境变量默认 */
export function getConfigValue(key) {
  if (overrides.has(key)) return overrides.get(key);
  const item = CONFIG_SCHEMA[key];
  return item ? item.default() : undefined;
}

/** 列出全部可配置项（secret 值用掩码，避免下发前端） */
export function listConfig({ reveal = false } = {}) {
  return Object.entries(CONFIG_SCHEMA).map(([key, item]) => {
    const value = getConfigValue(key);
    const isSet = overrides.has(key);
    return {
      key,
      label: item.label,
      description: item.description,
      value: item.secret && !reveal ? maskSecret(value) : value,
      secret: Boolean(item.secret),
      source: isSet ? 'database' : 'env',
      hasValue: Boolean(value),
    };
  });
}

/** 掩码：只露末尾 4 位，便于确认是否配置 */
function maskSecret(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
}

/**
 * 写入配置。只接受 CONFIG_SCHEMA 中登记的键；
 * 空字符串表示清除覆盖、回落到环境变量。
 */
export async function setConfig(key, rawValue) {
  const item = CONFIG_SCHEMA[key];
  if (!item) throw new Error(`不支持的配置项: ${key}`);
  const value = item.normalize(rawValue);
  if (!isDbEnabled()) throw new Error('数据库未启用，无法保存配置');

  if (!value) {
    await getPool().query('DELETE FROM app_config WHERE config_key = ?', [key]);
    overrides.delete(key);
  } else {
    await getPool().query(
      'INSERT INTO app_config (config_key, config_value) VALUES (?, ?) ' +
        'ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
      [key, value]
    );
    overrides.set(key, value);
  }
  logger.info('运行时配置已更新', { key, source: value ? 'database' : 'env' });
  return getConfigValue(key);
}

/** 启动时从数据库加载覆盖项 */
export async function loadConfigOverrides() {
  if (!isDbEnabled()) return;
  const [rows] = await getPool().query('SELECT config_key, config_value FROM app_config');
  const next = new Map();
  for (const row of rows) {
    const item = CONFIG_SCHEMA[row.config_key];
    if (!item) {
      logger.warn('忽略未知配置项', { key: row.config_key });
      continue;
    }
    try {
      const value = item.normalize(row.config_value);
      if (value) next.set(row.config_key, value);
    } catch (err) {
      logger.warn('配置项归一化失败，已忽略', { key: row.config_key, error: err.message });
    }
  }
  overrides = next;
  logger.info('运行时配置已从数据库加载', { count: next.size });
}

/** 供供应商读取的便捷取值：MiMo 三项 + 代理 */
export function runtimeMimo() {
  return {
    baseUrl: getConfigValue('MIMO_BASE_URL'),
    apiKey: getConfigValue('MIMO_API_KEY'),
    model: getConfigValue('MIMO_MODEL'),
    defaultVoice: getConfigValue('MIMO_VOICE'),
    proxyUrl: normalizeProxyUrl(config.mimoProxyUrl, 'MIMO_PROXY_URL'),
  };
}
