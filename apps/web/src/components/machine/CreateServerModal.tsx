/**
 * Lot 5 — assistant de création d'un serveur, en quatre écrans : emplacement, version, ressources,
 * EULA. Le récapitulatif tient dans le dernier écran, avec le pré-contrôle de la machine (dossier
 * vide, port libre, JRE, place) : c'est le seul moment où l'on peut encore reculer sans rien avoir
 * écrit sur le disque.
 *
 * L'EULA n'est **jamais** pré-cochée. C'est un engagement pris par une personne — le panel écrit
 * son nom dans le journal d'audit — et le schéma la refuse tant qu'elle n'est pas cochée.
 *
 * Les listes déroulantes sont des `NativeSelect` : un `Select` Mantine ne s'ouvre pas sous jsdom
 * (piège 63), et une liste de cent versions se parcourt très bien avec le sélecteur du système.
 */
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  List,
  Modal,
  NativeSelect,
  NumberInput,
  SegmentedControl,
  Stack,
  Stepper,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';

import {
  INSTALL_FOLDER_RE,
  type InstallLoader,
  type InstallPrecheckDto,
  type MachineDto,
} from '@mmo/protocol/client';

import { useCreateInstall, useInstallCatalog, useInstallPrecheck } from '../../api/installs.js';
import { useT } from '../../i18n/hooks.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { HelpLink } from '../HelpLink.js';

export interface CreateServerModalProps {
  machine: MachineDto;
  directories: MachineDto['watchedDirectories'];
  opened: boolean;
  onClose: () => void;
  onCreated: (serverId: string) => void;
}

interface FormValues {
  directoryId: string;
  folderName: string;
  name: string;
  loader: InstallLoader;
  mcVersion: string;
  maxRamMb: number;
  motd: string;
  acceptEula: boolean;
}

export function CreateServerModal({
  machine,
  directories,
  opened,
  onClose,
  onCreated,
}: CreateServerModalProps) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [precheck, setPrecheck] = useState<InstallPrecheckDto | undefined>(undefined);
  const form = useForm<FormValues>({
    initialValues: {
      directoryId: directories[0]?.id ?? '',
      folderName: '',
      name: '',
      loader: 'vanilla',
      mcVersion: '',
      maxRamMb: 4096,
      motd: '',
      // Jamais pré-cochée : c'est le sens même de l'acceptation.
      acceptEula: false,
    },
    validate: {
      directoryId: (value) => (value === '' ? t('web:install.directoryRequired') : null),
      folderName: (value) =>
        INSTALL_FOLDER_RE.test(value) ? null : t('web:install.folderInvalid'),
      mcVersion: (value) => (value === '' ? t('web:install.versionRequired') : null),
    },
  });

  const catalog = useInstallCatalog(form.values.loader, opened);
  const runPrecheck = useInstallPrecheck(machine.id);
  const create = useCreateInstall(machine.id);

  const directory = directories.find((d) => d.id === form.values.directoryId);
  const separator = machine.os === 'windows' ? String.fromCharCode(92) : '/';
  const fullPath = `${(directory?.path ?? '').replace(/[\\/]+$/, '')}${separator}${form.values.folderName}`;
  const versions = catalog.data?.versions ?? [];

  const close = () => {
    setStep(0);
    setPrecheck(undefined);
    form.reset();
    create.reset();
    runPrecheck.reset();
    onClose();
  };

  const body = () => ({
    directoryId: form.values.directoryId,
    folderName: form.values.folderName,
    loader: form.values.loader,
    mcVersion: form.values.mcVersion,
    maxRamMb: form.values.maxRamMb,
    ...(form.values.name.trim() === '' ? {} : { name: form.values.name.trim() }),
    ...(form.values.motd.trim() === '' ? {} : { motd: form.values.motd.trim() }),
  });

  const next = () => {
    if (step === 0 && form.validateField('directoryId').hasError) return;
    if (step === 0 && form.validateField('folderName').hasError) return;
    if (step === 1 && form.validateField('mcVersion').hasError) return;
    // Dernier pas avant l'engagement : on demande à la machine ce qu'elle en pense.
    if (step === 2) {
      runPrecheck.mutate(body(), {
        onSuccess: (data) => {
          setPrecheck(data.precheck);
          setStep(3);
        },
      });
      return;
    }
    setStep((s) => s + 1);
  };

  const submit = () => {
    create.mutate(
      { ...body(), acceptEula: true },
      {
        onSuccess: (data) => {
          onCreated(data.server.id);
          close();
        },
      },
    );
  };

  // Le pre-controle ne bloque pas : il previent, en nommant ce qui cloche.
  const problems: string[] = [];
  if (precheck !== undefined) {
    if (!precheck.path.ok) problems.push(t('web:install.problemPath'));
    if (!precheck.port.ok) problems.push(t('web:install.problemPort'));
    if (!precheck.java.ok) problems.push(t('web:install.problemJava'));
    if (!precheck.disk.ok) problems.push(t('web:install.problemDisk'));
  }

  return (
    <Modal opened={opened} onClose={close} title={t('web:install.title')} size="lg">
      <Stack gap="md">
        <Stepper active={step} size="sm" allowNextStepsSelect={false}>
          <Stepper.Step label={t('web:install.stepPlace')} />
          <Stepper.Step label={t('web:install.stepVersion')} />
          <Stepper.Step label={t('web:install.stepResources')} />
          <Stepper.Step label={t('web:install.stepConfirm')} />
        </Stepper>

        {step === 0 && (
          <Stack gap="sm">
            <NativeSelect
              label={t('web:install.directory')}
              data={directories.map((d) => ({ value: d.id, label: d.path }))}
              data-testid="install-directory"
              {...form.getInputProps('directoryId')}
            />
            <TextInput
              label={t('web:install.folderName')}
              description={t('web:install.folderHint')}
              required
              {...TECHNICAL_INPUT_PROPS}
              data-testid="install-folder"
              {...form.getInputProps('folderName')}
            />
            <TextInput
              label={t('web:install.displayName')}
              placeholder={form.values.folderName}
              {...form.getInputProps('name')}
            />
            <Card withBorder radius="sm" padding="xs" bg="var(--mantine-color-default-hover)">
              <Text size="xs" c="dimmed">
                {t('web:install.finalPath')}
              </Text>
              <Text size="sm" ff="monospace" data-testid="install-path">
                {fullPath}
              </Text>
            </Card>
          </Stack>
        )}

        {step === 1 && (
          <Stack gap="sm">
            <SegmentedControl
              fullWidth
              data={[
                { value: 'vanilla', label: t('web:install.loaderVanilla') },
                { value: 'fabric', label: t('web:install.loaderFabric') },
              ]}
              data-testid="install-loader"
              value={form.values.loader}
              onChange={(value) => {
                form.setFieldValue('loader', value as InstallLoader);
                form.setFieldValue('mcVersion', '');
              }}
            />
            <NativeSelect
              label={t('web:install.version')}
              disabled={catalog.isPending}
              data={[
                { value: '', label: catalog.isPending ? t('web:common.loading') : '—' },
                ...versions.map((v) => ({
                  value: v.id,
                  label: v.stable ? v.id : `${v.id} (${t('web:install.snapshot')})`,
                })),
              ]}
              data-testid="install-version"
              {...form.getInputProps('mcVersion')}
            />
            <ErrorAlert error={catalog.error} />
            <Text size="xs" c="dimmed">
              {t('web:install.versionHint')}
            </Text>
          </Stack>
        )}

        {step === 2 && (
          <Stack gap="sm">
            <NumberInput
              label={t('web:install.maxRam')}
              description={t('web:install.maxRamHint')}
              min={512}
              max={131072}
              step={512}
              data-testid="install-ram"
              {...form.getInputProps('maxRamMb')}
            />
            <TextInput label={t('web:install.motd')} {...form.getInputProps('motd')} />
          </Stack>
        )}

        {step === 3 && (
          <Stack gap="sm">
            <Card withBorder radius="sm" padding="sm">
              <Stack gap={4}>
                <Summary
                  label={t('web:install.finalPath')}
                  value={precheck?.target.path ?? fullPath}
                />
                <Summary
                  label={t('web:install.version')}
                  value={`${form.values.loader === 'fabric' ? 'Fabric' : 'Minecraft'} ${form.values.mcVersion}${
                    precheck?.target.loaderVersion === null ||
                    precheck?.target.loaderVersion === undefined
                      ? ''
                      : ` · ${precheck.target.loaderVersion}`
                  }`}
                />
                <Summary
                  label={t('web:install.port')}
                  value={String(precheck?.target.gamePort ?? '—')}
                />
                <Summary
                  label={t('web:install.maxRam')}
                  value={`${String(form.values.maxRamMb)} Mio`}
                />
              </Stack>
            </Card>
            {problems.length > 0 && (
              <Alert
                color="orange"
                icon={<IconAlertTriangle size={16} />}
                data-testid="install-precheck-problems"
              >
                <List size="sm">
                  {problems.map((p) => (
                    <List.Item key={p}>{p}</List.Item>
                  ))}
                </List>
              </Alert>
            )}
            <Checkbox
              label={
                <Group gap={4} wrap="nowrap">
                  <Text size="sm">{t('web:install.eula')}</Text>
                  <HelpLink topic="createServer" inline />
                </Group>
              }
              data-testid="install-eula"
              {...form.getInputProps('acceptEula', { type: 'checkbox' })}
            />
            <ErrorAlert error={create.error} />
          </Stack>
        )}

        <ErrorAlert error={runPrecheck.error} />
        <Group justify="space-between">
          <Button
            variant="subtle"
            disabled={step === 0}
            onClick={() => {
              setStep((s) => Math.max(0, s - 1));
            }}
          >
            {t('web:common.back')}
          </Button>
          {step < 3 ? (
            <Button onClick={next} loading={runPrecheck.isPending} data-testid="install-next">
              {t('web:common.next')}
            </Button>
          ) : (
            <Button
              onClick={submit}
              loading={create.isPending}
              disabled={!form.values.acceptEula}
              data-testid="install-submit"
            >
              {t('web:install.create')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" ff="monospace" ta="right" style={{ wordBreak: 'break-all' }}>
        {value}
      </Text>
    </Group>
  );
}
