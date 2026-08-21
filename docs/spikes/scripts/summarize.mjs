// Résumé tabulaire des résultats du spike EOF (tous les fichiers results/eof-*.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
for (const f of fs.readdirSync(dir).filter((f) => /^eof-.*\.json$/.test(f))) {
  console.log(`--- ${f}`);
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const [name, v] of Object.entries(data)) for (const r of v.results) {
    const cpu = (c) => (c ? `${c.cpuPctOneCore ?? c.cpuPct}%/${c.rssMb}Mo` : '-');
    console.log(name.padEnd(20), r.scenario.padEnd(13), r.error ? `ERREUR ${r.error}` : `start ${String(r.startSeconds).padStart(3)}s | cpu avant ${cpu(r.cpuBeforeEof)} après ${cpu(r.cpuAfterEof)} | vivant 3s/20s ${r.aliveAfter3s}/${r.aliveAfter20s} | rcon list/say ${r.rconList?.ok}/${r.rconSay?.ok} | log ${r.latestLogStillWritten} | stop ${r.rconStop?.ok} sorti ${r.exitedWithin120s}${r.forceKilled ? ' FORCÉ' : ''}${r.exitInfo ? ` code ${r.exitInfo.code}` : ''}${r.stdoutStillFlowingAfterEof !== undefined ? ` | stdout continue ${r.stdoutStillFlowingAfterEof}` : ''} | anomalies ${(r.logAnomalies ?? []).filter((l) => !/spike-after-eof/.test(l)).length}`);
  }
}
