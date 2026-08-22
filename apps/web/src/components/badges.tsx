/** Badges d'état (serveur, machine, gravité) — couleurs cohérentes sur toute l'UI. */
import { Badge, type BadgeProps } from '@mantine/core';
import { useT } from '../i18n/hooks.js';

import type { MachineDto, ServerDto } from '@mmo/protocol/client';

const RUN_STATE_COLOR: Record<ServerDto['runState'] | 'unreachable', string> = {
  stopped: 'gray',
  starting: 'yellow',
  running: 'green',
  stopping: 'orange',
  crashed: 'red',
  unreachable: 'gray',
};

export function RunStateBadge({
  server,
  ...props
}: { server: Pick<ServerDto, 'runState' | 'reachable'> } & BadgeProps) {
  const { t } = useT();
  const state = server.reachable ? server.runState : 'unreachable';
  return (
    <Badge
      color={RUN_STATE_COLOR[state]}
      variant={state === 'running' ? 'filled' : 'light'}
      data-testid="run-state"
      data-state={state}
      {...props}
    >
      {t(`common:runState.${state}`)}
    </Badge>
  );
}

const MACHINE_STATUS_COLOR: Record<MachineDto['status'], string> = {
  pending: 'yellow',
  online: 'green',
  offline: 'red',
  disabled: 'gray',
};

export function MachineStatusBadge({
  machine,
  ...props
}: { machine: Pick<MachineDto, 'status' | 'connected'> } & BadgeProps) {
  const { t } = useT();
  const status: MachineDto['status'] =
    machine.connected && machine.status !== 'disabled' ? 'online' : machine.status;
  return (
    <Badge
      color={MACHINE_STATUS_COLOR[status]}
      variant={status === 'online' ? 'filled' : 'light'}
      data-testid="machine-status"
      data-status={status}
      {...props}
    >
      {t(`web:machine.status.${status}`)}
    </Badge>
  );
}

const SEVERITY_COLOR: Record<string, string> = {
  debug: 'gray',
  info: 'blue',
  warning: 'yellow',
  error: 'red',
  critical: 'red',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge color={SEVERITY_COLOR[severity] ?? 'gray'} variant="light" size="sm">
      {severity}
    </Badge>
  );
}
