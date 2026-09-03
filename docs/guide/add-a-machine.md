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

## 7. Backups

Server page → **Backups** tab. Two halves:

- **Archives**: create a backup now (works on a running server — the agent flushes the world with `save-all` first), download it, restore it in one click (a safety backup of the current state is taken by default), or delete it. Each archive shows its size, date and integrity hash. The agent also **re-reads every archive periodically** (one pass a day, oldest first, up to 8 GiB per pass, never while a backup or restore is running on that server) and the tab shows when each one was last verified. An archive that no longer matches its manifest is flagged **Corrupted**, with an event and a notification: delete it and take a new backup — do not restore from it.
- **Restore files…** (in the archive's menu): browse the archive without extracting it — the agent reads the tar headers on the machine — and tick the folders or files to bring back: one world, one region file, yesterday's `server.properties`. By default they land **next to** the current files, in a new `restored-<date>` folder inside the server folder: nothing is replaced, the server keeps running, and you move what you need from there (that folder is never backed up and never detected as a server; delete it when done). Choose _Replace the current files_ to restore in place: the selected paths are deleted and rewritten from the archive, the server is stopped first and a safety backup is taken by default. Needs an agent from 1.0.8 or newer; an older agent gets a clear "update the agent" message.
- **Policies**: scheduled backups executed **by the agent**, panel online or not. Pick the frequency and how many archives to keep (rotation never expires the most recent successful archive). "Only if running" skips a stopped server. Times follow the panel's schedule time zone, shown under the form.
- **Off-site copy**: pick another machine of the fleet, and every successful backup of this server (manual or scheduled) is copied there right after it is written — agent to agent when the two can reach each other, through the panel otherwise, resumable and verified (sha256). The copy keeps its own retention ("copies kept"), independent from the original's. Each archive shows where its copy lives; if the original disappears from the server's machine (rotation, lost disk), _Pull back from <machine>_ brings the copy home and the backup becomes restorable again. A destination that was offline catches up when it reconnects (the latest archive without a copy is sent). Deleting a backup deletes its reachable copies too.

A new server gets a default policy (daily, keep 7). If a scheduled backup fails or is skipped, the panel records it and can notify you — see the notification categories in your account settings. The destination folder is set in Settings → General (per-server override on the policy).

Two checks run **before** anything is written:

- **Free space.** The agent estimates the archive size (from the compression ratio of the previous archive of that server, plus a 64 MiB margin) and refuses when the destination does not have that much room — the error names the numbers. Nothing is written, and a running server is left saving normally.
- **Destination marker.** When you set a destination folder (other than the agent's own), the agent drops a small file, `.mmo-backups.json`, at its root. A backup is refused if that file is missing — typically a network drive or USB disk that is not mounted: without the check, the backup would land in the empty mount point on the system disk and everything would look fine until the day you need it. Mount the drive and retry. If the folder really is the right one (new disk, file deleted), create an empty file with that name at its root, or clear the destination in the settings, save, then set it again.

## 8. Duplicate a server

Server page → **Duplicate** (a dialog opens): the panel copies the server into a **new** server, on the same machine or another one. The typical case is a "template" server you clone on its own machine.

The original is never modified: if it was running, it is stopped for the duration of the copy then restarted automatically — whether the duplication succeeds or fails. The clone arrives **stopped**, with a "Copy" badge, its own identity, and a free game port picked automatically by the panel (change it later in Configuration if you prefer another). Its RCON is reassigned on its first start.

Under the hood this is the same mechanism as a migration (backup → transfer → restore): both machines must be online, and it takes about as long as a backup plus a restore. If something fails before the restore, nothing is created; if it fails after, the clone is kept and the error tells you what to check (the port, in particular).

## 9. Start groups

**Servers** page (fleet view) → **Groups** button (admin): create a group, add servers to it, and order them with the arrows. Servers that belong to a group show a group badge in the list.

**Start the group** launches the servers **one by one** in the chosen order, waiting for each one to be actually running before moving to the next; stopping walks the order in reverse. The series stops at the first failure and notifies you. Only one group action can run at a time on a given group.

Schedules do not target groups: for a scheduled start in sequence, stagger per-server schedules. If a Velocity proxy belongs to the group, put it last for start-up (the interface warns you if it is not): the servers should be ready by the time the proxy starts accepting players.

## 10. Velocity proxies

A folder containing a `velocity.toml` is recognized at scan time as a **Velocity proxy** and managed like a server: start, stop, console, logs.

A few differences are by design: no Minecraft version is shown (a proxy has none), no RCON and no TPS (the metrics panel explains why), the clean stop uses Velocity's `shutdown` command, the port and MOTD are read from `velocity.toml`, and there is no EULA to accept. Java 17 is used to launch it.

The machine's agent must be up to date to detect proxies — an older agent simply ignores them.

## 11. Share with friends: accounts limited to some servers

A friend who hosts one of the machines, or who only plays on one server, should not get the whole panel. Settings → Users has an **Access** column next to the role: **Whole panel** (the historical behaviour: the role applies everywhere) or **Chosen servers**. With the second, the **Servers…** button opens what the account can see:

- a **machine** grants every server on it, including servers detected later — the right choice for "he manages his own machine";
- a **server** grants that server only, and lets them open its machine page read-only (metrics, agent status);
- each line carries a role, **viewer** or **operator**, never above the role of the account: an account created as viewer stays a viewer everywhere.

Everything else does not exist for that account: not in the lists, not in the live updates, not in the console, not in the notifications, and a direct link to another server answers "not found" rather than "forbidden". Changing the access setting signs the account out (like a role change); changing the granted servers only reloads its open pages. Administrators always see everything and cannot be limited.

Group actions run on every server of the group, so a limited account can only launch a group when it is operator on each of its members.
