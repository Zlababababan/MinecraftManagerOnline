/**
 * Graphique de séries temporelles en SVG pur (léger, sans dépendance, thème Mantine) : lignes
 * interrompues sur les trous (`null`), bande min/max optionnelle, ligne de référence, survol avec
 * valeurs. Largeur fluide (ResizeObserver via `useElementSize`), hauteur fixe.
 */
import { Box, Group, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useMemo, useState, type ReactNode } from 'react';

import { useT } from '../../i18n/hooks.js';
import { formatDateTime, formatTime } from '../../lib/format.js';

export interface ChartSeries {
  key: string;
  label: string;
  /** Couleur CSS (variable Mantine conseillée). */
  color: string;
  values: (number | null)[];
  /** Enveloppe (max, ou min) dessinée en bande translucide entre `values` et `band`. */
  band?: (number | null)[];
  /** Trait pointillé (valeurs dérivées). */
  dashed?: boolean;
}

export interface TimeSeriesChartProps {
  timestamps: number[];
  series: ChartSeries[];
  /** Bornes de l'axe Y ; `yMax` absent = max des données (+ marge), `yMin` défaut 0. */
  yMin?: number;
  yMax?: number;
  /** Formatage des valeurs (axe et survol). */
  format: (value: number) => string;
  /** Ligne de référence horizontale (ex. RAM maximale). */
  reference?: { value: number; label: string };
  /** Séries entières (joueurs) : graduations entières, jamais 1,5 joueur. */
  integer?: boolean;
  /** Plage affichée (axe X) ; défaut : bornes des timestamps. */
  from?: number;
  to?: number;
  height?: number;
  /** Contenu quand aucune donnée (texte « indisponible » honnête). */
  empty?: ReactNode;
  testId?: string;
}

const PAD = { top: 8, right: 12, bottom: 22, left: 44 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const m = value / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return nice * base;
}

function linePath(points: { x: number; y: number | null }[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.y === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

export function TimeSeriesChart({
  timestamps,
  series,
  yMin = 0,
  yMax,
  format,
  reference,
  integer = false,
  from,
  to,
  height = 160,
  empty,
  testId,
}: TimeSeriesChartProps) {
  const { t, i18n } = useT();
  const { ref, width: measured } = useElementSize<HTMLDivElement>();
  const width = measured > 0 ? measured : 600;
  const [hover, setHover] = useState<number | undefined>(undefined);

  const hasData = series.some((s) => s.values.some((v) => v !== null));
  const x0 = from ?? timestamps[0] ?? 0;
  const x1 = Math.max(to ?? timestamps[timestamps.length - 1] ?? x0 + 1, x0 + 1);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);

  const top = useMemo(() => {
    if (yMax !== undefined) return yMax;
    let max = 0;
    for (const s of series) {
      for (const v of s.values) if (v !== null && v > max) max = v;
      for (const v of s.band ?? []) if (v !== null && v > max) max = v;
    }
    if (reference && reference.value > max) max = reference.value;
    if (integer) {
      // 4 graduations entières : pas = ⌈max/4⌉, sommet = 4 × pas (au moins 4).
      const step = Math.max(1, Math.ceil(Math.max(max, 1) / 4));
      return step * 4;
    }
    return niceMax(max * 1.1);
  }, [series, yMax, reference, integer]);

  const scales = useMemo(
    () => ({
      sx: (ts: number): number => PAD.left + ((ts - x0) / (x1 - x0)) * plotW,
      sy: (v: number): number =>
        PAD.top + plotH - ((Math.min(Math.max(v, yMin), top) - yMin) / (top - yMin)) * plotH,
    }),
    [x0, x1, plotW, plotH, yMin, top],
  );
  const { sx, sy } = scales;

  const paths = useMemo(
    () =>
      series.map((s) => {
        const pts = timestamps.map((ts, i) => {
          const v = s.values[i] ?? null;
          return { x: sx(ts), y: v === null ? null : sy(v) };
        });
        let band: string | undefined;
        if (s.band) {
          const up = timestamps.map((ts, i) => {
            const v = s.band?.[i] ?? null;
            return { x: sx(ts), y: v === null ? null : sy(v) };
          });
          // Polygone par segments continus (simplifié : une seule zone si pas de trou)
          const seg: string[] = [];
          let current: { x: number; y: number }[] = [];
          let currentUp: { x: number; y: number }[] = [];
          const flush = (): void => {
            if (current.length > 1) {
              const forward = current.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
              const back = [...currentUp]
                .reverse()
                .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
              seg.push(`M${[...forward, ...back].join(' L')} Z`);
            }
            current = [];
            currentUp = [];
          };
          pts.forEach((p, i) => {
            const u = up[i];
            if (p.y === null || u?.y === null || u === undefined) {
              flush();
              return;
            }
            current.push({ x: p.x, y: p.y });
            currentUp.push({ x: u.x, y: u.y });
          });
          flush();
          band = seg.join(' ');
        }
        return { key: s.key, d: linePath(pts), band };
      }),
    [series, timestamps, scales],
  );

  // Graduations arrondies au dixième (évite « 2 %, 2 %, 1 %, 1 % » sur de petites échelles).
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(
    (f) => Math.round((yMin + (top - yMin) * f) * 10) / 10,
  );
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => x0 + (x1 - x0) * f);
  const longRange = x1 - x0 > 36 * 3_600_000;

  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (timestamps.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ts = x0 + ((x - PAD.left) / plotW) * (x1 - x0);
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    timestamps.forEach((v, i) => {
      const d = Math.abs(v - ts);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <Box ref={ref} pos="relative" style={{ width: '100%' }} data-testid={testId}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        role="img"
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(undefined);
        }}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={sy(v)}
              y2={sy(v)}
              stroke="var(--mantine-color-default-border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={sy(v) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--mantine-color-dimmed)"
            >
              {format(v)}
            </text>
          </g>
        ))}
        {xTicks.map((ts, i) => (
          <text
            key={ts}
            x={sx(ts)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize={10}
            fill="var(--mantine-color-dimmed)"
          >
            {longRange ? formatDateTime(ts, i18n.language) : formatTime(ts, i18n.language)}
          </text>
        ))}
        {reference && reference.value >= yMin && reference.value <= top && (
          <g>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={sy(reference.value)}
              y2={sy(reference.value)}
              stroke="var(--mantine-color-red-6)"
              strokeDasharray="4 3"
              strokeWidth={1}
            />
            <text
              x={PAD.left + plotW}
              y={sy(reference.value) - 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--mantine-color-red-6)"
            >
              {reference.label}
            </text>
          </g>
        )}
        {paths.map((p, i) => (
          <g key={p.key} data-testid={`series-${p.key}`}>
            {p.band !== undefined && p.band !== '' && (
              <path d={p.band} fill={series[i]?.color} opacity={0.15} stroke="none" />
            )}
            <path
              d={p.d}
              fill="none"
              stroke={series[i]?.color}
              strokeWidth={1.5}
              strokeDasharray={series[i]?.dashed ? '3 3' : undefined}
              strokeLinejoin="round"
            />
          </g>
        ))}
        {hover !== undefined && timestamps[hover] !== undefined && (
          <line
            x1={sx(timestamps[hover])}
            x2={sx(timestamps[hover])}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="var(--mantine-color-dimmed)"
            strokeWidth={1}
          />
        )}
      </svg>
      {!hasData && (
        <Box
          pos="absolute"
          top={PAD.top}
          left={PAD.left}
          w={plotW}
          h={plotH}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Text size="sm" c="dimmed" ta="center">
            {empty ?? t('web:metrics.noData')}
          </Text>
        </Box>
      )}
      {hover !== undefined && timestamps[hover] !== undefined && (
        <Box
          pos="absolute"
          top={0}
          style={{
            left: Math.min(sx(timestamps[hover]) + 8, width - 160),
            pointerEvents: 'none',
            background: 'var(--mantine-color-body)',
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          <Text size="xs" c="dimmed">
            {formatDateTime(timestamps[hover], i18n.language)}
          </Text>
          {series.map((s) => {
            const v = s.values[hover] ?? null;
            return (
              <Group key={s.key} gap={6} wrap="nowrap">
                <Box w={8} h={8} style={{ background: s.color, borderRadius: 2 }} />
                <Text size="xs">
                  {s.label}: {v === null ? '—' : format(v)}
                </Text>
              </Group>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
