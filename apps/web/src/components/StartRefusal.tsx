/**
 * Un démarrage refusé propose son remède SUR PLACE (retour de Yassin, 02/10 : pas de détour).
 *
 * Avant, la carte affichait un message rouge (« l'EULA doit être acceptée », « aucun Java 21 »,
 * « port déjà utilisé ») et c'était à l'utilisateur de trouver l'écran qui règle le problème. Ici,
 * chaque refus connu ouvre une fenêtre qui fait la chose : accepter l'EULA puis démarrer, installer
 * le Java manquant, ouvrir les réglages du serveur. Un refus inconnu garde le message d'origine.
 */
import { Button, Group, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import type { ServerDto } from '@mmo/protocol/client';

import { ApiRequestError } from '../api/client.js';
import { useInstallJava } from '../api/phase9.js';
import { useAcceptEula } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';
import { describeError } from '../lib/errors.js';
import { EulaDialog } from './config/EulaCard.js';

const REMEDIES = ['E_EULA_REQUIRED', 'E_JAVA_UNAVAILABLE', 'E_PORT_IN_USE', 'E_RAM_GUARD'] as const;
type Remedy = (typeof REMEDIES)[number];

function remedyOf(error: unknown): Remedy | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  return REMEDIES.find((code) => code === error.code);
}

/**
 * Rend une fonction `(error, retry) => boolean` : `true` si le refus a été pris en charge (une
 * fenêtre est ouverte), `false` s'il faut afficher l'erreur comme d'habitude.
 */
export function useStartRefusal(server: ServerDto): (error: unknown, retry: () => void) => boolean {
  const { t, i18n } = useT();
  const navigate = useNavigate();
  const eula = useAcceptEula(server.id);
  const installJava = useInstallJava(server.machineId);

  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const open = (title: string, body: ReactNode): string =>
    modals.open({ title, children: <Stack gap="md">{body}</Stack> });

  return (error, retry) => {
    const remedy = remedyOf(error);
    if (remedy === undefined || !(error instanceof ApiRequestError)) return false;
    const reason = describeError(i18n, error);

    if (remedy === 'E_EULA_REQUIRED') {
      const id = modals.open({
        title: t('web:eula.title'),
        children: (
          <EulaDialog
            pending={false}
            onAccept={() => {
              eula.mutate(undefined, {
                onSuccess: () => {
                  modals.close(id);
                  // Accepter n'était qu'une étape : ce qu'on voulait, c'était démarrer.
                  retry();
                },
                onError: fail,
              });
            }}
          />
        ),
      });
      return true;
    }

    if (remedy === 'E_JAVA_UNAVAILABLE') {
      const major = typeof error.details.required === 'number' ? error.details.required : undefined;
      // Un chemin Java imposé et cassé ne se répare pas par une installation : réglages du serveur.
      if (major === undefined) return false;
      const id = open(
        t('web:server.refusal.javaTitle', { major }),
        <>
          <Text size="sm">{t('web:server.refusal.java', { major, name: server.name })}</Text>
          <Group justify="flex-end">
            <Button
              data-testid="refusal-install-java"
              onClick={() => {
                installJava.mutate(
                  { majorVersion: major, relay: false },
                  {
                    onSuccess: () => {
                      modals.close(id);
                      notifications.show({
                        color: 'teal',
                        message: t('web:server.refusal.javaStarted', { major }),
                      });
                    },
                    onError: fail,
                  },
                );
              }}
            >
              {t('web:install.installJava', { major })}
            </Button>
          </Group>
        </>,
      );
      return true;
    }

    // Port pris ou mémoire insuffisante : le réglage est sur la page du serveur, on y mène.
    const id = open(
      t('web:server.refusal.title', { name: server.name }),
      <>
        <Text size="sm">{reason}</Text>
        <Text size="sm" c="dimmed">
          {t(remedy === 'E_PORT_IN_USE' ? 'web:server.refusal.port' : 'web:server.refusal.ram')}
        </Text>
        <Group justify="flex-end">
          <Button
            data-testid="refusal-open-settings"
            onClick={() => {
              modals.close(id);
              void navigate({
                to: '/servers/$serverId',
                params: { serverId: server.id },
                search: { tab: 'settings' },
              });
            }}
          >
            {t('web:server.refusal.openSettings')}
          </Button>
        </Group>
      </>,
    );
    return true;
  };
}
