/**
 * Console d'un serveur : xterm (lecture seule, rattrapage par `seq`), abonnement `console:<id>` via
 * `/ws/client` (snapshot + lignes), saisie de commandes (`POST /api/servers/:id/command`) avec
 * historique ↑/↓ et complétion Tab (V1). Un miroir textuel caché expose les dernières lignes
 * (accessibilité + tests e2e, xterm rendant sur une grille de cellules).
 * Historique : la fin de `logs/latest.log` est préchargée en tête (les lignes live arrivées
 * pendant la lecture sont mises en attente puis rejouées) — indispensable en mode détaché, où le
 * tampon console repart vide à chaque redémarrage de l'agent.
 */
import { ActionIcon, Box, Group, Paper, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconSend, IconTrash } from '@tabler/icons-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../i18n/hooks.js';

import type { ConsoleLine } from '@mmo/protocol';
import { consoleChannel, type ServerMessage } from '@mmo/protocol/client';

import { fileDownloadUrl } from '../../api/phase8.js';
import {
  commandHistoryQuery,
  fileReadQuery,
  serverCommandsQuery,
  useSendCommand,
} from '../../api/queries.js';
import { describeError } from '../../lib/errors.js';
import { realtime, type RealtimeClient } from '../../ws/client.js';
import { CommandSignature } from './CommandSignature.js';
import { MacroBar } from './MacroBar.js';
import {
  CommandHistory,
  complete,
  recentVerbs,
  signature,
  type CompletionContext,
  type Suggestion,
} from './commands.js';

import '@xterm/xterm/css/xterm.css';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';

const MIRROR_LINES = 200;
const LOG_FILE = 'logs/latest.log';
const HISTORY_LINES = 200;

/** Dernières lignes non vides d'un contenu de log, pour le préchargement de la console. */
export function historyLines(content: string, max = HISTORY_LINES): string[] {
  return content
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .slice(-max);
}

const LEVEL_STYLE: Record<ConsoleLine['level'], string> = {
  TRACE: '\x1b[2m',
  DEBUG: '\x1b[2m',
  INFO: '',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  FATAL: '\x1b[1;31m',
};

export function formatConsoleLine(line: ConsoleLine): string {
  const time = new Date(line.ts).toTimeString().slice(0, 8);
  const style = LEVEL_STYLE[line.level];
  return `\x1b[90m${time}\x1b[0m ${style}${line.text}${style === '' ? '' : '\x1b[0m'}`;
}

export interface ConsolePanelProps {
  serverId: string;
  canSend: boolean;
  loader?: string;
  players?: readonly string[];
  /** État courant : on n'interroge un serveur sur ses commandes que s'il tourne. */
  runState?: string;
  /** Client temps réel (tests) — défaut : instance de l'application. */
  client?: RealtimeClient;
  /** Hauteur CSS du terminal. */
  height?: string | number;
}

export function ConsolePanel({
  serverId,
  canSend,
  loader,
  players,
  runState,
  client = realtime,
  height = 'min(60vh, 520px)',
}: ConsolePanelProps) {
  const { t, i18n } = useT();
  const colorScheme = useComputedColorScheme('dark');
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const lastSeqRef = useRef(-1);
  // Miroir lisible par lecteur d'écran : une entrée PAR LIGNE avec un id stable, pour qu'une
  // région `role="log"` n'annonce que les additions (un nœud texte unique serait ré-annoncé entier).
  const [mirror, setMirror] = useState<{ id: number; text: string }[]>([]);
  const mirrorIdRef = useRef(0);
  const toMirror = (texts: string[]): { id: number; text: string }[] =>
    texts.map((text) => ({ id: mirrorIdRef.current++, text }));
  const [truncated, setTruncated] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const historyQuery = useQuery({ ...commandHistoryQuery(serverId), enabled: canSend });
  /**
   * Commandes réellement acceptées par CE serveur. Interrogé seulement quand ça a un sens : un
   * serveur arrêté refusera, et un lecteur n'a pas le droit d'envoyer de commande.
   */
  const commandsQuery = useQuery({
    ...serverCommandsQuery(serverId),
    enabled: canSend && runState === 'running',
  });
  const send = useSendCommand(serverId);
  const history = useMemo(() => new CommandHistory(), []);
  const seededRef = useRef(false);
  // Historique de `logs/latest.log` : tant qu'il n'est pas écrit, les lignes live sont en attente.
  const historyDoneRef = useRef(false);
  const pendingRef = useRef<ConsoleLine[]>([]);
  const flushRef = useRef<() => void>(() => undefined);
  const logHistory = useQuery({
    ...fileReadQuery(serverId, LOG_FILE),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Historique serveur (ordre antéchronologique) → amorce de l'historique local, une seule fois.
  useEffect(() => {
    if (seededRef.current || historyQuery.data === undefined) return;
    seededRef.current = true;
    history.seed([...historyQuery.data.history].reverse().map((h) => h.command));
  }, [historyQuery.data, history]);

  // Terminal xterm : création, ajustement à la taille, thème.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorStyle: 'underline',
      cursorInactiveStyle: 'none',
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // conteneur pas encore mesurable
      }
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme =
      colorScheme === 'dark'
        ? { background: '#141517', foreground: '#d8dee9', cursor: '#d8dee9' }
        : { background: '#ffffff', foreground: '#1a1b1e', cursor: '#1a1b1e' };
  }, [colorScheme]);

  // Historique : fin de `logs/latest.log` écrite en tête (estompée), puis rejeu des lignes en attente.
  useEffect(() => {
    if (historyDoneRef.current || logHistory.isPending) return;
    historyDoneRef.current = true;
    const term = termRef.current;
    const data = logHistory.data;
    if (term !== null && data !== undefined && data.content !== '') {
      if (data.truncated) {
        term.writeln(`\x1b[2m${t('web:server.console.historyTooBig')}\x1b[0m`);
      } else {
        const lines = historyLines(data.content);
        if (lines.length > 0) {
          term.writeln(`\x1b[2m─── ${t('web:server.console.history')} ───\x1b[0m`);
          for (const line of lines) term.writeln(`\x1b[2m${line}\x1b[0m`);
          term.writeln(`\x1b[2m─── ${t('web:server.console.live')} ───\x1b[0m`);
          setEmpty(false);
          const entries = toMirror(lines);
          setMirror((prev) => [...prev, ...entries].slice(-MIRROR_LINES));
        }
      }
    }
    flushRef.current();
  }, [logHistory.isPending, logHistory.data, t]);

  // Abonnement console : snapshot (rattrapage par `seq`, sans doublon) puis lignes live.
  useEffect(() => {
    const append = (lines: ConsoleLine[]): void => {
      const fresh = lines.filter((l) => l.seq > lastSeqRef.current);
      if (fresh.length === 0) return;
      const term = termRef.current;
      const first = fresh[0];
      if (term !== null && first !== undefined && lastSeqRef.current >= 0) {
        if (first.seq > lastSeqRef.current + 1) term.writeln('\x1b[2m…\x1b[0m');
      }
      for (const line of fresh) term?.writeln(formatConsoleLine(line));
      lastSeqRef.current = fresh[fresh.length - 1]?.seq ?? lastSeqRef.current;
      setEmpty(false);
      const entries = toMirror(fresh.map((l) => l.text));
      setMirror((prev) => [...prev, ...entries].slice(-MIRROR_LINES));
    };
    // Tant que l'historique n'est pas écrit, on met en attente pour préserver l'ordre d'affichage.
    const enqueue = (lines: ConsoleLine[]): void => {
      if (historyDoneRef.current) {
        append(lines);
        return;
      }
      pendingRef.current.push(...lines);
    };
    flushRef.current = () => {
      const pending = pendingRef.current;
      pendingRef.current = [];
      if (pending.length > 0) append(pending);
    };
    const handler = (message: ServerMessage): void => {
      if (message.type === 'console.snapshot' && message.serverId === serverId) {
        setTruncated(message.truncated);
        enqueue(message.lines);
      } else if (message.type === 'console.lines' && message.serverId === serverId) {
        enqueue(message.lines);
      } else if (message.type === 'error' && message.channel === consoleChannel(serverId)) {
        notifications.show({ color: 'red', message: describeError(i18n, message.error) });
      }
    };
    const off = client.on(handler);
    const unsubscribe = client.subscribe(consoleChannel(serverId));
    client.connect();
    return () => {
      off();
      unsubscribe();
    };
  }, [client, serverId, i18n]);

  // Reconstruit seulement quand une de ses sources change : la frappe ne doit faire que des
  // recherches, pas réanalyser un catalogue de plusieurs centaines de commandes.
  const completionContext = useMemo<CompletionContext>(
    () => ({
      ...(loader === undefined ? {} : { loader }),
      ...(players === undefined ? {} : { players }),
      ...(commandsQuery.data?.source === 'discovered'
        ? { discovered: commandsQuery.data.commands }
        : {}),
      ...(historyQuery.data === undefined
        ? {}
        : { history: recentVerbs([...historyQuery.data.history].reverse().map((h) => h.command)) }),
    }),
    [loader, players, commandsQuery.data, historyQuery.data],
  );

  const signatureView = signature(input, completionContext);
  const catalogSource =
    commandsQuery.data?.source === 'discovered'
      ? 'discovered'
      : commandsQuery.isFetching
        ? 'static'
        : 'static';

  const submit = (): void => {
    const command = input.trim();
    if (command === '' || !canSend) return;
    history.push(command);
    setInput('');
    setSuggestions([]);
    send.mutate(command, {
      onError: (error) => {
        notifications.show({ color: 'red', message: describeError(i18n, error) });
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'ArrowUp') {
      const previous = history.up(input);
      if (previous !== undefined) {
        event.preventDefault();
        setInput(previous);
      }
    } else if (event.key === 'ArrowDown') {
      const next = history.down();
      if (next !== undefined) {
        event.preventDefault();
        setInput(next);
      }
    } else if (event.key === 'Tab') {
      const options = complete(input, completionContext);
      if (options.length > 0) {
        event.preventDefault();
        // Une seule proposition : on la complète et on passe au mot suivant. Plusieurs : on
        // affiche la liste sans rien écrire — écrire d'office la première fait taper au hasard.
        const first = options[0];
        if (options.length === 1 && first) {
          setInput(`${first.insert} `);
          setSuggestions([]);
        } else {
          setSuggestions(options);
        }
      }
    } else if (event.key === 'Escape') {
      setSuggestions([]);
    }
  };

  const onChange = (value: string): void => {
    setInput(value);
    setSuggestions(value.trim() === '' ? [] : complete(value, completionContext));
  };

  const clear = (): void => {
    termRef.current?.clear();
    setMirror([]);
  };

  return (
    <Stack gap="xs" data-testid="console">
      <Paper
        withBorder
        radius="sm"
        p={4}
        style={{
          height,
          position: 'relative',
          background: colorScheme === 'dark' ? '#141517' : '#ffffff',
        }}
      >
        <Box ref={containerRef} style={{ height: '100%', width: '100%' }} />
        {empty && (
          <Text
            size="sm"
            c="dimmed"
            style={{ position: 'absolute', top: 8, left: 12, pointerEvents: 'none' }}
          >
            {t('web:server.console.empty')}
          </Text>
        )}
        <Group gap={4} style={{ position: 'absolute', top: 6, right: 6 }}>
          <Tooltip label={t('web:server.console.download')} withArrow>
            <ActionIcon
              component="a"
              href={fileDownloadUrl(serverId, LOG_FILE)}
              download
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={t('web:server.console.download')}
              data-testid="console-download-log"
            >
              <IconDownload size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('web:server.console.clear')} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={clear}
              aria-label={t('web:server.console.clear')}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Paper>
      {truncated && (
        <Text size="xs" c="dimmed">
          {t('web:server.console.truncated')}
        </Text>
      )}
      <Group gap="xs" align="flex-start" wrap="nowrap">
        <TextInput
          value={input}
          onChange={(e) => {
            onChange(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={
            canSend ? t('web:server.console.placeholder') : t('web:server.console.viewerHint')
          }
          disabled={!canSend}
          style={{ flex: 1 }}
          {...TECHNICAL_INPUT_PROPS}
          enterKeyHint="send"
          aria-label={t('web:server.console.placeholder')}
          data-testid="console-input"
          styles={{
            input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
          }}
        />
        <ActionIcon
          size="input-sm"
          variant="filled"
          onClick={submit}
          disabled={!canSend || input.trim() === ''}
          loading={send.isPending}
          aria-label={t('web:server.console.send')}
          data-testid="console-send"
        >
          <IconSend size={18} />
        </ActionIcon>
      </Group>
      {suggestions.length > 0 && (
        <Group gap={6} data-testid="console-suggestions">
          {suggestions.map((s) => (
            <Text
              key={s.insert}
              size="xs"
              component="button"
              type="button"
              onClick={() => {
                setInput(`${s.insert} `);
                setSuggestions([]);
              }}
              style={{
                cursor: 'pointer',
                fontFamily: 'ui-monospace, monospace',
                background: 'var(--mantine-color-default-hover)',
                border: 'none',
                borderRadius: 4,
                padding: '2px 6px',
              }}
            >
              {s.label}
            </Text>
          ))}
        </Group>
      )}
      <CommandSignature view={signatureView} source={catalogSource} />
      <MacroBar serverId={serverId} canSend={canSend} />
      <div
        data-testid="console-mirror"
        role="log"
        aria-label={t('web:server.console.mirror')}
        className="mmo-visually-hidden"
      >
        {mirror.map((line) => (
          <div key={line.id}>{line.text}</div>
        ))}
      </div>
    </Stack>
  );
}
