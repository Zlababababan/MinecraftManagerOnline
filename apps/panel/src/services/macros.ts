/**
 * Macros de console : une séquence de commandes enregistrée, rejouée d'un clic.
 *
 * Contrairement à la découverte des commandes (`command-catalog.ts`), une macro exécute de VRAIES
 * commandes au nom de l'utilisateur : chacune est donc journalisée dans `command_history` et dans
 * l'audit, exactement comme si elle avait été tapée. C'est la différence entre lire et agir.
 *
 * Exécution **séquentielle et arrêtée au premier échec** : une séquence comme
 * `save-off / save-all flush / save-on` n'a de sens que dans l'ordre, et continuer après un échec
 * laisserait le serveur dans l'état intermédiaire (sauvegarde désactivée) sans que personne ne le
 * sache.
 */
import { asc, eq, isNull, or } from 'drizzle-orm';

import { isProtocolError, ulid } from '@mmo/protocol';
import { MACRO_MAX_COMMANDS } from '@mmo/protocol/client';

import type { MmoDatabase } from '../db/client.js';
import { consoleMacros, servers, type ConsoleMacroRow } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';

export interface MacroDto {
  id: string;
  name: string;
  commands: string[];
  serverId: string | null;
  createdBy: string | null;
  updatedAt: number;
  destructive: boolean;
}

export interface MacroInput {
  name: string;
  commands: string;
  /** Absent ou nul = macro globale, disponible sur tous les serveurs. */
  serverId?: string | null | undefined;
}

/** Une macro rattachée doit l'être à un serveur qui existe : sinon la clé étrangère de
 * `console_macros` sort en `SqliteError` brute, masquée en « erreur interne ». */
function requireServer(db: MmoDatabase, serverId: string): void {
  const row = db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).get();
  if (!row) throw notFound('server', serverId);
}

export interface MacroRunResult {
  results: {
    command: string;
    ok: boolean;
    via?: 'stdin' | 'rcon';
    error?: string;
    message?: string;
  }[];
  /** Longueur réelle de la séquence exécutée (la liste du client peut être en retard). */
  total: number;
}

export interface MacrosDeps {
  db: MmoDatabase;
  now: () => number;
  logger: { error: (obj: object, msg: string) => void };
}

/**
 * Envoi d'une commande, fourni par la route : c'est elle qui détient l'utilisateur et les
 * métadonnées d'audit, et une commande de macro doit être journalisée comme une commande tapée.
 */
export type SendCommand = (serverId: string, command: string) => Promise<{ via: 'stdin' | 'rcon' }>;

/**
 * Verbes qui arrêtent, bannissent ou détruisent. La liste ne prétend pas être exhaustive — les
 * mods en ajoutent — mais elle couvre ce qui casse une soirée : l'interface demande confirmation.
 */
const DESTRUCTIVE = [
  'stop',
  'kill',
  'ban',
  'ban-ip',
  'kick',
  'deop',
  'save-off',
  'whitelist off',
  'difficulty',
  'gamerule',
  'setworldspawn',
  'fill',
  'clone',
  'datapack disable',
  'reload',
];

/** Lignes utiles d'une macro : vides ignorées, `/` initial retiré comme dans la console. */
export function splitCommands(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/^\//, ''))
    .filter((l) => l !== '');
}

/** La séquence contient-elle une commande à confirmer ? */
export function isDestructive(commands: readonly string[]): boolean {
  return commands.some((c) => {
    const lower = c.toLowerCase();
    return DESTRUCTIVE.some((verb) => lower === verb || lower.startsWith(`${verb} `));
  });
}

function toDto(row: ConsoleMacroRow): MacroDto {
  const commands = splitCommands(row.commands);
  return {
    id: row.id,
    name: row.name,
    commands,
    serverId: row.serverId,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    destructive: isDestructive(commands),
  };
}

export class MacrosService {
  constructor(private readonly deps: MacrosDeps) {}

  /** Macros visibles depuis un serveur : les globales, plus les siennes. */
  list(serverId?: string): MacroDto[] {
    const rows = this.deps.db
      .select()
      .from(consoleMacros)
      .where(
        serverId === undefined
          ? undefined
          : or(isNull(consoleMacros.serverId), eq(consoleMacros.serverId, serverId)),
      )
      .orderBy(asc(consoleMacros.name))
      .all();
    return rows.map(toDto);
  }

  get(id: string): MacroDto {
    const row = this.deps.db.select().from(consoleMacros).where(eq(consoleMacros.id, id)).get();
    if (!row) throw notFound('macro', id);
    return toDto(row);
  }

  create(input: MacroInput, userId: string): MacroDto {
    const commands = this.validate(input);
    const now = this.deps.now();
    const id = ulid(now);
    this.deps.db
      .insert(consoleMacros)
      .values({
        id,
        name: input.name.trim(),
        commands: commands.join('\n'),
        serverId: input.serverId ?? null,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(id);
  }

  update(id: string, input: MacroInput): MacroDto {
    this.get(id);
    const commands = this.validate(input);
    this.deps.db
      .update(consoleMacros)
      .set({
        name: input.name.trim(),
        commands: commands.join('\n'),
        serverId: input.serverId ?? null,
        updatedAt: this.deps.now(),
      })
      .where(eq(consoleMacros.id, id))
      .run();
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    this.deps.db.delete(consoleMacros).where(eq(consoleMacros.id, id)).run();
  }

  private validate(input: MacroInput): string[] {
    if (input.serverId !== null && input.serverId !== undefined) {
      requireServer(this.deps.db, input.serverId);
    }
    // Le nom est trimé à l'écriture : fait uniquement d'espaces, il deviendrait un bouton sans
    // libellé dans la barre.
    if (input.name.trim() === '') {
      throw new AppError('E_VALIDATION', 'a macro needs a name', { details: { field: 'name' } });
    }
    const commands = splitCommands(input.commands);
    if (commands.length === 0) {
      throw new AppError('E_VALIDATION', 'a macro needs at least one command', {
        details: { field: 'commands' },
      });
    }
    if (commands.length > MACRO_MAX_COMMANDS) {
      throw new AppError('E_VALIDATION', 'too many commands in this macro', {
        details: { field: 'commands', max: MACRO_MAX_COMMANDS, got: commands.length },
      });
    }
    return commands;
  }

  /**
   * Exécute la macro sur un serveur, dans l'ordre, en s'arrêtant au premier échec.
   *
   * Reçoit le DTO — pas un id : c'est la séquence que la route vient de vérifier (et que
   * l'utilisateur a approuvée) qui s'exécute, pas une relecture qui pourrait avoir changé
   * entre le garde-fou et l'exécution.
   *
   * Ne lève pas sur l'échec d'une commande : l'appelant a besoin de savoir **lesquelles** sont
   * passées. Une erreur globale ne dirait pas si le serveur a été arrêté avant de casser.
   */
  async run(macro: MacroDto, serverId: string, send: SendCommand): Promise<MacroRunResult> {
    if (macro.serverId !== null && macro.serverId !== serverId) {
      throw new AppError('E_VALIDATION', 'this macro belongs to another server', {
        details: { macroId: macro.id, serverId },
      });
    }
    const results: MacroRunResult['results'] = [];
    for (const command of macro.commands) {
      try {
        const res = await send(serverId, command);
        results.push({ command, ok: true, via: res.via });
      } catch (error) {
        // `AppError.from` conserve le code d'une erreur du panel comme d'une erreur d'agent.
        // Le ternaire précédent ne reconnaissait que les `ProtocolError` : une machine hors
        // ligne (`E_AGENT_OFFLINE`, une `AppError`) ressortait en « erreur interne », ce qui est
        // à la fois faux et inexploitable pour qui lit le résultat.
        const app = AppError.from(error);
        // Même politique que le gestionnaire HTTP (`http/errors.ts`) : une exception INATTENDUE
        // du panel (SQLite, TypeError…) ne sort pas en clair — cette réponse part en 200 et ne
        // passe jamais par lui. Le message brut va au journal ; une E_INTERNAL écrite par
        // l'agent (ProtocolError) reste du vocabulaire produit et traverse.
        const unexpected = app.code === 'E_INTERNAL' && !isProtocolError(error);
        if (unexpected) {
          this.deps.logger.error(
            { macroId: macro.id, serverId, command, err: error },
            'macro command failed unexpectedly',
          );
        }
        results.push({
          command,
          ok: false,
          error: app.code,
          ...(unexpected
            ? { message: 'internal error' }
            : app.message === ''
              ? {}
              : { message: app.message }),
        });
        // Les commandes suivantes ne sont même pas tentées : la séquence a un sens, pas les
        // commandes prises isolément.
        break;
      }
    }
    return { results, total: macro.commands.length };
  }
}
