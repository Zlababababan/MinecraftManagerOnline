// « Faux agent » : lance java détaché avec stdin/stdout/stderr pipés, note le PID, puis reste vivant.
// Le driver le tue brutalement (taskkill /F) pour simuler un crash de l'agent.
// usage: node fake-agent.mjs <cwd> <stdoutLog> <pidFile> <java> <args...>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [cwd, stdoutLog, pidFile, java, ...args] = process.argv.slice(2);
const out = fs.createWriteStream(stdoutLog, { flags: 'a' });
const child = spawn(java, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
fs.writeFileSync(pidFile, String(child.pid));
child.stdout.pipe(out, { end: false });
child.stderr.pipe(out, { end: false });
child.on('exit', (code, signal) => { out.write(`\n[fake-agent] java exited code=${code} signal=${signal}\n`); });
// On ne fait rien d'autre : on attend d'être tué.
setInterval(() => {}, 1 << 30);
