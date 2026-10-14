import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecMsGec, buildWsUrl } from '../src/providers/edge/protocol.js';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

test('Sec-MS-GEC：固定时间戳的 SHA-256 大写 hex（与参考实现向量一致）', () => {
  // now=2025-01-01T00:00:00Z，向量用 Python 独立计算
  assert.equal(generateSecMsGec(TOKEN, 1735689600000), 'B0EDD22C7C09868E2F24C10264A8A3EB877773A7B6040B68AFA4FBCBABEA0238');
});

test('Sec-MS-GEC：向下取整到 5 分钟，同一 5 分钟窗口内不变', () => {
  const a = generateSecMsGec(TOKEN, 1735689600000);
  const b = generateSecMsGec(TOKEN, 1735689601000); // +1s，仍在同一窗口
  const c = generateSecMsGec(TOKEN, 1735689600000 + 299_000); // +299s，同一窗口
  const d = generateSecMsGec(TOKEN, 1735689600000 + 300_000); // +300s，跨窗口
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, d);
});

test('buildWsUrl：指向 api.msedgeservices.com，含 token、签名与 uuid ConnectionId', () => {
  const url = new URL(buildWsUrl(1735689600000));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.host, 'api.msedgeservices.com');
  assert.equal(url.pathname, '/tts/cognitiveservices/websocket/v1');
  // 新端点沿用同一 token，参数名为 Ocp-Apim-Subscription-Key
  assert.equal(url.searchParams.get('Ocp-Apim-Subscription-Key'), TOKEN);
  assert.equal(url.searchParams.get('Sec-MS-GEC'), 'B0EDD22C7C09868E2F24C10264A8A3EB877773A7B6040B68AFA4FBCBABEA0238');
  assert.match(url.searchParams.get('ConnectionId'), /^[0-9a-f-]{36}$/);
  assert.ok(url.searchParams.has('Sec-MS-GEC-Version'));
});