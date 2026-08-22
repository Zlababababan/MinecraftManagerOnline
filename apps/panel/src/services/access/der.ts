/**
 * Encodeur DER minimal (ASN.1) : juste ce qu'il faut pour produire une CSR PKCS#10 (`node:crypto` ne
 * sait pas en générer) et, en test, des certificats X.509 auto-signés lisibles par `X509Certificate`.
 * Pas de décodeur : le panel ne lit jamais de DER lui-même (Node s'en charge).
 */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';

export const OID = {
  commonName: '2.5.4.3',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  extensionRequest: '1.2.840.113549.1.9.14',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
} as const;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

export const der = {
  seq: (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items)),
  int: (value: number | Buffer): Buffer => {
    if (typeof value === 'number') {
      if (value < 0 || !Number.isInteger(value)) throw new Error('unsupported integer');
      const bytes: number[] = [];
      let v = value;
      do {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
      } while (v > 0);
      if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
      return tlv(0x02, Buffer.from(bytes));
    }
    const b = (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
    return tlv(0x02, b);
  },
  bool: (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  null: (): Buffer => Buffer.from([0x05, 0x00]),
  oid: (value: string): Buffer => {
    const parts = value.split('.').map(Number);
    const first = (parts[0] ?? 0) * 40 + (parts[1] ?? 0);
    const bytes: number[] = [first];
    for (const part of parts.slice(2)) {
      const chunk: number[] = [];
      let v = part;
      do {
        chunk.unshift(v & 0x7f);
        v = Math.floor(v / 128);
      } while (v > 0);
      for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] ?? 0) | 0x80;
      bytes.push(...chunk);
    }
    return tlv(0x06, Buffer.from(bytes));
  },
  utf8: (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8')),
  ia5: (value: string): Buffer => tlv(0x16, Buffer.from(value, 'ascii')),
  octet: (content: Buffer): Buffer => tlv(0x04, content),
  bitString: (content: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), content])),
  /** UTCTime `YYMMDDHHMMSSZ`. */
  utcTime: (date: Date): Buffer =>
    tlv(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii')),
  /** `[n]` explicite (constructed). */
  explicit: (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content),
  /** `[n]` implicite primitif (ex. dNSName IA5String dans un GeneralName). */
  implicit: (n: number, content: Buffer): Buffer => tlv(0x80 | n, content),
  raw: (buffer: Buffer): Buffer => buffer,
};

/** `Name` à un seul RDN `CN=<value>`. */
export function nameCn(value: string): Buffer {
  return der.seq(der.set(der.seq(der.oid(OID.commonName), der.utf8(value))));
}

/** Extension `subjectAltName` : dNSName, ou iPAddress pour `ip:<IPv4|IPv6>` (tests). */
export function sanExtension(names: string[]): Buffer {
  const generalNames = der.seq(
    ...names.map((n) =>
      n.startsWith('ip:')
        ? der.implicit(7, ipBytes(n.slice(3)))
        : der.implicit(2, Buffer.from(n, 'ascii')),
    ),
  );
  return der.seq(der.oid(OID.subjectAltName), der.octet(generalNames));
}

/** CSR PKCS#10 signée ECDSA/SHA-256 avec la clé P-256 fournie (PEM ou KeyObject). */
export function createCsr(privateKey: KeyObject | string, names: string[]): Buffer {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const primary = names[0];
  if (primary === undefined) throw new Error('at least one name is required');
  const info = der.seq(
    der.int(0),
    nameCn(primary),
    der.raw(Buffer.from(spki)),
    der.explicit(0, der.seq(der.oid(OID.extensionRequest), der.set(der.seq(sanExtension(names))))),
  );
  const signature = sign('sha256', info, key);
  return der.seq(info, der.seq(der.oid(OID.ecdsaWithSha256)), der.bitString(signature));
}

function ipBytes(address: string): Buffer {
  if (address.includes(':')) {
    const halves = address.split('::');
    const head = (halves[0] ?? '').split(':').filter(Boolean);
    const tail = (halves[1] ?? '').split(':').filter(Boolean);
    const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
    return out;
  }
  return Buffer.from(address.split('.').map(Number));
}

export function toPem(label: string, body: Buffer): string {
  const b64 = body
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
