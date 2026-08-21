// Lecture CPU/RSS d'un PID — mesure indépendante des libs testées.
// Windows : CYCLES CPU (QueryProcessCycleTime via PowerShell + P/Invoke), car la comptabilité par ticks
// (GetProcessTimes / Win32_Process / Task Manager) est faussée sur les hôtes Hyper-V (cf. spike n°2).
import { spawnSync } from 'node:child_process';

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const PS_CYCLES = (pid) => `
$ErrorActionPreference='SilentlyContinue'
Add-Type -Namespace Mmo -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool QueryProcessCycleTime(IntPtr h, out ulong c);'
$p = Get-Process -Id ${pid}
if ($p) { $c = [uint64]0; [void][Mmo.Native]::QueryProcessCycleTime($p.Handle, [ref]$c); $mhz = (Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed; "$c $($p.WorkingSet64) $mhz" }`;

/** { cpuMs (équivalent ms d'UN cœur nominal), rssBytes } ou null si le process n'existe pas. */
export function procInfo(pid) {
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['-o', 'rss=,cputime=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout.trim()) return null;
    const [rssKb, cputime] = r.stdout.trim().split(/\s+/);
    const [h, m, s] = cputime.split(':').map(Number);
    return { cpuMs: ((h * 60 + m) * 60 + s) * 1000, rssBytes: Number(rssKb) * 1024 };
  }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_CYCLES(pid)], { encoding: 'utf8' });
  const out = r.stdout.trim();
  if (!out) return null;
  const [cycles, rss, mhz] = out.split(' ').map(Number);
  return { cpuMs: cycles / (mhz * 1e3), rssBytes: rss };
}

/** % CPU d'UN cœur (100 = un cœur saturé) sur une fenêtre, + RSS final. */
export async function sampleCpu(pid, windowMs) {
  const a = procInfo(pid); const t0 = Date.now();
  if (!a) return null;
  await new Promise((r) => setTimeout(r, windowMs));
  const b = procInfo(pid); const t1 = Date.now();
  if (!b) return null;
  return { cpuPctOneCore: Math.round(((b.cpuMs - a.cpuMs) / (t1 - t0)) * 1000) / 10, rssMb: Math.round(b.rssBytes / 1048576) };
}
