<#
MinecraftManagerOnline — installation du PANEL sous Windows (service via shawl).
Compatible Windows PowerShell 5.1 et PowerShell 7.

  & ([scriptblock]::Create((irm https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.ps1)))

Un seul copier-coller : téléchargement de la release GitHub, vérification sha256, code dans
%ProgramFiles%\mmo-panel (remplacé à chaque mise à jour), données dans %ProgramData%\mmo-panel
(jamais touchées), service Windows (démarrage automatique différé), attente de /api/health.
Relancer la même commande met à jour (sauvegarde d'abord, retour arrière si la nouvelle version
ne démarre pas). Les choix (-Port, -DataDir…) sont mémorisés dans install.json et relus.

Paramètres :
  -Archive FICHIER      installation hors ligne depuis mmo-panel-<v>-win-x64.zip
  -Version X.Y.Z        installe cette version précise (défaut : la dernière release)
  -InstallDir DIR       dossier du code (défaut : %ProgramFiles%\mmo-panel)
  -DataDir DIR          dossier des données (défaut : %ProgramData%\mmo-panel)
  -Port N               port d'écoute (défaut : 3000)
  -ListenHost ADRESSE   adresse d'écoute (défaut : 127.0.0.1)
  -MigrateFrom DIR      copie les données d'une ancienne installation (son dossier data\, ou lui)
                        vers -DataDir, avec integrity_check — l'ancienne n'est jamais modifiée
  -ServiceAccount LocalSystem|User   identité du service (défaut : LocalSystem ; User si les
                        sauvegardes visent un lecteur réseau — mot de passe demandé)
  -Repo OWNER/NAME      dépôt GitHub source (défaut : Zlababababan/MinecraftManagerOnline)
  -NoService            fichiers seulement (pas de service, pas d'élévation)
  -Uninstall [-Purge]   arrête et supprime le service et le code (-Purge : les données aussi)
#>
[CmdletBinding()]
param(
  [string]$Archive = '',
  [string]$Version = '',
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [int]$Port = 0,
  [string]$ListenHost = '',
  [string]$MigrateFrom = '',
  [ValidateSet('LocalSystem', 'User')][string]$ServiceAccount = '',
  [string]$Repo = 'Zlababababan/MinecraftManagerOnline',
  [switch]$NoService,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ServiceName = 'mmo-panel'
$Platform = 'win-x64'
$ReleaseBase = "https://github.com/$Repo/releases"
$StartMenuLnk = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\MinecraftManagerOnline.lnk'

$InstallLog = Join-Path $env:TEMP 'mmo-panel-install.log'

function Say([string]$m) { Write-Host "[mmo] $m" }
function Fail([string]$m) { Write-Host "[mmo] ERREUR : $m" -ForegroundColor Red; if ($Elevated) { Read-Host 'Appuyez sur Entrée pour fermer' }; exit 1 }
# Toute erreur non prévue (la fenêtre élevée se fermerait sans message) : affichée, journalisée, pause.
trap { Fail "$($_.Exception.Message) ($($_.InvocationInfo.PositionMessage -replace '\s+', ' '))" }
if ($Elevated) { try { Start-Transcript -Path $InstallLog -Force | Out-Null } catch { } }

if ($InstallDir -eq '') { $InstallDir = Join-Path $env:ProgramFiles 'mmo-panel' }
if ($DataDir -eq '') { $DataDir = Join-Path $env:ProgramData 'mmo-panel' }
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') { Say "Windows ARM64 : le panel x64 fonctionnera sous émulation (aucune archive ARM64 Windows)" }
elseif ($arch -ne 'AMD64') { Fail "architecture non prise en charge : $arch" }

# Choix mémorisés de l'installation précédente (le service est recréé à chaque mise à jour :
# c'est ce fichier qui fait que -Port ou -DataDir n'ont pas à être répétés).
$SettingsPath = Join-Path $DataDir 'install.json'
$prevSettings = $null
if (Test-Path $SettingsPath) { try { $prevSettings = Get-Content $SettingsPath -Raw | ConvertFrom-Json } catch { } }
if ($Port -eq 0) { if ($prevSettings -and $prevSettings.port) { $Port = [int]$prevSettings.port } else { $Port = 3000 } }
if ($ListenHost -eq '') { if ($prevSettings -and $prevSettings.host) { $ListenHost = [string]$prevSettings.host } else { $ListenHost = '127.0.0.1' } }
if ($ServiceAccount -eq '') { if ($prevSettings -and $prevSettings.serviceAccount) { $ServiceAccount = [string]$prevSettings.serviceAccount } else { $ServiceAccount = 'LocalSystem' } }

# --- Élévation (service) -----------------------------------------------------------------------
if (-not $IsAdmin -and -not $NoService) {
  Say "droits administrateur requis pour $(if ($Uninstall) { 'supprimer' } else { 'installer' }) le service : une fenêtre d'élévation va s'ouvrir…"
  $self = Join-Path $env:TEMP 'mmo-panel-install.ps1'
  $body = $MyInvocation.MyCommand.ScriptBlock.ToString()
  if ($MyInvocation.MyCommand.Path) { Copy-Item $MyInvocation.MyCommand.Path $self -Force } else { Set-Content -Path $self -Value $body -Encoding UTF8 }
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$self`"", '-Elevated', '-InstallDir', "`"$InstallDir`"", '-DataDir', "`"$DataDir`"", '-Port', $Port, '-ListenHost', "`"$ListenHost`"", '-ServiceAccount', $ServiceAccount, '-Repo', $Repo)
  if ($Archive) { $argList += @('-Archive', "`"$Archive`"") }
  if ($Version) { $argList += @('-Version', $Version) }
  if ($MigrateFrom) { $argList += @('-MigrateFrom', "`"$MigrateFrom`"") }
  if ($Uninstall) { $argList += '-Uninstall' }
  if ($Purge) { $argList += '-Purge' }
  $shell = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
  $p = Start-Process -FilePath $shell -ArgumentList $argList -Verb RunAs -Wait -PassThru
  if ($p.ExitCode -ne 0) { Fail "l'opération élevée a échoué (code $($p.ExitCode)) — journal : $InstallLog" }
  if ($Uninstall) { Say 'désinstallation terminée' } else { Say "terminé — le panel répond sur http://$($ListenHost):$Port" }
  exit 0
}

function Get-ServiceSafe { Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }
function Stop-PanelService {
  $s = Get-ServiceSafe
  if ($s -and $s.Status -ne 'Stopped') { Say "arrêt du service $ServiceName"; Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue; $s.WaitForStatus('Stopped', '00:01:00') }
}
function Remove-PanelService {
  if (Get-ServiceSafe) { & sc.exe delete $ServiceName | Out-Null; Start-Sleep -Seconds 1 }
}
function Find-NodeExe([string]$dir) {
  $n = Get-ChildItem (Join-Path $dir 'runtime') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
  if ($n) { $n.FullName } else { $null }
}
function Wait-Health([int]$seconds) {
  $url = "http://$(if ($ListenHost -match ':') { "[$ListenHost]" } else { $ListenHost }):$Port/api/health"
  for ($i = 0; $i -lt $seconds; $i++) {
    try { return Invoke-RestMethod -UseBasicParsing -Uri $url -TimeoutSec 3 } catch { Start-Sleep -Seconds 1 }
  }
  $null
}
function Show-ServiceLog {
  $log = Get-ChildItem (Join-Path $DataDir 'logs\service') -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($log) { Say "dernières lignes du journal du service ($($log.FullName)) :"; Get-Content $log.FullName -Tail 20 | ForEach-Object { Write-Host "  $_" } }
}

# --- Désinstallation ------------------------------------------------------------------------------
if ($Uninstall) {
  Say "désinstallation ($InstallDir)"
  Stop-PanelService
  Remove-PanelService
  foreach ($d in @($InstallDir, "$InstallDir.old", "$InstallDir.failed")) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
  # Raccourcis de l'icône de zone de notification (menu Démarrer + démarrage automatique).
  foreach ($lnk in @($StartMenuLnk, (Join-Path ([Environment]::GetFolderPath('Startup')) 'MinecraftManagerOnline.lnk'))) {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue }
  }
  if ($Purge) { if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }; Say "données supprimées ($DataDir) — les serveurs Minecraft eux-mêmes ne sont jamais touchés" }
  else { Say "données conservées dans $DataDir (ajoutez -Purge pour les supprimer)" }
  Say 'désinstallation terminée'
  if ($Elevated) { Start-Sleep -Seconds 2 }
  exit 0
}

# --- Téléchargement / vérification --------------------------------------------------------------
$tmp = Join-Path $env:TEMP ("mmo-panel-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $targetVersion = ''
  if ($Archive) {
    if (-not (Test-Path -LiteralPath $Archive)) { Fail "archive introuvable : $Archive" }
    $zip = $Archive
    Say "installation hors ligne depuis $Archive"
  } else {
    $dl = if ($Version) { "$ReleaseBase/download/v$Version" } else { "$ReleaseBase/latest/download" }
    try { $manifest = Invoke-RestMethod -UseBasicParsing -Uri "$dl/panel-$Platform.json" }
    catch { Fail "manifeste panel-$Platform.json introuvable sur $ReleaseBase : $($_.Exception.Message)" }
    $targetVersion = [string]$manifest.version
    Say "téléchargement du panel $targetVersion ($Platform, $([math]::Round($manifest.size / 1MB)) Mo)…"
    $zip = Join-Path $tmp $manifest.file
    Invoke-WebRequest -UseBasicParsing -Uri "$dl/$($manifest.file)" -OutFile $zip
    $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    if ($actual -ne $manifest.sha256) { Fail "empreinte sha256 incorrecte ($actual ≠ $($manifest.sha256))" }
  }
  $x = Join-Path $tmp 'x'
  # -LiteralPath : un chemin d'archive peut contenir des crochets, que -Path traiterait en glob.
  Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
  $src = Join-Path $x 'mmo-panel'
  if (-not (Test-Path (Join-Path $src 'app\dist\main.js'))) { Fail 'archive invalide (app\dist\main.js absent)' }

  # --- Ancien emplacement des données (rétrocompatibilité) --------------------------------------
  $prev = Test-Path $InstallDir
  $legacyData = $prev -and (Test-Path (Join-Path $InstallDir 'data\mmo.db'))
  $effectiveData = $DataDir
  if ($legacyData) {
    $effectiveData = Join-Path $InstallDir 'data'
    Say "ATTENTION : vos données vivent dans le dossier du code ($effectiveData)."
    Say "  Elles sont préservées à travers les mises à jour ; -MigrateFrom les déplacera quand vous voulez."
  }

  # --- Migration depuis une ancienne installation ------------------------------------------------
  if ($MigrateFrom) {
    $srcData = $MigrateFrom
    if (Test-Path -LiteralPath (Join-Path $MigrateFrom 'data\mmo.db')) { $srcData = Join-Path $MigrateFrom 'data' }
    if (-not (Test-Path -LiteralPath (Join-Path $srcData 'mmo.db'))) { Fail "pas de base dans $srcData (attendu : mmo.db, ou un dossier data\ qui la contient)" }
    if (Test-Path -LiteralPath (Join-Path $DataDir 'mmo.db')) { Fail "il y a déjà une base dans $DataDir — je refuse d'écraser" }
    if (Test-Path -LiteralPath (Join-Path $srcData 'mmo.db-wal')) {
      $wal = Get-Item -LiteralPath (Join-Path $srcData 'mmo.db-wal')
      if ($wal.Length -gt 0) { Fail "l'ancien panel semble encore tourner ($srcData\mmo.db-wal non vide) : arrêtez-le proprement puis relancez" }
    }
    Say "migration des données : $srcData → $DataDir (l'original n'est pas modifié)"
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    Get-ChildItem -LiteralPath $srcData -Force | Copy-Item -Destination $DataDir -Recurse -Force
    $nodeCheck = Find-NodeExe $src
    # Via un fichier : PowerShell 5.1 transmet mal les guillemets imbriqués d'un `-e` aux natifs.
    $checkJs = Join-Path $tmp 'integrity-check.js'
    Set-Content -Path $checkJs -Encoding Ascii -Value 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[2]);const r=db.prepare("PRAGMA integrity_check").get();db.close();if(String(Object.values(r)[0])!=="ok"){console.error(r);process.exit(1);}'
    & $nodeCheck $checkJs (Join-Path $DataDir 'mmo.db')
    if ($LASTEXITCODE -ne 0) { Fail "integrity_check en échec sur la copie — l'original ($srcData) n'a pas été touché" }
    $insideInstall = $srcData -eq $InstallDir -or $srcData.StartsWith(($InstallDir.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)
    if ($insideInstall) {
      Say "copie vérifiée (integrity_check ok) — l'original suivra l'ancien code dans $InstallDir.old\data (remplacé à la prochaine mise à jour)"
    } else {
      Say "copie vérifiée (integrity_check ok) — l'original n'est pas modifié, supprimez-le vous-même quand tout vous convient"
    }
    # Le service doit viser les données migrées, pas l'ancien emplacement détecté plus haut.
    $effectiveData = $DataDir
    $legacyData = $false
  }

  # --- Sauvegarde avant remplacement -------------------------------------------------------------
  Stop-PanelService
  if ($prev -and (Test-Path (Join-Path $effectiveData 'mmo.db'))) {
    $stamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
    $bak = Join-Path $effectiveData 'backups\panel'
    New-Item -ItemType Directory -Path $bak -Force | Out-Null
    Copy-Item (Join-Path $effectiveData 'mmo.db') (Join-Path $bak "mmo-pre-update-$stamp.db")
    foreach ($suffix in @('-wal', '-shm')) {
      $f = Join-Path $effectiveData "mmo.db$suffix"
      if (Test-Path $f) { Copy-Item $f (Join-Path $bak "mmo-pre-update-$stamp.db$suffix") }
    }
    Say "base sauvegardée (backups\panel\mmo-pre-update-$stamp.db)"
  }

  # --- Pose des fichiers (bascule, l'ancien reste en .old) ---------------------------------------
  New-Item -ItemType Directory -Path (Split-Path $InstallDir -Parent) -Force | Out-Null
  $new = "$InstallDir.new"
  if (Test-Path $new) { Remove-Item -Recurse -Force $new }
  Move-Item $src $new
  if ($prev) {
    $old = "$InstallDir.old"
    if (Test-Path $old) { Remove-Item -Recurse -Force $old }
    Move-Item $InstallDir $old
    Move-Item $new $InstallDir
    if ($legacyData -and (Test-Path (Join-Path $old 'data'))) { Move-Item (Join-Path $old 'data') (Join-Path $InstallDir 'data') }
  } else { Move-Item $new $InstallDir }
  $nodeExe = Find-NodeExe $InstallDir
  if (-not $nodeExe) { Fail "runtime Node absent de l'archive" }
  Say "fichiers installés dans $InstallDir (Node $(& $nodeExe --version))"

  function Undo-Swap {
    Say 'retour à la version précédente…'
    Stop-PanelService
    if (Test-Path "$InstallDir.failed") { Remove-Item -Recurse -Force "$InstallDir.failed" }
    Move-Item $InstallDir "$InstallDir.failed"
    Move-Item "$InstallDir.old" $InstallDir
    if ($legacyData -and (Test-Path (Join-Path "$InstallDir.failed" 'data'))) { Move-Item (Join-Path "$InstallDir.failed" 'data') (Join-Path $InstallDir 'data') }
  }

  # --- Fichiers seulement ------------------------------------------------------------------------
  if ($NoService) {
    # `mmo-panel.cmd` retombe sur <install>\data faute de MMO_DATA_DIR : lancé tel quel avec des
    # données ailleurs, il ouvre une base VIDE en silence. On écrit donc un lanceur qui les porte.
    $starter = Join-Path $InstallDir 'start-panel.cmd'
    $starterLines = @(
      '@echo off',
      'rem MinecraftManagerOnline - lanceur ecrit par install-panel.ps1.',
      'rem Il porte le dossier de DONNEES : sans lui, le panel en creerait un vide a cote du code.',
      'setlocal',
      "set ""MMO_DATA_DIR=$effectiveData""",
      "set ""MMO_HOST=$ListenHost""",
      "set ""MMO_PORT=$Port""",
      'call "%~dp0mmo-panel.cmd" %*'
    )
    Set-Content -LiteralPath $starter -Value $starterLines -Encoding Ascii
    Say "pas de service (-NoService). Lancement : `"$starter`""
    Say "  (il porte MMO_DATA_DIR=$effectiveData ; mmo-panel.cmd seul ouvrirait une base vide)"
    exit 0
  }

  # --- Service (shawl, recréé à chaque passage : le chemin du runtime est re-résolu) -------------
  New-Item -ItemType Directory -Path $effectiveData -Force | Out-Null
  $logs = Join-Path $effectiveData 'logs\service'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $shawl = Join-Path $InstallDir 'shawl.exe'
  if (-not (Test-Path $shawl)) { Fail 'shawl.exe absent de l''archive' }
  Remove-PanelService
  $mainJs = Join-Path $InstallDir 'app\dist\main.js'
  & $shawl add --name $ServiceName --cwd $InstallDir --log-dir $logs --stop-timeout 30000 --restart `
    --env "MMO_DATA_DIR=$effectiveData" --env "MMO_WEB_DIR=$InstallDir\web" --env "MMO_DIST_DIR=$InstallDir\dist-agent" `
    --env "MMO_HOST=$ListenHost" --env "MMO_PORT=$Port" `
    -- $nodeExe $mainJs
  if ($LASTEXITCODE -ne 0) { Fail "shawl add a échoué (code $LASTEXITCODE)" }
  & sc.exe description $ServiceName "MinecraftManagerOnline panel" | Out-Null
  & sc.exe config $ServiceName start= delayed-auto | Out-Null
  & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null

  if ($ServiceAccount -eq 'User') {
    $userName = "$env:USERDOMAIN\$env:USERNAME"
    Say "le service tournera sous votre compte ($userName) : mot de passe de session Windows requis"
    $cred = Get-Credential -UserName $userName -Message "Mot de passe Windows de $userName (service $ServiceName)"
    if (-not $cred) { Fail 'identifiants requis (ou relancez avec -ServiceAccount LocalSystem)' }
    if ($cred.GetNetworkCredential().Password -eq '') {
      # Windows refuse aux services d'ouvrir une session avec un mot de passe vide (erreur 1327).
      Say "mot de passe vide : le service tournera sous LocalSystem (définissez un mot de passe puis relancez pour le changer)"
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
  }

  try { Start-Service -Name $ServiceName -ErrorAction Stop } catch {
    Show-ServiceLog
    if ($prev) { Undo-Swap; Start-Service -Name $ServiceName -ErrorAction SilentlyContinue }
    Fail "le service ne démarre pas : $($_.Exception.Message)$(if ($prev) { ' — retour à la version précédente (la nouvelle est dans ' + $InstallDir + '.failed)' })"
  }

  # --- Attente de /api/health + vérification de version ------------------------------------------
  $health = Wait-Health 45
  $rolledBack = $false
  if (-not $health) { $rolledBack = $true; Say "le panel ne répond pas sur le port $Port" }
  elseif ($targetVersion -and [string]$health.version -ne $targetVersion) { $rolledBack = $true; Say "le panel répond en version $($health.version) au lieu de $targetVersion" }
  if ($rolledBack) {
    Show-ServiceLog
    if ($prev) {
      Undo-Swap
      Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
      $back = Wait-Health 30
      if ($back) { Fail "mise à jour annulée — retour à la version précédente réussi ($($back.version)). La version en échec est dans $InstallDir.failed" }
      Fail "la nouvelle version n'a pas démarré, et le retour arrière non plus — données intactes dans $effectiveData"
    }
    Fail "le panel n'a pas démarré — diagnostic : `$env:MMO_DATA_DIR = `"$effectiveData`" ; & `"$nodeExe`" `"$mainJs`" doctor"
  }

  # --- Choix mémorisés + raccourci + fin ---------------------------------------------------------
  @{ port = $Port; host = $ListenHost; serviceAccount = $ServiceAccount; installDir = $InstallDir } |
    ConvertTo-Json | Set-Content -Path $SettingsPath -Encoding UTF8
  # Menu Démarrer → « MinecraftManagerOnline » : l'icône de zone de notification (pilote le service).
  $tray = Join-Path $InstallDir 'app\install\mmo-panel-tray.ps1'
  if (Test-Path -LiteralPath $tray) {
    try {
      $shell = New-Object -ComObject WScript.Shell
      $lnk = $shell.CreateShortcut($StartMenuLnk)
      $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
      $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$tray`""
      $lnk.WorkingDirectory = $InstallDir
      $lnk.Description = 'MinecraftManagerOnline'
      $lnk.Save()
    } catch { Say "raccourci du menu Démarrer non créé ($($_.Exception.Message)) — lancez $tray à la main" }
  }
  Say "panel $($health.version) en service — http://$($ListenHost):$Port"
  Say "icône près de l'horloge : menu Démarrer → MinecraftManagerOnline (ouvrir, journaux, redémarrer)"
  Say ''
  Say 'depuis un autre appareil :'
  Say "  Tailscale : tailscale serve --bg --https=443 http://127.0.0.1:$Port"
  Say ''
  Say "compte administrateur (première installation) : ouvrez http://$($ListenHost):$Port dans le navigateur"
  Say "journal du service : $logs · données : $effectiveData · mise à jour : relancez ce script"
  if ($Elevated) { Start-Sleep -Seconds 3 }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
