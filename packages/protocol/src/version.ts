/**
 * Versionnement du protocole (doc 05 §11).
 * - `v` entier ; bump uniquement sur rupture réelle (ajouts de champs optionnels/types = sans bump).
 * - Le panel supporte N et N-1 ; l'agent annonce `[protoMin, protoMax]` dans `auth.hello`.
 */

/** Version courante du protocole. */
export const PROTOCOL_VERSION = 1;

/** Versions qu'un panel sait parler : N et N-1 (jamais en dessous de 1). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [
  PROTOCOL_VERSION - 1,
  PROTOCOL_VERSION,
].filter((v) => v >= 1);

export interface VersionRange {
  protoMin: number;
  protoMax: number;
}

/** Plage supportée par le panel courant. */
export const PANEL_VERSION_RANGE: VersionRange = {
  protoMin: SUPPORTED_PROTOCOL_VERSIONS[0] ?? PROTOCOL_VERSION,
  protoMax: PROTOCOL_VERSION,
};

export type NegotiationResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'agent_too_old' | 'agent_too_new' | 'invalid_range' };

/**
 * Négociation : `min(panelMax, agentMax)` si les plages se recouvrent, sinon échec typé.
 * `agent_too_old` ⇒ le panel répond `E_UNSUPPORTED_VERSION` + ordre de mise à jour (doc 05 §4).
 */
export function negotiateProtocolVersion(
  agent: VersionRange,
  panel: VersionRange = PANEL_VERSION_RANGE,
): NegotiationResult {
  if (
    !Number.isInteger(agent.protoMin) ||
    !Number.isInteger(agent.protoMax) ||
    agent.protoMin < 1 ||
    agent.protoMax < agent.protoMin
  ) {
    return { ok: false, reason: 'invalid_range' };
  }
  const version = Math.min(panel.protoMax, agent.protoMax);
  if (version < panel.protoMin) return { ok: false, reason: 'agent_too_old' };
  if (version < agent.protoMin) return { ok: false, reason: 'agent_too_new' };
  return { ok: true, version };
}
