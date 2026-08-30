/**
 * Lecture de l'arbre de commandes d'un serveur, par `help` en RCON.
 *
 * L'aperçu des commandes de la console ne peut pas venir d'une table écrite à la main : le parc va
 * de la 1.12 à la 1.21, en Forge/NeoForge/Fabric, avec des centaines de commandes ajoutées par les
 * mods. Le serveur, lui, sait exactement ce qu'il accepte — `help` imprime son arbre Brigadier.
 *
 * Trois précautions, apprises ailleurs dans ce dépôt :
 *   - **rien ne doit apparaître dans la console de l'utilisateur** : on passe par `rconExec`, qui
 *     n'a PAS le repli stdin de `execWithResponse` (lequel ferait écrire `help` dans le processus
 *     en mode attaché) et n'écrit ni dans `command_history` ni dans l'audit ;
 *   - **la socket RCON est partagée** avec la sonde TPS et le watchdog, et un `E_TIMEOUT` la
 *     ferme : d'où un délai explicite plus large que le défaut de 5 s, un seul balayage à la fois,
 *     et rien pendant la première minute d'un démarrage (le serveur charge encore ses mods) ;
 *   - **transport ≠ commande inconnue** : c'est le bug de la sonde TPS (6c83e66). Un serveur qui
 *     ne répond pas se réessaie ; un serveur qui répond sans connaître `help` se verrouille long,
 *     sinon on spamme sa console pour rien.
 */
import { isProtocolError } from '@mmo/protocol';
import { HELP_LIMITS } from '@mmo/shared';

export interface CommandHelpProbeOptions {
  exec: (command: string, timeoutMs: number) => Promise<string>;
  /** État courant du serveur : rien n'est tenté hors `running`. */
  state: () => string;
  /** Depuis quand le serveur est démarré (epoch ms), `undefined` s'il ne l'est pas. */
  startedAt: () => number | undefined;
  timeoutMs?: number;
  /** Silence après un serveur qui répond mais ignore `help` (défaut 10 min). */
  retryAfterMs?: number;
  /** Délai laissé au serveur après son démarrage avant de le déranger (défaut 60 s). */
  warmupMs?: number;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface CommandHelpResult {
  available: boolean;
  lines: string[];
  truncated: boolean;
}

const UNAVAILABLE: CommandHelpResult = { available: false, lines: [], truncated: false };

/** Un serveur qui ne connaît pas `help` le dit de mille façons ; ces marqueurs suffisent. */
const UNKNOWN_MARKERS = [
  'unknown command',
  'unknown or incomplete command',
  'commande inconnue',
  'incorrect argument',
  'you do not have permission',
];

/** `--- Showing help page 1 of 7 ---` : la 1.12 pagine, il faut demander les suivantes. */
const PAGE_RE = /help page\s+\d+\s+of\s+(\d+)/iu;

export class CommandHelpProbe {
  private readonly now: () => number;
  private lockedUntil = 0;
  /** Un balayage à la fois : deux navigateurs ouverts sur la même console, c'est le cas courant. */
  private inFlight: Promise<CommandHelpResult> | undefined;

  constructor(private readonly options: CommandHelpProbeOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Oublie le verrou : appelé quand le serveur redémarre, son arbre a pu changer. */
  reset(): void {
    this.lockedUntil = 0;
    this.inFlight = undefined;
  }

  /**
   * `help`, ou `help <name>` pour déplier une commande. Ne lève jamais : l'indisponibilité est
   * une réponse normale, pas une erreur — un serveur arrêté ou un agent sans RCON est le cas
   * ordinaire, et l'interface se rabat sur son catalogue statique sans rien dire.
   */
  async fetch(name?: string): Promise<CommandHelpResult> {
    if (!this.ready()) return UNAVAILABLE;
    if (this.inFlight) return this.inFlight;
    const run = this.run(name).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private ready(): boolean {
    if (this.options.state() !== 'running') return false;
    if (this.now() < this.lockedUntil) return false;
    const startedAt = this.options.startedAt();
    const warmup = this.options.warmupMs ?? 60_000;
    // Un serveur qui charge encore ses mods répondra mal, et occuperait la socket partagée.
    return startedAt === undefined || this.now() - startedAt >= warmup;
  }

  private async run(name?: string): Promise<CommandHelpResult> {
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const command = name === undefined ? 'help' : `help ${name}`;
    let first: string;
    try {
      first = await this.options.exec(command, timeoutMs);
    } catch (error) {
      // Transport : la commande n'y est pour rien, on réessaiera au prochain besoin.
      this.options.log?.('command help unavailable', {
        command,
        reason: isProtocolError(error) ? error.code : 'unknown',
      });
      return UNAVAILABLE;
    }
    if (this.looksUnknown(first)) {
      this.lockedUntil = this.now() + (this.options.retryAfterMs ?? 600_000);
      this.options.log?.('server does not know help, backing off', { command });
      return UNAVAILABLE;
    }
    const lines = split(first);
    // Un serveur 1.12 pagine : on demande la suite, en bornant durement le nombre de pages.
    const pages = pageCount(first);
    if (pages !== undefined && name === undefined) {
      for (let page = 2; page <= Math.min(pages, HELP_LIMITS.maxPages); page += 1) {
        if (lines.length >= HELP_LIMITS.maxLines) break;
        try {
          lines.push(...split(await this.options.exec(`help ${String(page)}`, timeoutMs)));
        } catch {
          // Page manquante : ce qui a déjà été lu reste utile.
          break;
        }
      }
    }
    const truncated = lines.length > HELP_LIMITS.maxLines;
    return { available: true, lines: lines.slice(0, HELP_LIMITS.maxLines), truncated };
  }

  private looksUnknown(response: string): boolean {
    const lower = response.toLowerCase();
    return UNKNOWN_MARKERS.some((m) => lower.includes(m));
  }
}

function split(response: string): string[] {
  return response
    .split(/\r?\n/u)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');
}

function pageCount(response: string): number | undefined {
  const m = PAGE_RE.exec(response);
  if (!m) return undefined;
  const total = Number(m[1]);
  return Number.isFinite(total) && total > 1 ? total : undefined;
}
