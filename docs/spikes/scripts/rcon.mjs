// Client RCON minimal (protocole Source RCON) — suffisant pour les spikes.
import net from 'node:net';

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  buf.writeInt32LE(buf.length - 4, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

/** Exécute une commande RCON et résout avec la réponse texte. Rejette sur timeout/refus. */
export function rcon(port, password, command, { host = '127.0.0.1', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let acc = Buffer.alloc(0);
    let authed = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`rcon timeout (${command})`)); }, timeoutMs);
    const done = (err, val) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
    sock.on('error', (e) => done(e));
    sock.on('connect', () => sock.write(encode(1, SERVERDATA_AUTH, password)));
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0);
        if (acc.length < 4 + len) break;
        const id = acc.readInt32LE(4);
        const type = acc.readInt32LE(8);
        const body = acc.subarray(12, 4 + len - 2).toString('utf8');
        acc = acc.subarray(4 + len);
        if (!authed) {
          if (type === 2 && id === -1) return done(new Error('rcon auth refused'));
          if (type === 2 && id === 1) { authed = true; sock.write(encode(2, SERVERDATA_EXECCOMMAND, command)); }
          continue;
        }
        if (id === 2) return done(null, body);
      }
    });
  });
}
