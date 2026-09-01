<#
MinecraftManagerOnline — icône de zone de notification du panel (près de l'horloge).
Rien à installer : Windows sait afficher une icône de notification (WinForms est livré avec .NET).

  powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File mmo-panel-tray.ps1

install-panel.ps1 crée le raccourci « MinecraftManagerOnline » du menu Démarrer qui lance ceci.
- clic gauche : ouvre l'interface dans le navigateur
- clic droit : Ouvrir, Journaux, Démarrer/Arrêter/Redémarrer, Démarrer avec Windows, Quitter

Une icône vit le temps d'une session ; un service tourne même déconnecté. Quand le service
Windows `mmo-panel` existe, l'icône le PILOTE (élévation UAC à chaque action de service) — elle ne
lance jamais un second panel. Sans service, elle lance le panel en processus enfant (données dans
data\ à côté du code, comme le mode console du guide §1.2) et « Quitter » l'arrête.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ServiceName = 'mmo-panel'
# Le script est livré dans <installation>\app\install\ : la racine est deux crans au-dessus.
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$SettingsPath = Join-Path $env:ProgramData 'mmo-panel\install.json'
$StartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'MinecraftManagerOnline.lnk'

$cfg = $null
if (Test-Path -LiteralPath $SettingsPath) { try { $cfg = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json } catch { } }
$Port = if ($cfg -and $cfg.port) { [int]$cfg.port } else { 3000 }
$PanelUrl = "http://127.0.0.1:$Port"
$DataDir = if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { Join-Path $env:ProgramData 'mmo-panel' } else { Join-Path $Root 'data' }

function Get-PanelService { Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }
function Invoke-ServiceAction([string]$verb) {
  # Piloter un service demande l'élévation : une fenêtre UAC par action, c'est le prix.
  $cmd = switch ($verb) {
    'start' { "Start-Service -Name $ServiceName" }
    'stop' { "Stop-Service -Name $ServiceName -Force" }
    'restart' { "Restart-Service -Name $ServiceName -Force" }
  }
  try { Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', $cmd) } catch { }
}

$script:child = $null
function Test-ChildAlive { $script:child -and -not $script:child.HasExited }
function Start-ChildPanel {
  if (Test-ChildAlive) { return }
  $node = Get-ChildItem (Join-Path $Root 'runtime') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
  if (-not $node) { return }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $node.FullName
  $psi.Arguments = "`"$(Join-Path $Root 'app\dist\main.js')`""
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['MMO_DATA_DIR'] = $DataDir
  $psi.EnvironmentVariables['MMO_WEB_DIR'] = Join-Path $Root 'web'
  $psi.EnvironmentVariables['MMO_DIST_DIR'] = Join-Path $Root 'dist-agent'
  $script:child = [Diagnostics.Process]::Start($psi)
}
function Stop-ChildPanel {
  # Arrêt abrupt assumé : le panel est conçu pour survivre à un arrêt brutal (SQLite en WAL),
  # exactement comme la fermeture de la fenêtre noire du mode console.
  if (Test-ChildAlive) { try { $script:child.Kill() } catch { } }
  $script:child = $null
}

function Get-PanelState {
  $svc = Get-PanelService
  if ($svc) { if ($svc.Status -eq 'Running') { 'running' } else { 'stopped' } }
  elseif (Test-ChildAlive) { 'running' }
  else { 'stopped' }
}

function Open-Panel { Start-Process $PanelUrl }
function Open-Logs {
  foreach ($dir in @((Join-Path $DataDir 'logs'), $DataDir)) {
    if (Test-Path -LiteralPath $dir) { Start-Process explorer.exe -ArgumentList "`"$dir`""; return }
  }
}

function Set-StartWithWindows([bool]$enabled) {
  if ($enabled) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($StartupLnk)
    $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($MyInvocation.ScriptName)`""
    $lnk.WorkingDirectory = $Root
    $lnk.Description = 'MinecraftManagerOnline'
    $lnk.Save()
  } elseif (Test-Path -LiteralPath $StartupLnk) {
    Remove-Item -LiteralPath $StartupLnk -Force
  }
}

# --- Icône et menu -----------------------------------------------------------------------------
$icon = New-Object Windows.Forms.NotifyIcon
$icon.Icon = [Drawing.SystemIcons]::Application
$icon.Visible = $true

$menu = New-Object Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('Ouvrir le panel')
$miLogs = $menu.Items.Add('Journaux')
$menu.Items.Add('-') | Out-Null
$miStart = $menu.Items.Add('Démarrer')
$miStop = $menu.Items.Add('Arrêter')
$miRestart = $menu.Items.Add('Redémarrer')
$menu.Items.Add('-') | Out-Null
$miStartup = New-Object Windows.Forms.ToolStripMenuItem('Démarrer avec Windows')
$miStartup.CheckOnClick = $true
$menu.Items.Add($miStartup) | Out-Null
$menu.Items.Add('-') | Out-Null
$miQuit = $menu.Items.Add('Quitter')
$icon.ContextMenuStrip = $menu

function Update-Ui {
  $svc = Get-PanelService
  $state = Get-PanelState
  $mode = if ($svc) { 'service' } else { 'session' }
  $icon.Text = "MinecraftManagerOnline — $(if ($state -eq 'running') { 'en marche' } else { 'arrêté' }) ($mode)"
  $miStart.Enabled = $state -ne 'running'
  $miStop.Enabled = $state -eq 'running'
  $miRestart.Enabled = $state -eq 'running'
  $miStartup.Checked = Test-Path -LiteralPath $StartupLnk
  $miQuit.Text = if (-not $svc -and $state -eq 'running') { 'Quitter (arrête le panel)' } else { "Quitter l'icône" }
}

$miOpen.add_Click({ Open-Panel })
$icon.add_MouseClick({ param($s, $e) if ($e.Button -eq [Windows.Forms.MouseButtons]::Left) { Open-Panel } })
$miLogs.add_Click({ Open-Logs })
$miStart.add_Click({ if (Get-PanelService) { Invoke-ServiceAction 'start' } else { Start-ChildPanel }; Update-Ui })
$miStop.add_Click({ if (Get-PanelService) { Invoke-ServiceAction 'stop' } else { Stop-ChildPanel }; Update-Ui })
$miRestart.add_Click({ if (Get-PanelService) { Invoke-ServiceAction 'restart' } else { Stop-ChildPanel; Start-Sleep -Seconds 1; Start-ChildPanel }; Update-Ui })
$miStartup.add_Click({ Set-StartWithWindows $miStartup.Checked })
$miQuit.add_Click({
  Stop-ChildPanel
  $icon.Visible = $false
  $icon.Dispose()
  [Windows.Forms.Application]::Exit()
})
$menu.add_Opening({ Update-Ui })

# Rafraîchit l'infobulle toutes les 10 s (le service peut bouger sans nous).
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 10000
$timer.add_Tick({ Update-Ui })
$timer.Start()

# Sans service ni panel en marche : en lancer un tout de suite — c'est le geste attendu quand on
# clique « MinecraftManagerOnline » dans le menu Démarrer.
if (-not (Get-PanelService) -and -not (Test-ChildAlive)) { Start-ChildPanel }
Update-Ui

[Windows.Forms.Application]::Run()
