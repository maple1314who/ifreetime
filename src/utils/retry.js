/**
 * 有限次重试（指数退避）。
 * 只重试 AppError.retryable === true 的错误（如上游 502/超时）；其余错误直接抛出。
 */
export async function withRetries(fn, { retries = 1, baseDelayMs = 300, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !err || !err.retryable) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      if (onRetry) onRetry(attempt + 1, err, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}