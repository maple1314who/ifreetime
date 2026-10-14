/**
 * 管理端认证：账号密码登录 → 会话（Cookie），与对外调用 token 完全分离。
 *
 * - 密码用 bcrypt 哈希存储
 * - 会话 token 只存 SHA-256 摘要，随机 32 字节
 * - 对外调用 token 同样只存摘要，明文仅创建时返回一次
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getPool, isDbEnabled } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const BCRYPT_ROUNDS = 10;
const SESSION_COOKIE = 'rtts_session';

export { SESSION_COOKIE };

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** 生成前缀便于识别的调用 token：rtts_<32字节hex> */
function generateApiToken() {
  return `rtts_${randomBytes(32).toString('hex')}`;
}

/**
 * 首次启动初始化：用户表为空且配置了 ADMIN_PASSWORD 时创建管理员。
 * 已有管理员则不覆盖，避免重置线上账号。
 */
export async function ensureAdminUser() {
  if (!isDbEnabled()) return;
  const [[{ n }]] = await getPool().query('SELECT COUNT(*) AS n FROM admin_user');
  if (n > 0) return;
  if (!config.adminPassword) {
    logger.warn('用户表为空且未配置 ADMIN_PASSWORD，管理端暂无可用账号', {
      hint: '设置 ADMIN_PASSWORD 后重启即可创建管理员',
    });
    return;
  }
  const hash = await bcrypt.hash(config.adminPassword, BCRYPT_ROUNDS);
  await getPool().query('INSERT INTO admin_user (username, password_hash) VALUES (?, ?)', [
    config.adminUsername,
    hash,
  ]);
  logger.info('已创建初始管理员账号', { username: config.adminUsername });
}

/** 校验账号密码；成功返回用户信息，失败返回 null */
export async function verifyLogin(username, password) {
  if (!isDbEnabled()) throw new Error('数据库未启用，管理端不可用');
  const [rows] = await getPool().query(
    'SELECT id, username, password_hash FROM admin_user WHERE username = ? LIMIT 1',
    [username]
  );
  const user = rows[0];
  if (!user) return null;
  const ok = await bcrypt.compare(String(password ?? ''), user.password_hash);
  if (!ok) return null;
  await getPool().query('UPDATE admin_user SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
  return { id: user.id, username: user.username };
}

/** 签发会话，返回明文 token（写入 Cookie） */
export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await getPool().query(
    'INSERT INTO admin_session (token, user_id, expires_at) VALUES (?, ?, ?)',
    [sha256(token), userId, expiresAt]
  );
  return { token, expiresAt };
}

/** 用会话 token 取用户；过期返回 null 并顺手清理 */
export async function getSessionUser(token) {
  if (!isDbEnabled() || !token) return null;
  const digest = sha256(token);
  const [rows] = await getPool().query(
    `SELECT s.token, s.expires_at, u.id, u.username
       FROM admin_session s JOIN admin_user u ON u.id = s.user_id
      WHERE s.token = ? LIMIT 1`,
    [digest]
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await getPool().query('DELETE FROM admin_session WHERE token = ?', [digest]);
    return null;
  }
  return { id: row.id, username: row.username };
}

export async function destroySession(token) {
  if (!isDbEnabled() || !token) return;
  await getPool().query('DELETE FROM admin_session WHERE token = ?', [sha256(token)]);
}

/** 清理过期会话（启动时调用） */
export async function purgeExpiredSessions() {
  if (!isDbEnabled()) return 0;
  const [res] = await getPool().query('DELETE FROM admin_session WHERE expires_at <= NOW()');
  return res.affectedRows ?? 0;
}

// ---------------- 对外调用 token ----------------

/** 新建调用 token，明文只返回这一次 */
export async function createApiToken({ name, expiresAt = null }) {
  const token = generateApiToken();
  const [res] = await getPool().query(
    'INSERT INTO api_token (name, token_hash, token_prefix, expires_at) VALUES (?, ?, ?, ?)',
    [String(name || '未命名').slice(0, 64), sha256(token), token.slice(0, 12), expiresAt]
  );
  logger.info('已创建调用 token', { id: res.insertId, name });
  return { id: res.insertId, token, name, prefix: token.slice(0, 12), expiresAt };
}

export async function listApiTokens() {
  const [rows] = await getPool().query(
    `SELECT id, name, token_prefix, enabled, created_at, last_used_at, expires_at
       FROM api_token ORDER BY id DESC`
  );
  return rows;
}

export async function setApiTokenEnabled(id, enabled) {
  const [res] = await getPool().query('UPDATE api_token SET enabled = ? WHERE id = ?', [
    enabled ? 1 : 0,
    id,
  ]);
  return res.affectedRows > 0;
}

export async function deleteApiToken(id) {
  const [res] = await getPool().query('DELETE FROM api_token WHERE id = ?', [id]);
  return res.affectedRows > 0;
}

/**
 * 校验调用 token：命中且启用、未过期则放行，并异步记录使用时间。
 * 用恒定时间比较摘要，避免时序侧信道。
 */
export async function verifyApiToken(token) {
  if (!isDbEnabled() || !token) return false;
  const [rows] = await getPool().query(
    'SELECT id, token_hash, expires_at, enabled FROM api_token WHERE token_hash = ? LIMIT 1',
    [sha256(token)]
  );
  const row = rows[0];
  if (!row) return false;
  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(sha256(token), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  if (!row.enabled) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return false;
  getPool()
    .query('UPDATE api_token SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id])
    .catch((err) => logger.warn('更新 token 使用时间失败', { error: err.message }));
  return true;
}

/** 是否存在任何调用 token（用于决定是否强制鉴权） */
export async function countEnabledApiTokens() {
  if (!isDbEnabled()) return 0;
  const [[{ n }]] = await getPool().query('SELECT COUNT(*) AS n FROM api_token WHERE enabled = 1');
  return Number(n);
}

// ---------------- 管理端用户 ----------------

export async function listUsers() {
  const [rows] = await getPool().query(
    'SELECT id, username, created_at, last_login_at FROM admin_user ORDER BY id'
  );
  return rows;
}

export async function createUser(username, password) {
  const name = String(username ?? '').trim();
  if (!name) throw new Error('用户名不能为空');
  if (String(password ?? '').length < 6) throw new Error('密码至少 6 位');
  const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  const [res] = await getPool().query(
    'INSERT INTO admin_user (username, password_hash) VALUES (?, ?)',
    [name, hash]
  );
  return { id: res.insertId, username: name };
}

export async function changePassword(id, newPassword) {
  if (String(newPassword ?? '').length < 6) throw new Error('密码至少 6 位');
  const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  const [res] = await getPool().query('UPDATE admin_user SET password_hash = ? WHERE id = ?', [
    hash,
    id,
  ]);
  // 改密后清掉该用户所有会话，强制重新登录
  await getPool().query('DELETE FROM admin_session WHERE user_id = ?', [id]);
  return res.affectedRows > 0;
}

export async function deleteUser(id) {
  const [[{ n }]] = await getPool().query('SELECT COUNT(*) AS n FROM admin_user');
  if (Number(n) <= 1) throw new Error('至少保留一个管理员账号');
  const [res] = await getPool().query('DELETE FROM admin_user WHERE id = ?', [id]);
  return res.affectedRows > 0;
}
