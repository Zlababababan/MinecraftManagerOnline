/**
 * Erreur applicative unique du panel : un code (`ApiErrorCode` = codes protocole + codes panel),
 * traduit par l'UI via `errors` de `@mmo/shared`, et un statut HTTP dérivé. Les `ProtocolError`
 * renvoyées par les agents sont converties telles quelles (le code traverse jusqu'au front).
 */
import { ProtocolError, isProtocolError } from '@mmo/protocol';
import type { ApiError, ApiErrorCode } from '@mmo/protocol/client';

const HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  E_AUTH: 401,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_SETUP_DONE: 409,
  E_SETUP_REQUIRED: 409,
  E_INVALID_PAYLOAD: 400,
  E_VALIDATION: 400,
  E_PAIRING_CODE_INVALID: 400,
  E_RATE_LIMITED: 429,
  E_UNSUPPORTED_VERSION: 409,
  E_UNSUPPORTED_TYPE: 501,
  E_BUSY: 503,
  E_AGENT_OFFLINE: 503,
  E_TIMEOUT: 504,
  E_CANCELLED: 409,
  E_IO: 502,
  E_PORT_IN_USE: 409,
  E_RAM_GUARD: 409,
  E_EULA_REQUIRED: 409,
  E_JAVA_UNAVAILABLE: 409,
  E_CHECKSUM_MISMATCH: 502,
  E_INTERRUPTED: 503,
  E_PRECHECK_FAILED: 409,
  E_SIGNATURE_INVALID: 409,
  E_UNREACHABLE: 502,
  E_NO_RELEASE: 404,
  E_PUSH_DISABLED: 409,
  E_ACCESS_NOT_CONFIGURED: 409,
  E_ACME_FAILED: 502,
  E_DNS_FAILED: 502,
  E_INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  static from(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (isProtocolError(error)) {
      return new AppError(error.code, error.message, {
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new AppError('E_INTERNAL', message, { cause: error });
  }

  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function notFound(what: string, id?: string): AppError {
  return new AppError(
    'E_NOT_FOUND',
    id === undefined ? `${what} not found` : `${what} ${id} not found`,
    {
      details: id === undefined ? { what } : { what, id },
    },
  );
}

export function conflict(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('E_CONFLICT', message, details === undefined ? {} : { details });
}

export function forbidden(message = 'forbidden'): AppError {
  return new AppError('E_FORBIDDEN', message);
}

export function unauthorized(message = 'authentication required'): AppError {
  return new AppError('E_AUTH', message);
}

export function agentOffline(machineId: string): AppError {
  return new AppError('E_AGENT_OFFLINE', `agent ${machineId} is not connected`, {
    details: { machineId },
    retryable: true,
  });
}

export { ProtocolError };
