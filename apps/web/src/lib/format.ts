/** Formatage (tailles, durées, dates) — toutes les dates sont des epoch ms (décision verrouillée). */
import type { Role } from '@mmo/protocol/client';

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10_240 ? 0 : 1)} GB`;
  return `${String(mb)} MB`;
}

export function formatGb(gb: number | null | undefined): string {
  if (gb === null || gb === undefined) return '—';
  if (gb >= 1000) return `${(gb / 1000).toFixed(2)} TB`;
  return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value).toString()} %`;
}

/** Durée lisible (`3 s`, `12 min`, `2 h`, `5 d`) — unité courte, indépendante de la langue. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${String(h)} h`;
  return `${String(Math.round(h / 24))} d`;
}

export function formatDateTime(ts: number | null | undefined, locale: string): string {
  if (ts === null || ts === undefined) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(ts),
  );
}

export function formatTime(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(new Date(ts));
}

/** Texte « il y a … » : retourne `undefined` si jamais vu (l'appelant traduit). */
export function ago(ts: number | null | undefined, now: number): string | undefined {
  if (ts === null || ts === undefined) return undefined;
  return formatDuration(now - ts);
}
