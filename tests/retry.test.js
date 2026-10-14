import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetries } from '../src/utils/retry.js';
import { AppError } from '../src/utils/errors.js';

const retryable502 = (msg = 'u') =>
  new AppError({ statusCode: 502, code: 'upstream_error', message: msg, retryable: true });

test('withRetries：可重试错误按次数重试后成功', async () => {
  let calls = 0;
  const out = await withRetries(async () => {
    calls += 1;
    if (calls < 3) throw retryable502();
    return 'ok';
  }, { retries: 2, baseDelayMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('withRetries：超过次数后抛出最终错误', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetries(async () => {
      calls += 1;
      throw retryable502();
    }, { retries: 1, baseDelayMs: 1 }),
    (e) => e instanceof AppError && e.code === 'upstream_error'
  );
  assert.equal(calls, 2);
});

test('withRetries：不可重试错误不重试直接抛', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetries(async () => {
      calls += 1;
      throw new Error('boom');
    }, { retries: 3, baseDelayMs: 1 }),
    /boom/
  );
  assert.equal(calls, 1);
});