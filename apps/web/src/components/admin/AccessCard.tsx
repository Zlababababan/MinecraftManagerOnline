/**
 * Phase 10 — réglages admin : couche d'accès (doc 03 §5). Mode tailscale (commande `tailscale serve`),
 * direct (domaine, fournisseur DNS, certificat ACME DNS-01 avec TXT manuel affiché, DynDNS, règles
 * pare-feu), manuel ; test de joignabilité HTTP + WS + frames binaires par l'URL publique.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconShieldCheck, IconShieldX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import type {
  AccessMode,
  AccessStatusDto,
  AccessTestResult,
  DnsProvider,
} from '@mmo/protocol/client';

import {
  useAccessStatus,
  useAccessTest,
  useFirewallRules,
  useIssueCertificate,
  useSettings,
  useUpdateDynDns,
  useUpdateSettings,
  type SettingsPatch,
} from '../../api/phase10.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';

const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

function CommandBlock({ command, testId }: { command: string; testId: string }) {
  const { t } = useT();
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Code
        block
        style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        data-testid={testId}
      >
        {command}
      </Code>
      <CopyButton value={command}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? t('web:access.copied') : t('web:access.copyCommand')}>
            <Button
              type="button"
              size="compact-xs"
              variant="light"
              leftSection={<IconCopy size={14} />}
              onClick={copy}
            >
              {t('web:access.copyCommand')}
            </Button>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

function TestResult({ result }: { result: AccessTestResult }) {
  const { t, i18n } = useT();
  const rows: [string, boolean, string | null][] = [
    [
      t('web:access.test.http'),
      result.http.ok,
      result.http.error ??
        (result.http.status === null
          ? null
          : `HTTP ${String(result.http.status)} · ${String(result.http.ms)} ms`),
    ],
    [t('web:access.test.ws'), result.ws.ok, result.ws.error ?? `${String(result.ws.ms)} ms`],
    [
      t('web:access.test.binary'),
      result.binary.ok,
      result.binary.error ?? `${String(result.binary.bytes)} B`,
    ],
    [t('web:access.test.tls'), result.tls.ok, result.tls.error ?? result.tls.issuer],
  ];
  return (
    <Stack gap={4} data-testid="access-test-result" data-ok={result.ok}>
      <Alert
        color={result.ok ? 'teal' : 'red'}
        icon={result.ok ? <IconShieldCheck size={18} /> : <IconShieldX size={18} />}
      >
        {result.ok
          ? t('web:access.test.allGood', { url: result.url })
          : t('web:access.test.someFailed', { url: result.url })}
      </Alert>
      <Table withRowBorders={false} verticalSpacing={2}>
        <Table.Tbody>
          {rows.map(([label, ok, detail]) => (
            <Table.Tr key={label}>
              <Table.Td>{label}</Table.Td>
              <Table.Td>
                <Badge color={ok ? 'teal' : 'red'} size="sm" variant="light">
                  {ok ? t('web:access.test.ok') : t('web:access.test.failed')}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {detail ?? ''}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
          {result.via !== null && (
            <Table.Tr>
              <Table.Td>{t('web:access.test.via')}</Table.Td>
              <Table.Td colSpan={2}>
                <Text size="xs" data-testid="access-test-via">
                  {i18n.exists(`web:access.requestVia.${result.via}`)
                    ? tDynamic(i18n, `web:access.requestVia.${result.via}`)
                    : result.via}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function DirectSection({
  status,
  settings,
}: {
  status: AccessStatusDto;
  settings: Record<string, string>;
}) {
  const { t, i18n } = useT();
  const update = useUpdateSettings();
  const issue = useIssueCertificate();
  const dyn = useUpdateDynDns();
  const firewall = useFirewallRules(true);
  const d = status.direct;
  const form = useForm({
    initialValues: {
      domain: settings['access.domain'] ?? '',
      httpsPort: settings['access.httpsPort'] ?? '443',
      publicHost: settings['access.publicHost'] ?? '',
      provider: (settings['access.dns.provider'] ?? 'manual') as DnsProvider,
      token: '',
      zone: settings['access.dns.zone'] ?? '',
      updateUrl: settings['access.dns.updateUrl'] ?? '',
      acmeEmail: settings['access.acme.email'] ?? '',
      staging: settings['access.acme.directory'] === LE_STAGING,
      dyndns: settings['access.dyndns.enabled'] === 'true',
    },
  });
  const tokenSet = settings['access.dns.token.set'] === 'true';

  const save = (values: typeof form.values): void => {
    const patch: SettingsPatch = {
      'access.domain': values.domain.trim(),
      'access.httpsPort': values.httpsPort.trim() || '443',
      'access.publicHost': values.publicHost.trim(),
      'access.dns.provider': values.provider,
      'access.dns.zone': values.zone.trim(),
      'access.dns.updateUrl': values.updateUrl.trim(),
      'access.acme.email': values.acmeEmail.trim(),
      'access.acme.directory': values.staging ? LE_STAGING : '',
      'access.dyndns.enabled': values.dyndns ? 'true' : 'false',
    };
    if (values.token.trim() !== '') patch['access.dns.token'] = values.token.trim();
    update.mutate(patch, {
      onSuccess: () => {
        form.setFieldValue('token', '');
        notifications.show({ color: 'teal', message: t('web:settings.saved') });
      },
      onError: (error) => {
        notifications.show({ color: 'red', message: describeError(i18n, error) });
      },
    });
  };

  return (
    <Stack gap="md" data-testid="access-direct">
      <form onSubmit={form.onSubmit(save)}>
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('web:access.direct.domain')}
              description={t('web:access.direct.domainHint')}
              {...form.getInputProps('domain')}
              data-testid="access-domain"
            />
            <TextInput
              label={t('web:access.direct.httpsPort')}
              {...form.getInputProps('httpsPort')}
              data-testid="access-https-port"
            />
            <TextInput
              label={t('web:access.direct.publicHost')}
              description={t('web:access.direct.publicHostHint')}
              {...form.getInputProps('publicHost')}
            />
            <Select
              label={t('web:access.direct.dnsProvider')}
              allowDeselect={false}
              data={(['manual', 'duckdns', 'cloudflare', 'generic'] as DnsProvider[]).map((p) => ({
                value: p,
                label: tDynamic(i18n, `web:access.direct.providers.${p}`),
              }))}
              {...form.getInputProps('provider')}
              data-testid="access-dns-provider"
            />
            {form.values.provider !== 'manual' && (
              <PasswordInput
                label={t('web:access.direct.token')}
                description={tokenSet ? t('web:access.direct.tokenSet') : undefined}
                autoComplete="off"
                {...form.getInputProps('token')}
                data-testid="access-dns-token"
              />
            )}
            {form.values.provider === 'cloudflare' && (
              <TextInput label={t('web:access.direct.zone')} {...form.getInputProps('zone')} />
            )}
            {form.values.provider === 'generic' && (
              <TextInput
                label={t('web:access.direct.updateUrl')}
                description={t('web:access.direct.updateUrlHint')}
                {...form.getInputProps('updateUrl')}
              />
            )}
            <TextInput
              label={t('web:access.direct.acmeEmail')}
              type="email"
              {...form.getInputProps('acmeEmail')}
            />
          </SimpleGrid>
          <Switch
            label={t('web:access.direct.acmeStaging')}
            {...form.getInputProps('staging', { type: 'checkbox' })}
          />
          <Switch
            label={t('web:access.direct.dyndnsEnabled')}
            disabled={form.values.provider === 'manual'}
            {...form.getInputProps('dyndns', { type: 'checkbox' })}
            data-testid="access-dyndns-enabled"
          />
          <Group justify="flex-end">
            <Button
              type="submit"
              size="xs"
              loading={update.isPending}
              data-testid="access-direct-save"
            >
              {t('web:common.save')}
            </Button>
          </Group>
        </Stack>
      </form>

      <Stack gap="xs">
        <Title order={5}>{t('web:access.direct.certificate')}</Title>
        {d?.certificate ? (
          <Text
            size="sm"
            {...(d.certificate.daysLeft < 14 ? { c: 'yellow' } : {})}
            data-testid="access-certificate"
          >
            {t('web:access.direct.certValid', {
              date: formatDateTime(d.certificate.validTo, i18n.language),
              days: Math.floor(d.certificate.daysLeft),
              issuer: d.certificate.issuer,
            })}
            {d.certificate.daysLeft < 14 ? ` — ${t('web:access.direct.certExpiring')}` : ''}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" data-testid="access-no-certificate">
            {t('web:access.direct.noCertificate')}
          </Text>
        )}
        <Text size="sm">
          {t('web:access.https')} :{' '}
          {status.https.listening
            ? t('web:access.listening', { port: status.https.port ?? 0 })
            : t('web:access.notListening')}
        </Text>
        {d?.pendingChallenge && (
          <Alert color="blue" data-testid="access-pending-challenge">
            <Stack gap={4}>
              <Text size="sm">{t('web:access.direct.pendingChallenge')}</Text>
              <Text size="xs">
                {t('web:access.direct.challengeName')} : <Code>{d.pendingChallenge.name}</Code>
              </Text>
              <Text size="xs">
                {t('web:access.direct.challengeValue')} : <Code>{d.pendingChallenge.value}</Code>
              </Text>
            </Stack>
          </Alert>
        )}
        {d?.certificateError && (
          <Text size="xs" c="red" data-testid="access-certificate-error">
            {t('web:access.direct.certificateError')} : {d.certificateError}
          </Text>
        )}
        <Group>
          <Button
            type="button"
            size="xs"
            loading={issue.isPending}
            disabled={!settings['access.domain']}
            onClick={() => {
              issue.mutate(undefined, {
                onSuccess: () => {
                  notifications.show({ color: 'teal', message: t('web:access.direct.issued') });
                },
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              });
            }}
            data-testid="access-issue-certificate"
          >
            {issue.isPending
              ? t('web:access.direct.issuing')
              : d?.certificate
                ? t('web:access.direct.renew')
                : t('web:access.direct.issue')}
          </Button>
        </Group>
      </Stack>

      <Stack gap="xs">
        <Title order={5}>{t('web:access.direct.dyndns')}</Title>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
          <Text size="sm">
            {t('web:access.direct.currentAddress')} : <Code>{d?.dyndns.currentAddress ?? '—'}</Code>
          </Text>
          <Text size="sm">
            {t('web:access.direct.publishedAddress')} :{' '}
            <Code data-testid="access-published">{d?.dyndns.publishedAddress ?? '—'}</Code>
          </Text>
          <Text size="sm">
            {t('web:access.direct.lastUpdate')} :{' '}
            {formatDateTime(d?.dyndns.lastUpdateAt, i18n.language)}
          </Text>
        </SimpleGrid>
        {d?.dyndns.lastError && (
          <Text size="xs" c="red">
            {t('web:access.direct.dyndnsError')} : {d.dyndns.lastError}
          </Text>
        )}
        <Group>
          <Button
            type="button"
            size="xs"
            variant="default"
            loading={dyn.isPending}
            disabled={
              !settings['access.domain'] ||
              (settings['access.dns.provider'] ?? 'manual') === 'manual'
            }
            onClick={() => {
              dyn.mutate(undefined, {
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              });
            }}
            data-testid="access-dyndns-now"
          >
            {t('web:access.direct.dyndnsNow')}
          </Button>
        </Group>
      </Stack>

      <Stack gap="xs">
        <Title order={5}>{t('web:access.direct.firewall')}</Title>
        <Text size="xs" c="dimmed">
          {t('web:access.direct.firewallHint')}
        </Text>
        {firewall.data?.rules.panel && (
          <Stack gap={4}>
            <Text size="sm">
              {t('web:access.direct.firewallPanel', {
                os: firewall.data.rules.panel.os,
                port: firewall.data.rules.panel.port,
              })}
            </Text>
            {firewall.data.rules.panel.commands.map((c) => (
              <CommandBlock key={c} command={c} testId="firewall-panel" />
            ))}
          </Stack>
        )}
        {firewall.data?.rules.servers.length === 0 && (
          <Text size="xs" c="dimmed">
            {t('web:access.direct.firewallNone')}
          </Text>
        )}
        {firewall.data?.rules.servers.map((s) => (
          <Stack key={s.serverId} gap={4}>
            <Text size="sm">
              {s.name} · {s.machineName} ({s.os ?? '?'}, {String(s.port ?? '')})
            </Text>
            {s.commands.map((c) => (
              <CommandBlock key={c} command={c} testId={`firewall-${s.serverId}`} />
            ))}
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

export function AccessCard() {
  const { t, i18n } = useT();
  const status = useAccessStatus();
  const settings = useSettings();
  const update = useUpdateSettings();
  const test = useAccessTest();
  const [publicUrl, setPublicUrl] = useState<string | undefined>(undefined);
  const s = status.data?.access;
  const current = settings.data?.settings['panel.publicUrl'] ?? '';
  useEffect(() => {
    if (publicUrl === undefined && settings.data !== undefined) setPublicUrl(current);
  }, [publicUrl, settings.data, current]);

  if (s === undefined || settings.data === undefined) return null;
  const mode: AccessMode = s.mode;

  return (
    <Card withBorder radius="md" padding="md" data-testid="access-card">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={4}>{t('web:access.title')}</Title>
          <Badge variant="light" data-testid="access-request-via">
            {t('web:access.requestVia.label')}{' '}
            {tDynamic(i18n, `web:access.requestVia.${s.requestVia}`)}
          </Badge>
        </Group>
        <Select
          label={t('web:access.mode')}
          value={mode}
          allowDeselect={false}
          data={(['tailscale', 'direct', 'manual'] as AccessMode[]).map((m) => ({
            value: m,
            label: tDynamic(i18n, `web:access.modes.${m}`),
          }))}
          onChange={(value) => {
            if (value === 'tailscale' || value === 'direct' || value === 'manual') {
              update.mutate(
                { 'access.mode': value },
                {
                  onError: (error) => {
                    notifications.show({ color: 'red', message: describeError(i18n, error) });
                  },
                },
              );
            }
          }}
          data-testid="access-mode"
        />
        <Text size="sm" c="dimmed" data-testid="access-mode-hint">
          {tDynamic(i18n, `web:access.modeHint.${mode}`, {
            host: s.listen.host,
            port: s.listen.port,
          })}
        </Text>
        {mode === 'tailscale' && s.tailscaleServeCommand !== null && (
          <CommandBlock command={s.tailscaleServeCommand} testId="tailscale-serve-command" />
        )}
        {mode === 'direct' && <DirectSection status={s} settings={settings.data.settings} />}

        <Stack gap="xs">
          <Title order={5}>{t('web:access.test.title')}</Title>
          <Text size="xs" c="dimmed">
            {t('web:access.test.hint')}
          </Text>
          <Group align="flex-end" gap="sm">
            <TextInput
              label={t('web:settings.general.publicUrl')}
              value={publicUrl ?? ''}
              onChange={(e) => {
                setPublicUrl(e.currentTarget.value);
              }}
              style={{ flex: 1 }}
              placeholder="https://panel.example.org"
              data-testid="access-test-url"
            />
            <Button
              type="button"
              size="sm"
              loading={test.isPending}
              disabled={!publicUrl}
              onClick={() => {
                const url = (publicUrl ?? '').trim().replace(/\/+$/, '');
                if (url === '') return;
                const run = (): void => {
                  test.mutate(url, {
                    onError: (error) => {
                      notifications.show({ color: 'red', message: describeError(i18n, error) });
                    },
                  });
                };
                if (url !== current)
                  update.mutate({ 'panel.publicUrl': url }, { onSuccess: run, onError: run });
                else run();
              }}
              data-testid="access-test-run"
            >
              {test.isPending ? t('web:access.test.running') : t('web:access.test.run')}
            </Button>
          </Group>
          {test.data !== undefined && <TestResult result={test.data.result} />}
          {test.data === undefined && s.lastTest !== null && (
            <Text size="xs" c="dimmed" data-testid="access-last-test">
              {t('web:access.test.last')} : {formatDateTime(s.lastTest.at, i18n.language)} ·{' '}
              {s.lastTest.ok ? t('web:access.test.ok') : t('web:access.test.failed')}
            </Text>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
