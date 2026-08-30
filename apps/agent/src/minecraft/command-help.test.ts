/**
 * La sonde `help` partage la socket RCON avec la sonde TPS et le watchdog, et son résultat sert à
 * un aperçu, pas à une opération. Elle doit donc être discrète avant d'être complète : ne rien
 * tenter sur un serveur qui n'est pas prêt, ne jamais insister sur un serveur qui ne connaît pas
 * `help`, ne jamais lever, et ne lancer qu'un balayage à la fois.
 */
import { describe, expect, it, vi } from 'vitest';

import { CommandHelpProbe, type CommandHelpProbeOptions } from './command-help.js';

function probe(over: Partial<CommandHelpProbeOptions> = {}) {
  let now = 1_000_000;
  const exec = vi.fn<(command: string, timeoutMs: number) => Promise<string>>();
  const p = new CommandHelpProbe({
    exec,
    state: () => 'running',
    // Démarré depuis longtemps : la période de chauffe est passée.
    startedAt: () => now - 600_000,
    now: () => now,
    ...over,
  });
  return { p, exec, advance: (ms: number) => (now += ms) };
}

describe('sonde des commandes', () => {
  it('rend les lignes du serveur', async () => {
    const { p, exec } = probe();
    exec.mockResolvedValue('/list\n/whitelist (add|remove) <targets>\n');
    const result = await p.fetch();
    expect(result.available).toBe(true);
    expect(result.lines).toEqual(['/list', '/whitelist (add|remove) <targets>']);
    expect(exec).toHaveBeenCalledWith('help', expect.any(Number));
  });

  it('déplie une commande précise', async () => {
    const { p, exec } = probe();
    exec.mockResolvedValue('/execute run <command>');
    await p.fetch('execute');
    expect(exec).toHaveBeenCalledWith('help execute', expect.any(Number));
  });

  it('suit la pagination de la 1.12, en bornant le nombre de pages', async () => {
    const { p, exec } = probe();
    exec.mockImplementation((command) =>
      Promise.resolve(
        command === 'help'
          ? '--- Showing help page 1 of 3 ---\n/gamemode <mode> [player]'
          : `/page${command.slice(-1)}`,
      ),
    );
    const result = await p.fetch();
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['help', 'help 2', 'help 3']);
    // La ligne d'en-tête de page est conservée telle quelle : c'est le parseur du panel qui la
    // reconnaît et l'écarte, l'agent ne fait que transporter.
    expect(result.lines).toHaveLength(4);
  });

  it('se tait longtemps quand le serveur ne connaît pas la commande', async () => {
    const { p, exec, advance } = probe();
    exec.mockResolvedValue('Unknown command. Try /help for a list of commands');
    expect((await p.fetch()).available).toBe(false);
    // Insister spammerait la console du serveur pour rien.
    expect((await p.fetch()).available).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    advance(11 * 60_000);
    exec.mockResolvedValue('/list');
    expect((await p.fetch()).available).toBe(true);
  });

  it('ne verrouille PAS sur une panne de transport : la commande n’y est pour rien', async () => {
    const { p, exec } = probe();
    exec.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await p.fetch()).available).toBe(false);
    exec.mockResolvedValueOnce('/list');
    expect((await p.fetch()).available).toBe(true);
  });

  it('ne dérange pas un serveur qui n’est pas prêt', async () => {
    const stopped = probe({ state: () => 'stopped' });
    expect((await stopped.p.fetch()).available).toBe(false);
    expect(stopped.exec).not.toHaveBeenCalled();

    // Serveur tout juste démarré : il charge encore ses mods, et la socket RCON est partagée
    // avec la sonde TPS et le watchdog.
    let now = 1_000_000;
    const startedAt = now - 5_000;
    const warming = new CommandHelpProbe({
      exec: vi.fn().mockResolvedValue('/list'),
      state: () => 'running',
      startedAt: () => startedAt,
      now: () => now,
    });
    expect((await warming.fetch()).available).toBe(false);
    now += 120_000;
    expect((await warming.fetch()).available).toBe(true);
  });

  it('ne lance qu’un balayage à la fois (deux navigateurs sur la même console)', async () => {
    const { p, exec } = probe();
    let release: (value: string) => void = () => undefined;
    exec.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const both = Promise.all([p.fetch(), p.fetch()]);
    release('/list');
    const [a, b] = await both;
    expect(exec).toHaveBeenCalledTimes(1);
    expect(a.lines).toEqual(b.lines);
  });

  it('oublie ce qu’elle savait quand le serveur redémarre', async () => {
    const { p, exec } = probe();
    exec.mockResolvedValue('Unknown command');
    await p.fetch();
    p.reset();
    exec.mockResolvedValue('/list');
    expect((await p.fetch()).available).toBe(true);
  });
});
