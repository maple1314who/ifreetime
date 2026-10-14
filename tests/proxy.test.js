/**
 * 代理配置单测：地址校验、按出口缓存、WebSocket 代理 agent。
 * 不访问真实网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProxyUrl, getProxyDispatcher, getWebSocketProxyAgent, closeProxyConnections,
} from '../src/utils/proxy.js';

test('normalizeProxyUrl：空值/空白 → 直连（空串）', () => {
  assert.equal(normalizeProxyUrl(''), '');
  assert.equal(normalizeProxyUrl('   '), '');
  assert.equal(normalizeProxyUrl(undefined), '');
  assert.equal(normalizeProxyUrl(null), '');
});

test('normalizeProxyUrl：HTTP/HTTPS 代理地址归一化', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(normalizeProxyUrl('http://user:pass@resin:2260'), 'http://user:pass@resin:2260/');
  assert.equal(normalizeProxyUrl('https://proxy.local:3128'), 'https://proxy.local:3128/');
});

test('normalizeProxyUrl：非法协议或带路径 → 报错，避免悄悄直连', () => {
  assert.throws(() => normalizeProxyUrl('socks5://127.0.0.1:1080'), /仅支持 HTTP\/HTTPS/);
  assert.throws(() => normalizeProxyUrl('127.0.0.1:8080'), /有效的 HTTP\/HTTPS/);
  assert.throws(() => normalizeProxyUrl('http://resin:2260/proxy'), /仅支持 HTTP\/HTTPS/);
  assert.throws(() => normalizeProxyUrl('http://resin:2260/?a=1'), /仅支持 HTTP\/HTTPS/);
});

test('getProxyDispatcher：同地址复用，空地址返回 undefined（直连）', () => {
  assert.equal(getProxyDispatcher(''), undefined);
  const a = getProxyDispatcher('http://127.0.0.1:9999');
  const b = getProxyDispatcher('http://127.0.0.1:9999');
  assert.ok(a);
  assert.equal(a, b, '同代理地址应复用同一 dispatcher');
});

test('getWebSocketProxyAgent：返回 https-proxy-agent 实例', () => {
  assert.equal(getWebSocketProxyAgent(''), undefined);
  const agent = getWebSocketProxyAgent('http://127.0.0.1:9999');
  assert.ok(agent);
  assert.equal(agent.constructor.name, 'HttpsProxyAgent');
});

test('closeProxyConnections：清空缓存并可重复调用', async () => {
  getProxyDispatcher('http://127.0.0.1:9998');
  getWebSocketProxyAgent('http://127.0.0.1:9998');
  await closeProxyConnections();
  await closeProxyConnections();
  assert.notEqual(getProxyDispatcher('http://127.0.0.1:9998'), undefined, '关闭后仍可新建');
});
