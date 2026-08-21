/**
 * Informations sur un processus pour la ré-adoption (doc 05 §4, doc 03 §1) : vivant ? heure de
 * démarrage ? ligne de commande ? — sans module natif.
 *   - Windows : PowerShell `Get-CimInstance Win32_Process` (sans wmic, 24H2+) ;
 *   - Linux : `/proc/<pid>/stat` (champ starttime) + `/proc/stat` (btime) + `/proc/<pid>/cmdline` ;
 *   - macOS : `ps -o lstart=,command=`.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface ProcessInfo {
  pid: number;
  startedAt: number | undefined;
  cmdline: string | undefined;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = existe mais pas le droit de signaler ⇒ vivant.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `undefined` si le processus n'existe pas ; champs `undefined` si l'OS ne les fournit pas. */
export async function getProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  if (!isProcessAlive(pid)) return undefined;
  try {
    if (process.platform === 'win32') return await windowsInfo(pid);
    if (process.platform === 'linux') return await linuxInfo(pid);
    if (process.platform === 'darwin') return await darwinInfo(pid);
    return { pid, startedAt: undefined, cmdline: undefined };
  } catch {
    return { pid, startedAt: undefined, cmdline: undefined };
  }
}

function run(file: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) reject(error instanceof Error ? error : new Error('process query failed'));
        else resolve(stdout);
      },
    );
  });
}

async function windowsInfo(pid: number): Promise<ProcessInfo> {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}'`,
    'if ($null -eq $p) { exit 2 }',
    '$ms = [DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()',
    '[Console]::Out.Write("$ms`n$($p.CommandLine)")',
  ].join('; ');
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
  const nl = out.indexOf('\n');
  const first = (nl === -1 ? out : out.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : out.slice(nl + 1).trim();
  const startedAt = Number(first);
  return {
    pid,
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : undefined,
    cmdline: rest === '' ? undefined : rest,
  };
}

async function linuxInfo(pid: number): Promise<ProcessInfo> {
  const [stat, statAll, cmdlineRaw] = await Promise.all([
    readFile(`/proc/${String(pid)}/stat`, 'utf8'),
    readFile('/proc/stat', 'utf8'),
    readFile(`/proc/${String(pid)}/cmdline`, 'utf8').catch(() => ''),
  ]);
  // Le nom du processus (champ 2) peut contenir des espaces : on repart de la dernière ')'.
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const startTicks = Number(after[19]); // champ 22 (1-based) = starttime, en ticks depuis le boot
  const btime = Number(/^btime (\d+)/m.exec(statAll)?.[1]);
  const hz = 100; // CLK_TCK (sysconf) : 100 sur toutes les distributions courantes
  const startedAt =
    Number.isFinite(startTicks) && Number.isFinite(btime)
      ? btime * 1000 + Math.round((startTicks * 1000) / hz)
      : undefined;
  const cmdline = cmdlineRaw
    .split('\0')
    .filter((s) => s !== '')
    .join(' ');
  return { pid, startedAt, cmdline: cmdline === '' ? undefined : cmdline };
}

async function darwinInfo(pid: number): Promise<ProcessInfo> {
  const out = await run('ps', ['-o', 'lstart=,command=', '-p', String(pid)]);
  const line = out.trim();
  if (line === '') return { pid, startedAt: undefined, cmdline: undefined };
  // `Thu Aug 22 10:11:12 2026 /usr/bin/java -jar …`
  const m = /^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
  if (!m) return { pid, startedAt: undefined, cmdline: line };
  const parsed = Date.parse(m[1] ?? '');
  return {
    pid,
    startedAt: Number.isFinite(parsed) ? parsed : undefined,
    cmdline: m[2] === '' ? undefined : m[2],
  };
}

export interface IdentityCheck {
  startedAt: number;
  cmdlineKey: string;
  /** Tolérance sur l'heure de démarrage (défaut 5 s : arrondis OS, horloge). */
  toleranceMs?: number;
}

export type IdentityVerdict =
  | { alive: false }
  | { alive: true; matches: true; verified: boolean }
  | { alive: true; matches: false; reason: 'start_time' | 'cmdline' };

/**
 * Le PID désigne-t-il encore notre processus ? Vérifie l'heure de démarrage et la présence de la
 * clé de ligne de commande quand l'OS les fournit ; `verified: false` si rien n'était vérifiable.
 */
export async function verifyProcessIdentity(
  pid: number,
  expected: IdentityCheck,
): Promise<IdentityVerdict> {
  const info = await getProcessInfo(pid);
  if (!info) return { alive: false };
  let verified = false;
  if (info.startedAt !== undefined) {
    verified = true;
    const tolerance = expected.toleranceMs ?? 5000;
    if (Math.abs(info.startedAt - expected.startedAt) > tolerance) {
      return { alive: true, matches: false, reason: 'start_time' };
    }
  }
  if (info.cmdline !== undefined && expected.cmdlineKey !== '') {
    verified = true;
    const haystack = normalizeCmdline(info.cmdline);
    if (!haystack.includes(normalizeCmdline(expected.cmdlineKey))) {
      return { alive: true, matches: false, reason: 'cmdline' };
    }
  }
  return { alive: true, matches: true, verified };
}

function normalizeCmdline(s: string): string {
  return s.replace(/\\/g, '/').replace(/"/g, '').toLowerCase();
}
