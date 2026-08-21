#!/usr/bin/env node
// Fake Java server (doc 03 §9, doc 07 phase 3) : imite un serveur Minecraft pour les tests
// d'intégration de l'agent sans Java — lignes de log au format vanilla, `Done`, joueurs, crash,
// EULA, RCON (protocole Source, fragments 4096, « Unknown request » sur type inconnu), délais.
//
// Options (toutes facultatives) :
//   --done-after <ms>       délai avant `Done` (défaut 300)
//   --crash-after <ms>      crash (exit 1 + crash-report) après `Done` + délai
//   --exit-after <ms>       sortie propre (code 0) sans stop demandé (simule un arrêt externe)
//   --eula                  refuse de démarrer (message EULA, exit 0)
//   --join <nom>[,<nom>]    joueurs qui rejoignent 100 ms après `Done`
//   --stop-delay <ms>       délai entre `stop` et la sortie (sauvegarde du monde)
//   --ignore-stop           ignore `stop` (test d'arrêt forcé)
//   --rcon-port <port>      active RCON (mot de passe `--rcon-password`, défaut : server.properties)
//   --rcon-password <pwd>
//   --rcon-delay <ms>       délai avant l'ouverture du listener RCON (défaut : juste avant `Done`)
//   --log-dir <dir>         écrit aussi logs/latest.log (mode détaché)
//   --modern-format         format de log Forge/NeoForge moderne avec mois localisé
//   --big-response <n>      `list` renvoie une réponse de n octets (test de fragmentation)
//   --hold <ms>             reste vivant après EOF stdin (par défaut : pour toujours, comme un vrai serveur)
//   --port <port>           « écoute » le port de jeu (bloque le port pour les tests de conflit)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const doneAfter = Number(opt('done-after', 300));
const crashAfter = opt('crash-after', undefined);
const exitAfter = opt('exit-after', undefined);
const eula = opt('eula', false) === true;
const joins = String(opt('join', '') || '')
  .split(',')
  .filter((s) => s !== '');
const stopDelay = Number(opt('stop-delay', 50));
const ignoreStop = opt('ignore-stop', false) === true;
const modern = opt('modern-format', false) === true;
const bigResponse = Number(opt('big-response', 0));
const gamePort = opt('port', undefined);
const logDir = opt('log-dir', undefined);

// RCON : options explicites, sinon server.properties du cwd (auto-provisionnement par l'agent)
let rconPort = opt('rcon-port', undefined);
let rconPassword = opt('rcon-password', undefined);
if (rconPort === undefined && existsSync('server.properties')) {
  const props = Object.fromEntries(
    readFileSync('server.properties', 'utf8')
      .split(/\r?\n/)
      .filter((l) => l !== '' && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]),
  );
  if (props['enable-rcon'] === 'true') {
    rconPort = props['rcon.port'];
    rconPassword = props['rcon.password'];
  }
}
const rconDelay = Number(opt('rcon-delay', Math.max(0, doneAfter - 20)));

const players = new Set();
let stopping = false;
let logStream;
if (logDir !== undefined) {
  mkdirSync(path.join(logDir, 'logs'), { recursive: true });
  logStream = path.join(logDir, 'logs', 'latest.log');
  writeFileSync(logStream, '');
}

function ts() {
  const d = new Date();
  const hms = d.toTimeString().slice(0, 8);
  if (!modern) return `[${hms}]`;
  const months = [
    'janv.',
    'févr.',
    'mars',
    'avr.',
    'mai',
    'juin',
    'juil.',
    'août',
    'sept.',
    'oct.',
    'nov.',
    'déc.',
  ];
  return `[${String(d.getDate()).padStart(2, '0')}${months[d.getMonth()]}${d.getFullYear()} ${hms}.${String(d.getMilliseconds()).padStart(3, '0')}]`;
}
function log(message, level = 'INFO', thread = 'Server thread') {
  const line = modern
    ? `${ts()} [${thread}/${level}] [net.minecraft.server.MinecraftServer/]: ${message}`
    : `${ts()} [${thread}/${level}]: ${message}`;
  process.stdout.write(`${line}\n`);
  if (logStream) appendFileSync(logStream, `${line}\n`);
}

function exit(code) {
  setTimeout(() => process.exit(code), 20);
}

function crash() {
  log('Encountered an unexpected exception', 'ERROR');
  log('java.lang.IllegalStateException: fake crash', 'ERROR');
  mkdirSync('crash-reports', { recursive: true });
  const name = `crash-${new Date().toISOString().replace(/[:.]/g, '-')}-server.txt`;
  writeFileSync(
    path.join('crash-reports', name),
    '---- Minecraft Crash Report ----\nDescription: fake crash\n',
  );
  log('This crash report has been saved to: ' + path.resolve('crash-reports', name), 'ERROR');
  exit(1);
}

function doStop() {
  if (stopping) return;
  stopping = true;
  log('Stopping the server');
  log('Stopping server');
  log('Saving players');
  log('Saving worlds');
  setTimeout(() => {
    log("Saving chunks for level 'ServerLevel[world]'/minecraft:overworld");
    log('ThreadedAnvilChunkStorage: All dimensions are saved');
    for (const s of rconSockets) s.destroy();
    rconServer?.close();
    gameServer?.close();
    exit(0);
  }, stopDelay);
}

function runCommand(cmd) {
  const [name, ...rest] = cmd.trim().replace(/^\//, '').split(/\s+/);
  switch (name) {
    case 'stop':
      if (ignoreStop) {
        log('stop ignored (--ignore-stop)', 'WARN');
        return 'stop ignored';
      }
      doStop();
      return 'Stopping the server';
    case 'say': {
      const msg = rest.join(' ');
      log(`[Server] ${msg}`);
      return '';
    }
    case 'list': {
      const names = [...players];
      let text = `There are ${names.length} of a max of 20 players online: ${names.join(', ')}`;
      if (bigResponse > 0) text = text.padEnd(bigResponse, 'x');
      log(text);
      return text;
    }
    case 'crash':
      crash();
      return '';
    case 'join': {
      for (const p of rest) join(p);
      return '';
    }
    case 'leave': {
      for (const p of rest) leave(p);
      return '';
    }
    case 'sleep': {
      // commande bloquante (test de timeout RCON)
      const until = Date.now() + Number(rest[0] ?? 1000);
      while (Date.now() < until) {
        /* bloque */
      }
      return 'slept';
    }
    case 'accent':
      log('Accents : éèàç — ok');
      return 'éèàç';
    default:
      log(`Unknown or incomplete command, see below for error`, 'INFO');
      return 'Unknown or incomplete command, see below for error\n' + cmd + '<--[HERE]';
  }
}

function join(name) {
  if (players.has(name)) return;
  players.add(name);
  log(
    `UUID of player ${name} is 069a79f4-44e9-4726-a5be-fca90e38aaf5`,
    'INFO',
    'User Authenticator #1',
  );
  log(`${name}[/127.0.0.1:54321] logged in with entity id 123 at (0.5, 64.0, 0.5)`);
  log(`${name} joined the game`);
}
function leave(name) {
  if (!players.delete(name)) return;
  log(`${name} lost connection: Disconnected`);
  log(`${name} left the game`);
}

// --- RCON (Source) ------------------------------------------------------------------------------
let rconServer;
const rconSockets = new Set();
function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(buf.length - 4, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}
function startRcon() {
  if (rconPort === undefined) return;
  rconServer = net.createServer((sock) => {
    rconSockets.add(sock);
    sock.on('close', () => rconSockets.delete(sock));
    sock.on('error', () => undefined);
    let acc = Buffer.alloc(0);
    let authed = false;
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0);
        if (acc.length < 4 + len) break;
        const id = acc.readInt32LE(4);
        const type = acc.readInt32LE(8);
        const body = acc.subarray(12, 4 + len - 2).toString('utf8');
        acc = acc.subarray(4 + len);
        if (type === 3) {
          if (body === String(rconPassword)) {
            authed = true;
            sock.write(encode(id, 2, ''));
          } else {
            sock.write(encode(-1, 2, ''));
          }
        } else if (type === 2) {
          if (!authed) {
            sock.write(encode(-1, 2, ''));
            continue;
          }
          const out = runCommand(body);
          // Fragmentation à 4096 octets comme Minecraft
          const buf = Buffer.from(out, 'utf8');
          if (buf.length === 0) sock.write(encode(id, 0, ''));
          for (let i = 0; i < buf.length; i += 4096)
            sock.write(encode(id, 0, buf.subarray(i, i + 4096).toString('utf8')));
        } else {
          sock.write(encode(id, 0, `Unknown request ${type.toString(16)}`));
        }
      }
    });
  });
  rconServer.listen(Number(rconPort), '0.0.0.0', () => {
    log(`RCON running on 0.0.0.0:${rconPort}`, 'INFO', 'RCON Listener #1');
  });
}

// --- Port de jeu ---------------------------------------------------------------------------------
let gameServer;
if (gamePort !== undefined) {
  gameServer = net.createServer(() => undefined);
  gameServer.on('error', (e) => {
    log(`**** FAILED TO BIND TO PORT! ${e.message}`, 'WARN');
    exit(1);
  });
  gameServer.listen(Number(gamePort), '0.0.0.0');
}

// --- Cycle de vie --------------------------------------------------------------------------------
log('Starting minecraft server version 1.20.1');
log('Loading properties');
if (eula) {
  log('Failed to load eula.txt', 'WARN');
  log(
    'You need to agree to the EULA in order to run the server. Go to eula.txt for more info.',
    'INFO',
  );
  exit(0);
} else {
  log('Default game type: SURVIVAL');
  log(`Starting Minecraft server on *:${gamePort ?? 25565}`);
  log('Preparing level "world"');
  log('Preparing start region for dimension minecraft:overworld');
  log('Preparing spawn area: 0%');
  setTimeout(startRcon, rconDelay);
  setTimeout(() => {
    log('Preparing spawn area: 100%');
    log('Time elapsed: 1234 ms');
    log(`Done (${(doneAfter / 1000).toFixed(3).replace('.', ',')}s)! For help, type "help"`);
    setTimeout(() => {
      for (const p of joins) join(p);
    }, 100);
    if (crashAfter !== undefined) setTimeout(crash, Number(crashAfter));
    if (exitAfter !== undefined) {
      setTimeout(() => {
        log('Stopping the server (external)');
        exit(0);
      }, Number(exitAfter));
    }
  }, doneAfter);
}

// stdin : commandes ; l'EOF ne tue pas le serveur (spike n°1)
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() ?? '';
  for (const line of lines) if (line.trim() !== '') runCommand(line);
});
process.stdin.on('end', () => {
  log(
    'stdin closed (EOF) — console thread ended, server continues',
    'INFO',
    'Server console handler',
  );
});
process.stdin.on('error', () => undefined);
process.stdout.on('error', () => undefined);
const hold = opt('hold', undefined);
if (hold !== undefined) setTimeout(() => exit(0), Number(hold));
// Maintient l'event loop vivante même sans stdin ni serveur (comme le thread principal Java).
setInterval(() => undefined, 60_000);
