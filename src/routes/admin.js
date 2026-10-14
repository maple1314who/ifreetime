/**
 * 管理端路由：/admin/api/*
 *
 * 认证方式与会话分离：
 *   - 账号密码登录 → 会话 Cookie（rtts_session），仅管理端使用
 *   - 对外调用 token（rtts_xxx）→ 用于 /v1/tts，不参与管理端登录
 */
import { config } from '../config.js';
import { isDbEnabled } from '../db/pool.js';
import {
  createApiToken, createSession, createUser, changePassword, deleteApiToken, deleteUser,
  destroySession, getSessionUser, listApiTokens, listUsers, setApiTokenEnabled, verifyLogin,
  SESSION_COOKIE, countEnabledApiTokens,
} from '../admin/auth.js';
import { CONFIG_SCHEMA, listConfig, setConfig } from '../admin/runtime-config.js';
import { logger } from '../utils/logger.js';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: true, // 线上走 HTTPS（nginx 反代）
};

function clearCookie(reply) {
  reply.setCookie(SESSION_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0 });
}

/** 从 Cookie 取会话 token */
function sessionToken(req) {
  return req.cookies?.[SESSION_COOKIE] || '';
}

export default async function adminRoutes(app) {
  // 未启用数据库时，管理端整体不可用（TTS 本身不受影响）
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin')) return;
    if (!isDbEnabled()) {
      return reply.code(503).send({
        code: 'admin_disabled',
        message: '未配置 MYSQL_HOST，管理端不可用',
        requestId: req.id,
      });
    }
  });

  // ---- 会话 ----
  app.post('/admin/api/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const user = await verifyLogin(username, password);
    if (!user) {
      logger.warn('管理端登录失败', { username, ip: req.ip });
      return reply.code(401).send({ code: 'invalid_credentials', message: '用户名或密码错误' });
    }
    const { token, expiresAt } = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, {
      ...COOKIE_OPTS,
      expires: expiresAt,
    });
    logger.info('管理端登录成功', { username: user.username, ip: req.ip });
    return { username: user.username };
  });

  app.post('/admin/api/logout', async (req, reply) => {
    await destroySession(sessionToken(req));
    clearCookie(reply);
    return { ok: true };
  });

  app.get('/admin/api/me', async (req) => {
    const user = await getSessionUser(sessionToken(req));
    return { user };
  });

  // ---- 以下接口都要求已登录 ----
  app.register(async (scoped) => {
    scoped.addHook('onRequest', async (req, reply) => {
      const user = await getSessionUser(sessionToken(req));
      if (!user) {
        return reply.code(401).send({ code: 'unauthorized', message: '请先登录' });
      }
      req.adminUser = user;
    });

    // 概览
    scoped.get('/admin/api/overview', async () => ({
      providers: app.services.listProviders(),
      defaults: {
        provider: config.defaultProvider,
        voice: config.defaultVoice,
        format: config.defaultFormat,
      },
      tokens: { enabled: await countEnabledApiTokens() },
      upstream: { edge: 'api.msedgeservices.com', mimo: CONFIG_SCHEMA.MIMO_BASE_URL ? undefined : undefined },
    }));

    // 运行时配置（MiMo 地址与 Key 等）
    scoped.get('/admin/api/config', async () => ({ items: listConfig() }));

    scoped.put('/admin/api/config/:key', async (req, reply) => {
      const { key } = req.params;
      const { value } = req.body || {};
      try {
        const saved = await setConfig(key, value);
        return { key, value: CONFIG_SCHEMA[key]?.secret ? undefined : saved, ok: true };
      } catch (err) {
        return reply.code(400).send({ code: 'invalid_config', message: err.message });
      }
    });

    // 调用 token
    scoped.get('/admin/api/tokens', async () => ({ items: await listApiTokens() }));

    scoped.post('/admin/api/tokens', async (req, reply) => {
      const { name, expiresAt } = req.body || {};
      if (!name || !String(name).trim()) {
        return reply.code(400).send({ code: 'invalid_parameter', message: '请填写 token 名称' });
      }
      const created = await createApiToken({ name: String(name).trim(), expiresAt: expiresAt || null });
      // 明文 token 仅此一次返回
      return reply.code(201).send(created);
    });

    scoped.post('/admin/api/tokens/:id/toggle', async (req, reply) => {
      const { enabled } = req.body || {};
      const ok = await setApiTokenEnabled(Number(req.params.id), Boolean(enabled));
      if (!ok) return reply.code(404).send({ code: 'not_found', message: 'token 不存在' });
      return { ok: true };
    });

    scoped.delete('/admin/api/tokens/:id', async (req, reply) => {
      const ok = await deleteApiToken(Number(req.params.id));
      if (!ok) return reply.code(404).send({ code: 'not_found', message: 'token 不存在' });
      return { ok: true };
    });

    // 管理员账号
    scoped.get('/admin/api/users', async () => ({ items: await listUsers() }));

    scoped.post('/admin/api/users', async (req, reply) => {
      const { username, password } = req.body || {};
      try {
        return reply.code(201).send(await createUser(username, password));
      } catch (err) {
        const duplicate = /Duplicate entry/i.test(err.message);
        return reply
          .code(duplicate ? 409 : 400)
          .send({ code: duplicate ? 'duplicate_user' : 'invalid_parameter', message: duplicate ? '用户名已存在' : err.message });
      }
    });

    scoped.post('/admin/api/users/:id/password', async (req, reply) => {
      const { password } = req.body || {};
      try {
        const ok = await changePassword(Number(req.params.id), password);
        if (!ok) return reply.code(404).send({ code: 'not_found', message: '用户不存在' });
        return { ok: true, relogin: true };
      } catch (err) {
        return reply.code(400).send({ code: 'invalid_parameter', message: err.message });
      }
    });

    scoped.delete('/admin/api/users/:id', async (req, reply) => {
      try {
        const ok = await deleteUser(Number(req.params.id));
        if (!ok) return reply.code(404).send({ code: 'not_found', message: '用户不存在' });
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ code: 'invalid_operation', message: err.message });
      }
    });
  });
}
