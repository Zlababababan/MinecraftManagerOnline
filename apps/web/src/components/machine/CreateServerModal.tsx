/**
 * Lot 5 — assistant de création d'un serveur, en trois écrans : **quoi installer** (une version,
 * un modpack ou une archive), **réglages** (dossier et mémoire, tous deux proposés), **vérification**
 * (EULA). On choisit d'abord QUOI : le nom du dossier s'en déduit, et personne n'a à inventer un nom
 * avant de savoir ce qu'il installe (retour de Yassin, 01/10). Le récapitulatif tient dans le
 * dernier écran, avec le pré-contrôle de la machine (dossier vide, port libre, JRE, place) : c'est
 * le seul moment où l'on peut encore reculer sans rien avoir écrit sur le disque.
 *
 * L'EULA n'est **jamais** pré-cochée. C'est un engagement pris par une personne — le panel écrit
 * son nom dans le journal d'audit — et le schéma la refuse tant qu'elle n'est pas cochée.
 *
 * Remarques de la recette (4.1) : la liste des versions était une colonne de 900 lignes, snapshots
 * et alphas de 2010 compris — elle est désormais groupée par série, les versions de test sont
 * masquées par défaut et la dernière version stable est présélectionnée. Un Java manquant ne renvoie
 * plus vers un autre écran : l'assistant dit lequel et propose de l'installer sur place.
 *
 * Les listes déroulantes sont des `NativeSelect` : un `Select` Mantine ne s'ouvre pas sous jsdom
 * (piège 63), et une liste de versions se parcourt très bien avec le sélecteur du système.
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
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertTriangle, IconCoffee } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import {
  INSTALL_FOLDER_RE,
  type CatalogVersionDto,
  type InstallLoader,
  type InstallPrecheckDto,
  type MachineDto,
} from '@mmo/protocol/client';

import { useCreateInstall, useInstallCatalog, useInstallPrecheck } from '../../api/installs.js';
import { useActiveTasks } from '../../api/phase8.js';
import { useInstallJava } from '../../api/phase9.js';
import { serversQuery, useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { hasRole } from '../../lib/format.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { HelpLink } from '../HelpLink.js';
import { TaskProgressRow } from '../tasks/TaskProgress.js';
import { ArchivePicker, type ArchiveSelection } from './ArchivePicker.js';
// Intégration FTB, retirable en entier (docs/services-tiers.md).
import { FtbPackPicker, type FtbSelection } from './FtbPackPicker.js';

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

const LOADER_LABELS: Record<InstallLoader, string> = {
  vanilla: 'Minecraft',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

/**
 * Mémoire proposée : un serveur moddé Forge/NeoForge tient mal dans 4 Gio. Ce n'est qu'un point de
 * départ, modifié seulement tant que l'utilisateur n'y a pas touché.
 */
export const DEFAULT_RAM_MB: Record<InstallLoader, number> = {
  vanilla: 4096,
  fabric: 4096,
  forge: 6144,
  neoforge: 6144,
};

/** Un « server pack » moddé livré en zip (ATM10 : 418 mods) ne démarre pas dans 6 Gio. */
export const ARCHIVE_MODDED_RAM_MB = 8192;

/**
 * Nom de dossier proposé d'après ce qu'on installe (« ATM10AERO-0.7.1-server.zip » →
 * « ATM10AERO-0.7.1 ») : seulement les caractères qu'accepte `INSTALL_FOLDER_RE`, et jamais un nom
 * déjà pris sous le répertoire choisi (« -2 », « -3 »…).
 */
export function suggestFolderName(
  raw: string,
  taken: ReadonlySet<string>,
  caseSensitive: boolean,
): string {
  const base =
    raw
      .replace(/\.zip$/i, '')
      .replace(/[-_ .]*server([-_ ]?files?)?$/i, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 56)
      .replace(/[._-]+$/, '') || 'serveur';
  const isTaken = (name: string): boolean => taken.has(caseSensitive ? name : name.toLowerCase());
  let name = base;
  for (let i = 2; isTaken(name); i++) name = `${base}-${String(i)}`;
  return name;
}

export interface VersionGroup {
  /** Série (`1.21`, `26`) ; `undefined` pour le groupe des versions de test. */
  series: string | undefined;
  items: CatalogVersionDto[];
}

/**
 * Regroupe les versions par série, dans l'ordre reçu (le plus récent d'abord). Les versions de
 * test (snapshots, pré-versions, alphas et bêtas historiques) ne sont gardées que sur demande, dans
 * un groupe à part en fin de liste.
 */
export function groupVersions(
  versions: readonly CatalogVersionDto[],
  showUnstable: boolean,
): VersionGroup[] {
  const groups: VersionGroup[] = [];
  const bySeries = new Map<string, VersionGroup>();
  const unstable: CatalogVersionDto[] = [];
  for (const v of versions) {
    if (!v.stable) {
      if (showUnstable) unstable.push(v);
      continue;
    }
    const m = /^(\d+)\.(\d+)/.exec(v.id);
    // `1.21.4` → série 1.21 ; depuis la numérotation par année, `26.2` → série 26.
    const series = m === null ? v.id : m[1] === '1' ? `1.${String(m[2])}` : String(m[1]);
    let group = bySeries.get(series);
    if (group === undefined) {
      group = { series, items: [] };
      bySeries.set(series, group);
      groups.push(group);
    }
    group.items.push(v);
  }
  if (unstable.length > 0) groups.push({ series: undefined, items: unstable });
  return groups;
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
  const [showUnstable, setShowUnstable] = useState(false);
  // Intégration FTB (retirable) : un modpack au lieu d'un chargeur nu.
  // … ou un zip « server files » posé sur la machine (doc 06 §6sexies).
  const [mode, setMode] = useState<'plain' | 'ftb' | 'archive'>('plain');
  const [archivePick, setArchivePick] = useState<ArchiveSelection | undefined>(undefined);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);
  const [ftbPick, setFtbPick] = useState<FtbSelection | undefined>(undefined);
  const [ftbError, setFtbError] = useState<string | undefined>(undefined);
  // Dernière mémoire proposée par l'assistant : tant que le champ la porte, on peut la remplacer.
  const suggestedRam = useRef<number>(DEFAULT_RAM_MB.vanilla);
  // Même règle pour le nom du dossier : proposé, et remplacé tant qu'on ne l'a pas retouché.
  const suggestedFolder = useRef<string>('');
  const form = useForm<FormValues>({
    initialValues: {
      directoryId: directories[0]?.id ?? '',
      folderName: '',
      name: '',
      loader: 'vanilla',
      mcVersion: '',
      maxRamMb: DEFAULT_RAM_MB.vanilla,
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

  const catalog = useInstallCatalog(form.values.loader, opened && mode === 'plain');
  const runPrecheck = useInstallPrecheck(machine.id);
  const create = useCreateInstall(machine.id);
  const installJava = useInstallJava(machine.id);
  const me = useMe();
  const tasks = useActiveTasks();
  const servers = useQuery({ ...serversQuery, enabled: opened });
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const ftbAvailable = me.data?.features?.ftb === true;

  const directory = directories.find((d) => d.id === form.values.directoryId);
  const separator = machine.os === 'windows' ? String.fromCharCode(92) : '/';
  const fullPath = `${(directory?.path ?? '').replace(/[\\/]+$/, '')}${separator}${form.values.folderName}`;
  const versions = useMemo(() => catalog.data?.versions ?? [], [catalog.data]);
  const groups = useMemo(() => groupVersions(versions, showUnstable), [versions, showUnstable]);
  const selected = versions.find((v) => v.id === form.values.mcVersion);

  // La dernière version stable est présélectionnée dès que le catalogue arrive : c'est le choix de
  // presque tout le monde, et il reste modifiable.
  const { setFieldValue } = form;
  const currentVersion = form.values.mcVersion;
  useEffect(() => {
    // En mode modpack ou archive, c'est le pack qui dit la version de jeu.
    if (mode !== 'plain' || currentVersion !== '') return;
    const first = versions.find((v) => v.stable);
    if (first !== undefined) setFieldValue('mcVersion', first.id);
  }, [versions, currentVersion, setFieldValue, mode]);

  // Les dossiers déjà enregistrés sur cette machine, sous le répertoire choisi : dire tout de suite
  // « ce nom est pris » plutôt que laisser avancer jusqu'au refus du panel (recette, 4.9). Casse
  // ignorée sauf sous Linux, seul système où deux dossiers ne différant que par la casse coexistent.
  const caseSensitive = machine.os === 'linux';
  const takenFolders = useMemo(() => {
    const fold = (s: string): string => (caseSensitive ? s : s.toLowerCase());
    const normalize = (p: string): string => fold(p.replace(/[\\/]+/g, '/').replace(/\/+$/, ''));
    const parent = normalize(directory?.path ?? '');
    const taken = new Set<string>();
    for (const s of servers.data?.servers ?? []) {
      if (s.machineId !== machine.id) continue;
      const full = normalize(s.path);
      const slash = full.lastIndexOf('/');
      if (slash < 0 || full.slice(0, slash) !== parent) continue;
      taken.add(full.slice(slash + 1));
    }
    return taken;
  }, [servers.data, directory?.path, machine.id, caseSensitive]);
  const folderTaken = takenFolders.has(
    caseSensitive ? form.values.folderName : form.values.folderName.toLowerCase(),
  );

  const javaTasks = (tasks.data?.tasks ?? []).filter(
    (task) => task.kind === 'java.install' && task.machineId === machine.id,
  );

  const close = () => {
    setStep(0);
    setPrecheck(undefined);
    setShowUnstable(false);
    setMode('plain');
    setFtbPick(undefined);
    setFtbError(undefined);
    setArchivePick(undefined);
    setArchiveError(undefined);
    suggestedRam.current = DEFAULT_RAM_MB.vanilla;
    suggestedFolder.current = '';
    form.reset();
    create.reset();
    runPrecheck.reset();
    installJava.reset();
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
    ...(mode === 'ftb' && ftbPick !== undefined
      ? {
          modpack: {
            provider: 'ftb' as const,
            packId: ftbPick.pack.id,
            versionId: ftbPick.version.id,
          },
        }
      : {}),
    ...(mode === 'archive' && archivePick !== undefined
      ? { archive: { path: archivePick.archive.path } }
      : {}),
  });

  const check = (then?: () => void) => {
    runPrecheck.mutate(body(), {
      onSuccess: (data) => {
        setPrecheck(data.precheck);
        then?.();
      },
    });
  };

  // Java installé depuis l'assistant : quand sa task se termine, on redemande l'avis de la machine
  // — sans quoi l'avertissement resterait affiché alors que le problème est réglé.
  const javaRunning = javaTasks.length > 0;
  const wasRunning = useRef(false);
  // `check` lit le formulaire du rendu courant : un événement d'effet, pas une dépendance.
  const recheck = useEffectEvent(() => {
    if (step === 2) check();
  });
  useEffect(() => {
    if (wasRunning.current && !javaRunning) recheck();
    wasRunning.current = javaRunning;
  }, [javaRunning]);

  /** Ce qu'on installe, en un nom : la base du dossier proposé. */
  const sourceName = (): string => {
    if (mode === 'archive' && archivePick !== undefined) return archivePick.archive.name;
    if (mode === 'ftb' && ftbPick !== undefined) {
      return `${ftbPick.pack.name}-${ftbPick.version.name}`;
    }
    return `${form.values.loader}-${form.values.mcVersion}`;
  };

  const next = () => {
    if (step === 1 && form.validateField('directoryId').hasError) return;
    if (step === 1 && form.validateField('folderName').hasError) return;
    if (step === 1 && folderTaken) return;
    if (step === 0 && mode === 'ftb' && ftbPick === undefined) {
      setFtbError(t('web:install.ftb.required'));
      return;
    }
    // Une archive dont le panel n'a pas reconnu le chargeur n'avance pas : il ne devine pas.
    if (step === 0 && mode === 'archive' && (archivePick?.inspection.recognized ?? null) === null) {
      setArchiveError(t('web:install.archive.required'));
      return;
    }
    if (step === 0 && mode === 'plain' && form.validateField('mcVersion').hasError) return;
    if (step === 0) {
      // Le dossier se propose d'après ce qu'on vient de choisir, tant qu'on n'y a pas touché.
      if (form.values.folderName === suggestedFolder.current) {
        const proposal = suggestFolderName(sourceName(), takenFolders, caseSensitive);
        suggestedFolder.current = proposal;
        form.setFieldValue('folderName', proposal);
      }
      setStep(1);
      return;
    }
    // Dernier pas avant l'engagement : on demande à la machine ce qu'elle en pense.
    if (step === 1) {
      check(() => {
        setStep(2);
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

  // Le pré-contrôle ne bloque pas : il prévient, en nommant ce qui cloche. Java a sa propre carte,
  // avec de quoi le régler.
  const problems: string[] = [];
  if (precheck !== undefined) {
    if (!precheck.path.ok) problems.push(t('web:install.problemPath'));
    if (!precheck.port.ok) problems.push(t('web:install.problemPort'));
    if (!precheck.disk.ok) problems.push(t('web:install.problemDisk'));
  }
  const javaMissing = precheck !== undefined && !precheck.java.ok;
  const javaMajor = precheck?.target.javaMajor ?? undefined;

  // La mémoire suit ce que l'assistant propose tant que l'utilisateur ne l'a pas réglée lui-même.
  const suggestRam = (value: number) => {
    if (form.values.maxRamMb === suggestedRam.current) form.setFieldValue('maxRamMb', value);
    suggestedRam.current = value;
  };

  const changeLoader = (value: InstallLoader) => {
    suggestRam(DEFAULT_RAM_MB[value]);
    form.setFieldValue('loader', value);
    form.setFieldValue('mcVersion', '');
  };

  const changeSource = (value: string) => {
    setArchivePick(undefined);
    setArchiveError(undefined);
    if (value === 'archive') {
      setMode('archive');
      setFtbPick(undefined);
      form.setFieldValue('mcVersion', '');
      return;
    }
    if (value === 'ftb') {
      setMode('ftb');
      setFtbPick(undefined);
      form.setFieldValue('mcVersion', '');
      return;
    }
    setMode('plain');
    setFtbPick(undefined);
    setFtbError(undefined);
    changeLoader(value as InstallLoader);
  };

  const pickFtb = (selection: FtbSelection | undefined) => {
    setFtbPick(selection);
    setFtbError(undefined);
    if (selection === undefined) return;
    const { version } = selection;
    // Le pack fait autorité : le panel le relira de toute façon, mais le récapitulatif et le
    // pré-contrôle (Java, place) doivent parler du bon chargeur dès maintenant.
    if (version.loader !== null) form.setFieldValue('loader', version.loader);
    if (version.mcVersion !== null) form.setFieldValue('mcVersion', version.mcVersion);
    suggestRam(version.ramRecommendedMb ?? DEFAULT_RAM_MB[version.loader ?? 'neoforge']);
  };

  const pickArchive = (selection: ArchiveSelection | undefined) => {
    setArchivePick(selection);
    setArchiveError(undefined);
    const declared = selection?.inspection.recognized ?? null;
    if (selection === undefined || declared === null) return;
    // L'archive fait autorité (le panel la relira) : récapitulatif et pré-contrôle parlent d'elle.
    form.setFieldValue('loader', declared.loader);
    form.setFieldValue('mcVersion', declared.mcVersion);
    suggestRam(
      selection.inspection.hasMods ? ARCHIVE_MODDED_RAM_MB : DEFAULT_RAM_MB[declared.loader],
    );
  };

  return (
    <Modal opened={opened} onClose={close} title={t('web:install.title')} size="lg">
      <Stack gap="md">
        <Stepper active={step} size="sm" allowNextStepsSelect={false}>
          <Stepper.Step label={t('web:install.stepVersion')} />
          <Stepper.Step label={t('web:install.stepPlace')} />
          <Stepper.Step label={t('web:install.stepConfirm')} />
        </Stepper>

        {step === 1 && (
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
              error={folderTaken ? t('web:install.folderTaken') : form.errors.folderName}
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

        {step === 0 && (
          <Stack gap="sm">
            <SegmentedControl
              fullWidth
              data={[
                { value: 'vanilla', label: t('web:install.loaderVanilla') },
                { value: 'fabric', label: t('web:install.loaderFabric') },
                { value: 'forge', label: t('web:install.loaderForge') },
                { value: 'neoforge', label: t('web:install.loaderNeoForge') },
                // Intégration FTB : proposée seulement si elle est activée (Réglages → Services tiers).
                ...(ftbAvailable ? [{ value: 'ftb', label: t('web:install.loaderFtb') }] : []),
                { value: 'archive', label: t('web:install.loaderArchive') },
              ]}
              data-testid="install-loader"
              value={mode === 'plain' ? form.values.loader : mode}
              onChange={changeSource}
            />
            <Text size="sm" c="dimmed" data-testid="install-loader-hint">
              {mode === 'plain'
                ? t(`web:install.loaderHint.${form.values.loader}`)
                : t(`web:install.loaderHint.${mode}`)}
            </Text>
            {mode === 'ftb' && (
              <FtbPackPicker value={ftbPick} onChange={pickFtb} error={ftbError} />
            )}
            {mode === 'archive' && (
              <ArchivePicker
                machineId={machine.id}
                directories={directories}
                value={archivePick}
                onChange={pickArchive}
                error={archiveError}
              />
            )}
            {mode === 'plain' && (
              <>
                <NativeSelect
                  label={t('web:install.version')}
                  disabled={catalog.isPending}
                  data={[
                    { value: '', label: catalog.isPending ? t('web:common.loading') : '—' },
                    ...groups.map((g) => ({
                      group:
                        g.series === undefined
                          ? t('web:install.unstableGroup')
                          : t('web:install.seriesGroup', { series: g.series }),
                      items: g.items.map((v) => ({
                        value: v.id,
                        label: v.stable ? v.id : `${v.id} (${t('web:install.snapshot')})`,
                      })),
                    })),
                  ]}
                  data-testid="install-version"
                  {...form.getInputProps('mcVersion')}
                />
                {selected?.loaderVersion !== undefined && (
                  <Text size="sm" data-testid="install-loader-version">
                    {t('web:install.loaderBuild', {
                      loader: LOADER_LABELS[form.values.loader],
                      version: selected.loaderVersion,
                    })}
                  </Text>
                )}
                <Switch
                  label={t('web:install.showUnstable')}
                  checked={showUnstable}
                  data-testid="install-show-unstable"
                  onChange={(e) => {
                    setShowUnstable(e.currentTarget.checked);
                  }}
                />
                <ErrorAlert error={catalog.error} />
                <Text size="xs" c="dimmed">
                  {t('web:install.versionHint')}
                </Text>
              </>
            )}
          </Stack>
        )}

        {step === 2 && (
          <Stack gap="sm">
            <Card withBorder radius="sm" padding="sm">
              <Stack gap={4}>
                <Summary
                  label={t('web:install.finalPath')}
                  value={precheck?.target.path ?? fullPath}
                />
                <Summary
                  label={t('web:install.version')}
                  value={`${
                    mode === 'ftb' && ftbPick !== undefined
                      ? `${ftbPick.pack.name} ${ftbPick.version.name} — `
                      : mode === 'archive' && archivePick !== undefined
                        ? `${archivePick.archive.name} — `
                        : ''
                  }${LOADER_LABELS[form.values.loader]} ${form.values.mcVersion}${
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
                {javaMajor !== undefined && (
                  <Summary label={t('web:install.java')} value={`Java ${String(javaMajor)}`} />
                )}
              </Stack>
            </Card>
            {javaMissing && (
              <Alert
                color="orange"
                icon={<IconCoffee size={16} />}
                title={
                  javaMajor === undefined
                    ? t('web:install.javaMissingAny')
                    : t('web:install.javaMissing', { major: javaMajor })
                }
                data-testid="install-java-missing"
              >
                <Stack gap="xs">
                  <Text size="sm">{t('web:install.javaMissingHint')}</Text>
                  {javaTasks.map((task) => (
                    <TaskProgressRow key={task.id} task={task} compact />
                  ))}
                  {isAdmin && javaMajor !== undefined && !javaRunning && (
                    <Group>
                      <Button
                        size="xs"
                        leftSection={<IconCoffee size={14} />}
                        loading={installJava.isPending}
                        data-testid="install-java-button"
                        onClick={() => {
                          installJava.mutate({ majorVersion: javaMajor, relay: false });
                        }}
                      >
                        {t('web:install.installJava', { major: javaMajor })}
                      </Button>
                    </Group>
                  )}
                  {!isAdmin && <Text size="sm">{t('web:install.javaAskAdmin')}</Text>}
                  <ErrorAlert error={installJava.error} />
                </Stack>
              </Alert>
            )}
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
          {step < 2 ? (
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
