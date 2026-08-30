# Installation

**English** · [Français](fr/installation.md) · [Español](es/installation.md) · [Deutsch](de/installation.md) · [Português](pt/installation.md) · [Русский](ru/installation.md) · [中文](zh/installation.md)

User guide — install the **panel** (a single machine, the one that stays on), then an **agent** on every machine that hosts Minecraft servers (often the same one). Everything ships as self-contained archives: no Node, Java or Python to install beforehand.

Packaged platforms: **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, ARM servers), **macOS Apple Silicon**. Windows ARM64 works with the x64 archive (emulation). Intel macOS is not packaged.

**Which Linux distributions?** Since 1.0.5 the panel contains no compiled module, so **any glibc-based distribution works**: Ubuntu 20.04 and later, Debian 11 and later, Fedora, Rocky/Alma/RHEL 9, openSUSE, Raspberry Pi OS, Oracle Linux, Arch… Nothing to install — no compiler, no development package. The one exception is **Alpine** and other musl-based systems, which the bundled Node runtime does not support: use a glibc distribution, or run the panel with your own Node ≥ 24 (`node app/dist/main.js` from the extracted folder).

## 1. The panel

### 1.1 Download

Open the [releases page](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest) and download the file that matches your machine:

| Your machine                                   | File to download                          |
| ---------------------------------------------- | ----------------------------------------- |
| Windows (any recent PC)                        | `mmo-panel-<version>-win-x64.zip`         |
| Linux on a normal PC or server                 | `mmo-panel-<version>-linux-x64.tar.gz`    |
| Linux on ARM (Raspberry Pi, Oracle/Ampere VM…) | `mmo-panel-<version>-linux-arm64.tar.gz`  |
| Mac with Apple Silicon (M1–M4)                 | `mmo-panel-<version>-darwin-arm64.tar.gz` |

Not sure which Linux you have? Run `uname -m`: `x86_64` means x64, `aarch64` means ARM64.

The archive is self-contained: it carries its own Node runtime, the panel, the web interface and the agent installers for all four platforms. **There is nothing to install beforehand** — no Node, no Java, no compiler, no development package.

> Want to check the download? Each release also publishes `panel-<platform>.json`, which contains the expected SHA-256. Compare it with `sha256sum <file>` (Linux/macOS) or `Get-FileHash <file>` (Windows).

### 1.2 Extract and launch

**Windows.** Right-click the `.zip` → **Extract All**, into a folder you intend to keep, for example `C:\mmo\panel` (avoid Downloads and the Desktop). Open that folder and double-click **`mmo-panel.cmd`**. A black window opens and stays open: that is the panel running, and closing it stops the panel — §1.4 turns it into a proper service. From a terminal:

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux.** In a terminal, in the folder where the file was downloaded:

```bash
tar -xzf mmo-panel-*.tar.gz
cd mmo-panel
./mmo-panel.sh
```

That is enough to try it out. For a machine that will keep running, put it somewhere permanent — and mind the `chown`, the mistake that costs the most time:

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
sudo chown -R "$USER" /opt/mmo/mmo-panel   # extracted as root — hand it to the user who launches it (§1.4 hands it to the mmo service user)
/opt/mmo/mmo-panel/mmo-panel.sh
```

**macOS** — same commands as Linux. On first launch macOS may refuse to run a downloaded binary: System Settings → Privacy & Security → "Open anyway".

> Something wrong? `mmo-panel.cmd doctor` (Windows) or `./mmo-panel.sh doctor` (Linux/macOS) checks the runtime, the data folder and its owner, the database and the port, and says what to do — see §1.6.

The panel listens on `http://127.0.0.1:3000` (never on all interfaces — the access layer, §3, is what exposes it; `0.0.0.0` is refused at startup). Useful variables: `MMO_PORT`, `MMO_HOST` (a specific address), `MMO_DATA_DIR` (default `./data` next to the script — **this is the folder to back up**: SQLite database, metrics, certificates, releases). Besides the console, the panel writes its log to `data/logs/panel-<date>.log` (14 days kept) — that is where to look when something went wrong after the window was closed.

### 1.3 First start

Open `http://127.0.0.1:3000`. On a headless machine (server, VM): either set up remote access first (§3 — install Tailscale, run the `tailscale serve` command, then open `https://<machine>.<tailnet>.ts.net` from another device) or use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 user@machine` then open `http://127.0.0.1:3000` locally). The wizard runs in two steps — **Administrator account** (username, password, language), then **Access**: the **public panel URL** (optional at this stage), the **access mode** (see §3) and the **default backup destination**. The public URL can be changed at any time in Settings → General: it is what gets injected into the agent install commands and into push notifications — set it as soon as your remote access is in place.

**Without a browser at all** (cloud VM, container, cloud-init), create the administrator account
from the command line instead — it is the very same code path as the wizard:

```bash
/opt/mmo/mmo-panel/mmo-panel.sh setup --username admin --random-password --public-url panel.example.net
```

The generated password is printed once. Use `--password-stdin` (`echo -n 'secret' | … setup
--username admin --password-stdin`) or `--password-file <file>` to choose it yourself — never pass
it as an argument, the command line is visible to every process on the machine. `--locale` and
`--access-mode` are optional. The command refuses to run twice.

### 1.4 Start at boot (service)

**Windows** (shawl ships in the archive) — in an **administrator** PowerShell:

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

The service then runs as `LocalSystem`; to run it under your own account (recommended if backups target a network drive), use `services.msc` → Log On, or adapt the agent procedure (§2.2). Environment variables (`MMO_PORT`…): `shawl add --env MMO_PORT=3000 …`.

> Important: `mmo-panel.cmd` sets `MMO_WEB_DIR` and `MMO_DIST_DIR`; with shawl, add them explicitly: `--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`.

**Linux** (systemd) — `/etc/systemd/system/mmo-panel.service`:

```ini
[Unit]
Description=MinecraftManagerOnline panel
After=network-online.target
Wants=network-online.target

[Service]
User=mmo
WorkingDirectory=/opt/mmo/mmo-panel
ExecStart=/opt/mmo/mmo-panel/mmo-panel.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home-dir /opt/mmo/mmo-panel --shell /usr/sbin/nologin mmo
sudo chown -R mmo /opt/mmo/mmo-panel
sudo systemctl daemon-reload && sudo systemctl enable --now mmo-panel
```

**macOS** (launchd) — `/Library/LaunchDaemons/com.mmo.panel.plist` with `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` and `KeepAlive` set to `true`, then `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Update the panel

Stop the service, extract the new archive **on top** (the `data/` folder is never inside the archive), restart. Database migrations run at startup. The new archive embeds same-version agents: the panel publishes the agent release automatically and, if "Update agents automatically when they connect" is checked (Settings → General — unchecked by default), each agent is updated at its next connection, with automatic rollback on failure. Otherwise, update them one by one from the Agent card of each machine page.

### 1.6 When the panel does not start: `doctor`

Before reading a stack trace, ask the panel what is wrong. It checks the runtime, the modules it
loads, the data directory (a **real** write, plus the owner compared with the current user), the
database, the port and the front-end.

```powershell
C:mmopanelmmo-panel.cmd doctor
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh doctor
```

Every line is prefixed with `ok`, `warn` or `ERROR`, and each error says what to do — including
the exact `chown` command when the archive was extracted with `sudo` and the panel runs as
another user. The command exits with 1 as soon as one check fails, so it can be used in a script.

### 1.7 Back up and restore the panel

The panel backs itself up once a day (consistent `VACUUM INTO` copy of its database) into `data/backups/panel/mmo-<date>.db`, 7 copies kept; Settings → Panel backups lets you create one on demand. Metrics (`metrics.db`) are not copied: they can be rebuilt and are large. Also back up the whole `data/` folder if you want to keep certificates and agent archives.

To **restore**: stop the panel (service or Ctrl+C), then:

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

A bare file name is enough for a copy sitting in `data/backups/panel/`; a full path is accepted too. The copy is verified (`integrity_check`), the current database is kept as `mmo.db.before-restore-<date>`, then the panel can be restarted: agents reconnect with their original secret and the servers they host are re-adopted with the same identifiers (`.mmo-server.json` marker). Whatever was created after the backup (users, paired machines, settings) is lost: a machine paired after the backup will have to be paired again. The restore refuses to run if `mmo.db-wal` is not empty (panel still running, or killed abruptly — start it then stop it cleanly and try again).

## 2. The agents

One agent per machine hosting servers. It connects **outbound** to the panel (WebSocket): no port to open on agent machines.

### 2.1 The one-line command

In the panel: **Machines → Add a machine**. The panel generates a pairing code (valid for 15 minutes) and the full command to paste on the target machine:

- **Windows** (PowerShell, any version):
  `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -PairCode MMOP-XXXX-XXXX`
- **Linux / macOS**:
  `curl -fsSL https://<panel>/install.sh | sh -s -- --pair-code MMOP-XXXX-XXXX`

The script downloads the right platform archive from the panel, verifies its SHA-256 hash, installs the files, **pairs** the agent (the error is immediate if the code has expired), then registers and starts the service. The machine shows up `online` in the panel within a few seconds.

> The panel must be reachable from the target machine (§3). Until the public URL is set, the command uses the address you opened the panel with.

### 2.2 What the script does — Windows

- Files in `%LOCALAPPDATA%\Programs\mmo-agent` (runtime, `launcher.cjs`, `versions/<v>/agent.js`, `shawl.exe`), state in `%LOCALAPPDATA%\mmo-agent`.
- The `mmo-agent` service is registered with **shawl**, automatic start; it runs **under your Windows account** (password asked once, in the elevated window that opens) so the agent can see your mapped drives and folders. To be precise: the account of the elevated window — if UAC makes you enter another administrator's credentials, that is the account the service will run under. The "Log on as a service" right is granted automatically (if that fails, the script continues and explains how to grant it with `secpol.msc`). Alternative: `-ServiceAccount LocalSystem`.
- **Account without a password** (session opened with a PIN or no password at all): Windows forbids services from logging on with an empty password. Confirm the empty prompt: the script says so and registers the service as `LocalSystem` (the agent then cannot see your mapped network drives). To switch back to your account: set a Windows password and run the command again.
- If something fails in the elevated window, the message stays on screen (Enter to close) and the details are in `%TEMP%\mmo-install.log`.
- The service restarts automatically if it crashes; clean stop = Ctrl+C forwarded to the agent, **never** the whole process tree: Minecraft servers survive the agent being stopped or updated, then get re-adopted.
- Options: `-NoService` (files only), `-InstallDir`, `-StateDir`, `-Panel`, `-Archive <zip>` (offline).
- Uninstall: `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -Uninstall` (add `-Purge` to also remove the state; Minecraft servers are never touched).

### 2.3 What the script does — Linux

- Files in `/opt/mmo-agent`, state in `/var/lib/mmo-agent`, system account `mmo` created if needed (`--user <name>` for another account — the agent must be able to read/write the server folders).
- `mmo-agent` systemd unit with `KillMode=process` (detached servers survive) and `Restart=on-failure`. `sudo` is requested when needed.
- **Without root**: `--user-service` installs into `~/.local/share/mmo-agent` (files in `app/`, state at the root) with `systemctl --user` and `loginctl enable-linger` (starts at boot without an open session). Careful: when run with `sudo`, `--user-service` is ignored and the system-wide install is performed.
- Options: `--no-service`, `--dir`, `--state-dir`, `--panel`, `--archive <tar.gz>` (offline).
- ⚠ **Permissions on your server folders.** Installed as a system service, the agent runs as `mmo`, not as you: servers kept under `/home/<you>/…` are often read-only to it. The panel warns you as soon as the server is adopted ("folder not writable"), and a refused start names the folder and the account. Two fixes, either one:
  - give the agent's account access: `sudo chown -R mmo /path/to/my-servers` (or `sudo chmod -R g+w` after `sudo usermod -aG <your-group> mmo`);
  - or install the agent under your own account: `--user <you>` (system service) or `--user-service` (no root).
- Uninstall: `curl -fsSL https://<panel>/install.sh | sh -s -- --uninstall [--purge]` (add `--user-service` if installed that way). The `mmo` system account is kept (`userdel mmo` if you no longer want it).
- Under **WSL**, the VM stops a few seconds after the last terminal closes: the service (and the servers) stop with it — WSL is fine for trying things out, not for hosting.

### 2.4 What the script does — macOS

Same logic: `/opt/mmo-agent`, `com.mmo.agent` LaunchDaemon (`KeepAlive`, `AbandonProcessGroup`: servers survive), account = the user running `sudo`. `--user-service` creates a LaunchAgent instead (starts at session login only). Log: `/var/lib/mmo-agent/agent.log`.

### 2.5 After the machine reboots

The service relaunches the agent; the agent re-adopts the servers still alive (PID + start time + command line) and, if "Restore desired state when an agent boots" is enabled (Settings → General), restarts the ones that were marked `running`.

### 2.6 Offline install

Download the platform archive from the panel (Settings → Agent distribution) or from the release, copy it along with the script (`install.ps1` / `install.sh` are also inside the archive) and run `install.ps1 -Archive <zip> -Panel https://<panel> -PairCode …` or `sh install.sh --archive <tar.gz> --panel https://<panel> --pair-code …` (the SHA-256 hash is only verified for an archive downloaded from the panel — a local archive is taken as-is).

## 3. Remote access (summary)

The panel only listens on `127.0.0.1`. To reach it from agents on other machines, from your friends and from your phone, pick a mode (Settings → Remote access):

| Mode                    | Who it is for                                              | What to do                                                                                                   |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Tailscale** (default) | Everyone, including behind CGNAT/4G                        | Install Tailscale on the panel host and on every client device, then run the `tailscale serve` command shown |
| **Direct**              | You have a public IPv6 and a domain (DuckDNS, Cloudflare…) | Enter domain + DNS provider, request the certificate (DNS-01), open port 443 (IPv6 pinhole on your box)      |
| **Manual**              | You already run a reverse proxy                            | Point it at `127.0.0.1:3000` with WebSocket support                                                          |

In every case, the **Reachability test** card (**Run the test** button, in Settings → Remote access) checks HTTP, WebSocket, binary frames (64 KiB) and the TLS certificate through the public URL. Details and troubleshooting: [Network FAQ](network-faq.md). Adding machines and addresses to give to players: [Add a machine](add-a-machine.md).

## 4. On your phone: install the PWA

The panel is an installable web app (PWA): once remote access is in place (§3 — installation requires HTTPS), open the public URL in your phone's browser and add the app to the home screen:

- **Android (Chrome)**: ⋮ menu → "Add to Home screen" (or "Install app" when offered).
- **iOS (Safari)**: Share button → "Add to Home Screen". On iOS this is **mandatory** to receive push notifications: they only work from the installed PWA, not from Safari.

The app then opens full screen, with the navigation at the bottom of the screen. For notifications (server crash, failed backup, agent offline…): Account page → Push notifications — enable them, pick the categories, and verify with the "Send a test" button. In Tailscale mode, the phone must have the Tailscale app installed and connected to the tailnet to reach the panel.
