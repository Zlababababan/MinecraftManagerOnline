/**
 * Demandes de whitelist en libre-service (lot 8, doc 02 §9 et doc 04 §1). Un ami muni du lien de
 * la page de statut saisit son pseudo ; la demande arrive à l'opérateur, qui accepte ou refuse.
 *
 * La décision qui structure ce fichier : **une demande est inerte**. La soumettre n'appelle ni
 * l'agent, ni Mojang, n'écrit aucun fichier et ne touche à rien sur le serveur. Le panel range
 * une ligne, publie un événement, et s'arrête là. Tout le reste — résolution du pseudo, ajout à
 * la liste blanche — se produit du côté authentifié, quand un opérateur le déclenche. Une entrée
 * anonyme ne doit jamais mettre en mouvement le parc de quelqu'un.
 *
 * Conséquences visibles :
 * - une ligne par (serveur, pseudo) et non par tentative : redemander ne fait que relire l'état
 *   de sa propre demande, aucun compteur ne gonfle, aucun envoi ne se duplique ;
 * - rien du visiteur n'est conservé (ni adresse, ni horodatage de visite) — le limiteur public
 *   suffit à borner l'abus, et il vit en mémoire ;
 * - supprimer une demande tranchée rouvre la possibilité d'en refaire une : c'est le geste par
 *   lequel un opérateur dit « on en reparle », sans avoir à ouvrir une base.
 */
import { and, desc, eq } from 'drizzle-orm';

import { ulid } from '@mmo/protocol';
import type {
  WhitelistRequestDto,
  WhitelistRequestInput,
  WhitelistRequestStatus,
} from '@mmo/protocol/client';

import type { MmoDatabase } from '../db/client.js';
import type { SqliteHandle } from '../db/sqlite.js';
import { whitelistRequests, type WhitelistRequestRow } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { EventBus } from './events.js';
import type { UsersService } from './users.js';

export interface WhitelistRequestsDeps {
  db: MmoDatabase;
  sqlite: SqliteHandle;
  now: () => number;
  events: EventBus;
  users: UsersService;
}

export class WhitelistRequestsService {
  constructor(private readonly deps: WhitelistRequestsDeps) {}

  /** Les demandes d'un serveur, en attente d'abord puis les plus récentes. */
  list(serverId: string): WhitelistRequestDto[] {
    const rows = this.deps.db
      .select()
      .from(whitelistRequests)
      .where(eq(whitelistRequests.serverId, serverId))
      .orderBy(desc(whitelistRequests.createdAt))
      .all();
    const rank = (row: WhitelistRequestRow) => (row.status === 'pending' ? 0 : 1);
    return rows.sort((a, b) => rank(a) - rank(b)).map((row) => this.toDto(row));
  }

  get(serverId: string, id: string): WhitelistRequestRow | undefined {
    const row = this.deps.db
      .select()
      .from(whitelistRequests)
      .where(eq(whitelistRequests.id, id))
      .get();
    // Une demande vue depuis un AUTRE serveur n'existe pas : les identifiants ne traversent pas
    // les portées (lot 8, droits par serveur).
    return row?.serverId === serverId ? row : undefined;
  }

  require(serverId: string, id: string): WhitelistRequestRow {
    const row = this.get(serverId, id);
    if (row === undefined) throw notFound('whitelist request', id);
    return row;
  }

  /**
   * Enregistre (ou relit) la demande d'un visiteur. Rend l'état de SA demande pour ce pseudo :
   * `pending` qu'elle vienne d'être créée ou qu'elle attendait déjà — le visiteur n'a pas à
   * savoir laquelle, et le panel ne publie donc qu'un seul événement par pseudo.
   */
  submit(
    server: { id: string; machineId: string },
    input: WhitelistRequestInput,
  ): WhitelistRequestStatus {
    const nameKey = input.name.toLowerCase();
    const existing = this.deps.db
      .select()
      .from(whitelistRequests)
      .where(and(eq(whitelistRequests.serverId, server.id), eq(whitelistRequests.nameKey, nameKey)))
      .get();
    if (existing !== undefined) return existing.status;

    const note = input.note?.trim();
    this.deps.db
      .insert(whitelistRequests)
      .values({
        id: ulid(),
        serverId: server.id,
        name: input.name,
        nameKey,
        note: note === undefined || note === '' ? null : note,
        status: 'pending',
        createdAt: this.deps.now(),
        decidedAt: null,
        decidedBy: null,
      })
      .run();
    // Le mot du visiteur ne part PAS dans l'événement : il finirait sur un téléphone et dans un
    // salon Discord (webhooks) sans que personne l'ait relu. Le pseudo, lui, est contraint par
    // `MINECRAFT_NAME_RE` — c'est ce qui rend sûr de le citer.
    this.deps.events.publish({
      type: 'whitelist.requested',
      severity: 'info',
      serverId: server.id,
      machineId: server.machineId,
      payload: { name: input.name },
    });
    return 'pending';
  }

  /** Tranche une demande. L'ajout à la liste blanche, lui, a déjà eu lieu (route). */
  decide(
    serverId: string,
    id: string,
    status: Exclude<WhitelistRequestStatus, 'pending'>,
    userId: string,
  ): WhitelistRequestDto {
    const row = this.require(serverId, id);
    const next: WhitelistRequestRow = {
      ...row,
      status,
      decidedAt: this.deps.now(),
      decidedBy: userId,
    };
    this.deps.db
      .update(whitelistRequests)
      .set({ status, decidedAt: next.decidedAt, decidedBy: userId })
      .where(eq(whitelistRequests.id, id))
      .run();
    return this.toDto(next);
  }

  remove(serverId: string, id: string): WhitelistRequestRow {
    const row = this.require(serverId, id);
    this.deps.db.delete(whitelistRequests).where(eq(whitelistRequests.id, id)).run();
    return row;
  }

  /**
   * Plafond par serveur sur les demandes TRANCHÉES (maintenance) : une demande en attente n'est
   * jamais purgée — elle attend un humain, et la faire disparaître serait la perdre.
   */
  purgeDecided(keepPerServer: number): number {
    return this.deps.sqlite
      .prepare(
        `DELETE FROM whitelist_requests WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY decided_at DESC) AS rn
             FROM whitelist_requests WHERE status <> 'pending'
           ) WHERE rn > ?
         )`,
      )
      .run(keepPerServer).changes;
  }

  private toDto(row: WhitelistRequestRow): WhitelistRequestDto {
    return {
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      note: row.note,
      status: row.status,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      decidedBy:
        row.decidedBy === null ? null : (this.deps.users.get(row.decidedBy)?.username ?? null),
    };
  }
}
