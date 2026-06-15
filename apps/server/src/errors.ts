import type { ApiError } from '@graphvault/shared';

/**
 * Application-level error carrying an HTTP status and a machine-readable code.
 * Route handlers throw these; a single Fastify error handler renders them into
 * the standard JSON envelope (`apiErrorSchema` in @graphvault/shared).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, 'BAD_REQUEST', message, details);
}

export function unauthorized(message = 'Authentication required'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

export function forbidden(message = 'Forbidden'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function notFound(message = 'Not found'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError(409, 'CONFLICT', message, details);
}

/** Build the wire error envelope for an arbitrary code/message. */
export function errorEnvelope(code: string, message: string, details?: unknown): ApiError {
  const error: ApiError['error'] = { code, message };
  if (details !== undefined) error.details = details;
  return { error };
}
