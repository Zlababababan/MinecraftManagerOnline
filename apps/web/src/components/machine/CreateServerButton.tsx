/**
 * « Créer un serveur » : LE bouton, le même partout (tableau de bord, page Serveurs).
 *
 * Une fonction = un seul endroit complet (retour de Yassin, 01/10) : l'assistant de création est
 * unique, et ce bouton en est le raccourci. Avec une seule machine prête, il ouvre l'assistant
 * directement ; avec plusieurs, il demande d'abord laquelle. Sans machine prête (agent hors ligne
 * ou aucun répertoire surveillé), il n'y a nulle part où créer : pas de bouton.
 */
import { Button, Menu, type ButtonProps } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import type { MachineDto } from '@mmo/protocol/client';

import { useMachines, useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { creatableMachines } from '../../lib/dashboard.js';
import { canMachine } from '../../lib/permissions.js';
import { CreateServerModal } from './CreateServerModal.js';

export function CreateServerButton({
  testId,
  size = 'sm',
}: {
  testId: string;
  size?: ButtonProps['size'];
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const me = useMe();
  const machines = useMachines();
  const [createOn, setCreateOn] = useState<MachineDto | undefined>(undefined);

  const creatable = creatableMachines(machines.data?.machines ?? [], (id) =>
    canMachine(me.data, id, 'operator'),
  );
  const only = creatable.length === 1 ? creatable[0] : undefined;
  if (creatable.length === 0) return null;

  return (
    <>
      {only !== undefined ? (
        <Button
          size={size}
          leftSection={<IconPlus size={16} />}
          data-testid={testId}
          onClick={() => {
            setCreateOn(only);
          }}
        >
          {t('web:install.title')}
        </Button>
      ) : (
        <Menu position="bottom-end">
          <Menu.Target>
            <Button size={size} leftSection={<IconPlus size={16} />} data-testid={testId}>
              {t('web:install.title')}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('web:dashboard.createOn')}</Menu.Label>
            {creatable.map((m) => (
              <Menu.Item
                key={m.id}
                onClick={() => {
                  setCreateOn(m);
                }}
              >
                {m.name}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
      {createOn !== undefined && (
        <CreateServerModal
          machine={createOn}
          directories={createOn.watchedDirectories}
          opened
          onClose={() => {
            setCreateOn(undefined);
          }}
          onCreated={(serverId) => {
            // La page du serveur porte le bouton Démarrer : créer puis lancer s'enchaînent.
            void navigate({
              to: '/servers/$serverId',
              params: { serverId },
              search: { tab: 'overview' },
            });
          }}
        />
      )}
    </>
  );
}
