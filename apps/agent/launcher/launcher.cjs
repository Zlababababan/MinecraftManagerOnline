#!/usr/bin/env node
/**
 * Micro-launcher de l'agent (doc 03 §3) — figé, sans dépendance, ne parle jamais réseau.
 *
 *   node launcher.cjs [args de l'agent…]        (ex. --panel wss://… --state-dir …)
 *
 * Disposition dans le dossier du launcher (`home`) :
 *   versions/<v>/agent.js   bundles universels      current.json        { version }
 *   next.json               { version, previous }   (écrit par l'agent après `agent.update`, exit 75)
 *   trial.json              essai d'une nouvelle version (launcher)
 *   update-result.json      { kind, status, version, otherVersion, reason, ts } (lu par l'agent)
 *   runtime/<v>/…           runtimes Node           runtime-next.json / runtime-current.json
 *
 * Boucle : applique `next.json` (→ essai), lance `node versions/<cur>/agent.js run …` avec un canal IPC,
 * attend le message `{ type: 'healthy' }` (session panel établie) sous HEALTH_MS (30 s) et pas 2
 * crashs ; sinon **rollback N-1** (current.json ← previous) + `update-result.json`. Code de sortie 75 =
 * redémarrage immédiat (mise à jour demandée). Autres sorties : relance avec backoff (1 s → 60 s).
 * Les signaux SIGINT/SIGTERM sont transmis à l'agent (les serveurs Java, détachés, survivent).
 * Phase 11 : `--version` (ou `pair`/`scan`) = exécution unique, sans relance ni rollback (installeurs,
 * smoke test des archives) ; le code de sortie de l'agent est rendu tel quel.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOME = path.resolve(process.env.MMO_AGENT_HOME || __dirname);
const HEALTH_MS = Number(process.env.MMO_LAUNCHER_HEALTH_MS || 30_000);
const MAX_TRIAL_CRASHES = 2;
const UPDATE_EXIT = 75;
const LOG = path.join(HOME, 'launcher.log');
const ONE_SHOT =
  process.argv.includes('--version') || ['pair', 'scan'].includes(process.argv[2] || '');

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {}
  process.stderr.write(`[launcher] ${line}`);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, file), 'utf8'));
  } catch {
    return undefined;
  }
}
function writeJson(file, value) {
  const p = path.join(HOME, file);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2) + '\n');
  // Windows : rename peut échouer EPERM/EBUSY si la cible est ouverte (agent en train de la
  // consommer, antivirus) — réessayer brièvement plutôt que de laisser l'exception remonter.
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(`${p}.tmp`, p);
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}
function remove(file) {
  try {
    fs.unlinkSync(path.join(HOME, file));
  } catch {}
}
function bundleOf(version) {
  return path.join(HOME, 'versions', version, 'agent.js');
}
function nodeOf(version) {
  if (!version) return process.execPath;
  for (const rel of ['node.exe', 'node', path.join('bin', 'node')]) {
    const p = path.join(HOME, 'runtime', version, rel);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
function listVersions() {
  try {
    return fs
      .readdirSync(path.join(HOME, 'versions'))
      .filter((v) => fs.existsSync(bundleOf(v)))
      .sort();
  } catch {
    return [];
  }
}
function reportResult(kind, status, version, otherVersion, reason) {
  // Ne doit JAMAIS tuer le launcher : la bascule est déjà actée (current.json/trial.json) — au
  // pire l'agent ne remontera pas l'issue au panel (journalisée ici dans tous les cas).
  try {
    writeJson('update-result.json', {
      kind,
      status,
      version,
      otherVersion,
      reason,
      ts: Date.now(),
    });
  } catch (error) {
    log(`failed to write update-result.json: ${error.message}`);
  }
  log(
    `${kind} ${status}: ${version}${otherVersion ? ` (other: ${otherVersion})` : ''}${reason ? ` — ${reason}` : ''}`,
  );
}

/** Applique les bascules demandées (`next.json`, `runtime-next.json`) → essai. */
function applyPending() {
  const next = readJson('next.json');
  if (next && next.version && fs.existsSync(bundleOf(next.version))) {
    const current = (readJson('current.json') || {}).version;
    writeJson('trial.json', {
      kind: 'agent',
      version: next.version,
      previous: next.previous || current,
      crashes: 0,
      startedAt: Date.now(),
    });
    writeJson('current.json', { version: next.version });
    log(`trying agent ${next.version} (previous ${next.previous || current || 'none'})`);
  }
  if (next) remove('next.json');
  const rnext = readJson('runtime-next.json');
  if (rnext && rnext.version && nodeOf(rnext.version)) {
    const current = (readJson('runtime-current.json') || {}).version;
    if (!readJson('trial.json')) {
      writeJson('trial.json', {
        kind: 'runtime',
        version: rnext.version,
        previous: current,
        crashes: 0,
        startedAt: Date.now(),
      });
    }
    writeJson('runtime-current.json', { version: rnext.version });
    log(`trying runtime ${rnext.version} (previous ${current || 'embedded'})`);
  }
  if (rnext) remove('runtime-next.json');
}

function rollback(trial, reason) {
  if (trial.kind === 'runtime') {
    if (trial.previous) writeJson('runtime-current.json', { version: trial.previous });
    else remove('runtime-current.json');
    reportResult(
      'runtime',
      'rolled_back',
      trial.previous || process.version.replace(/^v/, ''),
      trial.version,
      reason,
    );
  } else {
    const fallback =
      trial.previous && fs.existsSync(bundleOf(trial.previous))
        ? trial.previous
        : listVersions()
            .filter((v) => v !== trial.version)
            .pop();
    if (!fallback) {
      log(`no previous version to roll back to; keeping ${trial.version}`);
      remove('trial.json');
      return;
    }
    writeJson('current.json', { version: fallback });
    try {
      fs.writeFileSync(path.join(HOME, 'versions', trial.version, '.broken'), `${reason}\n`);
    } catch {}
    reportResult('agent', 'rolled_back', fallback, trial.version, reason);
  }
  remove('trial.json');
}

let child;
let stopping = false;
let backoffMs = 1000;

function runOnce() {
  applyPending();
  let current = (readJson('current.json') || {}).version;
  if (!current || !fs.existsSync(bundleOf(current))) {
    const versions = listVersions();
    current = versions[versions.length - 1];
    if (!current) {
      log('no agent bundle found under versions/; exiting');
      process.exit(1);
    }
    writeJson('current.json', { version: current });
  }
  const runtimeVersion = (readJson('runtime-current.json') || {}).version;
  let node = nodeOf(runtimeVersion);
  if (!node) {
    if (runtimeVersion) log(`runtime ${runtimeVersion} missing, using embedded node`);
    node = process.execPath;
  }
  const args = [bundleOf(current), ...process.argv.slice(2)];
  if (ONE_SHOT) {
    const r = spawn(node, args, {
      stdio: 'inherit',
      env: { ...process.env, MMO_AGENT_HOME: HOME, MMO_AGENT_VERSION: current },
    });
    r.on('exit', (code) => process.exit(code === null ? 1 : code));
    return;
  }
  const trial = readJson('trial.json');
  log(`starting agent ${current} with ${node}${trial ? ' [trial]' : ''}`);
  child = spawn(node, args, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, MMO_AGENT_HOME: HOME, MMO_AGENT_VERSION: current },
    windowsHide: true,
  });
  const startedAt = Date.now();
  let healthy = false;
  let healthTimer;
  if (trial) {
    healthTimer = setTimeout(() => {
      if (healthy || stopping) return;
      log(`health check timed out after ${HEALTH_MS} ms`);
      rollback(trial, 'health_timeout');
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, HEALTH_MS);
  }
  child.on('message', (m) => {
    if (m && m.type === 'healthy' && !healthy) {
      healthy = true;
      backoffMs = 1000;
      if (healthTimer) clearTimeout(healthTimer);
      const t = readJson('trial.json');
      if (t) {
        // Écrire l'issue AVANT d'oublier l'essai : dans l'ordre inverse, une écriture qui échoue
        // (EPERM antivirus) perdait à la fois l'essai et l'issue, sans possibilité de rejouer.
        reportResult(t.kind, 'applied', t.version, t.previous, undefined);
        remove('trial.json');
      }
    }
  });
  child.on('exit', (code, signal) => {
    if (healthTimer) clearTimeout(healthTimer);
    child = undefined;
    log(
      `agent exited (code ${code}, signal ${signal || 'none'}) after ${Date.now() - startedAt} ms`,
    );
    if (stopping) process.exit(code === null ? 0 : code);
    if (code === UPDATE_EXIT) {
      runOnce();
      return;
    }
    const t = readJson('trial.json');
    if (t && !healthy) {
      t.crashes = (t.crashes || 0) + 1;
      if (t.crashes >= MAX_TRIAL_CRASHES) rollback(t, 'crash_loop');
      else writeJson('trial.json', t);
      runOnce();
      return;
    }
    const delay = code === 0 ? 0 : backoffMs;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    log(`restarting in ${delay} ms`);
    setTimeout(runOnce, delay);
  });
  child.on('error', (error) => {
    log(`spawn failed: ${error.message}`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}
runOnce();
