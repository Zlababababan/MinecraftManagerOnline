<#
MinecraftManagerOnline — installation de l'agent sous Windows (service via shawl, compte de l'utilisateur).
Compatible Windows PowerShell 5.1 et PowerShell 7.

  & ([scriptblock]::Create((irm https://<panel>/install.ps1))) -PairCode MMOP-XXXX

Paramètres :
  -PairCode CODE        code d'appairage (page « Ajouter une machine » du panel)
  -Panel URL            URL du panel (défaut : celle qui a servi ce script)
  -Archive FICHIER      installation hors ligne depuis mmo-agent-<v>-win-x64.zip
  -InstallDir DIR       dossier d'installation (défaut : %LOCALAPPDATA%\Programs\mmo-agent)
  -StateDir DIR         état de l'agent (défaut : %LOCALAPPDATA%\mmo-agent)
  -ServiceAccount User|LocalSystem   identité du service (défaut : User = votre compte, mot de passe demandé)
  -NoService            fichiers seulement (pas de service, pas d'élévation)
  -Uninstall [-Purge]   arrête et supprime le service et les fichiers (-Purge : l'état aussi)

Le service est installé avec shawl (https://github.com/mtkennerly/shawl) : à l'arrêt, shawl envoie Ctrl+C à
l'agent puis ne tue que ce processus — jamais l'arbre complet — les serveurs Minecraft (détachés) survivent.
#>
[CmdletBinding()]
param(
  [string]$PairCode = '',
  [string]$Panel = '__PANEL_URL__',
  [string]$Archive = '',
  [string]$InstallDir = '',
  [string]$StateDir = '',
  [ValidateSet('User', 'LocalSystem')][string]$ServiceAccount = 'User',
  [switch]$NoService,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ServiceName = 'mmo-agent'
$Platform = 'win-x64'

$InstallLog = Join-Path $env:TEMP 'mmo-install.log'

function Say([string]$m) { Write-Host "[mmo] $m" }
function Fail([string]$m) { Write-Host "[mmo] ERREUR : $m" -ForegroundColor Red; if ($Elevated) { Read-Host 'Appuyez sur Entrée pour fermer' }; exit 1 }
# Toute erreur non prévue (la fenêtre élevée se fermerait sans message) : affichée, journalisée, pause.
trap { Fail "$($_.Exception.Message) ($($_.InvocationInfo.PositionMessage -replace '\s+', ' '))" }
if ($Elevated) { try { Start-Transcript -Path $InstallLog -Force | Out-Null } catch { } }

if ($Panel -like '__*' -or $Panel -eq '') {
  if (-not $Uninstall -and $Archive -eq '') { Fail "URL du panel inconnue : passez -Panel https://…" }
}
$Panel = $Panel.TrimEnd('/')
if ($InstallDir -eq '') { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\mmo-agent' }
if ($StateDir -eq '') { $StateDir = Join-Path $env:LOCALAPPDATA 'mmo-agent' }
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') { Say "Windows ARM64 : l'agent x64 fonctionnera sous émulation (aucune archive ARM64 Windows)" }
elseif ($arch -ne 'AMD64') { Fail "architecture non prise en charge : $arch" }

# --- Élévation (service) -----------------------------------------------------------------------
if (-not $IsAdmin -and -not $NoService) {
  Say "droits administrateur requis pour $(if ($Uninstall) { 'supprimer' } else { 'installer' }) le service : une fenêtre d'élévation va s'ouvrir…"
  $self = Join-Path $env:TEMP 'mmo-install.ps1'
  $body = $MyInvocation.MyCommand.ScriptBlock.ToString()
  if ($MyInvocation.MyCommand.Path) { Copy-Item $MyInvocation.MyCommand.Path $self -Force } else { Set-Content -Path $self -Value $body -Encoding UTF8 }
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$self`"", '-Elevated', '-Panel', "`"$Panel`"", '-InstallDir', "`"$InstallDir`"", '-StateDir', "`"$StateDir`"", '-ServiceAccount', $ServiceAccount)
  if ($PairCode) { $argList += @('-PairCode', $PairCode) }
  if ($Archive) { $argList += @('-Archive', "`"$Archive`"") }
  if ($Uninstall) { $argList += '-Uninstall' }
  if ($Purge) { $argList += '-Purge' }
  $shell = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
  $p = Start-Process -FilePath $shell -ArgumentList $argList -Verb RunAs -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail "l'opération élevée a échoué (code $($p.ExitCode)) — journal : $InstallLog" }
  if ($Uninstall) { Say 'désinstallation terminée' } else { Say "terminé — la machine apparaît dans le panel sous quelques secondes" }
  exit 0
}

function Get-ServiceSafe { Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }
function Stop-AgentService {
  $s = Get-ServiceSafe
  if ($s -and $s.Status -ne 'Stopped') { Say "arrêt du service $ServiceName"; Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue; $s.WaitForStatus('Stopped', '00:01:00') }
}

# --- Désinstallation ------------------------------------------------------------------------------
if ($Uninstall) {
  Say "désinstallation ($InstallDir)"
  Stop-AgentService
  if (Get-ServiceSafe) { & sc.exe delete $ServiceName | Out-Null; Start-Sleep -Seconds 1 }
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  if ($Purge) { if (Test-Path $StateDir) { Remove-Item -Recurse -Force $StateDir }; Say "état supprimé ($StateDir) — les serveurs Minecraft eux-mêmes ne sont jamais touchés" }
  else { Say "état conservé dans $StateDir (ajoutez -Purge pour le supprimer)" }
  Say 'désinstallation terminée'
  if ($Elevated) { Start-Sleep -Seconds 2 }
  exit 0
}

# --- Téléchargement / vérification --------------------------------------------------------------
$tmp = Join-Path $env:TEMP ("mmo-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  if ($Archive) {
    if (-not (Test-Path $Archive)) { Fail "archive introuvable : $Archive" }
    $zip = $Archive
    Say "installation hors ligne depuis $Archive"
  } else {
    try { $dist = Invoke-RestMethod -UseBasicParsing -Uri "$Panel/api/dist/$Platform" }
    catch { Fail "aucune archive $Platform publiée sur $Panel (Réglages → distribution) : $($_.Exception.Message)" }
    Say "téléchargement de l'agent $($dist.version) ($Platform, $([math]::Round($dist.size / 1MB)) Mo)…"
    $zip = Join-Path $tmp $dist.file
    Invoke-WebRequest -UseBasicParsing -Uri "$Panel/dist/$($dist.file)" -OutFile $zip
    $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    if ($actual -ne $dist.sha256) { Fail "empreinte sha256 incorrecte ($actual ≠ $($dist.sha256))" }
  }
  $x = Join-Path $tmp 'x'
  Expand-Archive -Path $zip -DestinationPath $x -Force
  $src = Join-Path $x 'mmo-agent'
  if (-not (Test-Path (Join-Path $src 'launcher.cjs'))) { Fail 'archive invalide (launcher.cjs absent)' }
  $manifest = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.platform -and $manifest.platform -ne $Platform) { Fail "archive $($manifest.platform) sur une machine $Platform" }

  # --- Fichiers ---------------------------------------------------------------------------------
  Stop-AgentService
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path $InstallDir -Parent) -Force | Out-Null
  $new = "$InstallDir.new"
  if (Test-Path $new) { Remove-Item -Recurse -Force $new }
  Move-Item $src $new
  if (Test-Path $InstallDir) {
    # Conserve les versions reçues par agent.update (rollback possible) ; le reste vient de l'archive.
    $oldVersions = Join-Path $InstallDir 'versions'
    if (Test-Path $oldVersions) { Copy-Item -Recurse -Force "$oldVersions\*" (Join-Path $new 'versions') -ErrorAction SilentlyContinue }
    $old = "$InstallDir.old"
    if (Test-Path $old) { Remove-Item -Recurse -Force $old }
    Move-Item $InstallDir $old
    Move-Item $new $InstallDir
    Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
  } else { Move-Item $new $InstallDir }
  $version = (Get-Content (Join-Path $InstallDir 'current.json') -Raw | ConvertFrom-Json).version
  $node = Get-ChildItem (Join-Path $InstallDir 'runtime') -Filter node.exe -Recurse | Sort-Object FullName | Select-Object -Last 1
  if (-not $node) { Fail "runtime Node absent de l'archive" }
  $nodeExe = $node.FullName
  $launcher = Join-Path $InstallDir 'launcher.cjs'
  Say "fichiers installés dans $InstallDir (agent $version, Node $(& $nodeExe --version))"

  # --- Appairage ---------------------------------------------------------------------------------
  $wsUrl = ($Panel -replace '^http://', 'ws://' -replace '^https://', 'wss://') + '/ws/agent'
  if ($PairCode) {
    Say "appairage avec $Panel…"
    & $nodeExe (Join-Path $InstallDir "versions\$version\agent.js") pair --panel $wsUrl --pair-code $PairCode --state-dir $StateDir
    if ($LASTEXITCODE -ne 0) { Fail 'appairage refusé — générez un nouveau code dans le panel et relancez la commande' }
  }

  # --- Service -----------------------------------------------------------------------------------
  if ($NoService) {
    Say 'pas de service (-NoService). Lancement manuel :'
    Say "  & `"$nodeExe`" `"$launcher`" run --panel $wsUrl --state-dir `"$StateDir`""
    exit 0
  }
  $shawl = Join-Path $InstallDir 'shawl.exe'
  $logs = Join-Path $InstallDir 'logs'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  if (Get-ServiceSafe) { & sc.exe delete $ServiceName | Out-Null; Start-Sleep -Seconds 1 }
  & $shawl add --name $ServiceName --cwd $InstallDir --log-dir $logs --stop-timeout 60000 --restart -- $nodeExe $launcher run --panel $wsUrl --state-dir $StateDir
  if ($LASTEXITCODE -ne 0) { Fail "shawl add a échoué (code $LASTEXITCODE)" }
  & sc.exe description $ServiceName "MinecraftManagerOnline agent" | Out-Null
  & sc.exe config $ServiceName start= auto | Out-Null
  & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null

  if ($ServiceAccount -eq 'User') {
    $userName = "$env:USERDOMAIN\$env:USERNAME"
    Say "le service tournera sous votre compte ($userName) : mot de passe de session Windows requis"
    $cred = Get-Credential -UserName $userName -Message "Mot de passe Windows de $userName (service $ServiceName)"
    if (-not $cred) { Fail 'identifiants requis (ou relancez avec -ServiceAccount LocalSystem)' }
    if ($cred.GetNetworkCredential().Password -eq '') {
      # Windows refuse aux services d'ouvrir une session avec un mot de passe vide (erreur 1327, événement 7038).
      Say "mot de passe vide : Windows interdit aux services d'ouvrir une session sans mot de passe → le service tournera sous LocalSystem (définissez un mot de passe à votre compte puis relancez pour le faire tourner sous votre compte)"
      $ServiceAccount = 'LocalSystem'
    }
  }
  if ($ServiceAccount -eq 'User') {
    $account = $cred.UserName
    if ($account -notlike '*\*' -and $account -notlike '*@*') { $account = ".\$account" }
    # Droit « Ouvrir une session en tant que service » (SeServiceLogonRight) via secedit.
    try {
      $sid = (New-Object Security.Principal.NTAccount($cred.UserName)).Translate([Security.Principal.SecurityIdentifier]).Value
      $cfg = Join-Path $tmp 'secpol.cfg'
      & secedit.exe /export /cfg $cfg /areas USER_RIGHTS | Out-Null
      $lines = Get-Content $cfg
      $idx = [array]::FindIndex($lines, [Predicate[string]]{ param($l) $l -like 'SeServiceLogonRight*' })
      if ($idx -ge 0) { if ($lines[$idx] -notlike "*$sid*") { $lines[$idx] = $lines[$idx] + ",*$sid" } }
      else { $lines += "SeServiceLogonRight = *$sid" }
      if ($lines -notcontains '[Privilege Rights]') { $lines += '[Privilege Rights]'; $lines += "SeServiceLogonRight = *$sid" }
      Set-Content -Path $cfg -Value $lines -Encoding Unicode
      & secedit.exe /configure /db (Join-Path $tmp 'secpol.sdb') /cfg $cfg /areas USER_RIGHTS | Out-Null
    } catch { Say "impossible d'accorder SeServiceLogonRight automatiquement ($($_.Exception.Message)) : secpol.msc → Attribution des droits utilisateur" }
    $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    $r = Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments @{ StartName = $account; StartPassword = $cred.GetNetworkCredential().Password }
    if ($r.ReturnValue -ne 0) { Fail "impossible de définir le compte du service (code WMI $($r.ReturnValue))" }
    # L'agent (sous votre compte) doit pouvoir écrire ses mises à jour dans le dossier d'installation : déjà le cas (profil utilisateur).
  }
  try { Start-Service -Name $ServiceName -ErrorAction Stop } catch {
    $hint = if ($ServiceAccount -eq 'User') { " — ouverture de session refusée pour $account ? (mot de passe incorrect, ou droit « Ouvrir une session en tant que service » non accordé : secpol.msc) ; relancez avec -ServiceAccount LocalSystem pour contourner" } else { '' }
    Fail "le service ne démarre pas : $($_.Exception.Message)$hint"
  }
  Start-Sleep -Seconds 3
  $s = Get-ServiceSafe
  if ($s.Status -ne 'Running') { Fail "le service ne démarre pas (état $($s.Status)) — journal : $logs" }
  Say "service $ServiceName installé et démarré (journal : $logs, état : $StateDir)"
  Say "terminé — la machine apparaît dans le panel sous quelques secondes"
  if ($Elevated) { Start-Sleep -Seconds 3 }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
