/**
 * 健康检查：GET /health（存活）、GET /ready（就绪）。
 */
export default async function healthRoutes(app) {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => ({ status: 'ok', ts: Date.now() }));
}