/**
 * 统一错误码、HTTP 状态映射、重试判定。
 * 与《最终错误码表（确认版）》严格对齐。
 */

export const ErrorCodes = Object.freeze({
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_MODEL: 'INVALID_MODEL',
  INVALID_REQUEST: 'INVALID_REQUEST',
  RATE_LIMIT: 'RATE_LIMIT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
});

/** code → HTTP 状态码 */
const HTTP_STATUS = Object.freeze({
  AUTH_FAILED: 401,
  INVALID_MODEL: 400,
  INVALID_REQUEST: 400,
  RATE_LIMIT: 429,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
  UNKNOWN: 500,
});

/** 仅这两类在后端内部自动重试，最多 2 次，退避 1s→2s */
const RETRYABLE = new Set([
  ErrorCodes.UPSTREAM_ERROR,
  ErrorCodes.TIMEOUT,
]);

export class AppError extends Error {
  /**
   * @param {keyof typeof ErrorCodes} code
   * @param {string} message 中文描述（可对前端展示）
   * @param {unknown} [cause] 底层原因（不进响应体，仅日志）
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS[code] ?? 500;
    this.retryable = RETRYABLE.has(code);
    if (cause !== undefined) this.cause = cause;
  }
}

export const httpStatusOf = (code) => HTTP_STATUS[code] ?? 500;

export const isRetryable = (code) => RETRYABLE.has(code);

/** 归一化为对前端的错误体 { code, message } */
export function toErrorBody(err) {
  const code =
    err && typeof err.code === 'string' && HTTP_STATUS[err.code]
      ? err.code
      : ErrorCodes.UNKNOWN;
  const message =
    err && typeof err.message === 'string' && err.message
      ? err.message
      : '服务异常，请稍后重试';
  return { code, message };
}
