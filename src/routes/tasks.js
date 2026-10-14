/**
 * 异步任务管理接口：
 *   GET    /v1/tts/tasks/:id       查询状态
 *   GET    /v1/tts/tasks/:id/audio 下载音频（成功后可下）
 *   DELETE /v1/tts/tasks/:id       删除任务及文件
 */
import { createReadStream } from 'node:fs';
import { logger } from '../utils/logger.js';

export default async function taskRoutes(app) {
  const { taskManager } = app.services;

  app.get('/v1/tts/tasks/:id', async (req) => {
    const info = taskManager.status(req.params.id);
    logger.debug('查询任务', { taskId: req.params.id, status: info.status });
    return info;
  });

  app.get('/v1/tts/tasks/:id/audio', async (req, reply) => {
    const filePath = taskManager.audioPath(req.params.id); // 未成功/不存在会抛错
    const info = taskManager.status(req.params.id);
    reply.header('Content-Type', info.result?.contentType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${req.params.id}.${info.result?.extension || 'bin'}"`);
    return reply.send(createReadStream(filePath));
  });

  app.delete('/v1/tts/tasks/:id', async (req) => {
    await taskManager.remove(req.params.id);
    logger.info('任务已删除', { taskId: req.params.id });
    return { deleted: true, taskId: req.params.id };
  });
}