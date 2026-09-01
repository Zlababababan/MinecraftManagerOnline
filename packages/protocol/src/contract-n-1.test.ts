/**
 * Contrat N/N-1 (doc 05 §11) : « le panel supporte N et N-1 » est invoqué par toute la feuille de
 * route — les lots qui restent ajoutent des messages, des champs et des valeurs d'enum — mais rien
 * d'exécutable ne le garantissait. Les fixtures de `v1` ne le font pas : elles sont maintenues AVEC
 * les schémas, donc elles suivent chaque changement au lieu de s'y opposer.
 *
 * Ici, deux références **figées** à la dernière release :
 *  - `messages.json` : ce qu'un pair de la version précédente envoie encore aujourd'hui ;
 *  - `vocabularies.json` : les valeurs d'enum qu'il connaît, et qu'il continuera d'émettre.
 *
 * Les deux échecs que cela attrape, et qu'aucun autre test ne voit :
 *  1. un champ ajouté **obligatoire** — l'agent N-1 ne l'envoie pas, le panel le rejette ;
 *  2. une valeur d'enum **retirée ou renommée** — l'agent N-1 l'envoie encore, le parse échoue.
 *
 * En cas d'échec, c'est le schéma courant qu'il faut corriger, jamais la fixture (voir son
 * `$comment`). On ne refige une référence que délibérément, au moment d'une release.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  EVENTS,
  EVENT_TYPES,
  KNOWN_CAPABILITIES,
  REQUESTS,
  REQUEST_TYPES,
  archSchema,
  attachModeSchema,
  compressionSchema,
  confidenceSchema,
  cpuSourceSchema,
  desiredStateSchema,
  exitReasonSchema,
  isEventType,
  isRequestType,
  loaderSchema,
  logLevelSchema,
  osSchema,
  provisioningSchema,
  runStateSchema,
  tpsSourceSchema,
} from './index.js';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  localeSchema,
  machineStatusSchema,
  roleSchema,
} from './client/index.js';

interface FrozenMessages {
  $frozenAt: string;
  requests: { type: string; request: unknown; response: unknown }[];
  events: { type: string; payload: unknown }[];
}

const fixturesDir = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'n-1');
const frozen = JSON.parse(
  readFileSync(path.join(fixturesDir, 'messages.json'), 'utf8'),
) as FrozenMessages;
const vocabularies = JSON.parse(
  readFileSync(path.join(fixturesDir, 'vocabularies.json'), 'utf8'),
) as Record<string, string[] | string>;

/** Les vocabulaires courants, sous les mêmes noms que dans la référence figée. */
const CURRENT: Record<string, readonly string[]> = {
  loader: loaderSchema.options,
  runState: runStateSchema.options,
  desiredState: desiredStateSchema.options,
  attachMode: attachModeSchema.options,
  provisioning: provisioningSchema.options,
  exitReason: exitReasonSchema.options,
  logLevel: logLevelSchema.options,
  os: osSchema.options,
  arch: archSchema.options,
  compression: compressionSchema.options,
  cpuSource: cpuSourceSchema.options,
  tpsSource: tpsSourceSchema.options,
  confidence: confidenceSchema.options,
  errorCode: ERROR_CODES,
  capability: KNOWN_CAPABILITIES,
  requestType: REQUEST_TYPES,
  eventType: EVENT_TYPES,
  role: roleSchema.options,
  locale: localeSchema.options,
  machineStatus: machineStatusSchema.options,
  notificationType: NOTIFICATION_TYPES,
  notificationChannel: NOTIFICATION_CHANNELS,
};

describe('contrat N/N-1 : ce qu’un pair de la version précédente envoie encore', () => {
  it('les charges figées sont toujours acceptées par les schémas courants', () => {
    const refus: string[] = [];
    for (const f of frozen.requests) {
      // Un type disparu est un cas distinct, traité par le test des vocabulaires.
      if (!isRequestType(f.type)) continue;
      const def = REQUESTS[f.type];
      const req = def.request.safeParse(f.request);
      if (!req.success) refus.push(`${f.type} (requête) : ${JSON.stringify(req.error.issues)}`);
      const res = def.response.safeParse(f.response);
      if (!res.success) refus.push(`${f.type} (réponse) : ${JSON.stringify(res.error.issues)}`);
    }
    for (const f of frozen.events) {
      if (!isEventType(f.type)) continue;
      const parsed = EVENTS[f.type].payload.safeParse(f.payload);
      if (!parsed.success)
        refus.push(`${f.type} (événement) : ${JSON.stringify(parsed.error.issues)}`);
    }
    // Message explicite : un champ ajouté sans `.optional()` est la cause la plus probable.
    expect(refus, `un champ obligatoire a-t-il été ajouté depuis la ${frozen.$frozenAt} ?`).toEqual(
      [],
    );
  });

  it('aucun vocabulaire n’a perdu de valeur (un pair N-1 les envoie encore)', () => {
    const perdues: string[] = [];
    for (const [nom, gelees] of Object.entries(vocabularies)) {
      if (nom.startsWith('$') || !Array.isArray(gelees)) continue;
      const courantes = CURRENT[nom];
      expect(courantes, `vocabulaire « ${nom} » figé mais absent du relevé courant`).toBeDefined();
      for (const valeur of gelees) {
        if (courantes !== undefined && !courantes.includes(valeur))
          perdues.push(`${nom}.${valeur}`);
      }
    }
    expect(perdues, 'retirer une valeur casse le parse chez un pair N-1').toEqual([]);
  });

  it('la référence figée couvre bien le protocole (sinon elle ne prouve rien)', () => {
    // Garde-fou sur la garde : une référence vide ou amputée passerait les deux tests ci-dessus.
    expect(frozen.requests.length).toBeGreaterThanOrEqual(50);
    expect(frozen.events.length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(CURRENT).every((nom) => Array.isArray(vocabularies[nom]))).toBe(true);
  });
});
