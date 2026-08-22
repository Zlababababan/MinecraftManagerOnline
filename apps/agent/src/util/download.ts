/**
 * Téléchargement HTTP vers un fichier `.part` avec **reprise par `Range`** (phase 9) : sources
 * essayées dans l'ordre (directes puis relais), délai de connexion par source, vérification sha256 /
 * taille à la fin. Une URL relative est résolue contre l'origine HTTP du panel (mode relais).
 * Utilisé par `java.install`, `migration.import`, `agent.update` et `runtime.update`.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';

import { ERROR_CODES, ProtocolError, type ErrorCode } from '@mmo/protocol';

import { errorMessage } from '../log.js';

export interface DownloadSource {
  url: string;
  headers?: Record<string, string> | undefined;
  kind?: string | undefined;
}

export interface DownloadOptions {
  partPath: string;
  sources: DownloadSource[];
  /** Origine HTTP du panel (`http(s)://host[:port]`) pour résoudre les URLs relatives. */
  panelOrigin?: string | undefined;
  sha256?: string | undefined;
  size?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Délai d'établissement de la connexion (défaut 5 s pour les sources directes, 30 s sinon). */
  connectTimeoutMs?: number | undefined;
  /** Nombre de tentatives par source après une coupure en cours de flux (défaut 3). */
  retries?: number | undefined;
  onProgress?: (received: number, total: number | undefined, sourceIndex: number) => void;
  fetchImpl?: typeof fetch | undefined;
}

export interface DownloadResult {
  size: number;
  sha256: string;
  sourceIndex: number;
  /** Échecs par source avant celle retenue. */
  failures: { index: number; code: string; message: string }[];
}

export function resolveSourceUrl(url: string, panelOrigin: string | undefined): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (panelOrigin === undefined) {
    throw new ProtocolError('E_INVALID_PAYLOAD', 'relative URL without panel origin', {
      details: { url },
    });
  }
  return new URL(url, panelOrigin).toString();
}

/** `ws(s)://host/ws/agent` → `http(s)://host`. */
export function panelHttpOrigin(panelUrl: string | undefined): string | undefined {
  if (panelUrl === undefined) return undefined;
  try {
    const u = new URL(panelUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${proto}//${u.host}`;
  } catch {
    return undefined;
  }
}

/** Télécharge vers `partPath` (repris s'il existe) ; résout à la vérification finale. */
export async function downloadWithResume(options: DownloadOptions): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const failures: DownloadResult['failures'] = [];
  const total = options.size;
  for (let index = 0; index < options.sources.length; index++) {
    const source = options.sources[index];
    if (source === undefined) continue;
    let url: string;
    try {
      url = resolveSourceUrl(source.url, options.panelOrigin);
    } catch (error) {
      failures.push({ index, code: 'E_INVALID_PAYLOAD', message: errorMessage(error) });
      continue;
    }
    const attempts = Math.max(1, options.retries ?? 3);
    let lastError: { code: string; message: string } | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (options.signal?.aborted) throw new ProtocolError('E_CANCELLED', 'download cancelled');
      try {
        const done = await fetchChunk(fetchImpl, url, source, options, index, total);
        if (done === 'complete') {
          const result = await verify(options.partPath, options.sha256, total);
          return { ...result, sourceIndex: index, failures };
        }
        // `interrupted` : on repart de la taille du `.part` sur la même source.
        lastError = { code: 'E_IO', message: 'stream interrupted' };
      } catch (error) {
        if (options.signal?.aborted) throw new ProtocolError('E_CANCELLED', 'download cancelled');
        const perr = error instanceof ProtocolError ? error : undefined;
        lastError = { code: perr?.code ?? 'E_IO', message: errorMessage(error) };
        // Source injoignable, refusée ou contenu incorrect : inutile d'insister sur cette source.
        if (
          perr?.code === 'E_UNREACHABLE' ||
          perr?.code === 'E_NOT_FOUND' ||
          perr?.code === 'E_CHECKSUM_MISMATCH'
        ) {
          break;
        }
      }
    }
    if (lastError) failures.push({ index, ...lastError });
  }
  const last = failures[failures.length - 1];
  // Une seule source : son code d'échec est le plus parlant (404, checksum…) ; sinon synthèse.
  const code = failures.every((f) => f.code === 'E_UNREACHABLE')
    ? 'E_UNREACHABLE'
    : failures.length === 1 && last !== undefined && isErrorCode(last.code)
      ? last.code
      : 'E_IO';
  throw new ProtocolError(code, `download failed: ${last?.message ?? 'no source'}`, {
    details: { failures },
  });
}

async function fetchChunk(
  fetchImpl: typeof fetch,
  url: string,
  source: DownloadSource,
  options: DownloadOptions,
  index: number,
  total: number | undefined,
): Promise<'complete' | 'interrupted'> {
  const existing = (await stat(options.partPath).catch(() => undefined))?.size ?? 0;
  if (total !== undefined && existing >= total && total > 0) return 'complete';
  const headers: Record<string, string> = { ...(source.headers ?? {}) };
  if (existing > 0) headers.Range = `bytes=${String(existing)}-`;
  const connectTimeout = options.connectTimeoutMs ?? (source.kind === 'direct' ? 5_000 : 30_000);
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
  }, connectTimeout);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (options.signal?.aborted) throw new ProtocolError('E_CANCELLED', 'download cancelled');
    throw new ProtocolError('E_UNREACHABLE', `cannot reach ${url}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  clearTimeout(timer);
  try {
    if (response.status === 416 && total !== undefined && existing >= total) return 'complete';
    if (response.status === 404 || response.status === 410 || response.status === 403) {
      throw new ProtocolError('E_NOT_FOUND', `HTTP ${String(response.status)} from ${url}`, {
        details: { status: response.status },
      });
    }
    if (!response.ok || !response.body) {
      throw new ProtocolError('E_IO', `HTTP ${String(response.status)} from ${url}`, {
        details: { status: response.status },
      });
    }
    let offset = existing;
    if (existing > 0 && response.status !== 206) {
      // Pas de reprise côté serveur : on repart de zéro.
      offset = 0;
    }
    const expectedTotal =
      total ??
      (response.status === 206
        ? parseContentRangeTotal(response.headers.get('content-range'))
        : lengthOf(response.headers.get('content-length')));
    const handle = await open(options.partPath, offset > 0 ? 'r+' : 'w');
    try {
      if (offset > 0) await handle.truncate(offset);
      let received = offset;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (options.signal?.aborted) throw new ProtocolError('E_CANCELLED', 'download cancelled');
        await handle.write(chunk, 0, chunk.byteLength, received);
        received += chunk.byteLength;
        options.onProgress?.(received, expectedTotal, index);
      }
      if (expectedTotal !== undefined && received < expectedTotal) return 'interrupted';
      return 'complete';
    } finally {
      await handle.close();
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function isErrorCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

function lengthOf(header: string | null): number | undefined {
  if (header === null) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseContentRangeTotal(header: string | null): number | undefined {
  const m = /\/(\d+)\s*$/.exec(header ?? '');
  return m ? Number(m[1]) : undefined;
}

async function verify(
  partPath: string,
  expectedSha256: string | undefined,
  expectedSize: number | undefined,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const stream = createReadStream(partPath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).byteLength;
  }
  const sha256 = hash.digest('hex');
  if (
    (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== sha256) ||
    (expectedSize !== undefined && expectedSize !== size)
  ) {
    await rm(partPath, { force: true });
    throw new ProtocolError('E_CHECKSUM_MISMATCH', 'downloaded file does not match', {
      retryable: true,
      details: {
        sha256,
        size,
        expectedSha256: expectedSha256 ?? null,
        expectedSize: expectedSize ?? null,
      },
    });
  }
  return { size, sha256 };
}

/** Hash d'un fichier existant. */
export async function sha256File(file: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).byteLength;
  }
  return { size, sha256: hash.digest('hex') };
}
