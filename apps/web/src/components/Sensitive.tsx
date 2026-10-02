/**
 * Une donnée sensible (IP, adresse d'un serveur) : floutée par défaut, révélée d'un clic ou par
 * « Afficher les données sensibles » dans l'en-tête. Les boutons « Copier » voisins copient la
 * vraie valeur : on n'a pas besoin de la lire pour s'en servir. Voir `lib/sensitive.ts`.
 */
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';

import { useT } from '../i18n/hooks.js';
import { setRevealSensitive, splitAround, useRevealSensitive } from '../lib/sensitive.js';

export function Sensitive({ children }: { children: ReactNode }) {
  const { t } = useT();
  const all = useRevealSensitive();
  const [mine, setMine] = useState(false);
  const revealed = all || mine;
  if (revealed) {
    return (
      <span className="mmo-sensitive" data-sensitive="revealed">
        {children}
      </span>
    );
  }
  const reveal = (): void => {
    setMine(true);
  };
  return (
    <span
      className="mmo-sensitive mmo-sensitive-hidden"
      data-sensitive="hidden"
      role="button"
      tabIndex={0}
      title={t('web:sensitive.reveal')}
      aria-label={t('web:sensitive.reveal')}
      onClick={(event) => {
        // Dans une ligne cliquable (audit), révéler ne doit pas aussi déplier la ligne.
        event.stopPropagation();
        reveal();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          reveal();
        }
      }}
    >
      {children}
    </span>
  );
}

/** Une phrase traduite dont seule la donnée sensible est floutée. */
export function SensitiveSentence({
  render,
  value,
}: {
  /** Reçoit la valeur à placer dans la phrase : `(v) => t('…', { address: v })`. */
  render: (value: string) => string;
  value: string;
}) {
  const [before, after] = splitAround(render);
  return (
    <>
      {before}
      <Sensitive>{value}</Sensitive>
      {after}
    </>
  );
}

/** Interrupteur de l'en-tête : tout afficher / tout flouter dans ce navigateur. */
export function SensitiveToggle() {
  const { t } = useT();
  const all = useRevealSensitive();
  const label = all ? t('web:sensitive.hideAll') : t('web:sensitive.showAll');
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={label}
        aria-pressed={all}
        data-testid="sensitive-toggle"
        onClick={() => {
          setRevealSensitive(!all);
        }}
      >
        {all ? <IconEye size={18} /> : <IconEyeOff size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}
