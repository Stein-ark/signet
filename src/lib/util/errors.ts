/**
 * A single error type for anything the API layer is willing to describe to a caller.
 *
 * Anything that is not an AppError is treated as an internal fault and reported to the client
 * as a generic message with a correlation id, so stack traces, driver errors and file paths
 * never reach a browser.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'You need to sign in to do that.') =>
  new AppError(401, 'unauthorized', message);

/**
 * Deliberately vague. Telling a caller the difference between "this envelope does not exist"
 * and "this envelope exists but is not yours" leaks the existence of other people's
 * documents, so authorization failures on a resource are reported as not found.
 */
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);

export const forbidden = (message = 'You do not have access to that.') =>
  new AppError(403, 'forbidden', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);

export const tooLarge = (message: string) => new AppError(413, 'payload_too_large', message);

export const tooManyRequests = (message: string, retryAfterSeconds?: number) =>
  new AppError(429, 'rate_limited', message, { retryAfterSeconds });

export const serverError = (message = 'Something went wrong on our side.') =>
  new AppError(500, 'server_error', message);
