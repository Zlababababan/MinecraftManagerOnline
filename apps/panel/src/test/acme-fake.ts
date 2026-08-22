/**
 * Faux serveur ACME (RFC 8555) pour les tests du mode direct : vérifie les JWS (ES256, nonce à usage
 * unique, jwk puis kid), propose un défi dns-01, valide le TXT dans un faux DNS partagé, vérifie la
 * signature de la CSR et signe un certificat avec une CA de test (X.509 produit avec l'encodeur DER
 * du panel — si `X509Certificate` le lit, l'encodeur est correct).
 */
import {
  createHash,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import http from 'node:http';

import { OID, der, nameCn, sanExtension, toPem } from '../services/access/der.js';

// --- DER : lecteur minimal ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  content: Buffer;
  /** Octets complets (en-tête + contenu). */
  raw: Buffer;
  next: number;
}

export function readTlv(buffer: Buffer, offset: number): Tlv {
  const tag = buffer[offset] ?? 0;
  let len = buffer[offset + 1] ?? 0;
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + (buffer[offset + 2 + i] ?? 0);
    headerLen = 2 + n;
  }
  const content = buffer.subarray(offset + headerLen, offset + headerLen + len);
  return {
    tag,
    content,
    raw: buffer.subarray(offset, offset + headerLen + len),
    next: offset + headerLen + len,
  };
}

function children(tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = 0;
  while (off < tlv.content.length) {
    const child = readTlv(tlv.content, off);
    out.push(child);
    off = child.next;
  }
  return out;
}

/** Vérifie une CSR PKCS#10 et retourne sa clé publique. */
export function parseCsr(csrDer: Buffer): { publicKey: KeyObject; valid: boolean } {
  const top = children(readTlv(csrDer, 0));
  const info = top[0];
  const sig = top[2];
  if (info === undefined || sig === undefined) throw new Error('malformed CSR');
  const infoChildren = children(info);
  const spki = infoChildren[2];
  if (spki === undefined) throw new Error('malformed CSR info');
  const publicKey = createPublicKey({ key: spki.raw, format: 'der', type: 'spki' });
  const signature = sig.content.subarray(1);
  return { publicKey, valid: verify('sha256', info.raw, publicKey, signature) };
}

// --- X.509 de test -----------------------------------------------------------------------------------

export interface TestCa {
  key: KeyObject;
  certPem: string;
  name: string;
}

function tbs(
  serial: number,
  issuerCn: string,
  subjectCn: string,
  spki: Buffer,
  names: string[],
  notBefore: Date,
  notAfter: Date,
  ca: boolean,
): Buffer {
  const extensions: Buffer[] = [];
  if (names.length > 0) extensions.push(sanExtension(names));
  if (ca) {
    extensions.push(
      der.seq(der.oid(OID.basicConstraints), der.bool(true), der.octet(der.seq(der.bool(true)))),
    );
  }
  return der.seq(
    der.explicit(0, der.int(2)),
    der.int(serial),
    der.seq(der.oid(OID.ecdsaWithSha256)),
    nameCn(issuerCn),
    der.seq(der.utcTime(notBefore), der.utcTime(notAfter)),
    nameCn(subjectCn),
    der.raw(spki),
    der.explicit(3, der.seq(...extensions)),
  );
}

function signCert(body: Buffer, key: KeyObject): string {
  const signature = sign('sha256', body, key);
  return toPem(
    'CERTIFICATE',
    der.seq(body, der.seq(der.oid(OID.ecdsaWithSha256)), der.bitString(signature)),
  );
}

export function createTestCa(name = 'MMO Test CA'): TestCa {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const body = tbs(
    1,
    name,
    name,
    Buffer.from(spki),
    [],
    new Date(now - 60_000),
    new Date(now + 10 * 365 * 86_400_000),
    true,
  );
  return { key: privateKey, certPem: signCert(body, privateKey), name };
}

let serial = 1000;
export function issueTestCert(
  ca: TestCa,
  publicKey: KeyObject,
  names: string[],
  validity: { notBefore?: Date; notAfter?: Date } = {},
): string {
  const spki = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
  const now = Date.now();
  serial += 1;
  const body = tbs(
    serial,
    ca.name,
    names[0] ?? 'localhost',
    spki,
    [...names, 'ip:127.0.0.1'],
    validity.notBefore ?? new Date(now - 60_000),
    validity.notAfter ?? new Date(now + 90 * 86_400_000),
    false,
  );
  return signCert(body, ca.key);
}

/** Certificat auto-signé prêt pour `https.createServer` (sans passer par ACME). */
export function selfSignedPair(names: string[], validity?: { notBefore?: Date; notAfter?: Date }) {
  const ca = createTestCa();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    ca,
    certPem: issueTestCert(ca, publicKey, names, validity),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// --- Faux serveur ACME ---------------------------------------------------------------------------------

export interface FakeAcme {
  url: string;
  directoryUrl: string;
  ca: TestCa;
  /** Faux DNS partagé : `name` → valeurs TXT. */
  txt: Map<string, string[]>;
  resolveTxt(name: string): Promise<string[][]>;
  accounts: number;
  orders: { names: string[]; status: string }[];
  /** Nombre de requêtes rejetées pour nonce invalide (test du retry `badNonce`). */
  badNonces: number;
  close(): Promise<void>;
}

export async function startFakeAcme(options: { badNonceOnce?: boolean } = {}): Promise<FakeAcme> {
  const ca = createTestCa();
  const nonces = new Set<string>();
  const accounts = new Map<string, KeyObject>();
  const txt = new Map<string, string[]>();
  interface Order {
    id: number;
    names: string[];
    status: string;
    authzStatus: string;
    token: string;
    accountKid: string;
    certPem?: string;
  }
  const orders = new Map<number, Order>();
  let nextOrder = 1;
  let badNoncePending = options.badNonceOnce === true;
  const state = { badNonces: 0 };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
      const nonce = randomBytes(16).toString('base64url');
      nonces.add(nonce);
      res.setHeader('Replay-Nonce', nonce);
      const url = req.url ?? '/';
      const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.statusCode = status;
        if (typeof body === 'string') {
          res.setHeader('Content-Type', 'application/pem-certificate-chain');
          res.end(body);
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        }
      };
      const problem = (status: number, type: string, detail: string): void => {
        send(status, { type: `urn:ietf:params:acme:error:${type}`, detail });
      };
      if (req.method === 'GET' && url === '/directory') {
        send(200, {
          newNonce: `${base}/new-nonce`,
          newAccount: `${base}/new-account`,
          newOrder: `${base}/new-order`,
        });
        return;
      }
      if (req.method === 'HEAD' && url === '/new-nonce') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        problem(405, 'malformed', 'POST expected');
        return;
      }
      // JWS
      const jws = JSON.parse(Buffer.concat(chunks).toString()) as {
        protected: string;
        payload: string;
        signature: string;
      };
      const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString()) as {
        alg: string;
        nonce: string;
        url: string;
        jwk?: Record<string, string>;
        kid?: string;
      };
      if (badNoncePending) {
        badNoncePending = false;
        state.badNonces += 1;
        problem(400, 'badNonce', 'nonce rejected once');
        return;
      }
      if (!nonces.delete(header.nonce)) {
        state.badNonces += 1;
        problem(400, 'badNonce', 'unknown nonce');
        return;
      }
      if (header.url !== `${base}${url}`) {
        problem(400, 'malformed', `url mismatch ${header.url}`);
        return;
      }
      let key: KeyObject | undefined;
      if (header.jwk) key = createPublicKey({ key: header.jwk, format: 'jwk' });
      else if (header.kid) key = accounts.get(header.kid);
      if (key === undefined || header.alg !== 'ES256') {
        problem(400, 'malformed', 'no key');
        return;
      }
      const ok = verify(
        'sha256',
        Buffer.from(`${jws.protected}.${jws.payload}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(jws.signature, 'base64url'),
      );
      if (!ok) {
        problem(400, 'malformed', 'bad signature');
        return;
      }
      const payload =
        jws.payload === ''
          ? undefined
          : (JSON.parse(Buffer.from(jws.payload, 'base64url').toString()) as Record<
              string,
              unknown
            >);
      const thumbprint = (jwk: KeyObject): string => {
        const pub = jwk.export({ format: 'jwk' }) as Record<string, string>;
        return createHash('sha256')
          .update(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y }))
          .digest('base64url');
      };

      if (url === '/new-account') {
        if (!header.jwk) {
          problem(400, 'malformed', 'jwk required');
          return;
        }
        const kid = `${base}/acct/${String(accounts.size + 1)}`;
        accounts.set(kid, key);
        send(201, { status: 'valid' }, { Location: kid });
        return;
      }
      if (url === '/new-order') {
        const identifiers = (payload?.identifiers ?? []) as { value: string }[];
        const id = nextOrder;
        nextOrder += 1;
        orders.set(id, {
          id,
          names: identifiers.map((i) => i.value),
          status: 'pending',
          authzStatus: 'pending',
          token: randomBytes(16).toString('base64url'),
          accountKid: header.kid ?? '',
        });
        send(
          201,
          {
            status: 'pending',
            authorizations: [`${base}/authz/${String(id)}`],
            finalize: `${base}/order/${String(id)}/finalize`,
          },
          { Location: `${base}/order/${String(id)}` },
        );
        return;
      }
      const m = /^\/(authz|chall|order|cert)\/(\d+)(\/finalize)?$/.exec(url);
      const order = m ? orders.get(Number(m[2])) : undefined;
      if (!m || order === undefined) {
        problem(404, 'malformed', 'unknown resource');
        return;
      }
      const authzBody = (): unknown => ({
        identifier: { type: 'dns', value: order.names[0] },
        status: order.authzStatus,
        challenges: [
          {
            type: 'dns-01',
            url: `${base}/chall/${String(order.id)}`,
            token: order.token,
            status: order.authzStatus,
          },
        ],
      });
      if (m[1] === 'authz') {
        send(200, authzBody());
        return;
      }
      if (m[1] === 'chall') {
        const expected = createHash('sha256')
          .update(`${order.token}.${thumbprint(key)}`)
          .digest('base64url');
        const records = txt.get(`_acme-challenge.${order.names[0] ?? ''}`) ?? [];
        order.authzStatus = records.includes(expected) ? 'valid' : 'invalid';
        if (order.authzStatus === 'valid') order.status = 'ready';
        send(200, {
          type: 'dns-01',
          status: order.authzStatus,
          url: `${base}/chall/${String(order.id)}`,
          token: order.token,
        });
        return;
      }
      if (m[1] === 'order' && m[3] === '/finalize') {
        if (order.status !== 'ready') {
          problem(403, 'orderNotReady', `order is ${order.status}`);
          return;
        }
        const csrB64 = payload?.csr;
        const csr = parseCsr(Buffer.from(typeof csrB64 === 'string' ? csrB64 : '', 'base64url'));
        if (!csr.valid) {
          problem(400, 'badCSR', 'CSR signature invalid');
          return;
        }
        order.certPem = issueTestCert(ca, csr.publicKey, order.names);
        order.status = 'valid';
        send(200, { status: 'valid', certificate: `${base}/cert/${String(order.id)}` });
        return;
      }
      if (m[1] === 'order') {
        send(200, {
          status: order.status,
          ...(order.certPem === undefined
            ? {}
            : { certificate: `${base}/cert/${String(order.id)}` }),
        });
        return;
      }
      send(200, `${order.certPem ?? ''}${ca.certPem}`);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  const fake: FakeAcme = {
    url,
    directoryUrl: `${url}/directory`,
    ca,
    txt,
    resolveTxt: (name) => {
      const values = txt.get(name);
      if (values === undefined || values.length === 0) return Promise.reject(new Error('ENODATA'));
      return Promise.resolve(values.map((v) => [v]));
    },
    get accounts() {
      return accounts.size;
    },
    get orders() {
      return [...orders.values()].map((o) => ({ names: o.names, status: o.status }));
    },
    get badNonces() {
      return state.badNonces;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
  return fake;
}

export { createPrivateKey };
