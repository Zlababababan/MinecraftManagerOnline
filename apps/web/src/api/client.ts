/**
 * Client HTTP de l'API du panel (`/api/*`, cookie `mmo_session`). Toute réponse d'erreur est un
 * `ApiError` `{ code, message, retryable, details }` (doc 03 §7) ; l'UI traduit à partir du code.
 */
import { apiErrorSchema, type ApiError } from '@mmo/protocol/client';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.code = error.code;
    this.status = status;
    this.retryable = error.retryable ?? false;
    this.details = error.details ?? {};
  }

  /** 401 pendant le first-run : le panel n'a aucun utilisateur (`details.setupRequired`). */
  get setupRequired(): boolean {
    return this.status === 401 && this.details.setupRequired === true;
  }
}

/** Erreur réseau (fetch rejeté) — distincte d'une réponse d'erreur du panel. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('network error', { cause });
    this.name = 'NetworkError';
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const parsed = apiErrorSchema.safeParse(json);
  if (parsed.success) return new ApiRequestError(res.status, parsed.data);
  return new ApiRequestError(res.status, {
    code: res.status === 401 ? 'E_AUTH' : res.status === 404 ? 'E_NOT_FOUND' : 'E_INTERNAL',
    message: `HTTP ${String(res.status)}`,
  });
}

export async function request<T>(
  method: Method,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      ...(options.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new NetworkError(error);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) =>
    request<T>('GET', url, signal === undefined ? {} : { signal }),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, { body }),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, { body }),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, { body }),
  delete: <T = void>(url: string) => request<T>('DELETE', url),
  /** Corps binaire (`application/octet-stream`) — phase 9 : publication d'un bundle d'agent. */
  putBinary: async <T>(url: string, body: Blob): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      });
    } catch (error) {
      throw new NetworkError(error);
    }
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  },
  /**
   * Réponse fichier (pièce jointe) : le nom vient du `content-disposition`. Un lien `<a download>`
   * ferait aussi bien pour le cas nominal, mais une erreur (agent trop ancien, hors ligne) doit
   * arriver dans une notification, pas dans un onglet affichant du JSON.
   */
  download: async (url: string): Promise<{ blob: Blob; fileName: string }> => {
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'same-origin' });
    } catch (error) {
      throw new NetworkError(error);
    }
    if (!res.ok) throw await parseError(res);
    const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
    return { blob: await res.blob(), fileName: match?.[1] ?? 'download.txt' };
  },
};
