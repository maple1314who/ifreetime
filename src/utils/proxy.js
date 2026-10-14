import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

const dispatchers = new Map();
const websocketAgents = new Map();

export function normalizeProxyUrl(value, name = 'proxyUrl') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} 必须是有效的 HTTP/HTTPS 代理地址`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} 仅支持 HTTP/HTTPS 代理地址（不含路径、查询参数或片段）`);
  }
  return url.href;
}

export function getProxyDispatcher(proxyUrl) {
  const url = normalizeProxyUrl(proxyUrl);
  if (!url) return undefined;
  if (!dispatchers.has(url)) {
    dispatchers.set(url, new ProxyAgent({ uri: url, connectTimeout: 10_000 }));
  }
  return dispatchers.get(url);
}

export function getWebSocketProxyAgent(proxyUrl) {
  const url = normalizeProxyUrl(proxyUrl);
  if (!url) return undefined;
  if (!websocketAgents.has(url)) {
    websocketAgents.set(url, new HttpsProxyAgent(url, { timeout: 10_000 }));
  }
  return websocketAgents.get(url);
}

export async function closeProxyConnections() {
  const active = [...dispatchers.values()];
  dispatchers.clear();
  for (const agent of websocketAgents.values()) agent.destroy();
  websocketAgents.clear();
  await Promise.all(active.map((dispatcher) => dispatcher.destroy()));
}
