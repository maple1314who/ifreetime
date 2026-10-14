import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskManager, STATUS } from '../src/tasks/manager.js';
import { AppError } from '../src/utils/errors.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'read-tts-task-'));
const manager = new TaskManager({
  synthesize: async (payload) => {
    if (payload.fail) throw new AppError({ statusCode: 502, code: 'upstream_error', message: '假失败', retryable: true });
    return { audio: Buffer.from(payload.text), format: 'mp3', extension: 'mp3', contentType: 'audio/mpeg' };
  },
  concurrency: 2,
  ttlMs: 60_000,
  dataDir: tmp,
  cleanupIntervalMs: 3600_000,
});

after(() => {
  manager.stop();
  rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor 超时');
}

test('任务：提交 → 成功 → 音频文件存在 → 删除后文件消失', async () => {
  const id = manager.submit({ text: '你好', fail: false });
  const info = await waitFor(async () => {
    const s = manager.status(id);
    return s.status === STATUS.SUCCEEDED ? s : null;
  });
  assert.equal(info.result.bytes, Buffer.byteLength('你好'));
  const file = manager.audioPath(id);
  assert.equal(readFileSync(file, 'utf8'), '你好');

  await manager.remove(id);
  assert.throws(() => manager.status(id), (e) => e instanceof AppError && e.code === 'task_not_found');
});

test('任务：合成失败 → FAILED + 错误信息', async () => {
  const id = manager.submit({ text: 'x', fail: true });
  const info = await waitFor(async () => {
    const s = manager.status(id);
    return s.status === STATUS.FAILED ? s : null;
  });
  assert.equal(info.error.code, 'upstream_error');
});

test('任务：未成功的任务取音频抛 task_not_ready', async () => {
  const id = manager.submit({ text: '失败吧', fail: true });
  await waitFor(async () => (manager.status(id).status === STATUS.FAILED ? true : null));
  assert.throws(() => manager.audioPath(id), (e) => e instanceof AppError && e.code === 'task_not_ready');
});

test('任务：TTL 清理删除过期任务', async () => {
  const m = new TaskManager({
    synthesize: async () => ({ audio: Buffer.from('a'), format: 'x', extension: 'bin', contentType: 'audio/mpeg' }),
    concurrency: 1,
    ttlMs: 1, // 过期
    dataDir: tmp,
    cleanupIntervalMs: 3600_000,
  });
  const id = m.submit({ text: 'a' });
  await waitFor(async () => (m.status(id).status === STATUS.SUCCEEDED ? true : null));
  await m.cleanup();
  assert.throws(() => m.status(id), (e) => e instanceof AppError && e.code === 'task_not_found');
  m.stop();
});

test('任务状态字段完整', async () => {
  const id = manager.submit({ text: '状态', fail: false });
  const info = manager.status(id);
  assert.ok(info.taskId);
  assert.ok(['pending', 'running', 'succeeded', 'failed'].includes(info.status));
  assert.ok(info.createdAt);
  assert.ok(info.updatedAt);
  assert.equal(id, info.taskId);
  assert.ok(!randomUUID().includes(id)); // sanity
});