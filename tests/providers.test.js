import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFormat, EdgeProvider } from '../src/providers/edge/provider.js';
import { createProvider, registerProvider } from '../src/providers/registry.js';
import { Provider } from '../src/providers/base.js';
import { AppError } from '../src/utils/errors.js';

test('resolveFormat：别名映射到完整格式', () => {
  assert.equal(resolveFormat('mp3').format, 'audio-24khz-48kbitrate-mono-mp3');
  assert.equal(resolveFormat('mp3').mime, 'audio/mpeg');
  assert.equal(resolveFormat('mp3-96k').format, 'audio-24khz-96kbitrate-mono-mp3');
  assert.equal(resolveFormat('ogg').mime, 'audio/ogg');
  assert.equal(resolveFormat('webm').ext, 'webm');
});

test('resolveFormat：完整格式串透传', () => {
  const r = resolveFormat('ogg-48khz-16bit-mono-opus');
  assert.equal(r.format, 'ogg-48khz-16bit-mono-opus');
  assert.equal(r.ext, 'ogg');
});

test('resolveFormat：非法格式抛 400', () => {
  assert.throws(() => resolveFormat('png'), (e) => e instanceof AppError && e.code === 'invalid_parameter');
  assert.throws(() => resolveFormat('#$%'), (e) => e instanceof AppError);
});

test('Provider 抽象类不能直接实例化', () => {
  assert.throws(() => new Provider('x'), /抽象类/);
});

test('注册表：edge 工厂创建 EdgeProvider 实例', () => {
  const p = createProvider('edge');
  assert.ok(p instanceof EdgeProvider);
  assert.equal(p.name, 'edge');
});

test('注册表：未知供应商抛 provider_not_found', () => {
  assert.throws(() => createProvider('nope'), (e) => e instanceof AppError && e.code === 'provider_not_found');
});

test('注册表：自定义供应商可注册并创建', () => {
  registerProvider('test-x', () => ({ name: 'test-x', synthesize: async () => ({}), getVoices: async () => [] }));
  const p = createProvider('test-x');
  assert.equal(p.name, 'test-x');
});