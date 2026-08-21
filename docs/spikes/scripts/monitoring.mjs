// Spike n°2 — monitoring Windows 11 sans wmic : systeminformation + pidusage.
// Mesure la latence de chaque appel utile à l'agent (métriques toutes les 15 s) et vérifie la cohérence
// avec une mesure indépendante (PowerShell Get-Process). Lancer deux fois : PATH normal, puis PATH sans
// System32\Wbem (simulation d'un Windows 24H2+ sans wmic) — cf. run-monitoring.ps1.
// usage: node monitoring.mjs [pid]
import pidusage from 'pidusage';
import si from 'systeminformation';
import { spawn, spawnSync } from 'node:child_process';
import { procInfo } from './procinfo.mjs';

const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['wmic'], { encoding: 'utf8' });
console.log(`wmic résolu via PATH : ${which.status === 0 ? which.stdout.trim() : 'NON (absent du PATH)'}`);
console.log(`node ${process.version}, pidusage ${(await import('pidusage/package.json', { with: { type: 'json' } })).default.version}, systeminformation ${(await import('systeminformation/package.json', { with: { type: 'json' } })).default.version}`);

// Cible : un process qui consomme du CPU de façon connue (boucle node à ~100 % d'un cœur), sauf si PID fourni.
let target = Number(process.argv[2]);
let burner = null;
if (!target) {
  burner = spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<60000){}'], { stdio: 'ignore' });
  target = burner.pid;
  console.log(`process cible = node burner (pid ${target}, ~100 % d'un cœur attendu)`);
}

const timed = async (label, fn) => {
  const t0 = performance.now();
  try {
    const v = await fn();
    const ms = Math.round(performance.now() - t0);
    console.log(`  ${label.padEnd(34)} ${String(ms).padStart(5)} ms  ${typeof v === 'string' ? v : ''}`);
    return v;
  } catch (e) {
    console.log(`  ${label.padEnd(34)}  ÉCHEC ${e.message.split('\n')[0]}`);
    return null;
  }
};

await new Promise((r) => setTimeout(r, 1500));

console.log('\n[pidusage] 1er appel (à froid) puis 3 appels espacés de 2 s :');
for (let i = 0; i < 4; i++) {
  await timed(`pidusage(${target}) #${i + 1}`, async () => { const s = await pidusage(target); return `cpu=${s.cpu.toFixed(1)}% rss=${Math.round(s.memory / 1048576)}Mo ppid=${s.ppid} elapsed=${Math.round(s.elapsed / 1000)}s`; });
  if (i < 3) await new Promise((r) => setTimeout(r, 2000));
}
await timed('pidusage([pid, process.pid]) lot', async () => { const s = await pidusage([target, process.pid]); return `${Object.keys(s).length} entrées`; });
await timed('pidusage(999999) pid inexistant', async () => { try { await pidusage(999999); return 'résolu ?!'; } catch (e) { return `rejet attendu: ${e.code ?? e.message}`; } });
const ref = procInfo(target);
console.log(`  référence Get-Process : rss=${Math.round(ref.rssBytes / 1048576)}Mo cpuMs=${ref.cpuMs}`);

console.log('\n[systeminformation] appels « agent » (spawn PowerShell par appel) :');
await timed('si.osInfo()', async () => { const o = await si.osInfo(); return `${o.distro} ${o.release} build ${o.build} ${o.arch}`; });
await timed('si.cpu()', async () => { const c = await si.cpu(); return `${c.manufacturer} ${c.brand} ${c.physicalCores}c/${c.cores}t`; });
await timed('si.currentLoad()', async () => { const l = await si.currentLoad(); return `load=${l.currentLoad.toFixed(1)}% (${l.cpus.length} cpus)`; });
await timed('si.mem()', async () => { const m = await si.mem(); return `total=${Math.round(m.total / 1073741824)}Go used=${Math.round(m.used / 1073741824)}Go available=${Math.round(m.available / 1073741824)}Go`; });
await timed('si.fsSize()', async () => { const f = await si.fsSize(); return f.map((x) => `${x.fs} ${Math.round(x.used / 1073741824)}/${Math.round(x.size / 1073741824)}Go`).join(' '); });
await timed('si.networkStats()', async () => { const n = await si.networkStats(); return `${n.length} iface(s) rx_sec=${n[0]?.rx_sec}`; });
await timed('si.cpuTemperature()', async () => { const t = await si.cpuTemperature(); return `main=${t.main}`; });
await timed('si.processLoad("java")', async () => { const p = await si.processLoad('java'); return `${p.map((x) => `${x.proc}:${x.pids.length}pid cpu=${x.cpu.toFixed(1)}`).join(' ')}`; });
await timed('si.processes() (liste complète)', async () => { const p = await si.processes(); return `${p.all} process, ${p.list.length} listés`; });

console.log('\n[systeminformation] avec session PowerShell persistante (si.powerShellStart) :');
si.powerShellStart();
await timed('si.currentLoad()', async () => `${(await si.currentLoad()).currentLoad.toFixed(1)}%`);
await timed('si.mem()', async () => `${Math.round((await si.mem()).available / 1073741824)}Go dispo`);
await timed('si.fsSize()', async () => `${(await si.fsSize()).length} volumes`);
await timed('si.processes()', async () => `${(await si.processes()).all} process`);
await timed('si.currentLoad() (2e)', async () => `${(await si.currentLoad()).currentLoad.toFixed(1)}%`);
si.powerShellRelease();

console.log('\n[procinfo maison] Get-Process par spawn :');
await timed('procInfo(pid)', async () => { const p = procInfo(target); return `cpuMs=${p.cpuMs} rss=${Math.round(p.rssBytes / 1048576)}Mo`; });

if (burner) burner.kill();
console.log('\nterminé');
