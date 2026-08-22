/**
 * Client ACME (RFC 8555) minimal pour le défi **DNS-01** (doc 03 §5, mode `direct`) : compte ES256,
 * commande, autorisation, défi, finalisation avec CSR P-256, téléchargement de la chaîne PEM.
 * Aucune dépendance : JWS via `node:crypto`, HTTP via un `fetch` injectable, pose du TXT déléguée à
 * un `DnsChallengeHandler` (fournisseur DNS ou saisie manuelle) et vérification de propagation via
 * un résolveur injectable (tests : faux serveur ACME + faux DNS).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { promises as dns } from 'node:dns';

import { createCsr } from './der.js';

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING_DIRECTORY =
  'https://acme-staging-v02.api.letsencrypt.org/directory';

export interface AcmeAccountKey {
  /** JWK privé (kty EC, crv P-256, x, y, d). */
  jwk: Record<string, string>;
  /** URL du compte (kid) une fois créé. */
  kid?: string | undefined;
}

export interface DnsChallengeHandler {
  /** Pose `TXT <name> "<value>"` (ou l'affiche à l'utilisateur en mode manuel, puis attend). */
  present(name: string, value: string): Promise<void>;
  /** Retrait après validation (best effort). */
  cleanup(name: string, value: string): Promise<void>;
}

export interface AcmeClientOptions {
  directoryUrl: string;
  fetchImpl: typeof fetch;
  now?: () => number;
  /** Résolution TXT (test : faux) — défaut `dns.promises.resolveTxt` avec les résolveurs système. */
  resolveTxt?: (name: string) => Promise<string[][]>;
  pollIntervalMs?: number;
  /** Attente maximale de propagation du TXT avant de déclencher la validation. */
  propagationTimeoutMs?: number;
  /** Attente maximale d'un statut final (autorisation, commande). */
  statusTimeoutMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface IssueResult {
  /** Chaîne PEM (feuille d'abord). */
  certificatePem: string;
  /** Clé privée PKCS#8 PEM du certificat. */
  privateKeyPem: string;
  /** Clé de compte (éventuellement créée) avec son `kid`. */
  account: AcmeAccountKey;
}

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly type?: string | undefined,
    readonly status?: number | undefined,
  ) {
    super(message);
    this.name = 'AcmeError';
  }
}

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

export function generateAccountKey(): AcmeAccountKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return {
    jwk: {
      kty: jwk.kty ?? 'EC',
      crv: jwk.crv ?? 'P-256',
      x: jwk.x ?? '',
      y: jwk.y ?? '',
      d: jwk.d ?? '',
    },
  };
}

/** Empreinte JWK (RFC 7638) de la clé de compte. */
export function jwkThumbprint(jwk: Record<string, string>): string {
  const ordered = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(ordered).digest('base64url');
}

/** Valeur TXT attendue pour `_acme-challenge` (RFC 8555 §8.4). */
export function dnsChallengeValue(token: string, jwk: Record<string, string>): string {
  const keyAuthorization = `${token}.${jwkThumbprint(jwk)}`;
  return createHash('sha256').update(keyAuthorization).digest('base64url');
}

function publicJwk(jwk: Record<string, string>): Record<string, string> {
  return { kty: jwk.kty ?? 'EC', crv: jwk.crv ?? 'P-256', x: jwk.x ?? '', y: jwk.y ?? '' };
}

export class AcmeClient {
  private directory: Directory | undefined;
  private nonce: string | undefined;
  private readonly key: KeyObject;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly propagationTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly resolveTxt: (name: string) => Promise<string[][]>;

  constructor(
    private readonly account: AcmeAccountKey,
    private readonly options: AcmeClientOptions,
  ) {
    this.key = createPrivateKey({ key: account.jwk, format: 'jwk' });
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.propagationTimeoutMs = options.propagationTimeoutMs ?? 10 * 60_000;
    this.statusTimeoutMs = options.statusTimeoutMs ?? 5 * 60_000;
    this.resolveTxt = options.resolveTxt ?? ((name) => new dns.Resolver().resolveTxt(name));
  }

  /** Commande complète pour `names` (le premier est le CN) via DNS-01. */
  async issue(names: string[], handler: DnsChallengeHandler, email?: string): Promise<IssueResult> {
    const dir = await this.getDirectory();
    this.account.kid ??= await this.newAccount(dir.newAccount, email);
    const order = await this.post(dir.newOrder, {
      identifiers: names.map((value) => ({ type: 'dns', value })),
    });
    const orderBody = order.body as { authorizations: string[]; finalize: string };
    const orderUrl = order.location;
    if (orderUrl === undefined) throw new AcmeError('order without Location');
    for (const authzUrl of orderBody.authorizations) {
      await this.authorize(authzUrl, handler);
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const csr = createCsr(privateKey, names);
    await this.post(orderBody.finalize, { csr: csr.toString('base64url') });
    const final = await this.waitFor<{ status: string; certificate?: string }>(
      orderUrl,
      (o) => o.status === 'valid' || o.status === 'invalid',
      this.statusTimeoutMs,
    );
    if (final.status !== 'valid' || final.certificate === undefined) {
      throw new AcmeError(`order ${final.status}`);
    }
    const pem = await this.postAsGet(final.certificate, 'application/pem-certificate-chain');
    const certificatePem = await pem.text();
    if (!certificatePem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new AcmeError('certificate download did not return PEM');
    }
    return {
      certificatePem,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      account: this.account,
    };
  }

  private async authorize(authzUrl: string, handler: DnsChallengeHandler): Promise<void> {
    const authz = await this.postAsGetJson<{
      identifier: { value: string };
      status: string;
      challenges: { type: string; url: string; token: string; status: string }[];
    }>(authzUrl);
    if (authz.status === 'valid') return;
    const challenge = authz.challenges.find((c) => c.type === 'dns-01');
    if (challenge === undefined) throw new AcmeError('no dns-01 challenge offered');
    const name = `_acme-challenge.${authz.identifier.value}`;
    const value = dnsChallengeValue(challenge.token, this.account.jwk);
    this.options.log?.('acme: presenting TXT', { name });
    await handler.present(name, value);
    try {
      await this.waitForTxt(name, value);
      await this.post(challenge.url, {});
      const result = await this.waitFor<{
        status: string;
        challenges?: { error?: { detail?: string } }[];
      }>(
        authzUrl,
        (a) => a.status === 'valid' || a.status === 'invalid' || a.status === 'revoked',
        this.statusTimeoutMs,
      );
      if (result.status !== 'valid') {
        const detail = result.challenges?.map((c) => c.error?.detail).find((d) => d);
        throw new AcmeError(`authorization ${result.status}${detail ? `: ${detail}` : ''}`);
      }
    } finally {
      await handler.cleanup(name, value).catch(() => undefined);
    }
  }

  private async waitForTxt(name: string, value: string): Promise<void> {
    const deadline = this.now() + this.propagationTimeoutMs;
    for (;;) {
      try {
        const records = await this.resolveTxt(name);
        if (records.some((chunks) => chunks.join('') === value)) return;
      } catch {
        // NXDOMAIN / pas encore propagé
      }
      if (this.now() >= deadline)
        throw new AcmeError(`TXT ${name} not visible after propagation timeout`);
      await sleep(this.pollIntervalMs);
    }
  }

  private async waitFor<T>(url: string, done: (body: T) => boolean, timeoutMs: number): Promise<T> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const body = await this.postAsGetJson<T>(url);
      if (done(body)) return body;
      if (this.now() >= deadline) throw new AcmeError(`timeout waiting for ${url}`);
      await sleep(this.pollIntervalMs);
    }
  }

  private async getDirectory(): Promise<Directory> {
    if (this.directory) return this.directory;
    const res = await this.options.fetchImpl(this.options.directoryUrl, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new AcmeError(`directory: HTTP ${String(res.status)}`);
    const body = (await res.json()) as Partial<Directory>;
    if (!body.newNonce || !body.newAccount || !body.newOrder)
      throw new AcmeError('invalid directory');
    this.directory = {
      newNonce: body.newNonce,
      newAccount: body.newAccount,
      newOrder: body.newOrder,
    };
    return this.directory;
  }

  private async getNonce(): Promise<string> {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = undefined;
      return n;
    }
    const dir = await this.getDirectory();
    const res = await this.options.fetchImpl(dir.newNonce, {
      method: 'HEAD',
      signal: AbortSignal.timeout(20_000),
    });
    const nonce = res.headers.get('replay-nonce');
    if (!nonce) throw new AcmeError('no Replay-Nonce');
    return nonce;
  }

  private async newAccount(url: string, email: string | undefined): Promise<string> {
    const res = await this.post(
      url,
      {
        termsOfServiceAgreed: true,
        ...(email ? { contact: [`mailto:${email}`] } : {}),
      },
      { useJwk: true },
    );
    if (res.location === undefined) throw new AcmeError('newAccount without Location');
    return res.location;
  }

  private async post(
    url: string,
    payload: unknown,
    opts: { useJwk?: boolean; accept?: string } = {},
    retry = true,
  ): Promise<{ body: unknown; location: string | undefined; raw: Response }> {
    const nonce = await this.getNonce();
    const protectedHeader: Record<string, unknown> = { alg: 'ES256', nonce, url };
    if (opts.useJwk || this.account.kid === undefined)
      protectedHeader.jwk = publicJwk(this.account.jwk);
    else protectedHeader.kid = this.account.kid;
    const protectedB64 = Buffer.from(JSON.stringify(protectedHeader)).toString('base64url');
    const payloadB64 =
      payload === '' ? '' : Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const res = await this.options.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/jose+json',
        ...(opts.accept ? { Accept: opts.accept } : {}),
      },
      body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature }),
      signal: AbortSignal.timeout(30_000),
    });
    const fresh = res.headers.get('replay-nonce');
    if (fresh) this.nonce = fresh;
    if (!res.ok) {
      let problem: { type?: string; detail?: string } = {};
      try {
        problem = (await res.json()) as { type?: string; detail?: string };
      } catch {
        // corps non JSON
      }
      if (retry && problem.type?.endsWith(':badNonce')) {
        return this.post(url, payload, opts, false);
      }
      throw new AcmeError(problem.detail ?? `HTTP ${String(res.status)}`, problem.type, res.status);
    }
    const location = res.headers.get('location') ?? undefined;
    if (opts.accept === 'application/pem-certificate-chain') {
      return { body: undefined, location, raw: res };
    }
    const text = await res.text();
    return { body: text ? (JSON.parse(text) as unknown) : undefined, location, raw: res };
  }

  private async postAsGet(url: string, accept: string): Promise<Response> {
    const res = await this.post(url, '', { accept });
    return res.raw;
  }

  private async postAsGetJson<T>(url: string): Promise<T> {
    const res = await this.post(url, '');
    return res.body as T;
  }
}

/** Clé publique d'un JWK de compte (utile aux tests du faux serveur ACME). */
export function accountPublicKey(jwk: Record<string, string>): KeyObject {
  return createPublicKey({ key: publicJwk(jwk), format: 'jwk' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
