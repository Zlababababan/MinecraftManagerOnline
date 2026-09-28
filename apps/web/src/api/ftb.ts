/**
 * Intégration FTB (lot 5) — catalogue des modpacks, **retirable** avec le reste de l'intégration
 * (docs/services-tiers.md). Les listes vieillissent vite côté FTB : une heure de cache côté panel,
 * cinq minutes ici.
 */
import { queryOptions, useQuery } from '@tanstack/react-query';

import type { FtbPackDto, FtbPackListDto } from '@mmo/protocol/client';

import { api } from './client.js';

export const ftbPacksQuery = (q: string) =>
  queryOptions({
    queryKey: ['install', 'ftb', 'list', q] as const,
    queryFn: ({ signal }) =>
      api.get<FtbPackListDto>(`/api/install/modpacks/ftb?q=${encodeURIComponent(q)}`, signal),
    staleTime: 5 * 60_000,
  });

export const ftbPackQuery = (packId: number) =>
  queryOptions({
    queryKey: ['install', 'ftb', 'pack', packId] as const,
    queryFn: ({ signal }) =>
      api.get<{ pack: FtbPackDto }>(`/api/install/modpacks/ftb/${String(packId)}`, signal),
    staleTime: 5 * 60_000,
  });

export const useFtbPacks = (q: string, enabled: boolean) =>
  useQuery({ ...ftbPacksQuery(q), enabled });

export const useFtbPack = (packId: number | undefined) =>
  useQuery({ ...ftbPackQuery(packId ?? 0), enabled: packId !== undefined });
