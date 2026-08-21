# Échantillonneur CPU par process basé sur les CYCLES (QueryProcessCycleTime), fiable même quand la
# comptabilité par ticks (GetProcessTimes / Win32_Process / pidusage / Task Manager) est faussée par Hyper-V.
# Protocole : une ligne JSON en entrée {"pids":[1,2]} → une ligne JSON en sortie
#   {"t":<ms epoch>,"mhz":<nominal>,"cores":<logiques>,"utility":<% global>,"procs":{"<pid>":{"cycles":..,"rss":..}|null}}
# Conçu pour tourner en session persistante (Windows PowerShell 5.1 ou pwsh 7), piloté par l'agent via stdin/stdout.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace Mmo -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool QueryProcessCycleTime(IntPtr hProcess, out ulong cycles);
'@
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$mhz = [int]$cpu.MaxClockSpeed
$cores = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$utilityCounter = New-Object System.Diagnostics.PerformanceCounter('Processor Information', '% Processor Utility', '_Total')
$null = $utilityCounter.NextValue()  # amorçage (la 1re lecture vaut toujours 0)
[Console]::Out.WriteLine('{"ready":true,"mhz":' + $mhz + ',"cores":' + $cores + '}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $req = $line | ConvertFrom-Json
  $procs = @{}
  foreach ($pid0 in $req.pids) {
    $p = Get-Process -Id $pid0
    if ($p) {
      $c = [uint64]0
      [void][Mmo.Native]::QueryProcessCycleTime($p.Handle, [ref]$c)
      $procs["$pid0"] = @{ cycles = $c; rss = $p.WorkingSet64 }
    } else { $procs["$pid0"] = $null }
  }
  $out = @{ t = [int64](([datetime]::UtcNow - [datetime]'1970-01-01').TotalMilliseconds); mhz = $mhz; cores = $cores; utility = [math]::Round($utilityCounter.NextValue(), 1); procs = $procs }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 3))
}
