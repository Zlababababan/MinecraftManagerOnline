import { describe, expect, it, vi } from 'vitest';

import { Logger } from '../log.js';
import {
  applyAndLogCpuPriority,
  applyCpuPriority,
  niceFor,
  type PriorityIo,
} from './cpu-priority.js';

/** Faux OS : la priorité courante est une valeur, l'écriture peut être programmée pour échouer. */
function fakeIo(current: number, failWith?: Error) {
  const io = {
    getPriority: vi.fn(() => current),
    setPriority: vi.fn((_pid: number, priority: number) => {
      if (failWith) throw failWith;
      current = priority;
    }),
  };
  return io satisfies PriorityIo;
}

/** `ERR_SYS_ERROR` tel que Node le lève : le code utile n'est que dans le message. */
function sysError(code: string): Error {
  return new Error(`A system error occurred: uv_os_setpriority returned ${code} (denied)`);
}

describe('priorité CPU (os.setPriority, sans module natif)', () => {
  it('traduit les trois valeurs en nice, et une priorité absente vaut normale', () => {
    expect(niceFor('normal')).toBe(0);
    expect(niceFor('below_normal')).toBe(10);
    expect(niceFor('low')).toBe(19);
    // Un panel N-1 ne pousse pas le champ : ne rien abaisser plutôt que deviner.
    expect(niceFor(undefined)).toBe(0);
  });

  it("n'écrit RIEN quand la priorité est déjà la bonne", () => {
    const io = fakeIo(10);
    const outcome = applyCpuPriority(1234, 'below_normal', io);
    expect(outcome).toMatchObject({ changed: false, reason: 'already', from: 10, to: 10 });
    // C'est ce qui rend chaque reconnexion d'agent silencieuse : sans cette lecture préalable,
    // Linux refuserait de remonter un nice et avertirait à chaque `agent.configure`.
    expect(io.setPriority).not.toHaveBeenCalled();
  });

  it('abaisse la priorité et rend l’ancienne valeur', () => {
    const io = fakeIo(0);
    const outcome = applyCpuPriority(1234, 'low', io);
    expect(outcome).toMatchObject({ changed: true, from: 0, to: 19 });
    expect(io.setPriority).toHaveBeenCalledWith(1234, 19);
  });

  it('un refus de l’OS ne lève pas : il est classé, pas propagé', () => {
    // Unix n'autorise pas à REMONTER un nice sans privilège : repasser un serveur en marche de
    // « minimale » à « normale » est refusé, et ce n'est pas une panne.
    const denied = applyCpuPriority(1234, 'normal', fakeIo(19, sysError('EPERM')));
    expect(denied).toMatchObject({ changed: false, reason: 'denied', from: 19, to: 0 });
    expect(denied.error).toContain('EPERM');

    const gone = applyCpuPriority(1234, 'low', fakeIo(0, sysError('ESRCH')));
    expect(gone).toMatchObject({ changed: false, reason: 'gone' });

    const other = applyCpuPriority(1234, 'low', fakeIo(0, sysError('EINVAL')));
    expect(other).toMatchObject({ changed: false, reason: 'error' });
  });

  it('tente quand même l’écriture quand la priorité courante est illisible', () => {
    const io = {
      getPriority: vi.fn(() => {
        throw new Error('nope');
      }),
      setPriority: vi.fn(),
    } satisfies PriorityIo;
    const outcome = applyCpuPriority(1234, 'below_normal', io);
    expect(outcome).toMatchObject({ changed: true, to: 10 });
    expect(outcome.from).toBeUndefined();
    expect(io.setPriority).toHaveBeenCalledWith(1234, 10);
  });

  it('journalise le changement et le refus, et se tait quand il n’y a rien à faire', () => {
    const lines: { level: string; message: string }[] = [];
    const logger = new Logger('test', { stderr: false });
    logger.addSink((entry) => lines.push({ level: entry.level, message: entry.message }));

    applyAndLogCpuPriority(logger, 'srv_1', 1234, 'below_normal', fakeIo(0));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'INFO' });

    applyAndLogCpuPriority(logger, 'srv_1', 1234, 'normal', fakeIo(19, sysError('EPERM')));
    expect(lines).toHaveLength(2);
    expect(lines[1]?.level).toBe('WARN');

    applyAndLogCpuPriority(logger, 'srv_1', 1234, 'low', fakeIo(19));
    expect(lines).toHaveLength(2);
  });
});
