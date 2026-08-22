import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { type ProtocolError } from '../errors.js';
import {
  TransferReceiver,
  TransferSender,
  identityCodec,
  type ChunkCodec,
  type Hasher,
} from './engine.js';
import { FRAME_HEADER_SIZE, decodeFrame, encodeFrame, transferIdFromBytes } from './frame.js';

const hash = (): Hasher => {
  const h = createHash('sha256');
  return { update: (d) => h.update(d), digest: () => h.digest('hex') };
};
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function* pieces(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.byteLength; i += size) {
    await Promise.resolve();
    yield data.subarray(i, Math.min(i + size, data.byteLength));
  }
}

/** Codec de test : inverse les octets (prouve que compress/decompress sont appelés). */
const reverseCodec: ChunkCodec = {
  compress: (d) => Uint8Array.from(d).reverse(),
  decompress: (d) => Uint8Array.from(d).reverse(),
};

describe('frames binaires', () => {
  it('encode/décode l’en-tête (version, transferId, offset u64)', () => {
    const transferId = transferIdFromBytes(randomBytes(16));
    const data = randomBytes(10);
    const frame = encodeFrame({ transferId, offset: 2 ** 40 + 7, data });
    expect(frame.byteLength).toBe(FRAME_HEADER_SIZE + 10);
    const decoded = decodeFrame(frame);
    expect(decoded?.transferId).toBe(transferId);
    expect(decoded?.offset).toBe(2 ** 40 + 7);
    expect(Buffer.from(decoded?.data ?? new Uint8Array()).equals(data)).toBe(true);
    expect(decodeFrame(new Uint8Array([2, 0, 0]))).toBeUndefined();
  });
});

interface Link {
  sender: TransferSender;
  receiver: TransferReceiver;
  received: Uint8Array[];
  sentFrames: number;
  deliver: boolean;
  lost: Uint8Array[];
}

function link(
  transferId: string,
  options: { chunkSize: number; codec?: ChunkCodec; window?: number; startOffset?: number },
): Link {
  const received: Uint8Array[] = [];
  const state: Link = {
    sender: undefined as unknown as TransferSender,
    receiver: undefined as unknown as TransferReceiver,
    received,
    sentFrames: 0,
    deliver: true,
    lost: [],
  };
  const codec = options.codec ?? identityCodec;
  state.receiver = new TransferReceiver(
    {
      transferId,
      codec,
      hash,
      write: async (data) => {
        await Promise.resolve();
        received.push(Uint8Array.from(data));
      },
      sendAck: (offset) => {
        state.sender.onAck(offset);
      },
    },
    options.startOffset ?? 0,
  );
  state.sender = new TransferSender(
    {
      transferId,
      chunkSize: options.chunkSize,
      codec,
      hash,
      ...(options.window === undefined ? {} : { windowChunks: options.window }),
      sendFrame: (frame) => {
        state.sentFrames++;
        if (!state.deliver) {
          state.lost.push(frame);
          throw new Error('socket closed');
        }
        const decoded = decodeFrame(frame);
        if (decoded)
          setTimeout(() => {
            state.receiver.onFrame(decoded);
          }, 0);
      },
    },
    options.startOffset ?? 0,
  );
  return state;
}

describe('TransferSender / TransferReceiver', () => {
  const transferId = 'abcdefabcdefabcdefabcdefabcdefab';

  it('transfère, acquitte par chunk et vérifie taille + sha256 (codec par chunk)', async () => {
    const data = randomBytes(10 * 1024 + 123);
    const l = link(transferId, { chunkSize: 1024, codec: reverseCodec });
    const { size } = await l.sender.run(pieces(data, 700));
    expect(size).toBe(data.byteLength);
    expect(l.sentFrames).toBe(11);
    await expect(l.receiver.finish(size, l.sender.sha256)).resolves.toEqual({
      sha256: sha256(data),
    });
    expect(Buffer.concat(l.received).equals(data)).toBe(true);
    expect(l.receiver.receivedOffset).toBe(size);
  });

  it('refuse un sha256 ou une taille incohérents (E_CHECKSUM_MISMATCH)', async () => {
    const data = randomBytes(3000);
    const l = link(transferId, { chunkSize: 1024 });
    await l.sender.run(pieces(data, 1000));
    await expect(l.receiver.finish(3000, 'f'.repeat(64))).rejects.toMatchObject({
      code: 'E_CHECKSUM_MISMATCH',
    });
    const l2 = link(transferId, { chunkSize: 1024 });
    await l2.sender.run(pieces(data, 1000));
    await expect(l2.receiver.finish(2999, sha256(data))).rejects.toMatchObject({
      code: 'E_CHECKSUM_MISMATCH',
    });
  });

  it('respecte la fenêtre : jamais plus de N chunks non acquittés en vol', async () => {
    const data = randomBytes(64 * 256);
    const transfer = link(transferId, { chunkSize: 256, window: 4 });
    let maxInFlight = 0;
    const tick = setInterval(() => {
      maxInFlight = Math.max(
        maxInFlight,
        (transfer.sender.sentOffset - transfer.sender.ackedOffset) / 256,
      );
    }, 0);
    await transfer.sender.run(pieces(data, 256));
    clearInterval(tick);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it('reprend après une coupure : chunks retenus ré-émis depuis l’offset du récepteur', async () => {
    const data = randomBytes(20 * 512);
    const l = link(transferId, { chunkSize: 512, window: 4 });
    // Coupure après le 6e chunk émis : le socket jette, l'émetteur se détache sans échouer.
    let count = 0;
    const run = l.sender.run(
      (async function* () {
        for await (const p of pieces(data, 512)) {
          count++;
          if (count === 7) {
            l.deliver = false;
          }
          yield p;
        }
      })(),
    );
    // Attend que l'émetteur soit détaché (frame perdue), puis simule la reconnexion.
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (!l.sender.isAttached) resolve();
        else setTimeout(poll, 1);
      };
      poll();
    });
    await l.receiver.settle();
    const resumeAt = l.receiver.receivedOffset;
    expect(resumeAt).toBeLessThan(data.byteLength);
    expect(resumeAt % 512).toBe(0);
    l.deliver = true;
    l.sender.resume(resumeAt, (frame) => {
      l.sentFrames++;
      const decoded = decodeFrame(frame);
      if (decoded)
        setTimeout(() => {
          l.receiver.onFrame(decoded);
        }, 0);
    });
    const { size } = await run;
    expect(size).toBe(data.byteLength);
    await expect(l.receiver.finish(size, l.sender.sha256)).resolves.toEqual({
      sha256: sha256(data),
    });
    expect(Buffer.concat(l.received).equals(data)).toBe(true);
  });

  it('le récepteur ignore les duplicatas et refuse un trou (E_IO)', () => {
    const errors: ProtocolError[] = [];
    const r = new TransferReceiver({
      transferId,
      codec: identityCodec,
      hash,
      write: () => undefined,
      sendAck: () => undefined,
      onError: (e) => errors.push(e),
    });
    r.onFrame({ transferId, offset: 0, data: new Uint8Array(10) });
    r.onFrame({ transferId, offset: 0, data: new Uint8Array(10) }); // dup
    r.onFrame({ transferId: 'f'.repeat(32), offset: 10, data: new Uint8Array(10) }); // autre transfert
    r.onFrame({ transferId, offset: 30, data: new Uint8Array(10) }); // trou
    expect(errors.map((e) => e.code)).toEqual(['E_IO']);
  });

  it('cancel() rejette run() avec E_CANCELLED', async () => {
    const l = link(transferId, { chunkSize: 1024, window: 1 });
    l.deliver = false;
    const run = l.sender.run(pieces(randomBytes(5000), 1000));
    await new Promise((resolve) => setTimeout(resolve, 5));
    l.sender.cancel();
    await expect(run).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });

  it('reprise à partir d’un offset initial (fichier .part existant)', async () => {
    const data = randomBytes(4096);
    const l = link(transferId, { chunkSize: 1024, startOffset: 2048 });
    l.receiver.seed(data.subarray(0, 2048));
    const { size } = await l.sender.run(pieces(data.subarray(2048), 1024));
    expect(size).toBe(4096);
    // Le sha256 du récepteur couvre le fichier complet ; l'émetteur n'a haché que la fin.
    await expect(l.receiver.finish(4096, sha256(data))).resolves.toEqual({ sha256: sha256(data) });
  });
});
