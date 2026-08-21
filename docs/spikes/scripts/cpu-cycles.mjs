// Spike n°2 (suite) — prototype « échantillonneur cycles » : PowerShell persistant + QueryProcessCycleTime.
// Compare, sur un process qui sature un cœur, le CPU % calculé par cycles vs pidusage (ticks).
// usage: node cpu-cycles.mjs [powershell.exe|pwsh]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import pidusage from 'pidusage';
import { procInfo } from './procinfo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = process.argv[2] ?? 'powershell.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = performance.now();
const ps = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'cpu-cycles.ps1')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const rl = readline.createInterface({ input: ps.stdout });
const queue = [];
rl.on('line', (l) => queue.shift()?.(JSON.parse(l)));
const ask = (pids) => new Promise((res) => { queue.push(res); ps.stdin.write(JSON.stringify({ pids }) + '\n'); });
const ready = await new Promise((res) => queue.push(res));
console.log(`[${shell}] prêt en ${Math.round(performance.now() - t0)} ms (Add-Type + compteurs) — ${ready.mhz} MHz nominal, ${ready.cores} threads`);

const burner = spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<20000){}'], { stdio: 'ignore' });
await sleep(1500);

let prev = null;
for (let i = 0; i < 5; i++) {
  const ts = performance.now();
  const s = await ask([burner.pid, process.pid, 999999]);
  const latency = Math.round(performance.now() - ts);
  const pu = await pidusage(burner.pid).catch(() => null);
  if (prev) {
    const d = s.procs[burner.pid].cycles - prev.procs[burner.pid].cycles;
    const dt = (s.t - prev.t) / 1000;
    const oneCore = (d / (s.mhz * 1e6)) / dt; // fraction d'un cœur nominal
    console.log(`  échantillon ${i}: latence ${latency} ms | cycles → ${(oneCore * 100).toFixed(0)} % d'un cœur (${(oneCore / s.cores * 100).toFixed(1)} % machine) | pidusage(ticks) → ${pu?.cpu.toFixed(1)} % | utility global ${s.utility} % | rss ${Math.round(s.procs[burner.pid].rss / 1048576)} Mo | pid inexistant → ${s.procs[999999]}`);
  }
  prev = s;
  await sleep(3000);
}
const psInfo = procInfo(ps.pid);
console.log(`RSS du process ${shell} persistant : ${Math.round(psInfo.rssBytes / 1048576)} Mo`);
burner.kill();
ps.stdin.end();
await sleep(300);
ps.kill();
