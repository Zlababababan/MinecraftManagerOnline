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

/**
 * Temps de jeu cumulé (`45 min`, `3 h 30`, `12 j 4 h`). `formatDuration` arrondit — « 1 h 30 »
 * y devient « 2 h », ce qui est acceptable pour un délai et faux pour un total de temps passé.
 */
export function formatPlaytime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0
      ? `${String(hours)} h`
      : `${String(hours)} h ${String(rest).padStart(2, '0')}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${String(days)} j` : `${String(days)} j ${String(rest)} h`;
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

/** Taille en octets lisible (`12 B`, `3.4 KB`, `1.2 MB`). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
