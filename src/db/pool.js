/**
 * MySQL 连接池：管理端用户、会话、调用 token、运行时配置都存这里。
 *
 * 库表在启动时自动创建（CREATE TABLE IF NOT EXISTS），首次部署无需手工建库；
 * 未配置 MYSQL_HOST 时不连接，服务退化为「无管理端」模式，原有 TTS 功能不受影响。
 */
import mysql from 'mysql2/promise';
import { logger } from '../utils/logger.js';

let pool = null;

export function isDbEnabled() {
  return pool !== null;
}

export function getPool() {
  if (!pool) throw new Error('数据库未启用（未配置 MYSQL_HOST）');
  return pool;
}

/** 建表：幂等，可重复执行 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_user (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL DEFAULT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS admin_session (
    token CHAR(64) PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    INDEX idx_expires (expires_at),
    CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES admin_user(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // 对外调用 token：只存 SHA-256 摘要，明文仅在创建时返回一次
  `CREATE TABLE IF NOT EXISTS api_token (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    token_prefix VARCHAR(12) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP NULL DEFAULT NULL,
    expires_at TIMESTAMP NULL DEFAULT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // 运行时配置：覆盖环境变量，改完即时生效
  `CREATE TABLE IF NOT EXISTS app_config (
    config_key VARCHAR(64) PRIMARY KEY,
    config_value TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/**
 * 初始化连接池与表结构。
 * @returns {Promise<boolean>} 是否启用数据库
 */
export async function initDb(cfg) {
  if (!cfg.dbHost) {
    logger.info('未配置 MYSQL_HOST，管理端与配置库不可用，使用环境变量配置');
    return false;
  }
  pool = mysql.createPool({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPassword,
    database: cfg.dbName,
    waitForConnections: true,
    connectionLimit: cfg.dbPoolSize,
    charset: 'utf8mb4',
    timezone: 'Z',
  });
  // 连通性探测：失败直接抛，避免带病启动
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    for (const ddl of SCHEMA) await conn.query(ddl);
  } finally {
    conn.release();
  }
  logger.info('MySQL 已连接，表结构就绪', { host: cfg.dbHost, database: cfg.dbName });
  return true;
}

export async function closeDb() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
