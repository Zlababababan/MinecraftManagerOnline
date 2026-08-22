/**
 * Phase 10 — couche d'accès pluggable (doc 03 §5), **sans aucune API Tailscale** :
 * - `tailscale` : le panel reste sur 127.0.0.1 ; on affiche la commande `tailscale serve` à exécuter
 *   une fois et on teste le chemin complet (HTTP + WebSocket + frames binaires) via `/ws/probe`.
 * - `direct` : certificat Let's Encrypt par **ACME DNS-01** (client maison, `access/acme.ts`),
 *   fournisseur DNS pluggable (`access/dns.ts`), client DynDNS (AAAA = IPv6 globale de l'hôte),
 *   listener HTTPS démarré/rechargé à chaud (`setSecureContext`) lié à l'adresse publique — jamais
 *   `::`/`0.0.0.0` —, règles pare-feu affichées (hôte du panel + serveurs exposés en direct).
 * - `manual` : reverse-proxy/certificats de l'utilisateur ; seul le test de joignabilité s'applique.
 * - Par serveur : `expose_mode` → « adresse à donner aux amis » + test Server List Ping.
 */
import type { FastifyBaseLogger } from 'fastify';
import { randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import WebSocket from 'ws';

import type {
  AccessMode,
  AccessStatusDto,
  AccessTestResult,
  CertificateDto,
  DnsProvider,
  FirewallRulesDto,
  ReachabilityResult,
  ServerAddressDto,
} from '@mmo/protocol/client';

import type { PanelConfig } from '../config.js';
import type { MachineRow, ServerRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import { parseJson } from '../util/json.js';
import {
  AcmeClient,
  LETS_ENCRYPT_DIRECTORY,
  generateAccountKey,
  type AcmeAccountKey,
} from './access/acme.js';
import { createDnsClient, type DnsClient } from './access/dns.js';
import { formatAddress, pingMinecraft } from './access/mcping.js';
import type { AuditService } from './audit.js';
import type { EventBus } from './events.js';
import type { MachinesService } from './machines.js';
import type { ServersService } from './servers.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

export interface AccessDeps {
  config: PanelConfig;
  settings: SettingsService;
  machines: MachinesService;
  servers: ServersService;
  events: EventBus;
  audit: AuditService;
  logger: FastifyBaseLogger;
  now: () => number;
  fetchImpl: typeof fetch;
  /** Tests : adresses de l'hôte du panel, résolution TXT, directory ACME, cadences. */
  localAddresses?: () => { ipv6: string[]; ipv4: string[] };
  resolveTxt?: (name: string) => Promise<string[][]>;
  acmeDirectory?: string | undefined;
  acme?: { pollIntervalMs?: number; propagationTimeoutMs?: number; statusTimeoutMs?: number };
  dyndnsIntervalMs?: number;
  renewIntervalMs?: number;
  renewBeforeDays?: number;
}

interface AccessState {
  publishedAddress: string | null;
  lastUpdateAt: number | null;
  lastError: string | null;
  certificateError: string | null;
  lastTest: { at: number; ok: boolean; via: string | null } | null;
  previousCandidates: string[];
}

const RENEW_BEFORE_DAYS = 30;
const PROBE_BYTES = 64 * 1024;

export class AccessService {
  private readonly tlsDir: string;
  private readonly stateFile: string;
  private state: AccessState;
  private httpServer: http.Server | undefined;
  private httpsServer: https.Server | undefined;
  private httpsHost: string | undefined;
  private timers: NodeJS.Timeout[] = [];
  private issuing: Promise<CertificateDto> | undefined;
  private dnsClient: DnsClient | undefined;
  private dnsClientKey = '';
  pendingChallenge: { name: string; value: string } | null = null;

  constructor(private readonly deps: AccessDeps) {
    this.tlsDir = path.join(deps.config.dataDir, 'tls');
    this.stateFile = path.join(this.tlsDir, 'state.json');
    this.state = this.loadState();
  }

  // --- Cycle de vie -------------------------------------------------------------------------------

  /** Après `listen` : HTTPS si un certificat existe (mode direct), DynDNS et renouvellement périodiques. */
  start(server: http.Server): void {
    this.httpServer = server;
    if (this.mode() === 'direct') {
      if (this.certificatePem() !== undefined) {
        void this.ensureHttps().catch((error: unknown) => {
          this.deps.logger.warn({ err: error }, 'https listener failed');
        });
      }
      const dyn = setInterval(
        () => {
          void this.tickDynDns();
        },
        this.deps.dyndnsIntervalMs ?? 10 * 60_000,
      );
      dyn.unref();
      const renew = setInterval(
        () => {
          void this.tickRenew();
        },
        this.deps.renewIntervalMs ?? 24 * 3_600_000,
      );
      renew.unref();
      this.timers = [dyn, renew];
      void this.tickDynDns();
      void this.tickRenew();
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.httpsServer?.close();
    this.httpsServer = undefined;
  }

  mode(): AccessMode {
    const v = this.deps.settings.get(SETTING_KEYS.accessMode);
    return v === 'direct' || v === 'manual' ? v : 'tailscale';
  }

  // --- Statut --------------------------------------------------------------------------------------

  status(requestHeaders: Record<string, string | string[] | undefined> = {}): AccessStatusDto {
    const mode = this.mode();
    const publicUrl = this.deps.settings.get(SETTING_KEYS.publicUrl) ?? null;
    const cert = this.certificateInfo();
    const domain = nonEmpty(this.deps.settings.get('access.domain')) ?? null;
    return {
      mode,
      publicUrl,
      listen: { host: this.deps.config.host, port: this.deps.config.port },
      https: {
        listening: this.httpsServer?.listening === true,
        port: this.httpsServer?.listening ? this.httpsPort() : null,
      },
      tailscaleServeCommand: mode === 'tailscale' ? this.tailscaleServeCommand() : null,
      direct:
        mode === 'direct'
          ? {
              domain,
              dnsProvider: this.dnsProvider(),
              dnsTokenSet: Boolean(this.deps.settings.get('access.dns.token')),
              acmeEmail: nonEmpty(this.deps.settings.get('access.acme.email')) ?? null,
              acmeDirectory: this.acmeDirectory(),
              certificate: cert,
              certificateError: this.state.certificateError,
              dyndns: {
                enabled: this.deps.settings.getBool('access.dyndns.enabled'),
                currentAddress: this.currentAddress() ?? null,
                publishedAddress: this.state.publishedAddress,
                lastUpdateAt: this.state.lastUpdateAt,
                lastError: this.state.lastError,
              },
              pendingChallenge: this.pendingChallenge,
            }
          : null,
      lastTest: this.state.lastTest,
      requestVia: requestVia(requestHeaders),
    };
  }

  /** `tailscale serve` : HTTPS sur le tailnet → panel local (doc 03 §5). */
  tailscaleServeCommand(): string {
    const { host, port } = this.deps.config;
    return `tailscale serve --bg --https=443 http://${host}:${String(port)}`;
  }

  certificateInfo(): CertificateDto | null {
    const pem = this.certificatePem();
    if (pem === undefined) return null;
    try {
      const cert = new X509Certificate(pem);
      const validTo = Date.parse(cert.validTo);
      const names = (cert.subjectAltName ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('DNS:'))
        .map((s) => s.slice(4));
      return {
        subject: cert.subject.replace(/^CN=/, ''),
        issuer: cert.issuer.split('\n').find((l) => l.startsWith('CN=')) ?? cert.issuer,
        validFrom: Date.parse(cert.validFrom),
        validTo,
        names,
        daysLeft: Math.round(((validTo - this.deps.now()) / 86_400_000) * 10) / 10,
      };
    } catch {
      return null;
    }
  }

  // --- Certificat (ACME DNS-01) ----------------------------------------------------------------------

  /** Demande (ou renouvelle) le certificat du domaine ; une seule commande à la fois. */
  issueCertificate(): Promise<CertificateDto> {
    if (this.issuing) return this.issuing;
    this.issuing = this.doIssue().finally(() => {
      this.issuing = undefined;
    });
    return this.issuing;
  }

  private async doIssue(): Promise<CertificateDto> {
    if (this.mode() !== 'direct') {
      throw new AppError(
        'E_ACCESS_NOT_CONFIGURED',
        'certificate requests require access.mode=direct',
      );
    }
    const domain = this.deps.settings.get('access.domain');
    if (!domain) throw new AppError('E_ACCESS_NOT_CONFIGURED', 'access.domain missing');
    const dns = this.dns(domain);
    if (!dns.supportsChallenge) {
      throw new AppError(
        'E_ACCESS_NOT_CONFIGURED',
        'DNS provider cannot answer DNS-01 (use manual)',
      );
    }
    const manual = this.dnsProvider() === 'manual';
    fs.mkdirSync(this.tlsDir, { recursive: true });
    const account = this.loadAccount();
    const client = new AcmeClient(account, {
      directoryUrl: this.acmeDirectory(),
      fetchImpl: this.deps.fetchImpl,
      now: this.deps.now,
      ...(this.deps.resolveTxt === undefined ? {} : { resolveTxt: this.deps.resolveTxt }),
      ...(this.deps.acme?.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.deps.acme.pollIntervalMs }),
      propagationTimeoutMs:
        this.deps.acme?.propagationTimeoutMs ?? (manual ? 30 * 60_000 : 10 * 60_000),
      ...(this.deps.acme?.statusTimeoutMs === undefined
        ? {}
        : { statusTimeoutMs: this.deps.acme.statusTimeoutMs }),
      log: (message, data) => {
        this.deps.logger.info(data ?? {}, message);
      },
    });
    try {
      const result = await client.issue(
        [domain],
        {
          present: async (name, value) => {
            this.pendingChallenge = { name, value };
            if (!manual) await dns.setTxt(name, value);
          },
          cleanup: async (name, value) => {
            this.pendingChallenge = null;
            if (!manual) await dns.removeTxt(name, value);
          },
        },
        nonEmpty(this.deps.settings.get('access.acme.email')),
      );
      this.saveAccount(result.account);
      fs.writeFileSync(path.join(this.tlsDir, 'cert.pem'), result.certificatePem, 'utf8');
      fs.writeFileSync(path.join(this.tlsDir, 'key.pem'), result.privateKeyPem, {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.state.certificateError = null;
      this.saveState();
      await this.ensureHttps();
      const info = this.certificateInfo();
      if (info === null) throw new AppError('E_ACME_FAILED', 'issued certificate is unreadable');
      this.deps.audit.record({
        action: 'access.certificateIssued',
        details: { domain, validTo: info.validTo },
      });
      this.deps.events.publish({
        type: 'access.certificateIssued',
        payload: { domain, validTo: info.validTo },
      });
      return info;
    } catch (error) {
      this.pendingChallenge = null;
      const reason = error instanceof Error ? error.message : String(error);
      this.state.certificateError = reason;
      this.saveState();
      if (error instanceof AppError) throw error;
      throw new AppError('E_ACME_FAILED', reason, { details: { reason } });
    }
  }

  private async tickRenew(): Promise<void> {
    const info = this.certificateInfo();
    if (info === null || info.daysLeft > (this.deps.renewBeforeDays ?? RENEW_BEFORE_DAYS)) return;
    if (this.dnsProvider() === 'manual') return; // renouvellement manuel : l'UI avertit
    try {
      await this.issueCertificate();
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'certificate renewal failed');
    }
  }

  // --- HTTPS -------------------------------------------------------------------------------------

  httpsPort(): number {
    return this.deps.settings.getInt('access.httpsPort', 443);
  }

  /** Démarre (ou recharge) le listener HTTPS sur l'adresse publique de l'hôte. */
  async ensureHttps(): Promise<void> {
    const pem = this.certificatePem();
    const key = this.privateKeyPem();
    if (pem === undefined || key === undefined || this.httpServer === undefined) return;
    const host = nonEmpty(this.deps.settings.get('access.publicHost')) ?? this.currentAddress();
    if (!host) throw new AppError('E_ACCESS_NOT_CONFIGURED', 'no public address to bind HTTPS on');
    if (host === '::' || host === '0.0.0.0')
      throw new AppError('E_ACCESS_NOT_CONFIGURED', 'refusing to bind all interfaces');
    const context = { cert: pem, key };
    if (this.httpsServer && this.httpsHost === host) {
      this.httpsServer.setSecureContext(context);
      return;
    }
    this.httpsServer?.close();
    const upstream = this.httpServer;
    const server = https.createServer(context, (req, res) => {
      upstream.emit('request', req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      upstream.emit('upgrade', req, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.httpsPort(), host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.httpsServer = server;
    this.httpsHost = host;
    this.deps.logger.info({ host, port: this.httpsPort() }, 'https listener ready');
  }

  // --- DynDNS ------------------------------------------------------------------------------------

  /** IPv6 globale « stable » de l'hôte : surcharge manuelle, sinon candidate déjà vue au tick précédent. */
  currentAddress(): string | undefined {
    const override = this.deps.settings.get('access.publicHost');
    if (override && net.isIP(override)) return override;
    const { ipv6, ipv4 } = this.localAddresses();
    const stable = ipv6.find((a) => this.state.previousCandidates.includes(a));
    return stable ?? ipv6[0] ?? ipv4[0];
  }

  async updateDynDns(): Promise<{ address: string | null }> {
    const domain = this.deps.settings.get('access.domain');
    if (!domain) throw new AppError('E_ACCESS_NOT_CONFIGURED', 'access.domain missing');
    const dns = this.dns(domain);
    if (!dns.supportsDynDns)
      throw new AppError('E_ACCESS_NOT_CONFIGURED', 'DNS provider cannot update records');
    const { ipv6, ipv4 } = this.localAddresses();
    const address = this.currentAddress();
    this.state.previousCandidates = ipv6;
    if (!address) {
      this.state.lastError = 'no global address detected';
      this.saveState();
      throw new AppError('E_DNS_FAILED', 'no global address detected', {
        details: { reason: 'no address' },
      });
    }
    try {
      await dns.updateAddress(
        domain,
        net.isIPv6(address) ? address : undefined,
        net.isIPv4(address) ? address : ipv4[0],
      );
      const changed = this.state.publishedAddress !== address;
      this.state.publishedAddress = address;
      this.state.lastUpdateAt = this.deps.now();
      this.state.lastError = null;
      this.saveState();
      if (changed) {
        this.deps.events.publish({ type: 'access.addressPublished', payload: { domain, address } });
        // Le listener HTTPS suit l'adresse publiée.
        await this.ensureHttps().catch((error: unknown) => {
          this.deps.logger.warn({ err: error }, 'https rebind failed');
        });
      }
      return { address };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state.lastError = reason;
      this.saveState();
      if (error instanceof AppError) throw error;
      throw new AppError('E_DNS_FAILED', reason, { details: { reason } });
    }
  }

  private async tickDynDns(): Promise<void> {
    if (!this.deps.settings.getBool('access.dyndns.enabled')) return;
    try {
      await this.updateDynDns();
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'dyndns update failed');
    }
  }

  // --- Pare-feu ------------------------------------------------------------------------------------

  firewallRules(): FirewallRulesDto {
    const mode = this.mode();
    const panelOs =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const servers: FirewallRulesDto['servers'] = [];
    for (const server of this.deps.servers.list()) {
      if (server.exposeMode !== 'direct' || server.provisioning === 'archived') continue;
      const machine = this.deps.machines.get(server.machineId);
      const port = server.gamePort ?? 25565;
      servers.push({
        serverId: server.id,
        name: server.name,
        machineId: server.machineId,
        machineName: machine?.name ?? server.machineId,
        os: machine?.os ?? null,
        port,
        commands: firewallCommands(machine?.os ?? null, port, `MMO ${server.name}`),
      });
    }
    return {
      panel:
        mode === 'direct'
          ? {
              os: panelOs,
              port: this.httpsPort(),
              commands: firewallCommands(panelOs, this.httpsPort(), 'MMO panel HTTPS'),
            }
          : null,
      servers,
      boxNote: mode === 'direct' || servers.length > 0,
    };
  }

  // --- Test de joignabilité du panel -------------------------------------------------------------------

  /** HTTP (`/api/health`) + WS (`/ws/probe`, écho d'une frame binaire 64 KiB) + TLS, à travers l'URL publique. */
  async testReachability(urlOverride?: string): Promise<AccessTestResult> {
    const base = (urlOverride ?? this.deps.settings.get(SETTING_KEYS.publicUrl) ?? '').replace(
      /\/+$/,
      '',
    );
    if (!base) throw new AppError('E_ACCESS_NOT_CONFIGURED', 'panel.publicUrl missing');
    const started = this.deps.now();
    const result: AccessTestResult = {
      url: base,
      http: { ok: false, status: null, ms: 0, error: null },
      ws: { ok: false, ms: 0, error: null },
      binary: { ok: false, bytes: PROBE_BYTES, error: null },
      tls: { ok: !base.startsWith('https://'), issuer: null, error: null },
      via: null,
      ok: false,
    };
    try {
      const res = await this.deps.fetchImpl(`${base}/api/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      result.http = {
        ok: res.ok,
        status: res.status,
        ms: this.deps.now() - started,
        error: res.ok ? null : `HTTP ${String(res.status)}`,
      };
      await res.arrayBuffer().catch(() => undefined);
    } catch (error) {
      result.http = {
        ok: false,
        status: null,
        ms: this.deps.now() - started,
        error: errorText(error),
      };
    }
    if (base.startsWith('https://')) {
      const u = new URL(base);
      result.tls = await probeTls(u.hostname, Number(u.port || 443));
    }
    const wsStarted = this.deps.now();
    try {
      const probe = await probeWebSocket(`${base.replace(/^http/, 'ws')}/ws/probe`, PROBE_BYTES);
      result.ws = { ok: true, ms: this.deps.now() - wsStarted, error: null };
      result.binary = {
        ok: probe.echoed,
        bytes: PROBE_BYTES,
        error: probe.echoed ? null : 'binary frame altered',
      };
      result.via = probe.via;
    } catch (error) {
      result.ws = { ok: false, ms: this.deps.now() - wsStarted, error: errorText(error) };
      result.binary = { ok: false, bytes: PROBE_BYTES, error: 'websocket failed' };
    }
    result.ok = result.http.ok && result.ws.ok && result.binary.ok && result.tls.ok;
    this.state.lastTest = { at: this.deps.now(), ok: result.ok, via: result.via };
    this.saveState();
    return result;
  }

  // --- Serveurs : adresse à donner aux amis + joignabilité --------------------------------------------

  serverAddress(server: ServerRow): ServerAddressDto {
    const machine = this.deps.machines.get(server.machineId);
    const port = server.gamePort ?? 25565;
    const addresses = parseAddresses(machine);
    let host: string | null;
    let source: ServerAddressDto['source'];
    let alternatives: string[];
    if (server.exposeMode === 'tailnet') {
      if (machine?.tailnetHost) {
        host = machine.tailnetHost;
        source = 'machine';
        alternatives = addresses.tailnet;
      } else {
        host = addresses.tailnet.find((a) => net.isIPv4(a)) ?? addresses.tailnet[0] ?? null;
        source = host === null ? 'none' : 'detected';
        alternatives = addresses.tailnet.filter((a) => a !== host);
      }
    } else {
      const domain = this.deps.settings.get('access.domain');
      if (machine?.publicHost) {
        host = machine.publicHost;
        source = 'machine';
        alternatives = addresses.global;
      } else if (domain && this.isPanelHost(addresses.global)) {
        host = domain;
        source = 'domain';
        alternatives = addresses.global;
      } else {
        host = addresses.global.find((a) => net.isIPv6(a)) ?? addresses.global[0] ?? null;
        source = host === null ? 'none' : 'detected';
        alternatives = addresses.global.filter((a) => a !== host);
      }
    }
    return {
      exposeMode: server.exposeMode,
      address: host === null ? null : formatAddress(host, port),
      host,
      port,
      source,
      alternatives: alternatives.map((a) => formatAddress(a, port)),
    };
  }

  async testServer(server: ServerRow, address?: string): Promise<ReachabilityResult> {
    const target = address ?? this.serverAddress(server).address;
    if (!target) throw new AppError('E_ACCESS_NOT_CONFIGURED', 'no address known for this server');
    return pingMinecraft(target, { now: this.deps.now });
  }

  // --- Internes ------------------------------------------------------------------------------------

  private isPanelHost(machineGlobal: string[]): boolean {
    const mine = this.localAddresses();
    return machineGlobal.some((a) => mine.ipv6.includes(a) || mine.ipv4.includes(a));
  }

  private localAddresses(): { ipv6: string[]; ipv4: string[] } {
    return this.deps.localAddresses?.() ?? hostGlobalAddresses();
  }

  private dnsProvider(): DnsProvider {
    const v = this.deps.settings.get('access.dns.provider');
    return v === 'duckdns' || v === 'cloudflare' || v === 'generic' ? v : 'manual';
  }

  private acmeDirectory(): string {
    return (
      this.deps.acmeDirectory ??
      this.deps.settings.get('access.acme.directory') ??
      LETS_ENCRYPT_DIRECTORY
    );
  }

  private dns(domain: string): DnsClient {
    const key = [
      this.dnsProvider(),
      domain,
      this.deps.settings.get('access.dns.token'),
      this.deps.settings.get('access.dns.zone'),
      this.deps.settings.get('access.dns.updateUrl'),
    ].join('|');
    if (this.dnsClient === undefined || this.dnsClientKey !== key) {
      this.dnsClient = createDnsClient(
        {
          provider: this.dnsProvider(),
          domain,
          token: this.deps.settings.get('access.dns.token'),
          zone: this.deps.settings.get('access.dns.zone'),
          updateUrl: this.deps.settings.get('access.dns.updateUrl'),
        },
        this.deps.fetchImpl,
      );
      this.dnsClientKey = key;
    }
    return this.dnsClient;
  }

  private certificatePem(): string | undefined {
    return readIfExists(path.join(this.tlsDir, 'cert.pem'));
  }
  private privateKeyPem(): string | undefined {
    return readIfExists(path.join(this.tlsDir, 'key.pem'));
  }

  private loadAccount(): AcmeAccountKey {
    const raw = readIfExists(path.join(this.tlsDir, 'account.json'));
    const parsed =
      raw === undefined ? undefined : parseJson<AcmeAccountKey | undefined>(raw, undefined);
    if (parsed?.jwk.d && parsed.jwk.x) return parsed;
    const fresh = generateAccountKey();
    this.saveAccount(fresh);
    return fresh;
  }
  private saveAccount(account: AcmeAccountKey): void {
    fs.mkdirSync(this.tlsDir, { recursive: true });
    fs.writeFileSync(path.join(this.tlsDir, 'account.json'), JSON.stringify(account), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private loadState(): AccessState {
    const raw = readIfExists(this.stateFile);
    const base: AccessState = {
      publishedAddress: null,
      lastUpdateAt: null,
      lastError: null,
      certificateError: null,
      lastTest: null,
      previousCandidates: [],
    };
    return raw === undefined ? base : { ...base, ...parseJson<Partial<AccessState>>(raw, {}) };
  }
  private saveState(): void {
    try {
      fs.mkdirSync(this.tlsDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8');
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'cannot persist access state');
    }
  }
}

// --- Helpers ---------------------------------------------------------------------------------------

export function requestVia(
  headers: Record<string, string | string[] | undefined>,
): AccessStatusDto['requestVia'] {
  if (headers['tailscale-user-login'] !== undefined || headers['tailscale-user-name'] !== undefined)
    return 'tailscale';
  if (
    headers['x-forwarded-for'] !== undefined ||
    headers['x-forwarded-proto'] !== undefined ||
    headers.forwarded !== undefined
  )
    return 'proxy';
  return 'direct';
}

/** IPv6 unicast globales (2000::/3) et IPv4 publiques de l'hôte du panel. */
export function hostGlobalAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): { ipv6: string[]; ipv4: string[] } {
  const ipv6: string[] = [];
  const ipv4: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family === 'IPv6') {
        const a = (info.address.split('%')[0] ?? info.address).toLowerCase();
        if (/^[23][0-9a-f]{3}:/.test(a) && !ipv6.includes(a)) ipv6.push(a);
      } else if (!isPrivateV4(info.address) && !ipv4.includes(info.address)) {
        ipv4.push(info.address);
      }
    }
  }
  return { ipv6, ipv4 };
}

function isPrivateV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

export function firewallCommands(osName: string | null, port: number, label: string): string[] {
  const p = String(port);
  switch (osName) {
    case null:
      return [`# open TCP ${p} inbound (${label})`];
    case 'windows':
      return [
        `New-NetFirewallRule -DisplayName "${label}" -Direction Inbound -Protocol TCP -LocalPort ${p} -Action Allow -Profile Any`,
      ];
    case 'linux':
      return [
        `sudo ufw allow ${p}/tcp comment "${label}"`,
        `sudo firewall-cmd --permanent --add-port=${p}/tcp && sudo firewall-cmd --reload`,
      ];
    case 'macos':
      return [
        `# /etc/pf.conf : pass in proto tcp from any to any port ${p}  (${label}), puis : sudo pfctl -f /etc/pf.conf`,
      ];
    default:
      return [`# open TCP ${p} inbound (${label})`];
  }
}

function parseAddresses(machine: MachineRow | undefined): { tailnet: string[]; global: string[] } {
  const parsed = parseJson<{ tailnet?: string[]; global?: string[] } | null>(
    machine?.addresses ?? null,
    null,
  );
  return { tailnet: parsed?.tailnet ?? [], global: parsed?.global ?? [] };
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function probeTls(host: string, port: number): Promise<AccessTestResult['tls']> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      const issuerRaw =
        (cert.issuer as Record<string, string | string[] | undefined> | undefined)?.CN ??
        (cert.issuer as Record<string, string | string[] | undefined> | undefined)?.O ??
        null;
      const issuer = Array.isArray(issuerRaw) ? (issuerRaw[0] ?? null) : issuerRaw;
      const authorized = socket.authorized;
      const authError: unknown = socket.authorizationError;
      socket.destroy();
      resolve({
        ok: authorized,
        issuer,
        error: authorized ? null : errorText(authError ?? 'unauthorized'),
      });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ ok: false, issuer: null, error: 'timeout' });
    });
    socket.once('error', (error: unknown) => {
      resolve({ ok: false, issuer: null, error: errorText(error) });
    });
  });
}

/** Ouvre `/ws/probe`, lit le message d'accueil (`via`), envoie une frame binaire et attend l'écho. */
function probeWebSocket(
  url: string,
  bytes: number,
): Promise<{ via: string | null; echoed: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    const payload = randomBytes(bytes);
    let via: string | null = null;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout'));
    }, 15_000);
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        const hello = parseJson<{ via?: string } | null>(rawDataToBuffer(data).toString(), null);
        via = hello?.via ?? null;
        ws.send(payload, { binary: true });
        return;
      }
      clearTimeout(timer);
      const echoed = rawDataToBuffer(data).equals(payload);
      ws.close();
      resolve({ via, echoed });
    });
  });
}
