/**
 * 服务入口：装配 Fastify、注入 services、注册路由、统一错误处理。
 * 直接运行：node src/server.js（或 npm start）；也可 import buildApp 用于测试。
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { config } from './config.js';
import { createProvider, listProviders } from './providers/registry.js';
import { TaskManager } from './tasks/manager.js';
import { Semaphore } from './utils/semaphore.js';
import { toErrorResponse } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { closeProxyConnections } from './utils/proxy.js';
import ttsRoutes from './routes/tts.js';
import taskRoutes from './routes/tasks.js';
import voiceRoutes from './routes/voices.js';
import healthRoutes from './routes/health.js';
import adminRoutes from './routes/admin.js';
import cookie from '@fastify/cookie';
import { initDb, closeDb, isDbEnabled } from './db/pool.js';
import { loadConfigOverrides } from './admin/runtime-config.js';
import { ensureAdminUser, purgeExpiredSessions, verifyApiToken, countEnabledApiTokens } from './admin/auth.js';

const NO_AUTH_PATHS = new Set(['/health', '/ready']);

export function buildApp({ createProvider: providerFactory } = {}) {
  const app = Fastify({ logger: false });
  const create = providerFactory || createProvider; // 测试可注入假工厂

  // Cookie（管理端会话）
  app.register(cookie);

  // 兼容 application/x-www-form-urlencoded 请求体（客户端用 form 表单提交）
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body)));
    } catch (err) {
      done(err);
    }
  });

  // services（通过 app.services 访问，路由里解构使用）
  const semaphore = new Semaphore(config.concurrency);
  const taskManager = new TaskManager({
    // 任务执行：按 payload 里的供应商名创建新实例（无状态），并行安全
    synthesize: (payload) => create(payload.provider).synthesize(payload.text, payload),
    concurrency: Math.max(2, Math.floor(config.concurrency / 4)),
    ttlMs: config.taskTtlMs,
    dataDir: config.dataDir,
    cleanupIntervalMs: config.taskCleanupIntervalMs,
  });
  app.decorate('services', { config, createProvider: create, listProviders, taskManager, semaphore });

  // 可选鉴权：
  //  - 配了 API_KEY 环境变量：header x-api-key 或 query token 匹配即放行（兼容旧用法）
  //  - 启用了数据库：管理界面发放的调用 token 也可用（同样走这两个位置）
  //  - 两者都没配：不校验
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (NO_AUTH_PATHS.has(path)) return;
    if (path.startsWith('/admin')) return; // 管理端自己校验会话
    if (!config.apiKey && !isDbEnabled()) return;

    const queryToken = new URL(req.url, 'http://local').searchParams.get('token');
    const presented = req.headers['x-api-key'] || queryToken || '';
    if (config.apiKey && presented === config.apiKey) return;
    if (presented && (await verifyApiToken(presented))) return;
    return reply.code(401).send({ code: 'unauthorized', message: 'API Key 无效', requestId: req.id });
  });

  // 请求日志（debug 级别，生产环境 LOG_LEVEL=warn 可关闭）
  app.addHook('onResponse', async (req, reply) => {
    logger.debug('http', {
      method: req.method, url: req.url, status: reply.statusCode,
      ms: reply.elapsedTime, requestId: req.id,
    });
  });

  // 统一错误响应
  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body } = toErrorResponse(err, req.id);
    if (statusCode >= 500) {
      logger.error('请求处理失败', { requestId: req.id, url: req.url, code: body.code, error: err.message, stack: err.stack });
    } else {
      logger.warn('请求被拒绝', { requestId: req.id, url: req.url, code: body.code, message: err.message });
    }
    reply.code(statusCode).send(body);
  });

  // 404
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ code: 'route_not_found', message: `路由不存在: ${req.method} ${req.url}`, requestId: req.id });
  });

  // 优雅关闭
  app.addHook('onClose', () => {
    taskManager.stop();
    return Promise.all([closeProxyConnections(), closeDb()]);
  });

  // 静态文件服务（测试界面 + 管理界面）
  app.register(fastifyStatic, {
    root: join(import.meta.dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  // 注册路由
  app.register(healthRoutes);
  app.register(ttsRoutes);
  app.register(taskRoutes);
  app.register(voiceRoutes);
  app.register(adminRoutes);

  return app;
}

// 直接运行时启动服务（被测试 import 时不监听）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 先连数据库、加载运行时配置与初始管理员，再对外提供请求
  await initDb(config);
  await loadConfigOverrides();
  await ensureAdminUser();
  const purged = await purgeExpiredSessions();
  if (purged) logger.info('已清理过期管理会话', { count: purged });

  const app = buildApp();
  app.listen({ port: config.port, host: config.host }).then(() => {
    logger.info('read-tts 服务已启动', {
      port: config.port, providers: listProviders(),
      defaultVoice: config.defaultVoice, defaultProvider: config.defaultProvider,
      concurrency: config.concurrency,
      admin: isDbEnabled() ? '/admin' : '未启用（未配置 MYSQL_HOST）',
    });
  }).catch((err) => {
    logger.error('服务启动失败', { error: err.message });
    process.exit(1);
  });
}