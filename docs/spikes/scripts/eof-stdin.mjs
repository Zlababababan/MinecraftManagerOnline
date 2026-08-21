// Spike n°1 — comportement des serveurs Minecraft quand le pipe stdin se ferme.
//
// Scénarios :
//   parent-crash : java lancé DÉTACHÉ (stdin/stdout/stderr pipés) par un faux agent, lui-même tué par
//                  taskkill /F  →  reproduit la mort de l'agent (EOF stdin + stdout/stderr cassés).
//   stdin-eof    : java lancé par ce script, on ferme stdin (child.stdin.end()) en gardant stdout
//                  →  isole l'effet de l'EOF stdin seul ; on voit aussi si stdout continue.
//
// Pour chaque scénario on vérifie après l'événement : process vivant, CPU (boucle folle ?), RCON
// répond (`list`, `say`), logs/latest.log encore écrit, arrêt propre via RCON `stop`.
//
// usage: node eof-stdin.mjs <serversRoot> [--scenario parent-crash|stdin-eof|all] [--only name,name] [--out fichier.json]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcon } from './rcon.mjs';
import { isAlive, sampleCpu } from './procinfo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const JDK8 = 'D:\\Java\\jdk1.8.0_281\\bin\\java.exe';
const JDK17 = 'D:\\Java\\jdk-17.0.5\\bin\\java.exe';
const JDK21 = 'D:\\Java\\jdk-21.0.3\\bin\\java.exe';

const SERVERS = [
  { name: 'vanilla1201', label: 'Vanilla 1.20.1', java: JDK17, args: ['-Xmx2G', '-jar', 'server.jar', 'nogui'] },
  { name: 'sf4-forge112', label: 'Forge 1.12.2 (SkyFactory 4)', java: JDK8, args: ['-Xms1G', '-Xmx3G', '-jar', 'forge-1.12.2-14.23.5.2860.jar', 'nogui'] },
  { name: 'rad2-forge116', label: 'Forge 1.16.5 (RAD2)', java: JDK8, args: ['-Xmx4G', '-jar', 'forge-1.16.5-36.2.39.jar', 'nogui'] },
  { name: 'prom2-fabric1201', label: 'Fabric 1.20.1 (Prominence II v3.0.2)', java: JDK17, args: ['-Xms2G', '-Xmx4G', '-jar', 'fabric-server-launcher.jar', 'nogui'] }, // pack non lançable tel quel (loader 0.15.11 < 0.16.10 requis par ses mods)
  { name: 'dh-fabric1211', label: 'Fabric 1.21.1 (Dungeon Heroes)', java: JDK21, args: ['-Xms2G', '-Xmx4G', '-jar', 'fabric-server-launcher.jar', 'nogui'] },
  { name: 'atm10-neoforge1211', label: 'NeoForge 1.21.1 (ATM10)', java: JDK21, args: ['-Xms4G', '-Xmx8G', '@libraries/net/neoforged/neoforge/21.1.219/win_args.txt', 'nogui'] },
];

const argv = process.argv.slice(2);
const root = argv[0];
const scenarioArg = argv.includes('--scenario') ? argv[argv.indexOf('--scenario') + 1] : 'all';
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const scenarios = scenarioArg === 'all' ? ['parent-crash', 'stdin-eof'] : [scenarioArg];
const outName = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'eof-stdin.json';
const resultsDir = path.join(here, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function prepareServer(dir, { port, rconPort }) {
  const propsPath = path.join(dir, 'server.properties');
  const lines = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, 'utf8').split(/\r?\n/) : [];
  const props = new Map(lines.filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  const overrides = {
    'enable-rcon': 'true', 'rcon.port': String(rconPort), 'rcon.password': 'spike',
    'server-port': String(port), 'query.port': String(port), 'enable-query': 'false',
    'online-mode': 'false', 'max-tick-time': '-1', 'level-name': 'spikeworld',
    'view-distance': '4', 'spawn-protection': '0', 'enable-jmx-monitoring': 'false',
  };
  for (const [k, v] of Object.entries(overrides)) props.set(k, v);
  fs.writeFileSync(propsPath, [...props].map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
}

function latestLog(dir) {
  const p = path.join(dir, 'logs', 'latest.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

async function waitForDone(readText, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const txt = readText();
    if (/Done \([\d.,]+s\)!/.test(txt)) return Math.round((Date.now() - t0) / 1000);
    if (/\[fake-agent\] java exited/.test(txt)) throw new Error('java exited before Done');
    await sleep(2000);
  }
  throw new Error('timeout waiting for Done');
}

async function tryRcon(rconPort, cmd) {
  try { return { ok: true, body: (await rcon(rconPort, 'spike', cmd)).trim() }; } catch (e) { return { ok: false, error: e.message }; }
}

function taskkill(pid) { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }); }
/** Crash simulé de l'agent : kill du seul PID, SANS /T (un /T tuerait l'arbre, java compris — voir rapport). */
function crashAgent(pid) { spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' }); }

async function waitExit(pid, timeoutMs) {
  const t0 = Date.now();
  while (isAlive(pid)) { if (Date.now() - t0 > timeoutMs) return false; await sleep(1000); }
  return true;
}

/** Observation commune après l'événement EOF. */
async function observe(dir, pid, rconPort, r) {
  await sleep(3000);
  r.aliveAfter3s = isAlive(pid);
  if (!r.aliveAfter3s) return;
  r.cpuAfterEof = await sampleCpu(pid, 10000);
  r.rconList = await tryRcon(rconPort, 'list');
  const logLenBefore = latestLog(dir).length;
  r.rconSay = await tryRcon(rconPort, 'say spike-after-eof');
  await sleep(2000);
  const after = latestLog(dir);
  r.latestLogStillWritten = after.length > logLenBefore && /spike-after-eof/.test(after);
  r.aliveAfter20s = isAlive(pid);
  r.rconStop = await tryRcon(rconPort, 'stop');
  r.exitedWithin120s = await waitExit(pid, 120000);
  if (!r.exitedWithin120s) { r.forceKilled = true; taskkill(pid); await waitExit(pid, 10000); }
}

function logAnomalies(dir, sinceMarker) {
  const txt = latestLog(dir);
  const idx = sinceMarker ? txt.indexOf(sinceMarker) : -1;
  const after = idx >= 0 ? txt.slice(idx) : txt.slice(-20000);
  return after.split(/\r?\n/).filter((l) => /Exception|Error|Broken pipe|Stream closed|EOF|closed/i.test(l)).slice(0, 15);
}

async function runParentCrash(s, dir, ports) {
  const r = { scenario: 'parent-crash' };
  const stdoutLog = path.join(resultsDir, `${s.name}.parent-crash.stdout.log`);
  const pidFile = path.join(resultsDir, `${s.name}.pid`);
  fs.rmSync(stdoutLog, { force: true });
  fs.rmSync(pidFile, { force: true });
  const agent = spawn(process.execPath, [path.join(here, 'fake-agent.mjs'), dir, stdoutLog, pidFile, s.java, ...s.args], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  r.javaPid = pid;
  r.agentPid = agent.pid;
  try {
    r.startSeconds = await waitForDone(() => (fs.existsSync(stdoutLog) ? fs.readFileSync(stdoutLog, 'utf8') : ''), 15 * 60 * 1000);
  } catch (e) {
    r.error = e.message;
    taskkill(agent.pid);
    if (isAlive(pid)) taskkill(pid);
    return r;
  }
  r.cpuBeforeEof = await sampleCpu(pid, 10000);
  r.rconBefore = await tryRcon(ports.rconPort, 'list');
  const marker = `spike-marker-${Date.now()}`;
  await tryRcon(ports.rconPort, `say ${marker}`);
  await sleep(1000);
  log(`  tuer le faux agent (pid ${agent.pid}) → java ${pid} orphelin`);
  crashAgent(agent.pid);
  await observe(dir, pid, ports.rconPort, r);
  r.logAnomalies = logAnomalies(dir, marker);
  r.stdoutTail = fs.readFileSync(stdoutLog, 'utf8').split(/\r?\n/).filter(Boolean).slice(-3);
  return r;
}

async function runStdinEof(s, dir, ports) {
  const r = { scenario: 'stdin-eof' };
  const child = spawn(s.java, s.args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });
  r.javaPid = child.pid;
  try {
    r.startSeconds = await waitForDone(() => (exitInfo ? out + '\n[fake-agent] java exited' : out), 15 * 60 * 1000);
  } catch (e) {
    r.error = e.message;
    taskkill(child.pid);
    return r;
  }
  r.cpuBeforeEof = await sampleCpu(child.pid, 10000);
  const marker = `spike-marker-${Date.now()}`;
  await tryRcon(ports.rconPort, `say ${marker}`);
  await sleep(1000);
  const outLenBefore = out.length;
  log('  fermeture de stdin (child.stdin.end())');
  child.stdin.end();
  await observe(dir, child.pid, ports.rconPort, r);
  const tail = out.slice(outLenBefore);
  r.stdoutStillFlowingAfterEof = tail.includes('spike-after-eof');
  r.stdoutAfterEof = tail.split(/\r?\n/).filter(Boolean).slice(0, 8);
  r.exitInfo = exitInfo;
  r.logAnomalies = logAnomalies(dir, marker);
  return r;
}

const all = {};
let i = 0;
for (const s of SERVERS) {
  if (only && !only.includes(s.name)) continue;
  const dir = path.join(root, s.name);
  if (!fs.existsSync(dir)) { log(`SKIP ${s.name} (dossier absent)`); continue; }
  const ports = { port: 25700 + i, rconPort: 25800 + i };
  i++;
  prepareServer(dir, ports);
  all[s.name] = { label: s.label, results: [] };
  for (const sc of scenarios) {
    log(`=== ${s.label} — ${sc}`);
    fs.rmSync(path.join(dir, 'logs', 'latest.log'), { force: true });
    const r = sc === 'parent-crash' ? await runParentCrash(s, dir, ports) : await runStdinEof(s, dir, ports);
    all[s.name].results.push(r);
    log(`  → ${JSON.stringify(r)}`);
    fs.writeFileSync(path.join(resultsDir, outName), JSON.stringify(all, null, 2));
    await sleep(3000);
  }
}
log('terminé');
