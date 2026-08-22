/**
 * Client ACME DNS-01 contre le faux serveur : compte créé, TXT posé par le handler, validation,
 * CSR acceptée (signature vérifiée côté serveur), chaîne PEM lisible par `X509Certificate` et
 * vérifiable avec la CA de test ; reprise sur `badNonce` ; échec propre si le TXT ne paraît pas.
 */
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCsr, toPem } from './der.js';
import {
  AcmeClient,
  AcmeError,
  dnsChallengeValue,
  generateAccountKey,
  jwkThumbprint,
} from './acme.js';
import { parseCsr, startFakeAcme, type FakeAcme } from '../../test/acme-fake.js';

describe('der — CSR', () => {
  it('produit une CSR PKCS#10 dont la signature se vérifie', () => {
    const { privateKey } = generateKeyPair();
    const csr = createCsr(privateKey, ['panel.example.org', 'www.example.org']);
    const parsed = parseCsr(csr);
    expect(parsed.valid).toBe(true);
    expect(toPem('CERTIFICATE REQUEST', csr)).toContain('-----BEGIN CERTIFICATE REQUEST-----');
  });
});

describe('AcmeClient', () => {
  let acme: FakeAcme;
  beforeAll(async () => {
    acme = await startFakeAcme();
  });
  afterAll(async () => {
    await acme.close();
  });

  it('obtient un certificat par DNS-01 (fournisseur automatique)', async () => {
    const account = generateAccountKey();
    const client = new AcmeClient(account, {
      directoryUrl: acme.directoryUrl,
      fetchImpl: fetch,
      resolveTxt: (name) => acme.resolveTxt(name),
      pollIntervalMs: 10,
      propagationTimeoutMs: 2_000,
      statusTimeoutMs: 2_000,
    });
    const presented: string[] = [];
    const result = await client.issue(
      ['panel.example.org'],
      {
        present: (name, value) => {
          presented.push(name);
          acme.txt.set(name, [value]);
          return Promise.resolve();
        },
        cleanup: (name) => {
          acme.txt.delete(name);
          return Promise.resolve();
        },
      },
      'admin@example.org',
    );
    expect(presented).toEqual(['_acme-challenge.panel.example.org']);
    expect(result.account.kid).toMatch(/\/acct\/\d+$/);
    expect(acme.accounts).toBe(1);
    const leaf = new X509Certificate(result.certificatePem);
    expect(leaf.subjectAltName).toBe('DNS:panel.example.org, IP Address:127.0.0.1');
    expect(leaf.checkHost('panel.example.org')).toBe('panel.example.org');
    const ca = new X509Certificate(acme.ca.certPem);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    // La clé privée correspond au certificat.
    expect(leaf.checkPrivateKey(createPrivateKey(result.privateKeyPem))).toBe(true);
    expect(acme.txt.size).toBe(0);
  });

  it('réutilise le compte (kid) et survit à un badNonce', async () => {
    const flaky = await startFakeAcme({ badNonceOnce: true });
    try {
      const account = generateAccountKey();
      const client = new AcmeClient(account, {
        directoryUrl: flaky.directoryUrl,
        fetchImpl: fetch,
        resolveTxt: (name) => flaky.resolveTxt(name),
        pollIntervalMs: 10,
        propagationTimeoutMs: 1_000,
        statusTimeoutMs: 1_000,
      });
      const handler = {
        present: (name: string, value: string) => {
          flaky.txt.set(name, [value]);
          return Promise.resolve();
        },
        cleanup: () => Promise.resolve(),
      };
      await client.issue(['a.example.org'], handler);
      await client.issue(['b.example.org'], handler);
      expect(flaky.accounts).toBe(1);
      expect(flaky.badNonces).toBe(1);
      expect(flaky.orders.map((o) => o.status)).toEqual(['valid', 'valid']);
    } finally {
      await flaky.close();
    }
  });

  it('échoue proprement si le TXT ne se propage pas', async () => {
    const client = new AcmeClient(generateAccountKey(), {
      directoryUrl: acme.directoryUrl,
      fetchImpl: fetch,
      resolveTxt: (name) => acme.resolveTxt(name),
      pollIntervalMs: 10,
      propagationTimeoutMs: 100,
      statusTimeoutMs: 500,
    });
    const cleaned: string[] = [];
    await expect(
      client.issue(['nope.example.org'], {
        present: () => Promise.resolve(),
        cleanup: (name) => {
          cleaned.push(name);
          return Promise.resolve();
        },
      }),
    ).rejects.toBeInstanceOf(AcmeError);
    expect(cleaned).toEqual(['_acme-challenge.nope.example.org']);
  });

  it('calcule la valeur TXT à partir du token et de l’empreinte JWK', () => {
    const account = generateAccountKey();
    const value = dnsChallengeValue('tok', account.jwk);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwkThumbprint(account.jwk)).toHaveLength(43);
  });
});

function generateKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}
