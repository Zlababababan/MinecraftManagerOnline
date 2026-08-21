import { readdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Logger } from '../log.js';
import { fakeServerCommand, freePort, sleep, tmpDir, waitFor } from '../test/helpers.js';
import { ServerProcess, type ServerProcessEvent } from './server-process.js';

const logger = new Logger('test', { stderr: false });

function makeProcess(dir: string, events: ServerProcessEvent[]) {
  let seq = 0;
  return new ServerProcess({
    serverId: 'srv',
    serverDir: dir,
    logger,
    seq: { next: () => ++seq, current: () => seq },
    onEvent: (e) => events.push(e),
    batchMs: 20,
    rconProbeIntervalMs: 200,
    exitPollMs: 100,
  });
}

const states = (events: ServerProcessEvent[]) =>
  events.filter((e) => e.kind === 'state').map((e) => e.state);

describe('processus serveur géré (doc 06 §3–4)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let events: ServerProcessEvent[];
  let proc: ServerProcess | undefined;

  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir());
    events = [];
  });
  afterEach(async () => {
    if (proc?.isRunning) await proc.kill();
    proc?.dispose();
    await cleanup();
  });

  it('start → Done → running ; commandes stdin ; joueurs ; stop propre (exitReason stop)', async () => {
    proc = makeProcess(dir, events);
    const { pid } = await proc.start(
      fakeServerCommand(dir, ['--done-after', '150', '--join', 'Alice']),
    );
    expect(pid).toBeGreaterThan(0);
    expect(proc.state).toBe('starting');
    expect(proc.attachMode).toBe('attached');
    await waitFor(() => proc!.state === 'running', 5000);
    await waitFor(() => proc!.onlinePlayers.length === 1, 3000);
    expect(proc.onlinePlayers[0]).toEqual({
      name: 'Alice',
      uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    });

    expect(await proc.sendCommand('/say bonjour')).toBe('stdin');
    await waitFor(() =>
      proc!.buffer.since(undefined).lines.some((l) => l.text.includes('[Server] bonjour')),
    );
    await proc.sendCommand('leave Alice');
    await waitFor(() => proc!.onlinePlayers.length === 0);
    const players = events.filter((e) => e.kind === 'player');
    expect(players.map((p) => [p.event, p.name, p.online])).toEqual([
      ['join', 'Alice', 1],
      ['leave', 'Alice', 0],
    ]);

    const lines = proc.buffer.since(undefined).lines;
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    expect(lines.every((l) => l.level === 'INFO')).toBe(true);
    expect(lines.some((l) => l.text.includes('Done ('))).toBe(true);

    const result = await proc.stop({ timeoutMs: 5000 });
    expect(result).toEqual({ alreadyStopped: false, forced: false });
    expect(proc.state).toBe('stopped');
    expect(states(events)).toEqual(['starting', 'running', 'stopping', 'stopped']);
    const last = events.filter((e) => e.kind === 'state').at(-1);
    expect(last).toMatchObject({ state: 'stopped', exitReason: 'stop', exitCode: 0, pid });
    expect(await proc.stop()).toEqual({ alreadyStopped: true, forced: false });
  });

  it('exit sans arrêt demandé = crash, rapport attaché', async () => {
    proc = makeProcess(dir, events);
    await proc.start(fakeServerCommand(dir, ['--done-after', '50', '--crash-after', '100']));
    await waitFor(() => proc!.state === 'crashed', 5000);
    const last = events.filter((e) => e.kind === 'state').at(-1);
    expect(last).toMatchObject({
      state: 'crashed',
      previous: 'running',
      exitReason: 'crash',
      exitCode: 1,
    });
    expect(last && 'crashReportPath' in last ? last.crashReportPath : undefined).toMatch(
      /crash-reports/,
    );
    expect(await readdir(`${dir}/crash-reports`)).toHaveLength(1);
    expect(events.some((e) => e.kind === 'log-event' && e.event.kind === 'crash_signal')).toBe(
      true,
    );
  });

  it('stop tapé en console (hors séquence stop()) : classé stopped, pas crash (doc 06 §4)', async () => {
    proc = makeProcess(dir, events);
    await proc.start(fakeServerCommand(dir, ['--done-after', '50']));
    await waitFor(() => proc!.state === 'running', 5000);
    // Commande brute, pas proc.stop() : stopRequested reste indéfini
    await proc.sendCommand('stop');
    await waitFor(() => proc!.state === 'stopped', 5000);
    expect(events.filter((e) => e.kind === 'state').at(-1)).toMatchObject({
      state: 'stopped',
      exitReason: 'stop',
      exitCode: 0,
    });
  });

  it('EULA refusée : signalée, état stopped (pas crash)', async () => {
    proc = makeProcess(dir, events);
    await proc.start(fakeServerCommand(dir, ['--eula']));
    await waitFor(() => proc!.state === 'stopped', 5000);
    expect(events.some((e) => e.kind === 'eula-required')).toBe(true);
    expect(states(events)).toEqual(['starting', 'stopped']);
  });

  it('stop ignoré → terminaison forcée après le délai (forced: true)', async () => {
    proc = makeProcess(dir, events);
    await proc.start(fakeServerCommand(dir, ['--done-after', '50', '--ignore-stop']));
    await waitFor(() => proc!.state === 'running');
    const result = await proc.stop({ timeoutMs: 300, termGraceMs: 300 });
    expect(result.forced).toBe(true);
    expect(proc.state).toBe('stopped');
    expect(events.filter((e) => e.kind === 'state').at(-1)).toMatchObject({ exitReason: 'kill' });
  });

  it('forceAfterTimeout=false → E_TIMEOUT, le serveur continue', async () => {
    proc = makeProcess(dir, events);
    await proc.start(fakeServerCommand(dir, ['--done-after', '50', '--ignore-stop']));
    await waitFor(() => proc!.state === 'running');
    await expect(proc.stop({ timeoutMs: 200, forceAfterTimeout: false })).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
    expect(proc.isRunning).toBe(true);
    expect(await proc.kill()).toEqual({ wasRunning: true });
    expect(proc.state).toBe('stopped');
  });

  it('readiness par RCON (sans ligne Done) et commandes via RCON', async () => {
    const port = await freePort();
    proc = makeProcess(dir, events);
    proc.setRcon({ port, password: 'pw' });
    await proc.start(
      fakeServerCommand(dir, [
        '--done-after',
        '60000',
        '--rcon-port',
        String(port),
        '--rcon-password',
        'pw',
        '--rcon-delay',
        '50',
      ]),
    );
    await waitFor(() => proc!.state === 'running', 5000);
    expect(await proc.rconExec('list')).toContain('There are 0');
    await proc.stop({ timeoutMs: 3000 });
  });

  it('ré-adoption détachée : survie à l’agent, tail de latest.log, stop via RCON', async () => {
    const port = await freePort();
    proc = makeProcess(dir, events);
    proc.setRcon({ port, password: 'pw' });
    await proc.start(
      fakeServerCommand(dir, [
        '--done-after',
        '50',
        '--rcon-port',
        String(port),
        '--rcon-password',
        'pw',
        '--log-dir',
        dir,
      ]),
    );
    await waitFor(() => proc!.state === 'running');
    const runtime = {
      pid: proc.pid!,
      startedAt: proc.startedAt!,
      cmdlineKey: proc.cmdlineKey,
      rconPort: port,
      rconPassword: 'pw',
      attachMode: 'attached' as const,
    };
    // « Mort » de l'agent : on détache sans tuer (EOF stdin, pipes fermés)
    proc.dispose();
    proc = undefined;
    await sleep(300);

    const events2: ServerProcessEvent[] = [];
    const adopted = makeProcess(dir, events2);
    proc = adopted;
    expect(await adopted.adopt(runtime)).toBe(true);
    expect(adopted.attachMode).toBe('detached');
    expect(adopted.pid).toBe(runtime.pid);
    await waitFor(() => adopted.state === 'running', 5000);
    // La console passe par le fichier de log
    expect(await adopted.sendCommand('say via-rcon')).toBe('rcon');
    await waitFor(
      () => adopted.buffer.since(undefined).lines.some((l) => l.text.includes('[Server] via-rcon')),
      5000,
    );
    // Joueur rejoint après ré-adoption : détecté par le tail
    await adopted.rconExec('join Bob');
    await waitFor(() => adopted.onlinePlayers.some((p) => p.name === 'Bob'), 5000);

    const result = await adopted.stop({ timeoutMs: 5000 });
    expect(result).toEqual({ alreadyStopped: false, forced: false });
    await waitFor(() => adopted.state === 'stopped');
    expect(states(events2)).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });

  it('ré-adoption refusée si le PID est mort ou réutilisé', async () => {
    proc = makeProcess(dir, events);
    expect(
      await proc.adopt({
        pid: 2_147_483_645,
        startedAt: Date.now(),
        cmdlineKey: 'x',
        attachMode: 'attached',
      }),
    ).toBe(false);
    // PID vivant (nous-mêmes) mais autre programme / autre heure
    expect(
      await proc.adopt({
        pid: process.pid,
        startedAt: Date.now() - 86_400_000,
        cmdlineKey: 'not-this-program.jar',
        attachMode: 'attached',
      }),
    ).toBe(false);
    expect(proc.state).toBe('stopped');
  });

  it('décode l’UTF-8 des pipes et filtre les séquences ANSI', async () => {
    proc = makeProcess(dir, events);
    await proc.start(fakeServerCommand(dir, ['--done-after', '50']));
    await waitFor(() => proc!.state === 'running');
    await proc.sendCommand('accent');
    await waitFor(() =>
      proc!.buffer.since(undefined).lines.some((l) => l.text.includes('Accents : éèàç — ok')),
    );
    await proc.stop({ timeoutMs: 3000 });
  });
});
