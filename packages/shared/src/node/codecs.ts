/**
 * Codecs Node pour les transferts et backups (spike n°3) : zstd niveau 3 avec `checksumFlag`
 * (Node ≥ 22.15, jamais présumé : `hasZstd()`), gzip en repli. Règle absolue : jamais
 * `ZSTD_c_nbWorkers` (perte silencieuse de données constatée). L'intégrité d'un flux zstd ne repose
 * **jamais** sur le codec (un flux tronqué est accepté sans erreur) : SHA-256 + taille à côté.
 */
import { createHash } from 'node:crypto';
import type { Transform } from 'node:stream';
import zlib from 'node:zlib';

export type ChunkCompression = 'none' | 'gzip' | 'zstd';

export interface NodeChunkCodec {
  compress(data: Uint8Array): Uint8Array;
  decompress(data: Uint8Array): Uint8Array;
}

export interface NodeHasher {
  update(data: Uint8Array): void;
  digest(): string;
}

export const ZSTD_LEVEL = 3;

interface ZstdZlib {
  zstdCompressSync?: (buf: Uint8Array, options?: { params?: Record<number, number> }) => Buffer;
  zstdDecompressSync?: (buf: Uint8Array) => Buffer;
  createZstdCompress?: (options?: { params?: Record<number, number> }) => Transform;
  createZstdDecompress?: () => Transform;
  constants: Record<string, number>;
}

const z = zlib as unknown as ZstdZlib;

interface ZstdApi {
  compressSync: NonNullable<ZstdZlib['zstdCompressSync']>;
  decompressSync: NonNullable<ZstdZlib['zstdDecompressSync']>;
  createCompress: NonNullable<ZstdZlib['createZstdCompress']>;
  createDecompress: NonNullable<ZstdZlib['createZstdDecompress']>;
}

function zstdApi(): ZstdApi | undefined {
  const { zstdCompressSync, zstdDecompressSync, createZstdCompress, createZstdDecompress } = z;
  if (
    typeof zstdCompressSync !== 'function' ||
    typeof zstdDecompressSync !== 'function' ||
    typeof createZstdCompress !== 'function' ||
    typeof createZstdDecompress !== 'function'
  ) {
    return undefined;
  }
  return {
    compressSync: zstdCompressSync,
    decompressSync: zstdDecompressSync,
    createCompress: createZstdCompress,
    createDecompress: createZstdDecompress,
  };
}

/** zstd disponible dans ce runtime (`process.versions.zstd`, API `zlib.zstd*`). */
export function hasZstd(): boolean {
  return zstdApi() !== undefined;
}

function zstdParams(): Record<number, number> {
  return {
    [z.constants.ZSTD_c_compressionLevel ?? 100]: ZSTD_LEVEL,
    [z.constants.ZSTD_c_checksumFlag ?? 201]: 1,
  };
}

/** Codec par chunk (transferts) ; `zstd` retombe sur `gzip` si le runtime ne l'offre pas. */
export function chunkCodec(compression: ChunkCompression): NodeChunkCodec {
  const api = compression === 'zstd' ? zstdApi() : undefined;
  if (api) {
    const params = zstdParams();
    return {
      compress: (d) => api.compressSync(d, { params }),
      decompress: (d) => api.decompressSync(d),
    };
  }
  if (compression === 'gzip' || compression === 'zstd') {
    return {
      compress: (d) => zlib.gzipSync(d, { level: 1 }),
      decompress: (d) => zlib.gunzipSync(d),
    };
  }
  return { compress: (d) => d, decompress: (d) => d };
}

/** Codec effectivement utilisable parmi ceux demandés (le pair distant doit l'accepter aussi). */
export function effectiveCompression(wanted: ChunkCompression | undefined): ChunkCompression {
  if (wanted === 'zstd') return hasZstd() ? 'zstd' : 'gzip';
  return wanted ?? 'none';
}

/** Flux de compression d'archive (backups) : `.tar.zst` ou `.tar.gz`. */
export function createCompressStream(codec: 'zstd' | 'gzip'): Transform {
  if (codec === 'zstd') {
    const api = zstdApi();
    if (!api) throw new Error('zstd unavailable in this runtime');
    return api.createCompress({ params: zstdParams() });
  }
  return zlib.createGzip({ level: 6 });
}

export function createDecompressStream(codec: 'zstd' | 'gzip'): Transform {
  if (codec === 'zstd') {
    const api = zstdApi();
    if (!api) throw new Error('zstd unavailable in this runtime');
    return api.createDecompress();
  }
  return zlib.createGunzip();
}

export function sha256Hasher(): NodeHasher {
  const h = createHash('sha256');
  return { update: (d) => h.update(d), digest: () => h.digest('hex') };
}
