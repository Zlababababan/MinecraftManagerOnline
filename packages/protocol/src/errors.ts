/**
 * Erreurs du protocole (doc 05 §2) : `{ code, message, retryable, details }`.
 * `message` = anglais technique (logs) ; l'UI traduit `code` + `details` via l'i18n de `@mmo/shared`.
 */
import { z } from 'zod';

export const ERROR_CODES = [
  'E_AUTH',
  'E_PAIRING_CODE_INVALID',
  'E_UNSUPPORTED_VERSION',
  'E_UNSUPPORTED_TYPE',
  'E_INVALID_PAYLOAD',
  'E_NOT_FOUND',
  'E_CONFLICT',
  'E_BUSY',
  'E_TIMEOUT',
  'E_CANCELLED',
  'E_IO',
  'E_PORT_IN_USE',
  'E_RAM_GUARD',
  'E_EULA_REQUIRED',
  'E_JAVA_UNAVAILABLE',
  'E_CHECKSUM_MISMATCH',
  'E_INTERRUPTED',
  /** Phase 9 : pré-checks de migration refusés (`details.checks`). */
  'E_PRECHECK_FAILED',
  /** Phase 9 : signature Ed25519 d'un bundle invalide. */
  'E_SIGNATURE_INVALID',
  /** Phase 9 : aucune source directe joignable (le panel bascule en relais). */
  'E_UNREACHABLE',
  'E_INTERNAL',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const protocolErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ProtocolErrorPayload = z.infer<typeof protocolErrorSchema>;

/** Réessayable par défaut (l'émetteur peut surcharger au cas par cas). */
const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  E_AUTH: false,
  E_PAIRING_CODE_INVALID: false,
  E_UNSUPPORTED_VERSION: false,
  E_UNSUPPORTED_TYPE: false,
  E_INVALID_PAYLOAD: false,
  E_NOT_FOUND: false,
  E_CONFLICT: false,
  E_BUSY: true,
  E_TIMEOUT: true,
  E_CANCELLED: false,
  E_IO: true,
  E_PORT_IN_USE: false,
  E_RAM_GUARD: false,
  E_EULA_REQUIRED: false,
  E_JAVA_UNAVAILABLE: false,
  E_CHECKSUM_MISMATCH: true,
  E_INTERRUPTED: true,
  E_PRECHECK_FAILED: false,
  E_SIGNATURE_INVALID: false,
  E_UNREACHABLE: true,
  E_INTERNAL: false,
};

/** Erreur typée levée par les handlers RPC et reçue par les appelants (`request()` rejette avec). */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProtocolError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.details = options.details;
  }

  static fromPayload(payload: ProtocolErrorPayload): ProtocolError {
    return new ProtocolError(payload.code, payload.message, {
      retryable: payload.retryable,
      ...(payload.details === undefined ? {} : { details: payload.details }),
    });
  }

  toPayload(): ProtocolErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return value instanceof ProtocolError;
}
