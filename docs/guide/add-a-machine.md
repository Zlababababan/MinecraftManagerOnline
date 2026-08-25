# Add a machine

**English** · [Français](fr/ajouter-une-machine.md) · [Español](es/add-a-machine.md) · [Deutsch](de/add-a-machine.md) · [Português](pt/add-a-machine.md) · [Русский](ru/add-a-machine.md) · [中文](zh/add-a-machine.md)

A **machine** = a computer that hosts Minecraft servers, driven by an agent. The panel host itself can be one (the most common case: everything runs on the gaming PC).

## 1. Create the machine and get the command

1. Panel → **Machines** → **Add a machine**, give it a name.
2. The panel shows a **pairing code** (`MMOP-XXXX-XXXX`, valid for 15 minutes, single use) and the full command for Windows and for Linux/macOS.
3. Paste the command on the target machine — see [Installation § 2](installation.md#2-the-agents) for the details of what it does.
4. The machine turns `online` in the panel. If the code has expired, **New pairing code** generates another one (the machine's previous codes are invalidated); run the command again.

The command contains the panel's public URL: double-check it (Settings → General) if the target machine is not on the same network as you.

## 2. Detect servers

On the machine page: **Watched directories** → add the parent folder of your servers (e.g. `E:\Minecraft\Server`, `/srv/minecraft`). The agent scans (Forge, NeoForge, Fabric, Vanilla; 1.12 → 1.21+) and **automatically adopts** every detected server, with its loader, version and RAM — the periodic scan runs on its own, **Scan now** forces an immediate pass, and **Add a server folder** registers a specific folder without waiting. Everything stays editable afterwards on the server page (hand-tweaked packs sometimes fool the heuristics — the source of each detected value is shown). Nothing is modified on disk at adoption, except enabling RCON (`server.properties`, generated password), which is required to control the server in detached mode.

Java: the agent inventories the JREs present; if the required version is missing, install it from the **Java runtimes** card of the machine page (**Install this runtime** button — Temurin, otherwise Zulu, downloaded and verified automatically).

## 3. First server start

Start the server from its card (dashboard) or its page, and watch the state go `starting` → `running` (PID shown). The **Console** tab shows the lines live and accepts commands. On the first start of a fresh server, if the Mojang EULA has not been accepted yet, the panel walks you through it (explanation, link, checkbox), then you start again. Everything else lives in the server page tabs: **Players** (whitelist, ops, bans — without ever opening a file), **Configuration** (`server.properties` explained field by field), **Files**, **Backups**, **Metrics**, **Scheduler**, **Logs**.

## 4. Addresses for players

Each server has an **Exposure** setting (**Player access** card, Overview tab of the server page):

- **Tailnet**: your friends install Tailscale and join your tailnet (node sharing or invitation); the address to give them is the machine's `100.x.y.z` IP (or MagicDNS name) + port.
- **Direct**: public address — your domain if the machine is the panel host in direct mode, otherwise the machine's global IPv6 (or the public host you enter on the machine page, "Addresses for players" card). Open the server's port (IPv6 pinhole on the box + the rule shown in Settings → Remote access → Firewall rules).

Players on the same local network need nothing: LAN address + port, whatever the mode. The card's **Test reachability** button performs a real _Server List Ping_ from the panel host (version, players, MOTD): this is what a Minecraft client will see.

## 5. Several machines

- Servers can be **migrated** from one machine to another (**Migration** card of the Overview tab → **Migrate to another machine**): pre-checks on the target (disk space, Java, port), direct agent-to-agent transfer or relayed through the panel, switch-over, and the old folder is renamed `.migrated-<date>`.
- **Backups** have a per-server destination (local, or a shared/mounted folder), policy-based rotation, one-click restore.
- Agent updates: Settings → General → "Update agents automatically when they connect", or manually from the machine page (Agent card). An agent that does not come back healthy within 30 s rolls itself back to the previous version.

## 6. Remove a machine

Machine page → **Remove machine**: it disappears from the panel (servers and files stay intact on disk). On the machine itself: `install.ps1 -Uninstall` / `install.sh --uninstall` ([Installation § 2](installation.md#2-the-agents)).
