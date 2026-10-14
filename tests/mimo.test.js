/**
 * Mimo（小米官方 API）adapter 单测：注入假 fetch，验证请求构造与错误路径。
 * 真实合成需要 MIMO_API_KEY，不在此测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MimoProvider, MIMO_VOICES } from '../src/providers/mimo/provider.js';
import { AppError } from '../src/utils/errors.js';

const FAKE_AUDIO = Buffer.from([1, 2, 3, 4, 5]);

/** 构造 chat completions 风格响应：音频在 choices[0].message.audio.data（base64） */
function okResponse(audio = FAKE_AUDIO) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      choices: [{ message: { audio: { data: audio.toString('base64') } } }],
      usage: { total_tokens: 12 },
    }),
    text: async () => '',
  };
}

function makeProvider(handler, opts = {}) {
  return new MimoProvider({
    apiKey: 'test-key-123',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    defaultVoice: '',
    fetch: async (url, o) => handler(url, o),
    ...opts,
  });
}

test('synthesize：请求构造正确（端点/鉴权/messages/modalities/audio）', async () => {
  let captured;
  const p = makeProvider((url, opts) => {
    captured = { url, opts };
    return okResponse();
  });
  const result = await p.synthesize('你好世界', { voice: '冰糖', format: 'mp3' });

  assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'Bearer test-key-123');
  assert.equal(captured.opts.headers['x-api-key'], 'test-key-123');

  const body = JSON.parse(captured.opts.body);
  assert.equal(body.model, 'mimo-v2.5-tts');
  assert.deepEqual(body.modalities, ['text', 'audio']);
  assert.deepEqual(body.audio, { voice: '冰糖', format: 'mp3' });
  assert.equal(body.messages.at(-1).content, '你好世界');

  assert.deepEqual(Array.from(result.audio), [1, 2, 3, 4, 5]);
  assert.equal(result.extension, 'mp3');
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.format, 'mp3');
});

test('synthesize：请求级 token 覆盖构造时的 apiKey', async () => {
  let captured;
  const p = makeProvider((url, opts) => { captured = opts; return okResponse(); });
  await p.synthesize('a', { voice: '冰糖', token: 'request-key' });
  assert.equal(captured.headers.Authorization, 'Bearer request-key');
});

test('synthesize：format 别名映射到官方格式', async () => {
  const seen = [];
  const p = makeProvider((url, opts) => { seen.push(JSON.parse(opts.body).audio.format); return okResponse(); });
  await p.synthesize('a', { voice: '冰糖', format: 'wav' });
  await p.synthesize('b', { voice: '冰糖', format: 'mp3-96k' });
  assert.deepEqual(seen, ['wav', 'mp3']); // 无 96k 档，回落 mp3
});

test('synthesize：无 API Key → invalid_parameter', async () => {
  const p = new MimoProvider({ apiKey: '', fetch: async () => okResponse() });
  await assert.rejects(
    () => p.synthesize('x', { voice: '冰糖' }),
    (e) => e instanceof AppError && e.code === 'invalid_parameter' && /MIMO_API_KEY/.test(e.message)
  );
});

test('synthesize：缺 voice → invalid_parameter', async () => {
  const p = makeProvider(() => okResponse());
  await assert.rejects(
    () => p.synthesize('x', {}),
    (e) => e instanceof AppError && e.code === 'invalid_parameter' && /voice/.test(e.message)
  );
});

test('synthesize：未知 format → invalid_parameter', async () => {
  const p = makeProvider(() => okResponse());
  await assert.rejects(
    () => p.synthesize('x', { voice: '冰糖', format: 'png' }),
    (e) => e instanceof AppError && e.code === 'invalid_parameter'
  );
});

test('synthesize：上游 500 → retryable upstream_error', async () => {
  const p = makeProvider(async () => ({ ok: false, status: 500, headers: new Headers(), text: async () => 'boom', json: async () => ({}) }));
  await assert.rejects(
    () => p.synthesize('x', { voice: '冰糖' }),
    (e) => e instanceof AppError && e.code === 'upstream_error' && e.retryable === true && /500/.test(e.message)
  );
});

test('synthesize：响应缺少音频数据 → upstream_error', async () => {
  const p = makeProvider(async () => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: {} }] }), text: async () => '',
  }));
  await assert.rejects(
    () => p.synthesize('x', { voice: '冰糖' }),
    (e) => e instanceof AppError && e.code === 'upstream_error' && /音频数据/.test(e.message)
  );
});

test('synthesize：空音频 → upstream_error', async () => {
  const p = makeProvider(async () => okResponse(Buffer.alloc(0)));
  await assert.rejects(
    () => p.synthesize('x', { voice: '冰糖' }),
    (e) => e instanceof AppError && e.code === 'upstream_error'
  );
});

test('synthesize：网络失败 → upstream_error', async () => {
  const p = makeProvider(async () => { throw new Error('ECONNREFUSED'); });
  await assert.rejects(
    () => p.synthesize('x', { voice: '冰糖' }),
    (e) => e instanceof AppError && e.code === 'upstream_error'
  );
});

test('synthesize：非法代理地址 → 构造时报错', () => {
  assert.throws(() => new MimoProvider({ proxyUrl: 'socks5://127.0.0.1:1080' }), /MIMO_PROXY_URL/);
});

test('getVoices：返回 MiMo 官方音色列表', async () => {
  const p = makeProvider(() => okResponse());
  const voices = await p.getVoices();
  assert.equal(voices, MIMO_VOICES);
  assert.ok(voices.some((v) => v.name === '冰糖'));
  assert.ok(voices.every((v) => v.name && v.display));
});
