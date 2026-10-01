/**
 * « Créer un serveur » : LE bouton, le même partout (tableau de bord, page Serveurs).
 *
 * Une fonction = un seul endroit complet (retour de Yassin, 01/10) : l'assistant de création est
 * unique, et ce bouton en est le raccourci. Avec une seule machine en ligne, il ouvre l'assistant
 * directement ; avec plusieurs, il demande d'abord laquelle.
 *
 * Le bouton ne disparaît plus quand il manque quelque chose (retour du 02/10 : « une personne
 * lambda n'aura jamais la motivation de chercher partout ») : sans répertoire surveillé, il demande
 * le dossier sur place puis enchaîne sur l'assistant ; agent hors ligne, il reste là, grisé, et dit
 * pourquoi. Seul cas sans bouton : aucune machine (c'est « Ajouter une machine » qu'il faut).
 */
import { Button, Menu, Modal, Stack, Text, Tooltip, type ButtonProps } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { useMachines, useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { hasRole } from '../../lib/format.js';
import { canMachine } from '../../lib/permissions.js';
import { CreateServerModal } from './CreateServerModal.js';
import { DirectoryForm } from './DirectoryForm.js';

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
  const [targetId, setTargetId] = useState<string | undefined>(undefined);

  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const mine = (machines.data?.machines ?? []).filter((m) => canMachine(me.data, m.id, 'operator'));
  const online = mine.filter((m) => m.connected);
  // La cible se relit dans la liste vivante : le dossier ajouté ici y apparaît tout seul.
  const target = online.find((m) => m.id === targetId);
  if (mine.length === 0) return null;

  const button = (onClick?: () => void) => (
    <Button
      size={size}
      leftSection={<IconPlus size={16} />}
      data-testid={testId}
      disabled={online.length === 0}
      {...(onClick === undefined ? {} : { onClick })}
    >
      {t('web:install.title')}
    </Button>
  );
  const close = (): void => {
    setTargetId(undefined);
  };

  return (
    <>
      {online.length === 0 ? (
        <Tooltip label={t('web:install.noMachineOnline')} withArrow multiline w={260}>
          <span>{button()}</span>
        </Tooltip>
      ) : online.length === 1 ? (
        button(() => {
          setTargetId(online[0]?.id);
        })
      ) : (
        <Menu position="bottom-end">
          <Menu.Target>{button()}</Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('web:dashboard.createOn')}</Menu.Label>
            {online.map((m) => (
              <Menu.Item
                key={m.id}
                onClick={() => {
                  setTargetId(m.id);
                }}
              >
                {m.name}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
      {target?.watchedDirectories.length === 0 && (
        <Modal opened onClose={close} title={t('web:install.title')}>
          <Stack gap="sm" data-testid="create-needs-directory">
            <Text size="sm">{t('web:install.needsDirectory', { name: target.name })}</Text>
            {isAdmin ? (
              <DirectoryForm machineId={target.id} testId="create-directory" />
            ) : (
              <Text size="sm" c="dimmed">
                {t('web:install.needsDirectoryAdmin')}
              </Text>
            )}
          </Stack>
        </Modal>
      )}
      {target !== undefined && target.watchedDirectories.length > 0 && (
        <CreateServerModal
          machine={target}
          directories={target.watchedDirectories}
          opened
          onClose={close}
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
