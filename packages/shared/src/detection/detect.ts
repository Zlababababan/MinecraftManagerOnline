/**
 * Auto-détection d'un dossier serveur (doc 06 §2) — algorithme ordonné :
 *   0. qualifier (server.properties OU eula.txt OU jar serveur + mods/)
 *   1. loader : neoforge libs → forge argfiles → forge jar universal → fabric → inspection mods/ →
 *      vanilla → inconnu
 *   2. version MC : libraries → jar → version.json → variables.txt / yaml FTB → installer → logs
 *   3. RAM : user_jvm_args.txt → variables.txt → settings.* → scripts → défaut 4 Go
 *   4. ports : server.properties
 *   5. Java requis : table (le panel affine via le manifest Mojang)
 *   6. score de confiance par champ + evidence ; tout reste éditable.
 * Le résultat est exactement le payload `server.detected` du protocole.
 */
import type {
  Confidence,
  DetectedField,
  DetectedServer,
  Evidence,
  LaunchPlan,
  Loader,
  Os,
} from '@mmo/protocol';

import { javaRequirementFromTable } from '../java/index.js';
import { parseLogText } from '../logs/parser.js';
import { matchServerLogEvent } from '../logs/patterns.js';
import { normalizeMcVersion, parseMcVersion } from '../minecraft/version.js';
import { baseName, joinPath, type DetectFs, type DirEntry } from './fs.js';

export interface DetectOptions {
  /** OS de l'agent : choisit le script de lancement à lire en priorité (`.bat` vs `.sh`). */
  os?: Os;
  /** RAM proposée quand rien n'est trouvé (doc 06 §2 : 4 Go). */
  defaultMaxRamMb?: number;
  /** Nombre de jars de `mods/` inspectés (doc 06 : 3–5). */
  modSample?: number;
}

const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
function minConfidence(...cs: Confidence[]): Confidence {
  return cs.reduce((a, b) => (CONF_RANK[a] <= CONF_RANK[b] ? a : b), 'high');
}
function field<T>(value: T, confidence: Confidence, source: string): DetectedField<T> {
  return { value, confidence, source };
}

interface Claim<T> {
  value: T;
  confidence: Confidence;
  source: string;
}

const FORGE_JAR = /^forge-(\d+\.\d+(?:\.\d+)?)-([\d.]+?)(?:-universal)?\.jar$/i;
const INSTALLER_JAR = /^(forge|neoforge)-(.+)-installer\.jar$/i;
const MINECRAFT_SERVER_JAR = /^minecraft_server[._-]?(\d+\.\d+(?:\.\d+)?)\.jar$/i;
const FABRIC_MC_LAUNCHER = /^fabric-server-mc\.(.+?)-loader\.(.+?)-launcher\.(.+?)\.jar$/i;
const VANILLA_MAIN_CLASSES = new Set([
  'net.minecraft.bundler.Main',
  'net.minecraft.server.Main',
  'net.minecraft.server.MinecraftServer',
]);
const XMX = /-Xmx(\d+)([GgMmKk])?\b/;
const XMS = /-Xms(\d+)([GgMmKk])?\b/;

class Ctx {
  readonly evidence: Evidence[] = [];
  readonly entries: DirEntry[];
  private readonly byLower: Map<string, DirEntry>;

  constructor(
    readonly fs: DetectFs,
    readonly root: string,
    entries: DirEntry[],
    readonly options: Required<DetectOptions>,
  ) {
    this.entries = entries;
    this.byLower = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  }

  note(code: string, detail?: string): void {
    if (this.evidence.some((e) => e.code === code && e.detail === detail)) return;
    this.evidence.push(detail === undefined ? { code } : { code, detail });
  }
  entry(name: string): DirEntry | undefined {
    return this.byLower.get(name.toLowerCase());
  }
  hasFile(name: string): boolean {
    return this.entry(name)?.kind === 'file';
  }
  hasDir(name: string): boolean {
    return this.entry(name)?.kind === 'dir';
  }
  files(regex: RegExp): string[] {
    return this.entries.filter((e) => e.kind === 'file' && regex.test(e.name)).map((e) => e.name);
  }
  path(...parts: string[]): string {
    return joinPath(this.root, ...parts);
  }
  readText(rel: string, maxBytes = 256 * 1024): Promise<string | undefined> {
    return this.fs.readText(this.path(rel), maxBytes);
  }
  readdir(rel: string): Promise<DirEntry[]> {
    return this.fs.readdir(this.path(rel));
  }
}

interface LoaderResult {
  loader: Claim<Loader>;
  loaderVersion?: Claim<string>;
  mcVersionClaims: Claim<string>[];
  launch?: LaunchPlan;
  needsInstall?: boolean;
}

/** Détecte un dossier serveur ; `undefined` si le dossier n'est pas qualifié (étape 0). */
export async function detectServer(
  fs: DetectFs,
  root: string,
  options: DetectOptions = {},
): Promise<DetectedServer | undefined> {
  const opts: Required<DetectOptions> = {
    os: options.os ?? 'linux',
    defaultMaxRamMb: options.defaultMaxRamMb ?? 4096,
    modSample: options.modSample ?? 5,
  };
  const entries = await fs.readdir(root);
  if (entries.length === 0) return undefined;
  const ctx = new Ctx(fs, root, entries, opts);

  // 0. Qualification
  const rootJars = ctx.files(/\.jar$/i);
  const serverJars = rootJars.filter((j) => !INSTALLER_JAR.test(j));
  const qualified =
    ctx.hasFile('server.properties') ||
    ctx.hasFile('eula.txt') ||
    (serverJars.length > 0 && ctx.hasDir('mods'));
  if (!qualified) return undefined;

  // Marqueur MMO (le panel reste l'autorité)
  const marker = await readMarker(ctx);

  // 1. Loader
  const mods = await inspectMods(ctx);
  const spc = await readVariablesTxt(ctx);
  const ftb = await readServerSetupConfig(ctx);
  const loaderResult = await detectLoader(ctx, serverJars, mods, spc, ftb);

  // 2. Version MC
  const mcVersion = await detectMcVersion(ctx, loaderResult, serverJars, rootJars, spc, ftb);

  // 3. RAM
  const ram = await detectRam(ctx, spc);

  // 4. Ports et propriétés
  const props = parseProperties((await ctx.readText('server.properties')) ?? '');
  const gamePort = toPort(props.get('server-port'));
  const rconPort = toPort(props.get('rcon.port'));
  const queryPort = toPort(props.get('query.port'));
  const rconEnabled = props.has('enable-rcon') ? props.get('enable-rcon') === 'true' : undefined;

  // EULA
  const eulaText = await ctx.readText('eula.txt', 4096);
  const eulaAccepted = eulaText !== undefined && /^\s*eula\s*=\s*true\s*$/im.test(eulaText);
  ctx.note(eulaAccepted ? 'eula_accepted' : 'eula_missing');

  // 5. Java requis (table ; le panel affine avec le manifest)
  const javaRequirement =
    mcVersion === undefined
      ? undefined
      : javaRequirementFromTable(mcVersion.value, loaderResult.loader.value);

  // 6. Assemblage
  if (loaderResult.loader.value === 'unknown') ctx.note('no_loader');
  if (mcVersion === undefined) ctx.note('no_version');
  const confidence =
    loaderResult.loader.value === 'unknown'
      ? 'low'
      : minConfidence(loaderResult.loader.confidence, mcVersion?.confidence ?? 'low');

  const result: DetectedServer = {
    path: root,
    name: baseName(root),
    loader: field(
      loaderResult.loader.value,
      loaderResult.loader.confidence,
      loaderResult.loader.source,
    ),
    maxRamMb: ram.max,
    eulaAccepted,
    confidence,
    evidence: ctx.evidence,
  };
  if (marker !== undefined) result.markerServerId = marker;
  if (mcVersion) result.mcVersion = field(mcVersion.value, mcVersion.confidence, mcVersion.source);
  if (loaderResult.loaderVersion) {
    const lv = loaderResult.loaderVersion;
    result.loaderVersion = field(lv.value, lv.confidence, lv.source);
  }
  if (ram.min) result.minRamMb = ram.min;
  if (gamePort !== undefined) result.gamePort = gamePort;
  if (rconPort !== undefined) result.rconPort = rconPort;
  if (queryPort !== undefined) result.queryPort = queryPort;
  if (rconEnabled !== undefined) result.rconEnabled = rconEnabled;
  const motd = props.get('motd');
  if (motd !== undefined && motd !== '') result.motd = motd;
  const levelName = props.get('level-name');
  if (levelName !== undefined && levelName !== '') result.levelName = levelName;
  if (javaRequirement) result.javaRequirement = javaRequirement;
  if (loaderResult.launch) result.launch = loaderResult.launch;
  if (loaderResult.needsInstall) result.needsInstall = true;
  if (mods.count !== undefined) result.modCount = mods.count;
  return result;
}

// --- Marqueur -----------------------------------------------------------------------------------

async function readMarker(ctx: Ctx): Promise<string | undefined> {
  const text = await ctx.readText('.mmo-server.json', 16 * 1024);
  if (text === undefined) return undefined;
  try {
    const json = JSON.parse(text) as { serverId?: unknown };
    if (typeof json.serverId === 'string' && json.serverId !== '') {
      ctx.note('marker', json.serverId);
      return json.serverId;
    }
  } catch {
    // marqueur corrompu : ignoré
  }
  return undefined;
}

// --- Loader -------------------------------------------------------------------------------------

interface ModsInspection {
  count: number | undefined;
  /** Votes par famille de descripteur. */
  votes: {
    fabric: number;
    forgeFamily: number;
    neoforge: number;
    forgeLegacy: number;
    ambiguous: number;
  };
  inspected: number;
}

async function inspectMods(ctx: Ctx): Promise<ModsInspection> {
  const votes = { fabric: 0, forgeFamily: 0, neoforge: 0, forgeLegacy: 0, ambiguous: 0 };
  if (!ctx.hasDir('mods')) return { count: undefined, votes, inspected: 0 };
  const top = await ctx.readdir('mods');
  const jars: string[] = top
    .filter((e) => e.kind === 'file' && /\.jar$/i.test(e.name))
    .map((e) => joinPath('mods', e.name));
  // Sous-dossiers versionnés (`mods/1.12.2/` chez SkyFactory 4)
  for (const sub of top.filter((e) => e.kind === 'dir' && /^\d+\.\d+(\.\d+)?$/.test(e.name))) {
    const inner = await ctx.readdir(joinPath('mods', sub.name));
    jars.push(
      ...inner
        .filter((e) => e.kind === 'file' && /\.jar$/i.test(e.name))
        .map((e) => joinPath('mods', sub.name, e.name)),
    );
  }
  const count = jars.length;
  if (count === 0) return { count, votes, inspected: 0 };
  // Échantillon déterministe réparti sur la liste triée
  const sorted = [...jars].sort();
  const n = Math.min(ctx.options.modSample, sorted.length);
  const sample = Array.from(
    { length: n },
    (_, i) => sorted[Math.floor((i * sorted.length) / n)] ?? '',
  );
  let inspected = 0;
  for (const rel of sample) {
    const jar = await ctx.fs.openJar(ctx.path(rel));
    if (!jar) continue;
    try {
      inspected++;
      const fabric = jar.has('fabric.mod.json') || jar.has('quilt.mod.json');
      const neo = jar.has('META-INF/neoforge.mods.toml');
      const forge = jar.has('META-INF/mods.toml');
      const legacy = jar.has('mcmod.info');
      const kinds = [fabric, neo || forge, legacy].filter(Boolean).length;
      if (kinds > 1) votes.ambiguous++;
      else if (fabric) votes.fabric++;
      else if (neo) votes.neoforge++;
      else if (forge) votes.forgeFamily++;
      else if (legacy) votes.forgeLegacy++;
    } finally {
      await jar.close();
    }
  }
  return { count, votes, inspected };
}

function modsMajority(m: ModsInspection): { loader: Loader; votes: number } | undefined {
  const candidates: [Loader, number][] = [
    ['fabric', m.votes.fabric],
    ['neoforge', m.votes.neoforge],
    ['forge', m.votes.forgeFamily + m.votes.forgeLegacy],
  ];
  const best = candidates.sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? { loader: best[0], votes: best[1] } : undefined;
}

/** Les descripteurs de mods sont-ils compatibles avec le loader retenu ? */
function modsAgree(loader: Loader, m: ModsInspection): boolean | undefined {
  const total = m.votes.fabric + m.votes.neoforge + m.votes.forgeFamily + m.votes.forgeLegacy;
  if (total === 0) return undefined;
  switch (loader) {
    case 'fabric':
      return m.votes.fabric >= total / 2;
    case 'neoforge':
      return m.votes.neoforge + m.votes.forgeFamily >= total / 2;
    case 'forge':
      return m.votes.forgeFamily + m.votes.forgeLegacy >= total / 2;
    case 'vanilla':
    case 'unknown':
      return undefined;
  }
}

interface SpcVariables {
  loader?: Loader;
  loaderVersion?: string;
  mcVersion?: string;
  javaArgs?: string;
}

/** `variables.txt` de ServerPackCreator (DungeonHeroes, Prominence II, AllOfCreate…). */
async function readVariablesTxt(ctx: Ctx): Promise<SpcVariables | undefined> {
  const text = await ctx.readText('variables.txt', 64 * 1024);
  if (text === undefined) return undefined;
  const vars = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) vars.set(m[1] ?? '', unquote(m[2] ?? ''));
  }
  const out: SpcVariables = {};
  const loader = loaderFromName(vars.get('MODLOADER'));
  if (loader) out.loader = loader;
  const lv = vars.get('MODLOADER_VERSION');
  if (lv) out.loaderVersion = lv;
  const mc = vars.get('MINECRAFT_VERSION');
  if (mc && parseMcVersion(mc)) out.mcVersion = mc;
  const ja = vars.get('JAVA_ARGS');
  if (ja) out.javaArgs = ja;
  if (out.loader || out.mcVersion) {
    ctx.note(
      'variables_txt',
      [out.loader, out.loaderVersion, out.mcVersion].filter(Boolean).join(' '),
    );
  }
  return out;
}

/** `server-setup-config.yaml` du FTB ServerStarter (`install: { mcVersion, loaderVersion, modLoader }`). */
async function readServerSetupConfig(ctx: Ctx): Promise<SpcVariables | undefined> {
  const text = await ctx.readText('server-setup-config.yaml', 64 * 1024);
  if (text === undefined) return undefined;
  const get = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'#\\n]+?)["']?\\s*$`, 'm').exec(text);
    return m?.[1]?.trim();
  };
  const out: SpcVariables = {};
  const loader = loaderFromName(get('modLoader'));
  if (loader) out.loader = loader;
  const lv = get('loaderVersion') ?? get('forgeVersion');
  if (lv) out.loaderVersion = lv;
  const mc = get('mcVersion');
  if (mc && parseMcVersion(mc)) out.mcVersion = mc;
  if (out.loader || out.mcVersion) {
    ctx.note(
      'server_setup_config',
      [out.loader, out.loaderVersion, out.mcVersion].filter(Boolean).join(' '),
    );
  }
  return out;
}

function loaderFromName(name: string | undefined): Loader | undefined {
  switch (name?.trim().toLowerCase()) {
    case 'forge':
      return 'forge';
    case 'neoforge':
      return 'neoforge';
    case 'fabric':
    case 'quilt':
    case 'legacyfabric':
      return 'fabric';
    case 'vanilla':
      return 'vanilla';
    case undefined:
    default:
      return undefined;
  }
}

/** Version du loader référencée par `run.bat`/`run.sh` (`@libraries/net/.../<v>/win_args.txt`). */
async function argfileVersionFromRunScript(
  ctx: Ctx,
  group: 'minecraftforge/forge' | 'neoforged/neoforge',
): Promise<string | undefined> {
  for (const script of ['run.bat', 'run.sh']) {
    const text = await ctx.readText(script, 64 * 1024);
    if (!text) continue;
    const m = new RegExp(`@libraries/net/${group}/([^/\\s]+)/(?:win|unix)_args\\.txt`).exec(text);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function compareVersionStrings(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (!Number.isNaN(d) && d !== 0) return d;
  }
  return 0;
}

/** `21.1.219` → `1.21.1` ; `20.4.80` → `1.20.4` ; `20.2.0` → `1.20.2` ; ancien schéma `1.20.1-47.1.3` → `1.20.1`. */
export function mcVersionFromNeoForge(version: string): string | undefined {
  const legacy = /^(1\.\d+(?:\.\d+)?)-/.exec(version);
  if (legacy?.[1]) return legacy[1];
  const m = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (!m) return undefined;
  const minor = Number(m[1]);
  const patch = Number(m[2]);
  if (minor < 20) return undefined;
  return patch === 0 ? `1.${String(minor)}` : `1.${String(minor)}.${String(patch)}`;
}

async function detectLoader(
  ctx: Ctx,
  serverJars: string[],
  mods: ModsInspection,
  spc: SpcVariables | undefined,
  ftb: SpcVariables | undefined,
): Promise<LoaderResult> {
  const mcClaims: Claim<string>[] = [];
  let result: LoaderResult | undefined;

  // 1a. NeoForge : libraries/net/neoforged/neoforge/<v>/
  const neoDirs = (await ctx.readdir('libraries/net/neoforged/neoforge'))
    .filter((e) => e.kind === 'dir')
    .map((e) => e.name);
  if (neoDirs.length > 0) {
    const fromScript = await argfileVersionFromRunScript(ctx, 'neoforged/neoforge');
    const version =
      fromScript && neoDirs.includes(fromScript)
        ? fromScript
        : ([...neoDirs].sort(compareVersionStrings).at(-1) ?? '');
    const dir = joinPath('libraries/net/neoforged/neoforge', version);
    const files = await ctx.readdir(dir);
    const hasWin = files.some((f) => f.name === 'win_args.txt');
    const hasUnix = files.some((f) => f.name === 'unix_args.txt');
    ctx.note('neoforge_libraries', version);
    if (hasWin || hasUnix) ctx.note('forge_argfiles', dir);
    const mc = mcVersionFromNeoForge(version);
    if (mc) mcClaims.push({ value: mc, confidence: 'high', source: 'libraries' });
    result = {
      loader: {
        value: 'neoforge',
        confidence: 'high',
        source: fromScript ? 'run_script' : 'libraries',
      },
      loaderVersion: { value: version, confidence: 'high', source: 'libraries' },
      mcVersionClaims: mcClaims,
      ...(hasWin || hasUnix
        ? {
            launch: {
              kind: 'argfile',
              argfileDir: dir,
              hasWinArgs: hasWin,
              hasUnixArgs: hasUnix,
            } as const,
          }
        : {}),
    };
  }

  // 1b/1c. Forge : libraries/net/minecraftforge/forge/<mc>-<forge>/ (argfiles ⇒ moderne) ou jar universal racine
  if (!result) {
    const forgeDirs = (await ctx.readdir('libraries/net/minecraftforge/forge'))
      .filter((e) => e.kind === 'dir')
      .map((e) => e.name);
    const rootForgeJar = serverJars.find((j) => FORGE_JAR.test(j));
    if (forgeDirs.length > 0) {
      const fromScript = await argfileVersionFromRunScript(ctx, 'minecraftforge/forge');
      // Dossiers avec argfiles (moderne)
      const modern: { name: string; hasWin: boolean; hasUnix: boolean }[] = [];
      for (const name of forgeDirs) {
        const files = await ctx.readdir(joinPath('libraries/net/minecraftforge/forge', name));
        const hasWin = files.some((f) => f.name === 'win_args.txt');
        const hasUnix = files.some((f) => f.name === 'unix_args.txt');
        if (hasWin || hasUnix) modern.push({ name, hasWin, hasUnix });
      }
      if (modern.length > 0) {
        const pick =
          modern.find((m) => m.name === fromScript) ??
          [...modern].sort((a, b) => compareVersionStrings(a.name, b.name)).at(-1);
        if (pick) {
          const dir = joinPath('libraries/net/minecraftforge/forge', pick.name);
          const [mc, forgeVersion] = splitForgeDir(pick.name);
          ctx.note('forge_libraries', pick.name);
          ctx.note('forge_argfiles', dir);
          if (mc) mcClaims.push({ value: mc, confidence: 'high', source: 'libraries' });
          result = {
            loader: {
              value: 'forge',
              confidence: 'high',
              source: pick.name === fromScript ? 'run_script' : 'libraries',
            },
            ...(forgeVersion
              ? {
                  loaderVersion: {
                    value: forgeVersion,
                    confidence: 'high',
                    source: 'libraries',
                  },
                }
              : {}),
            mcVersionClaims: mcClaims,
            launch: {
              kind: 'argfile',
              argfileDir: dir,
              hasWinArgs: pick.hasWin,
              hasUnixArgs: pick.hasUnix,
            },
          };
        }
      } else if (!rootForgeJar) {
        // libraries sans argfiles ni jar racine : Forge legacy incomplet (ou installation abîmée)
        const latest = [...forgeDirs].sort(compareVersionStrings).at(-1) ?? '';
        const [mc, forgeVersion] = splitForgeDir(latest);
        ctx.note('forge_libraries', latest);
        if (mc) mcClaims.push({ value: mc, confidence: 'medium', source: 'libraries' });
        result = {
          loader: { value: 'forge', confidence: 'medium', source: 'libraries' },
          ...(forgeVersion
            ? {
                loaderVersion: {
                  value: forgeVersion,
                  confidence: 'medium',
                  source: 'libraries',
                },
              }
            : {}),
          mcVersionClaims: mcClaims,
        };
      }
    }
    if (!result && rootForgeJar) {
      const m = FORGE_JAR.exec(rootForgeJar);
      const mc = m?.[1] ?? '';
      const forgeVersion = m?.[2] ?? '';
      // Discriminant installer : Main-Class du manifeste (ou install_profile.json)
      let isInstaller = false;
      let confirmed = false;
      const jar = await ctx.fs.openJar(ctx.path(rootForgeJar));
      if (jar) {
        try {
          const manifest = (await jar.readText('META-INF/MANIFEST.MF', 8192)) ?? '';
          const main = /^Main-Class:\s*(\S+)/m.exec(manifest)?.[1] ?? '';
          isInstaller = /installer/i.test(main) || (main === '' && jar.has('install_profile.json'));
          confirmed = !isInstaller && main !== '';
        } finally {
          await jar.close();
        }
      }
      if (!isInstaller) {
        ctx.note('forge_universal_jar', rootForgeJar);
        if (mc) mcClaims.push({ value: mc, confidence: 'high', source: 'jar_name' });
        result = {
          loader: {
            value: 'forge',
            confidence: confirmed ? 'high' : 'medium',
            source: confirmed ? 'jar_manifest' : 'jar_name',
          },
          loaderVersion: { value: forgeVersion, confidence: 'high', source: 'jar_name' },
          mcVersionClaims: mcClaims,
          launch: { kind: 'jar', jar: rootForgeJar },
        };
      }
    }
  }

  // 1d. Fabric
  if (!result) {
    const launcher =
      serverJars.find((j) => /^fabric-server-launch(er)?\.jar$/i.test(j)) ??
      serverJars.find((j) => FABRIC_MC_LAUNCHER.test(j));
    const fabricDir = ctx.hasDir('.fabric');
    const fabricProps = ctx.hasFile('fabric-server-launcher.properties');
    if (launcher || fabricDir || fabricProps) {
      let loaderVersion: Claim<string> | undefined;
      let confidence: Confidence = launcher ? 'high' : 'medium';
      let source = launcher ? 'jar_name' : fabricDir ? 'libraries' : 'install_properties';
      if (launcher) {
        ctx.note('fabric_launcher', launcher);
        const named = FABRIC_MC_LAUNCHER.exec(launcher);
        if (named) {
          mcClaims.push({ value: named[1] ?? '', confidence: 'high', source: 'jar_name' });
          loaderVersion = { value: named[2] ?? '', confidence: 'high', source: 'jar_name' };
        }
        const jar = await ctx.fs.openJar(ctx.path(launcher));
        if (jar) {
          try {
            const props = parseProperties((await jar.readText('install.properties', 4096)) ?? '');
            const game = props.get('game-version');
            const loader = props.get('fabric-loader-version');
            if (game && parseMcVersion(game))
              mcClaims.push({ value: game, confidence: 'high', source: 'install_properties' });
            if (loader)
              loaderVersion = { value: loader, confidence: 'high', source: 'install_properties' };
            if (game || loader) {
              confidence = 'high';
              source = 'install_properties';
            }
          } finally {
            await jar.close();
          }
        }
      }
      if (fabricDir) ctx.note('fabric_dir');
      result = {
        loader: { value: 'fabric', confidence, source },
        ...(loaderVersion ? { loaderVersion } : {}),
        mcVersionClaims: mcClaims,
        ...(launcher ? { launch: { kind: 'jar', jar: launcher } as const } : {}),
      };
    }
  }

  // 1e. Installer présent sans libraries : loader connu par son nom, installation à faire
  const installer = ctx.files(INSTALLER_JAR)[0];
  if (installer) {
    const m = INSTALLER_JAR.exec(installer);
    const kind = (m?.[1] ?? '').toLowerCase() === 'neoforge' ? 'neoforge' : 'forge';
    const spec = m?.[2] ?? '';
    if (!result) {
      ctx.note('forge_installer_only', installer);
      result = {
        loader: { value: kind, confidence: 'medium', source: 'installer_name' },
        mcVersionClaims: mcClaims,
        needsInstall: true,
      };
    } else if (!ctx.hasDir('libraries') && result.loader.value === kind) {
      ctx.note('forge_installer_only', installer);
      result.needsInstall = true;
    }
    if (result.loader.value === kind) {
      if (kind === 'forge') {
        const [mc, fv] = splitForgeDir(spec);
        if (mc) mcClaims.push({ value: mc, confidence: 'medium', source: 'installer_name' });
        if (fv)
          result.loaderVersion ??= { value: fv, confidence: 'medium', source: 'installer_name' };
      } else {
        const mc = mcVersionFromNeoForge(spec);
        if (mc) mcClaims.push({ value: mc, confidence: 'medium', source: 'installer_name' });
        result.loaderVersion ??= { value: spec, confidence: 'medium', source: 'installer_name' };
      }
    }
  }

  // 1f. Déclarations de packs (variables.txt / yaml FTB) quand rien de physique n'a tranché
  if (!result) {
    const decl = spc?.loader ? spc : ftb?.loader ? ftb : undefined;
    if (decl?.loader) {
      result = {
        loader: {
          value: decl.loader,
          confidence: 'medium',
          source: decl === spc ? 'variables_txt' : 'server_setup_config',
        },
        ...(decl.loaderVersion
          ? {
              loaderVersion: {
                value: decl.loaderVersion,
                confidence: 'medium',
                source: decl === spc ? 'variables_txt' : 'server_setup_config',
              },
            }
          : {}),
        mcVersionClaims: mcClaims,
      };
    }
  }

  // 1g. Inspection de mods/ comme signal primaire
  if (!result) {
    const majority = modsMajority(mods);
    if (majority) {
      ctx.note(
        'mods_vote',
        `${majority.loader} (${String(majority.votes)}/${String(mods.inspected)})`,
      );
      result = {
        loader: { value: majority.loader, confidence: 'medium', source: 'mods' },
        mcVersionClaims: mcClaims,
      };
    } else if (mods.votes.ambiguous > 0) {
      ctx.note('mods_ambiguous', `${String(mods.votes.ambiguous)}/${String(mods.inspected)}`);
    }
  }

  // 1h. Vanilla : jar serveur Mojang, sans mods
  if (!result) {
    const modsEmpty = (mods.count ?? 0) === 0;
    for (const jar of serverJars) {
      if (!/^server\.jar$/i.test(jar) && !MINECRAFT_SERVER_JAR.test(jar)) continue;
      const info = await inspectServerJar(ctx, jar);
      if (info.kind === 'serverstarterjar') {
        ctx.note('serverstarterjar');
        continue;
      }
      if (info.kind === 'other') continue;
      if (!modsEmpty) continue;
      ctx.note('vanilla_jar', jar);
      const named = MINECRAFT_SERVER_JAR.exec(jar)?.[1];
      if (named) mcClaims.push({ value: named, confidence: 'high', source: 'jar_name' });
      if (info.version)
        mcClaims.push({ value: info.version, confidence: 'high', source: 'version_json' });
      result = {
        loader: {
          value: 'vanilla',
          confidence: info.kind === 'vanilla' ? 'high' : 'medium',
          source: info.kind === 'vanilla' ? 'jar_manifest' : 'jar_name',
        },
        mcVersionClaims: mcClaims,
        launch: { kind: 'jar', jar },
      };
      break;
    }
  }

  if (!result)
    return {
      loader: { value: 'unknown', confidence: 'low', source: 'default' },
      mcVersionClaims: mcClaims,
    };

  // Confirmation / contradiction par les mods
  const agree = modsAgree(result.loader.value, mods);
  if (agree === true && result.loader.confidence === 'medium' && result.loader.source !== 'mods') {
    result.loader.confidence = 'high';
    ctx.note('mods_vote', result.loader.value);
  } else if (agree === false) {
    const maj = modsMajority(mods);
    ctx.note(
      'mods_mismatch',
      maj ? `${maj.loader} (${String(maj.votes)}/${String(mods.inspected)})` : 'mixed',
    );
    result.loader.confidence = minConfidence(result.loader.confidence, 'low');
  }
  // Déclaration de pack contradictoire
  const decl = spc?.loader ?? ftb?.loader;
  if (
    decl &&
    decl !== result.loader.value &&
    result.loader.source !== 'variables_txt' &&
    result.loader.source !== 'server_setup_config'
  ) {
    result.loader.confidence = minConfidence(result.loader.confidence, 'medium');
  }
  return result;
}

function splitForgeDir(name: string): [string | undefined, string | undefined] {
  const m = /^(\d+\.\d+(?:\.\d+)?)-([\d.]+)$/.exec(name);
  return m ? [m[1], m[2]] : [undefined, undefined];
}

async function inspectServerJar(
  ctx: Ctx,
  jar: string,
): Promise<{ kind: 'vanilla' | 'unreadable' | 'serverstarterjar' | 'other'; version?: string }> {
  const handle = await ctx.fs.openJar(ctx.path(jar));
  if (!handle) return { kind: 'unreadable' };
  try {
    const manifest = (await handle.readText('META-INF/MANIFEST.MF', 8192)) ?? '';
    const main = /^Main-Class:\s*(\S+)/m.exec(manifest)?.[1] ?? '';
    if (/serverstarterjar/i.test(main)) return { kind: 'serverstarterjar' };
    let version: string | undefined;
    if (handle.has('version.json')) {
      try {
        const json = JSON.parse((await handle.readText('version.json', 64 * 1024)) ?? '{}') as {
          id?: unknown;
        };
        if (typeof json.id === 'string' && parseMcVersion(json.id)) version = json.id;
      } catch {
        // version.json illisible
      }
    }
    if (VANILLA_MAIN_CLASSES.has(main) || version !== undefined) {
      return version === undefined ? { kind: 'vanilla' } : { kind: 'vanilla', version };
    }
    return main === '' ? { kind: 'unreadable' } : { kind: 'other' };
  } finally {
    await handle.close();
  }
}

// --- Version MC -----------------------------------------------------------------------------------

async function detectMcVersion(
  ctx: Ctx,
  loader: LoaderResult,
  serverJars: string[],
  rootJars: string[],
  spc: SpcVariables | undefined,
  ftb: SpcVariables | undefined,
): Promise<Claim<string> | undefined> {
  const claims: Claim<string>[] = [...loader.mcVersionClaims];

  // version.json des jars vanilla présents (server.jar à côté d'un lanceur Fabric, minecraft_server.<v>.jar…)
  if (!claims.some((c) => c.source === 'version_json')) {
    for (const jar of serverJars) {
      if (!/^server\.jar$/i.test(jar) && !MINECRAFT_SERVER_JAR.test(jar)) continue;
      const info = await inspectServerJar(ctx, jar);
      if (info.version)
        claims.push({ value: info.version, confidence: 'high', source: 'version_json' });
    }
  }
  // versions/<v>/server-<v>.jar (Fabric ServerPackCreator, bundler vanilla extrait)
  const versionsDirs = (await ctx.readdir('versions')).filter(
    (e) => e.kind === 'dir' && parseMcVersion(e.name),
  );
  if (versionsDirs.length === 1 && versionsDirs[0]) {
    claims.push({ value: versionsDirs[0].name, confidence: 'medium', source: 'versions_dir' });
  }
  if (spc?.mcVersion)
    claims.push({ value: spc.mcVersion, confidence: 'medium', source: 'variables_txt' });
  if (ftb?.mcVersion)
    claims.push({ value: ftb.mcVersion, confidence: 'medium', source: 'server_setup_config' });
  // Nom de jar minecraft_server.<v>.jar déjà couvert ; nom d'installer en dernier recours physique
  if (claims.length === 0) {
    for (const jar of rootJars) {
      const named = MINECRAFT_SERVER_JAR.exec(jar)?.[1];
      if (named) claims.push({ value: named, confidence: 'medium', source: 'jar_name' });
    }
  }
  // logs/latest.log
  if (claims.length === 0 || claims.every((c) => c.confidence !== 'high')) {
    const fromLog = await mcVersionFromLog(ctx);
    if (fromLog) claims.push(fromLog);
  }
  if (claims.length === 0) return undefined;

  // Priorité : ordre d'insertion = ordre de l'algorithme ; on prend la meilleure confiance, puis l'ordre.
  const best = [...claims].sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence])[0];
  if (!best) return undefined;
  const norm = normalizeMcVersion(best.value);
  const agreeing = claims.filter((c) => normalizeMcVersion(c.value) === norm);
  const disagreeing = claims.filter((c) => normalizeMcVersion(c.value) !== norm);
  if (disagreeing.length > 0) {
    ctx.note('version_conflict', disagreeing.map((c) => `${c.source}=${c.value}`).join(', '));
    // Un conflit entre sources « high » fait douter ; un conflit avec une source faible est juste noté.
    if (disagreeing.some((c) => c.confidence === 'high')) {
      return { value: norm, confidence: 'medium', source: best.source };
    }
  }
  if (agreeing.length >= 2) {
    ctx.note(
      'version_confirmed',
      agreeing
        .slice(1)
        .map((c) => c.source)
        .join(', '),
    );
    return {
      value: norm,
      confidence: best.confidence === 'low' ? 'medium' : best.confidence,
      source: best.source,
    };
  }
  return { value: norm, confidence: best.confidence, source: best.source };
}

async function mcVersionFromLog(ctx: Ctx): Promise<Claim<string> | undefined> {
  const text = await ctx.readText('logs/latest.log', 512 * 1024);
  if (!text) return undefined;
  for (const entry of parseLogText(text)) {
    const ev = matchServerLogEvent(entry.message);
    if (!ev) continue;
    let mc: string | undefined;
    if (
      ev.kind === 'starting' ||
      ev.kind === 'fabric_loading' ||
      ev.kind === 'forge_legacy_loading'
    )
      mc = ev.mcVersion;
    else if (ev.kind === 'modlauncher') mc = ev.mcVersion;
    if (mc && parseMcVersion(mc)) {
      ctx.note('log_version', mc);
      return { value: mc, confidence: 'medium', source: 'latest_log' };
    }
  }
  return undefined;
}

// --- RAM ------------------------------------------------------------------------------------------

function toMb(amount: string, unit: string | undefined): number {
  const n = Number(amount);
  switch ((unit ?? 'm').toLowerCase()) {
    case 'g':
      return n * 1024;
    case 'k':
      return Math.round(n / 1024);
    default:
      return n;
  }
}

function extractXmx(
  text: string,
  skipComments: boolean,
): { max?: number; min?: number } | undefined {
  let max: number | undefined;
  let min: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (skipComments && /^(#|REM\b|::|"#|echo\b|Write-Host\b|'#)/i.test(line)) continue;
    const mx = XMX.exec(line);
    if (mx && max === undefined) max = toMb(mx[1] ?? '0', mx[2]);
    const ms = XMS.exec(line);
    if (ms && min === undefined) min = toMb(ms[1] ?? '0', ms[2]);
  }
  if (max === undefined && min === undefined) return undefined;
  return { ...(max === undefined ? {} : { max }), ...(min === undefined ? {} : { min }) };
}

async function detectRam(
  ctx: Ctx,
  spc: SpcVariables | undefined,
): Promise<{ max: DetectedField<number>; min?: DetectedField<number> }> {
  const mk = (
    r: { max?: number; min?: number },
    confidence: Confidence,
    source: string,
    detail: string,
  ) => {
    ctx.note('ram_from', detail);
    return {
      max: field(
        r.max ?? ctx.options.defaultMaxRamMb,
        r.max === undefined ? 'low' : confidence,
        r.max === undefined ? 'default' : source,
      ),
      ...(r.min === undefined ? {} : { min: field(r.min, confidence, source) }),
    };
  };
  // user_jvm_args.txt (Forge/NeoForge modernes)
  const ujva = await ctx.readText('user_jvm_args.txt', 64 * 1024);
  if (ujva) {
    const r = extractXmx(ujva, true);
    if (r?.max !== undefined) return mk(r, 'high', 'user_jvm_args', 'user_jvm_args.txt');
  }
  // variables.txt (ServerPackCreator)
  if (spc?.javaArgs) {
    const r = extractXmx(spc.javaArgs, false);
    if (r?.max !== undefined) return mk(r, 'high', 'variables_txt', 'variables.txt');
  }
  // settings.bat / settings.sh / settings.cfg (MAX_RAM=4096M)
  for (const name of ['settings.cfg', ...scriptOrder(ctx, ['settings.bat', 'settings.sh'])]) {
    const text = await ctx.readText(name, 64 * 1024);
    if (!text) continue;
    const max = /^\s*(?:set\s+)?MAX_RAM\s*=\s*"?(\d+)([GgMmKk])?"?/m.exec(text);
    const min = /^\s*(?:set\s+)?MIN_RAM\s*=\s*"?(\d+)([GgMmKk])?"?/m.exec(text);
    if (max) {
      const r = {
        max: toMb(max[1] ?? '0', max[2]),
        ...(min ? { min: toMb(min[1] ?? '0', min[2]) } : {}),
      };
      return mk(r, 'high', 'settings_script', name);
    }
    const r = extractXmx(text, true);
    if (r?.max !== undefined) return mk(r, 'medium', 'settings_script', name);
  }
  // Scripts de lancement : *.bat / *.sh / *.ps1 (OS de l'agent d'abord)
  const scripts = scriptOrder(
    ctx,
    ctx.files(/\.(bat|cmd|sh|ps1)$/i).filter((n) => !/^settings\./i.test(n)),
  );
  const found: { name: string; r: { max?: number; min?: number } }[] = [];
  for (const name of scripts) {
    const text = await ctx.readText(name, 128 * 1024);
    if (!text) continue;
    const r = extractXmx(text, true);
    if (r?.max !== undefined) found.push({ name, r });
  }
  const first = found[0];
  if (first) {
    const distinct = new Set(found.map((f) => f.r.max));
    if (distinct.size > 1)
      ctx.note('ram_ambiguous', found.map((f) => `${f.name}=${String(f.r.max)}`).join(', '));
    return mk(first.r, distinct.size > 1 ? 'low' : 'medium', 'script', first.name);
  }
  ctx.note('ram_default');
  return { max: field(ctx.options.defaultMaxRamMb, 'low', 'default') };
}

/** Scripts triés : ceux de l'OS de l'agent d'abord, puis par nom (déterministe). */
function scriptOrder(ctx: Ctx, names: string[]): string[] {
  const preferred = ctx.options.os === 'windows' ? /\.(bat|cmd|ps1)$/i : /\.sh$/i;
  const rank = (n: string): number => {
    if (!preferred.test(n)) return 2;
    return /^(start|run|launch|serverstart)/i.test(n) ? 0 : 1;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// --- Utilitaires ----------------------------------------------------------------------------------

/** Java `.properties` plat (server.properties, install.properties) : clé=valeur, `#`/`!` commentaires. */
export function parseProperties(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const i = line.search(/[=:]/);
    if (i === -1) {
      map.set(line, '');
      continue;
    }
    map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return map;
}

function toPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

function unquote(value: string): string {
  const v = value.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v;
}
