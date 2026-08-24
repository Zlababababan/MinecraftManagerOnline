/**
 * Barre d'onglets défilante : fine barre de défilement quand ça déborde, chevrons cliquables aux
 * extrémités (à la manière des onglets d'un navigateur) et onglet actif ramené en vue. Les chevrons
 * n'apparaissent que s'il y a débordement ; chacun se désactive en butée.
 */
import { ActionIcon, Group, ScrollArea } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useT } from '../i18n/hooks.js';

const SCROLL_STEP_PX = 240;

export function ScrollableTabsList({
  children,
  activeValue,
}: {
  children: ReactNode;
  /** Valeur de l'onglet actif : à chaque changement, il est ramené en vue. */
  activeValue?: string | undefined;
}) {
  const { t } = useT();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [reach, setReach] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = viewportRef.current;
    if (el === null) return;
    setReach({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    update();
    const el = viewportRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [update]);

  useEffect(() => {
    if (activeValue === undefined) return;
    const el = viewportRef.current?.querySelector('[data-active]');
    // jsdom n'implémente pas scrollIntoView.
    if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }, [activeValue]);

  const scrollBy = (direction: -1 | 1): void => {
    viewportRef.current?.scrollBy({ left: direction * SCROLL_STEP_PX, behavior: 'smooth' });
  };

  const overflowing = reach.left || reach.right;
  return (
    <Group gap={2} wrap="nowrap" align="center">
      {overflowing && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          disabled={!reach.left}
          onClick={() => {
            scrollBy(-1);
          }}
          aria-label={t('web:common.scrollLeft')}
          data-testid="tabs-scroll-left"
        >
          <IconChevronLeft size={16} />
        </ActionIcon>
      )}
      <ScrollArea
        type="auto"
        scrollbars="x"
        scrollbarSize={6}
        viewportRef={viewportRef}
        onScrollPositionChange={update}
        style={{ flex: 1, minWidth: 0 }}
      >
        {children}
      </ScrollArea>
      {overflowing && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          disabled={!reach.right}
          onClick={() => {
            scrollBy(1);
          }}
          aria-label={t('web:common.scrollRight')}
          data-testid="tabs-scroll-right"
        >
          <IconChevronRight size={16} />
        </ActionIcon>
      )}
    </Group>
  );
}
