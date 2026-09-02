/**
 * Coût de l'agent lui-même (lot 9, métrique `agent.self`) : RSS et CPU du processus, remontés
 * dans chaque heartbeat. C'est la seule critique fatale d'un outil de supervision auto-hébergé —
 * « il ralentit mon serveur » — et jusqu'ici personne ne pouvait la vérifier.
 *
 * CPU en « cœurs » comme le reste des métriques (100 = un cœur saturé) : delta de
 * `process.cpuUsage()` rapporté au temps écoulé depuis le relevé précédent. Le premier appel n'a
 * pas de référence et ne rend pas de CPU.
 */
export interface SelfUsage {
  rssMb: number;
  /** Absent au premier relevé (pas de delta). */
  cpuPct?: number;
}

export class SelfMeter {
  private last: { cpu: NodeJS.CpuUsage; at: number } | undefined;

  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly cpuUsage: () => NodeJS.CpuUsage = () => process.cpuUsage(),
    private readonly rss: () => number = () => process.memoryUsage().rss,
  ) {}

  read(): SelfUsage {
    const at = this.clock();
    const cpu = this.cpuUsage();
    const rssMb = Math.round((this.rss() / 1048576) * 10) / 10;
    const previous = this.last;
    this.last = { cpu, at };
    if (previous === undefined) return { rssMb };
    const elapsedUs = (at - previous.at) * 1000;
    if (elapsedUs <= 0) return { rssMb };
    const usedUs = cpu.user - previous.cpu.user + (cpu.system - previous.cpu.system);
    return { rssMb, cpuPct: Math.round(Math.max(0, (usedUs / elapsedUs) * 100) * 10) / 10 };
  }
}
