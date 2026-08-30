/**
 * Éditeur `server.properties` expliqué champ par champ (doc 06 §7) : clés connues typées et
 * groupées par catégorie (libellé + aide i18n), clés inconnues préservées et éditées en texte,
 * patch minimal envoyé à l'agent (`config.set`), `expectedSha256` contre l'édition concurrente,
 * `restartRequired` affiché quand le serveur tourne.
 */
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import type { ServerDto } from '@mmo/protocol/client';

import { useConfigFile, useMe, useServerAction, useSetConfig } from '../../api/queries.js';
import { tDynamic } from '../../i18n/index.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';
import {
  PROPERTY_BY_KEY,
  diffProperties,
  groupProperties,
  normalizeValue,
  propertyI18nKey,
  validateValue,
  type PropertySpec,
} from '../../lib/properties-catalog.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function Field({
  spec,
  value,
  present,
  onChange,
  readOnly,
}: {
  spec: PropertySpec;
  value: string;
  present: boolean;
  onChange: (value: string) => void;
  readOnly: boolean;
}) {
  const { t, i18n } = useT();
  const k = propertyI18nKey(spec.key);
  const label = tDynamic(i18n, `web:properties.keys.${k}.label`);
  const help = tDynamic(i18n, `web:properties.keys.${k}.help`);
  const error = present || value !== '' ? validateValue(spec, value) : undefined;
  const description = (
    <span>
      {help}
      {spec.default !== undefined && (
        <>
          {' '}
          <Text span size="xs" c="dimmed">
            (
            {t('web:properties.default', {
              value: spec.default === '' ? t('web:properties.empty') : spec.default,
            })}
            )
          </Text>
        </>
      )}
    </span>
  );
  const disabled = readOnly || spec.managed === true;
  const common = {
    label: (
      <Group gap={6} component="span">
        <span>{label}</span>
        <Text span size="xs" c="dimmed" ff="monospace">
          {spec.key}
        </Text>
        {spec.managed && (
          <Badge size="xs" variant="light">
            {t('web:properties.managed')}
          </Badge>
        )}
      </Group>
    ),
    description,
    'data-testid': `prop-${spec.key}`,
    disabled,
  };
  const errorText = error === undefined ? undefined : t(`web:properties.errors.${error}` as never);
  switch (spec.type.kind) {
    case 'boolean':
      return (
        <Switch
          {...common}
          checked={normalizeValue(spec, value) === 'true'}
          onChange={(e) => {
            onChange(e.currentTarget.checked ? 'true' : 'false');
          }}
        />
      );
    case 'int':
      return (
        <NumberInput
          {...common}
          value={value === '' ? '' : Number(value)}
          onChange={(v) => {
            onChange(v === '' ? '' : String(v));
          }}
          {...(spec.type.min === undefined ? {} : { min: spec.type.min })}
          {...(spec.type.max === undefined ? {} : { max: spec.type.max })}
          allowDecimal={false}
          error={errorText}
        />
      );
    case 'enum':
      return (
        <Select
          {...common}
          data={spec.type.values.map((v) => ({ value: v, label: v }))}
          value={spec.type.values.includes(value) ? value : null}
          onChange={(v) => {
            onChange(v ?? '');
          }}
          error={errorText}
          allowDeselect={false}
        />
      );
    case 'string':
      if (spec.type.secret) {
        return (
          <PasswordInput
            {...common}
            value={value}
            onChange={(e) => {
              onChange(e.currentTarget.value);
            }}
          />
        );
      }
      if (spec.type.long) {
        return (
          <Textarea
            {...common}
            value={value}
            autosize
            minRows={1}
            onChange={(e) => {
              onChange(e.currentTarget.value);
            }}
          />
        );
      }
      return (
        <TextInput
          {...common}
          value={value}
          onChange={(e) => {
            onChange(e.currentTarget.value);
          }}
        />
      );
  }
}

export function PropertiesEditor({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const query = useConfigFile(server.id, 'server.properties');
  const save = useSetConfig(server.id, 'server.properties');
  const restart = useServerAction(server.id);
  const canEdit =
    me.data !== undefined && hasRole(me.data.user.role, 'operator') && server.reachable;
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [newKey, setNewKey] = useState('');
  const [restartNeeded, setRestartNeeded] = useState(false);

  const original = query.data?.data ?? {};
  const current = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(original)) if (edits[k] !== null) out[k] = v;
    for (const [k, v] of Object.entries(edits)) if (v !== null) out[k] = v;
    return out;
  }, [original, edits]);
  const patch = useMemo(() => diffProperties(original, current), [original, current]);
  const changes = Object.keys(patch).length;
  const invalid = Object.entries(current).some(([k, v]) => {
    const spec = PROPERTY_BY_KEY.get(k);
    return spec !== undefined && validateValue(spec, v) !== undefined;
  });

  if (query.isPending) return <Loader size="sm" />;
  if (query.error) return <ErrorAlert error={query.error} />;
  const sha = query.data.sha256;
  const { categories, unknown } = groupProperties(current);
  const set = (key: string, value: string | null) => {
    setEdits((e) => ({ ...e, [key]: value }));
  };
  const submit = () => {
    save.mutate(
      { data: patch, ...(sha === undefined ? {} : { expectedSha256: sha }) },
      {
        onSuccess: (res) => {
          setEdits({});
          setRestartNeeded(res.restartRequired);
          notifications.show({ color: 'teal', message: t('web:properties.saved') });
          for (const w of res.warnings ?? []) {
            notifications.show({
              color: 'yellow',
              message: tDynamic(i18n, `web:server.players.warnings.${w}`),
            });
          }
        },
        onError: (error) => {
          notifications.show({ color: 'red', message: describeError(i18n, error) });
        },
      },
    );
  };

  return (
    <Stack gap="md" data-testid="properties-editor">
      <Text size="sm" c="dimmed">
        {t('web:properties.intro')}
      </Text>
      {Object.keys(original).length === 0 && (
        <Alert color="blue" variant="light">
          {t('web:properties.noFile')}
        </Alert>
      )}
      {(restartNeeded || (server.runState === 'running' && changes > 0)) && (
        <Alert color="yellow" variant="light" data-testid="properties-restart">
          <Group justify="space-between" wrap="wrap">
            <Text size="sm">{t('web:properties.restartRequired')}</Text>
            {restartNeeded && canEdit && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconRefresh size={14} />}
                loading={restart.isPending}
                onClick={() => {
                  restart.mutate(
                    { action: 'restart' },
                    {
                      onSuccess: () => {
                        setRestartNeeded(false);
                      },
                      onError: (error) => {
                        notifications.show({ color: 'red', message: describeError(i18n, error) });
                      },
                    },
                  );
                }}
              >
                {t('web:properties.restartNow')}
              </Button>
            )}
          </Group>
        </Alert>
      )}
      <Accordion multiple defaultValue={['general', 'players']} variant="separated">
        {categories.map(({ category, specs }) => (
          <Accordion.Item key={category} value={category}>
            <Accordion.Control data-testid={`properties-cat-${category}`}>
              {t(`web:properties.categories.${category}`)}
            </Accordion.Control>
            <Accordion.Panel>
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                {specs.map((spec) => (
                  <Field
                    key={spec.key}
                    spec={spec}
                    value={current[spec.key] ?? ''}
                    present={spec.key in current}
                    readOnly={!canEdit}
                    onChange={(v) => {
                      set(spec.key, v);
                    }}
                  />
                ))}
              </SimpleGrid>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
        <Accordion.Item value="unknown">
          <Accordion.Control data-testid="properties-cat-unknown">
            {t('web:properties.unknownKeys')}{' '}
            <Text span size="xs" c="dimmed">
              ({unknown.length})
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                {t('web:properties.unknownHint')}
              </Text>
              {unknown.map((key) => (
                <Group key={key} gap="xs" align="flex-end" wrap="nowrap">
                  <TextInput
                    label={key}
                    value={current[key] ?? ''}
                    disabled={!canEdit}
                    style={{ flex: 1 }}
                    {...TECHNICAL_INPUT_PROPS}
                    data-testid={`prop-${key}`}
                    onChange={(e) => {
                      set(key, e.currentTarget.value);
                    }}
                  />
                  {canEdit && (
                    <Tooltip label={t('web:properties.removeKey')}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={t('web:properties.removeKey')}
                        onClick={() => {
                          set(key, null);
                        }}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              ))}
              {canEdit && (
                <Group gap="xs" align="flex-end">
                  <TextInput
                    label={t('web:properties.keyName')}
                    value={newKey}
                    onChange={(e) => {
                      setNewKey(e.currentTarget.value);
                    }}
                    error={
                      newKey !== '' && !KEY_PATTERN.test(newKey)
                        ? t('web:properties.errors.key')
                        : undefined
                    }
                    {...TECHNICAL_INPUT_PROPS}
                    data-testid="properties-new-key"
                  />
                  <Button
                    type="button"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    disabled={!KEY_PATTERN.test(newKey) || newKey in current}
                    onClick={() => {
                      set(newKey, '');
                      setNewKey('');
                    }}
                  >
                    {t('web:properties.addKey')}
                  </Button>
                </Group>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      {canEdit && (
        <Group justify="flex-end" gap="sm" style={{ position: 'sticky', bottom: 0 }}>
          <Text size="xs" c="dimmed" data-testid="properties-changes">
            {t('web:properties.changes', { count: changes })}
          </Text>
          <Button
            type="button"
            variant="subtle"
            disabled={changes === 0}
            onClick={() => {
              setEdits({});
            }}
          >
            {t('web:properties.reset')}
          </Button>
          <Button
            type="button"
            disabled={changes === 0 || invalid}
            loading={save.isPending}
            onClick={submit}
            data-testid="properties-save"
          >
            {t('web:common.save')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
