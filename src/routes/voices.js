/**
 * GET /v1/voices —— 发音人列表（可按供应商过滤）。
 * query: provider（默认取配置）、refresh=true 可强制刷新在线清单。
 */
import { logger } from '../utils/logger.js';

export default async function voiceRoutes(app) {
  const { config, createProvider } = app.services;

  app.get('/v1/voices', async (req) => {
    const provider = createProvider(req.query?.provider || config.defaultProvider);
    const voices = await provider.getVoices();
    logger.info('发音人列表', { provider: provider.name, count: voices.length });
    return { provider: provider.name, count: voices.length, voices };
  });
}