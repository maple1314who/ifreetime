/**
 * 统一错误模型：所有业务错误都是 AppError，带 HTTP 状态码 + 错误码 + 是否可重试。
 * routes 的错误处理统一从这里映射成 JSON 响应。
 */
export class AppError extends Error {
  constructor({ statusCode, code, message, retryable = false, cause }) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export const errors = {
  invalidParameter: (msg) =>
    new AppError({ statusCode: 400, code: 'invalid_parameter', message: msg }),

  textTooLong: (msg) =>
    new AppError({ statusCode: 400, code: 'text_too_long', message: msg }),

  providerNotFound: (name) =>
    new AppError({ statusCode: 404, code: 'provider_not_found', message: `未知供应商: ${name}` }),

  taskNotFound: (id) =>
    new AppError({ statusCode: 404, code: 'task_not_found', message: `任务不存在: ${id}` }),

  taskNotReady: (status) =>
    new AppError({ statusCode: 409, code: 'task_not_ready', message: `任务尚未成功（当前状态：${status}）` }),

  rateLimited: () =>
    new AppError({ statusCode: 429, code: 'rate_limited', message: '忙，请稍后重试' }),

  unauthorized: () =>
    new AppError({ statusCode: 401, code: 'unauthorized', message: 'API Key 无效' }),

  upstreamError: (msg) =>
    new AppError({ statusCode: 502, code: 'upstream_error', message: msg, retryable: true }),

  upstreamTimeout: (msg) =>
    new AppError({ statusCode: 502, code: 'upstream_timeout', message: msg, retryable: true }),
};

/**
 * 把任意错误规整成 { statusCode, body }。
 * AppError → 自身状态；validation/其余未知错误 → 500。
 */
export function toErrorResponse(err, requestId) {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, body: { code: err.code, message: err.message, requestId } };
  }
  return {
    statusCode: 500,
    body: { code: 'internal_error', message: err?.message || '内部错误', requestId },
  };
}