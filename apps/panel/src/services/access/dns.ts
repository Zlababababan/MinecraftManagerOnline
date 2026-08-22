/**
 * Fournisseurs DNS du mode `direct` (doc 03 §5) : pose du TXT `_acme-challenge` (DNS-01) et mise à
 * jour de l'AAAA (DynDNS). Zéro dépendance : API HTTP publiques via `fetch` injectable.
 * - `duckdns` : un seul appel couvre DynDNS (`ipv6=`) et TXT (`txt=`), TXT servi pour tous les
 *   sous-domaines (dont `_acme-challenge`).
 * - `cloudflare` : API v4 avec jeton (zone déduite du domaine si non renseignée).
 * - `generic` : URL de mise à jour avec `{ipv6}`/`{ipv4}`/`{host}` (dynv6, no-ip…) — pas de DNS-01.
 * - `manual` : rien n'est automatisé ; le TXT est affiché à l'utilisateur, la propagation est sondée.
 */
import type { DnsProvider } from '@mmo/protocol/client';

export interface DnsConfig {
  provider: DnsProvider;
  domain: string;
  token?: string | undefined;
  zone?: string | undefined;
  updateUrl?: string | undefined;
}

export interface DnsClient {
  readonly supportsChallenge: boolean;
  readonly supportsDynDns: boolean;
  setTxt(name: string, value: string): Promise<void>;
  removeTxt(name: string, value: string): Promise<void>;
  updateAddress(host: string, ipv6: string | undefined, ipv4: string | undefined): Promise<void>;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export class DnsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsError';
  }
}

export function createDnsClient(config: DnsConfig, fetchImpl: typeof fetch): DnsClient {
  switch (config.provider) {
    case 'duckdns':
      return new DuckDnsClient(config, fetchImpl);
    case 'cloudflare':
      return new CloudflareClient(config, fetchImpl);
    case 'generic':
      return new GenericUpdateClient(config, fetchImpl);
    case 'manual':
      return new ManualClient();
  }
}

class ManualClient implements DnsClient {
  readonly supportsChallenge = true;
  readonly supportsDynDns = false;
  setTxt(): Promise<void> {
    return Promise.resolve();
  }
  removeTxt(): Promise<void> {
    return Promise.resolve();
  }
  updateAddress(): Promise<void> {
    return Promise.reject(new DnsError('manual provider cannot update records'));
  }
}

class DuckDnsClient implements DnsClient {
  readonly supportsChallenge = true;
  readonly supportsDynDns = true;

  constructor(
    private readonly config: DnsConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private get subdomain(): string {
    return (
      this.config.domain
        .replace(/\.duckdns\.org$/i, '')
        .split('.')
        .pop() ?? this.config.domain
    );
  }

  private async call(params: Record<string, string>): Promise<void> {
    if (!this.config.token) throw new DnsError('DuckDNS token missing');
    const url = new URL('https://www.duckdns.org/update');
    url.searchParams.set('domains', this.subdomain);
    url.searchParams.set('token', this.config.token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const text = (await res.text()).trim();
    if (!res.ok || !text.startsWith('OK'))
      throw new DnsError(`DuckDNS answered ${text || String(res.status)}`);
  }

  setTxt(_name: string, value: string): Promise<void> {
    return this.call({ txt: value });
  }
  removeTxt(_name: string, value: string): Promise<void> {
    return this.call({ txt: value, clear: 'true' });
  }
  updateAddress(_host: string, ipv6: string | undefined, ipv4: string | undefined): Promise<void> {
    const params: Record<string, string> = {};
    if (ipv6) params.ipv6 = ipv6;
    if (ipv4) params.ip = ipv4;
    if (!ipv6 && !ipv4) throw new DnsError('no address to publish');
    return this.call(params);
  }
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

class CloudflareClient implements DnsClient {
  readonly supportsChallenge = true;
  readonly supportsDynDns = true;
  private zoneId: string | undefined;
  static readonly API = 'https://api.cloudflare.com/client/v4';

  constructor(
    private readonly config: DnsConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.config.token) throw new DnsError('Cloudflare API token missing');
    const res = await this.fetchImpl(`${CloudflareClient.API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: { message: string }[];
    };
    if (!res.ok || json.success === false) {
      throw new DnsError(
        `Cloudflare ${method} ${path}: ${nonEmpty(json.errors?.map((e) => e.message).join('; ')) ?? String(res.status)}`,
      );
    }
    return json.result as T;
  }

  private async zone(): Promise<string> {
    if (this.zoneId) return this.zoneId;
    const name = nonEmpty(this.config.zone) ?? this.config.domain.split('.').slice(-2).join('.');
    const zones = await this.api<{ id: string }[]>(
      'GET',
      `/zones?name=${encodeURIComponent(name)}`,
    );
    const zone = zones[0];
    if (zone === undefined) throw new DnsError(`Cloudflare zone ${name} not found`);
    this.zoneId = zone.id;
    return zone.id;
  }

  private async find(type: string, name: string): Promise<CfRecord[]> {
    const zone = await this.zone();
    return this.api<CfRecord[]>(
      'GET',
      `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
    );
  }

  async setTxt(name: string, value: string): Promise<void> {
    const zone = await this.zone();
    await this.api('POST', `/zones/${zone}/dns_records`, {
      type: 'TXT',
      name,
      content: value,
      ttl: 60,
    });
  }

  async removeTxt(name: string, value: string): Promise<void> {
    const zone = await this.zone();
    for (const record of await this.find('TXT', name)) {
      if (record.content.replace(/^"|"$/g, '') === value) {
        await this.api('DELETE', `/zones/${zone}/dns_records/${record.id}`);
      }
    }
  }

  async updateAddress(
    host: string,
    ipv6: string | undefined,
    ipv4: string | undefined,
  ): Promise<void> {
    const zone = await this.zone();
    const wanted: [string, string | undefined][] = [
      ['AAAA', ipv6],
      ['A', ipv4],
    ];
    for (const [type, content] of wanted) {
      if (!content) continue;
      const existing = (await this.find(type, host))[0];
      if (existing === undefined) {
        await this.api('POST', `/zones/${zone}/dns_records`, {
          type,
          name: host,
          content,
          ttl: 120,
          proxied: false,
        });
      } else if (existing.content !== content) {
        await this.api('PATCH', `/zones/${zone}/dns_records/${existing.id}`, { content });
      }
    }
  }
}

class GenericUpdateClient implements DnsClient {
  readonly supportsChallenge = false;
  readonly supportsDynDns = true;

  constructor(
    private readonly config: DnsConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  setTxt(): Promise<void> {
    return Promise.reject(
      new DnsError('generic provider cannot set TXT records (use manual DNS-01)'),
    );
  }
  removeTxt(): Promise<void> {
    return Promise.resolve();
  }
  async updateAddress(
    host: string,
    ipv6: string | undefined,
    ipv4: string | undefined,
  ): Promise<void> {
    if (!this.config.updateUrl) throw new DnsError('update URL missing');
    const url = this.config.updateUrl
      .replace(/\{ipv6\}/g, encodeURIComponent(ipv6 ?? ''))
      .replace(/\{ipv4\}/g, encodeURIComponent(ipv4 ?? ''))
      .replace(/\{ip\}/g, encodeURIComponent(ipv6 ?? ipv4 ?? ''))
      .replace(/\{host\}/g, encodeURIComponent(host))
      .replace(/\{token\}/g, encodeURIComponent(this.config.token ?? ''));
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const text = (await res.text()).trim();
    if (!res.ok || /^(KO|badauth|nohost|abuse|911)/i.test(text)) {
      throw new DnsError(`update URL answered ${text || String(res.status)}`);
    }
  }
}
