/**
 * HTTP 层集成测试：注入假供应商，覆盖同步/异步/错误路径（不碰真实 Edge）。
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server.js';
import { Provider } from '../src/providers/base.js';
import { AppError } from '../src/utils/errors.js';
import { config } from '../src/config.js';

class FakeProvider extends Provider {
  constructor(name) {
    super(name);
  }
  async synthesize(text, options = {}) {
    const rate = options.rate || '+0%';
    // 模仿真实 provider：缺省 voice 由供应商用自己的默认音色
    const voice = options.voice || 'zh-CN-XiaoxiaoNeural';
    return {
      audio: Buffer.from(`OK:${text}|${this.name}|${rate}|${voice}`),
      format: 'audio-24khz-48kbitrate-mono-mp3',
      extension: 'mp3',
      contentType: 'audio/mpeg',
    };
  }
  async getVoices() {
    return [
      { name: 'zh-CN-FakeNeural', display: '测试晓', gender: 'Female', locale: 'zh-CN' },
      { name: 'en-US-FakeNeural', display: 'en-US-FakeNeural', gender: 'Male', locale: 'en-US' },
    ];
  }
}

const fakeCreateProvider = (name) => {
  if (name === 'edge' || name === 'fake') return new FakeProvider(name);
  throw new AppError({ statusCode: 404, code: 'provider_not_found', message: `未知供应商: ${name}` });
};

let app;
const tmpData = mkdtempSync(path.join(tmpdir(), 'read-tts-api-'));

before(() => {
  config.dataDir = tmpData; // 任务文件写临时目录
  app = buildApp({ createProvider: fakeCreateProvider });
});
after(() => {
  app.close();
  rmSync(tmpData, { recursive: true, force: true });
});

function json(res) {
  return JSON.parse(res.body);
}

test('POST /v1/tts 缺 text → 400 invalid_parameter', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/tts', payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'invalid_parameter');
});

test('POST /v1/tts 同步 stream（默认）→ audio/mpeg 音频', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/tts',
    payload: { text: '你好世界', provider: 'edge', rate: '+10%' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(res.body, 'OK:你好世界|edge|+10%|zh-CN-XiaoxiaoNeural');
  assert.match(res.headers['content-disposition'], /tts-.*\.mp3/);
});

test('POST /v1/tts 同步 base64', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/tts',
    payload: { text: 'hi', output: 'base64' },
  });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(Buffer.from(body.audioBase64, 'base64').toString(), 'OK:hi|edge|+0%|zh-CN-XiaoxiaoNeural');
  assert.equal(body.format, 'audio-24khz-48kbitrate-mono-mp3');
});

test('POST /v1/tts 同步超长文本 → 400 text_too_long', async () => {
  config.maxTextLengthSync = 5; // 临时收紧
  try {
    const res = await app.inject({ method: 'POST', url: '/v1/tts', payload: { text: '六个字超长了' } });
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).code, 'text_too_long');
  } finally {
    config.maxTextLengthSync = 1000;
  }
});

test('POST /v1/tts 未知供应商 → 404 provider_not_found', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/tts', payload: { text: 'x', provider: 'nope' } });
  assert.equal(res.statusCode, 404);
  assert.equal(json(res).code, 'provider_not_found');
});

test('POST /v1/tts mode 非法 → 400', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/tts', payload: { text: 'x', mode: 'weird' } });
  assert.equal(res.statusCode, 400);
});

test('异步全流程：提交 → 轮询 → 下载 → 删除', async () => {
  const post = await app.inject({
    method: 'POST', url: '/v1/tts',
    payload: { text: '长文本', mode: 'async', provider: 'fake' },
  });
  assert.equal(post.statusCode, 202);
  const taskId = json(post).taskId;
  assert.ok(taskId);

  // 轮询直到成功
  let status;
  const start = Date.now();
  do {
    const q = await app.inject({ method: 'GET', url: `/v1/tts/tasks/${taskId}` });
    status = json(q).status;
    await new Promise((r) => setTimeout(r, 20));
  } while (status !== 'succeeded' && Date.now() - start < 3000);
  assert.equal(status, 'succeeded');

  const audio = await app.inject({ method: 'GET', url: `/v1/tts/tasks/${taskId}/audio` });
  assert.equal(audio.statusCode, 200);
  assert.equal(audio.body, 'OK:长文本|fake|+0%|zh-CN-XiaoxiaoNeural');

  const del = await app.inject({ method: 'DELETE', url: `/v1/tts/tasks/${taskId}` });
  assert.equal(json(del).deleted, true);

  const gone = await app.inject({ method: 'GET', url: `/v1/tts/tasks/${taskId}` });
  assert.equal(gone.statusCode, 404);
  assert.equal(json(gone).code, 'task_not_found');
});

test('GET /v1/voices → 发音人列表', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/voices?provider=edge' });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.count, 2);
  assert.equal(body.voices[0].name, 'zh-CN-FakeNeural');
  assert.equal(body.voices[0].display, '测试晓'); // 中文显示名透传
});

test('GET /health → ok；未知路由 → 404 route_not_found', async () => {
  const h = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(json(h).status, 'ok');
  const nf = await app.inject({ method: 'GET', url: '/no-such-route' });
  assert.equal(nf.statusCode, 404);
  assert.equal(json(nf).code, 'route_not_found');
});

// ---- GET 调用兼容（调用方实际用法） ----

test('GET /v1/tts：voiceName + 完整 format + 空参数全兼容', async () => {
  const text = '爱阅记，以各种自定义功能为核心，努力打造最具个性化的阅读器。';
  const url = '/v1/tts?text=' + encodeURIComponent(text) +
    '&voiceName=zh-CN-shaanxi-XiaoniNeural' +
    '&format=audio-24khz-48kbitrate-mono-mp3' +
    '&pitch=&rate=&volume=&token=';
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  // rate/pitch/volume 空串 → 默认；voiceName 生效
  assert.equal(res.body, `OK:${text}|edge|+0%|zh-CN-shaanxi-XiaoniNeural`);
});

test('GET /v1/tts：voice 与 voiceName 等价，voiceName 优先', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/tts?text=a&voiceName=zh-CN-XiaoxiaoNeural&voice=en-US-AriaNeural',
  });
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.ok(res.body.endsWith('|zh-CN-XiaoxiaoNeural'), 'voiceName 应优先');
});

test('GET /v1/tts：output=base64 同样可用', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/tts?text=hi&output=base64' });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(Buffer.from(body.audioBase64, 'base64').toString(), 'OK:hi|edge|+0%|zh-CN-XiaoxiaoNeural');
});

test('GET /v1/tts：缺 text → 400', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/tts?voiceName=zh-CN-XiaoxiaoNeural' });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'invalid_parameter');
});

// ---- POST + application/x-www-form-urlencoded（客户端实际用法） ----

test('POST /v1/tts：x-www-form-urlencoded 表单提交', async () => {
  const form = [
    'text=' + encodeURIComponent('爱阅记，以各种自定义功能为核心。'),
    'voiceName=zh-CN-shaanxi-XiaoniNeural',
    'format=audio-24khz-48kbitrate-mono-mp3',
    'pitch=&rate=&volume=&token=',
  ].join('&');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tts',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  // voiceName 生效、rate/volume/pitch 空串 → 默认
  assert.equal(res.body, 'OK:爱阅记，以各种自定义功能为核心。|edge|+0%|zh-CN-shaanxi-XiaoniNeural');
});

test('POST /v1/tts：form 表单缺 text → 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tts',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'voiceName=zh-CN-XiaoxiaoNeural&rate=',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'invalid_parameter');
});