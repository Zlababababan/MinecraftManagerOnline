/**
 * Palette de commandes (Ctrl/Cmd+K). Sur cinquante-trois serveurs, atteindre le bon en trois
 * frappes vaut mieux que n'importe quel menu.
 *
 * Construite sur un `Modal` Mantine plutôt que sur `@mantine/spotlight` : le paquet n'est pas
 * installé, et ajouter une dépendance pour une liste filtrée et deux touches ne se justifie pas
 * — le dépôt épingle ses versions et vérifie son lockfile.
 */
import { Kbd, Modal, ScrollArea, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useMachines, useServers } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';
import { TECHNICAL_INPUT_PROPS } from '../lib/inputs.js';
import { moveSelection, searchPalette, type PaletteItem } from '../lib/palette.js';

type Target =
  | { to: '/' }
  | { to: '/servers' }
  | { to: '/machines' }
  | { to: '/settings' }
  | { to: '/account' }
  | { to: '/servers/$serverId'; params: { serverId: string } }
  | { to: '/machines/$machineId'; params: { machineId: string } };

export function CommandPalette({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const servers = useServers();
  const machines = useMachines();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { items, targets } = useMemo(() => {
    const targets = new Map<string, Target>();
    const items: PaletteItem[] = [];
    const action = (id: string, label: string, target: Target) => {
      items.push({ id, label, group: 'action' });
      targets.set(id, target);
    };
    action('go:dashboard', t('web:nav.dashboard'), { to: '/' });
    action('go:servers', t('web:nav.servers'), { to: '/servers' });
    action('go:machines', t('web:nav.machines'), { to: '/machines' });
    action('go:settings', t('web:nav.settings'), { to: '/settings' });
    action('go:account', t('web:nav.account'), { to: '/account' });
    for (const m of machines.data?.machines ?? []) {
      items.push({ id: `m:${m.id}`, label: m.name, hint: t('web:nav.machines'), group: 'machine' });
      targets.set(`m:${m.id}`, { to: '/machines/$machineId', params: { machineId: m.id } });
    }
    for (const s of servers.data?.servers ?? []) {
      const machine = machines.data?.machines.find((m) => m.id === s.machineId)?.name;
      items.push({
        id: `s:${s.id}`,
        label: s.name,
        // Le chemin est cherché aussi : c'est souvent ce dont on se souvient.
        hint: [machine, s.path].filter((x) => x !== undefined).join(' · '),
        group: 'server',
      });
      targets.set(`s:${s.id}`, { to: '/servers/$serverId', params: { serverId: s.id } });
    }
    return { items, targets };
  }, [servers.data, machines.data, t]);

  const results = searchPalette(items, query);

  // Une nouvelle saisie repart du premier résultat : garder le curseur donnerait une sélection
  // qui saute sur un élément que l'utilisateur n'a pas regardé.
  useEffect(() => {
    setCursor(0);
  }, [query]);
  useEffect(() => {
    if (!opened) setQuery('');
  }, [opened]);

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    const target = targets.get(item.id);
    if (!target) return;
    onClose();
    void navigate(target as Parameters<typeof navigate>[0]);
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      withCloseButton={false}
      size="lg"
      padding="xs"
      title={null}
      data-testid="palette"
    >
      <TextInput
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => moveSelection(c, e.key === 'ArrowDown' ? 1 : -1, results.length));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            go(results[cursor]);
          }
        }}
        placeholder={t('web:palette.placeholder')}
        aria-label={t('web:palette.placeholder')}
        leftSection={<IconSearch size={16} />}
        {...TECHNICAL_INPUT_PROPS}
        data-autofocus
        data-testid="palette-input"
      />
      <ScrollArea.Autosize mah={360} mt="xs" viewportRef={listRef}>
        <Stack gap={2} role="listbox" aria-label={t('web:palette.results')}>
          {results.length === 0 ? (
            <Text size="sm" c="dimmed" p="sm" data-testid="palette-empty">
              {t('web:palette.empty')}
            </Text>
          ) : (
            results.map((item, i) => (
              <UnstyledButton
                key={item.id}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => {
                  setCursor(i);
                }}
                onClick={() => {
                  go(item);
                }}
                p="xs"
                style={{
                  borderRadius: 6,
                  background: i === cursor ? 'var(--mantine-color-default-hover)' : undefined,
                }}
                data-testid={`palette-item-${item.id}`}
              >
                <Text size="sm" fw={500} truncate="end">
                  {item.label}
                </Text>
                {item.hint !== undefined && (
                  <Text size="xs" c="dimmed" truncate="end">
                    {item.hint}
                  </Text>
                )}
              </UnstyledButton>
            ))
          )}
        </Stack>
      </ScrollArea.Autosize>
      <Text size="xs" c="dimmed" mt="xs" ta="right">
        <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('web:palette.navigate')} · <Kbd>↵</Kbd> {t('web:palette.open')}{' '}
        · <Kbd>Esc</Kbd> {t('web:common.close')}
      </Text>
    </Modal>
  );
}
