# Changelog

What changed in each release, written for the people who download it. The section for a tag becomes
the release notes on GitHub — a release fails to publish if its section is missing.

Releases before 1.0.5 have their notes on the [releases page](https://github.com/Zlababababan/MinecraftManagerOnline/releases)
only; 1.0.2 and 1.0.3 are marked as pre-releases because their Linux panel archives were unusable.

## Unreleased

### Share with friends without handing over the whole panel

Until now a role was global: giving a friend one server meant giving them the fleet, stop button
included. Settings → Users gains an **Access** column: _Whole panel_ (as before) or _Chosen
servers_, and a **Servers…** button that lists what the account may see — a whole machine (every
server on it, including those detected later), or single servers — each with a role, viewer or
operator, never above the role of the account.

For such an account everything else does not exist: it is not listed, not pushed over the live
connection, not shown in the notifications, and a link to another server answers "not found",
not "forbidden". Group actions require operator on every member; changing the access setting signs
the account out, changing the granted servers only reloads its pages. Administrators always see
everything.

### The database stops growing for no reason

The hourly maintenance now bounds every table. Four of them had no limit at all: the console
command history, player sessions, finished migrations and the records of deleted backups. Each
retention is a setting (Settings → General → _Retention_, in days), and the panel log reports what
was removed, table by table, at every pass — the number you want the day a database grows and
nobody knows why.

`mmo.db` never shrank: it now gets a full `VACUUM` once a week, between 3 and 6 in the morning
(schedule time zone), only when nothing is running and only after checking that the disk has room
for the rewrite. `metrics.db` returns its free pages to the file system every hour within a fixed
time budget, instead of the 200 pages a day it was limited to.

### The agent keeps a log, and can tell you what is wrong

The agent used to write only to its standard error, which ends up in a different place on every
system — or nowhere. It now keeps `logs/agent-<date>.log` next to its state (14 days, 32 MiB per
file). And the machine page has a **Diagnostic file** button (administrators): agent version and
runtime, servers as the agent sees them, running tasks, and the last 200 lines of that log, with
user names, tokens and addresses masked. Attach it to a bug report. Agents older than this release
answer that they do not support it — update them first.

### The panel log finally says what happened

Every API request now leaves one line in the panel log: request id, method, route, status, duration
and user — never the query string. A request slower than a second, or a 500, is logged as a
warning, and the id an internal error shows you is the one to search for in that log. The log also
records agent connections and scheduled actions. Administrators get more from `/api/health`:
uptime, current log file, database sizes and the last maintenance pass.

### A slow browser no longer costs the panel its memory

A browser tab that stopped reading (asleep, on a saturated link) kept every metrics sample and
console line queued in the panel's memory. Above 1 MiB waiting, those low-value messages are now
dropped — the next ones replace them; above 8 MiB the panel closes the socket and the tab
reconnects. States and events always get through. The agent applies the same rule towards the
panel. The public surfaces (agent downloads, install scripts, relay links, agent handshakes) are
now rate-limited per address, 120 requests a minute.

### What the panel keeps about players, and who it talks to

The guide gains a section listing every piece of data kept about people (players, accounts,
sessions, commands, clicks), where it lives and for how long, plus every outbound call the panel
or an agent makes. Two of those calls concern players and now have a switch in Settings →
Privacy: looking up player names at Mojang (agents only use the server's `usercache.json` when
off) and loading player avatars from mc-heads.net (initials instead). Agents older than this
release keep asking Mojang until updated.

### What the agent itself costs, and a panel that does not flood idle tabs

The machine page shows the agent's own footprint (resident memory, CPU) from its heartbeat, so
"the agent slows my server down" can be checked rather than guessed. An agent reconnecting after
an outage replays up to an hour of metrics; those replayed points no longer go to every open
browser tab (they are stored and shown by the graphs). Three measurements of the 56-server scale
test are now budgets that fail the build: the size of the server list, the number of SQL
statements it takes, and what an idle tab receives.

### Backups are re-read, not just written

A backup was only ever proven the day you restored it — too late to learn that the disk had
silently damaged it. The agent now re-reads its archives on its own: one pass a day, oldest and
never-verified archives first, up to 8 GiB per pass, never while a backup or restore is running on
that server. Each archive on the **Backups** tab shows when it was last verified, and an archive
that no longer matches its manifest is flagged **Corrupted**, with an event and a notification (same
category as a failed backup). The verdict is written next to the archive, so a panel that was
offline at the time learns it when the agent reconnects. Agents older than this release do not
verify anything: their archives simply show "not verified yet".

### The panel's own backup can be downloaded, and its failure is no longer silent

The daily copy of the panel was a bare database file on the same disk, not downloadable, and a
failure to write it was one warning line in a log nobody reads. It is now an archive,
`mmo-panel-<date>.tar.gz`, holding the database **and** the `tls/` folder (certificate, private
key, ACME account) — restored on another machine, a panel in direct mode works straight away — plus
a manifest. Settings → Panel backups lists the archives with their contents, creates one on demand
and **downloads** it (administrators; the card says it first: an archive contains the panel's
secrets, keep it private). If the daily backup fails, an event and a notification are raised once
per episode, the card shows the error and `/api/health` reports it. `mmo-panel restore` accepts the
new archives and the old `.db` copies alike, and puts `tls/` back when the archive carries it.

Also fixed: a response the agent could not deliver because the panel had just gone (or the other
way round) surfaced as an unhandled error instead of a log line — the CI caught it on Windows.

### A backup refuses to start when it cannot finish

A full disk used to be discovered after minutes of compression: a truncated archive, no manifest,
and a late error. The agent now estimates the archive first — from the compression ratio of the
previous archive of that server, plus a 64 MiB margin — and refuses before writing a byte when the
destination does not have that much room. The error names the numbers, and a running server is
left saving normally.

The second check is for the silent case. When you set a backup destination other than the agent's
own folder, the agent drops a marker file, `.mmo-backups.json`, at its root, and refuses to write
there if the marker is missing — a network drive or USB disk that is not mounted, typically.
Without it, backups landed in the empty mount point on the system disk and everything looked fine
until the day they were needed. The marker is written once, when the destination is set (or, for
agents updated to this release, at their first configuration); it is deliberately not recreated at
every reconnection. If the folder really is the right one, create an empty file with that name at
its root, or clear and set the destination again. Agents older than this release keep their
previous behaviour.

### Restore one world, or one file, from a backup

A restore used to be all or nothing: to get back a corrupted region or yesterday's
`server.properties`, the whole server folder was replaced. The archive's menu now has _Restore
files…_: the agent reads the archive's table of contents on the machine without extracting it,
and you tick the folders or files to bring back — a ticked folder brings back everything below it.

By default the files land next to the current ones, in a new `restored-<date>` folder inside the
server folder: nothing is replaced, the server keeps running, and you move what you need from
there. That folder is never backed up, never detected as a server, and survives a full restore;
delete it when you are done. Choose _Replace the current files_ to restore in place — the selected
paths are deleted and rewritten from the archive, the server is stopped first, and a safety backup
is taken by default, as for a full restore.

Every check happens before anything is touched: the archive must match its manifest, every path
you asked for must exist in it, paths the agent manages itself (logs, the trash, the marker file)
are refused outright, and the disk must have room. Agents older than this release answer "not
supported": the panel says so and asks you to update the agent.

### Notifications reach Discord, or any service of yours

Settings → Webhooks sends the panel's notifications outside: to a Discord channel (an embed per
event, coloured by severity, in the language you pick), or as signed JSON to a service you run —
n8n, Home Assistant, a script. A webhook chooses its categories from the same list as the bell and
the phone. Deliveries are retried on transient failures only; when a webhook stops delivering you
get one notification and the last error shows next to it, then one more when it recovers.

The panel refuses, on purpose, any address that is not public https: names of the local network
or the tailnet, and hosts resolving to private, loopback, link-local or Tailscale addresses — a
webhook must not become a door into the network the panel sits on. The JSON secret is shown once,
at creation; the guide explains how to verify the `x-mmo-signature` header.

### Backups get an off-site copy

Server page → Backups → _Off-site copy_: pick another machine of the fleet and every successful
backup of that server is copied there as soon as it is written — agent to agent when the two can
reach each other, through the panel otherwise, resumable and verified. The copy keeps its own
retention. Each archive shows where its copy lives; if the original disappears from the server's
machine (rotation, lost disk), _Pull back_ brings the copy home and the backup is restorable again.
A machine that was off catches up when it reconnects. Agents need this version to receive copies.

## 1.0.7 — 2026-09-01

A small release, mostly about being able to check what you downloaded and to report a problem
without guessing what to attach.

### Verify your download

Every release now publishes `SHA256SUMS.txt`. Download it next to your archive and check everything
in one command:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing      # Linux
shasum -a 256 -c SHA256SUMS.txt --ignore-missing  # macOS
```

On Windows, compare `Get-FileHash <file>` with the line that names your file. The per-platform
`panel-<platform>.json` manifests still carry the same hashes, one file at a time.

The archives also carry a **build provenance attestation**: GitHub signs the fact that these files
were produced by this repository, from this commit, by this workflow. Check it with
`gh attestation verify <file> --repo Zlababababan/MinecraftManagerOnline`. To be precise about what
this is not: the Ed25519 signature in the release protects the agent's auto-update chain, and has
never been something a human could verify. The attestation and the checksums are.

### Report a problem in one command

`mmo-panel report` writes a text file with what a bug report actually needs: versions on both sides,
platforms, the full `doctor` output, your machines and their agents, your settings without their
secrets, and a masked excerpt of the log. Personal paths, tokens and pairing codes are masked, and
server folders are never listed — read it before attaching it, then drop it into the new issue form.

```bash
/opt/mmo-panel/mmo-panel.sh report      # --stdout to print it, --no-log to leave the log out
```

### Fixes

- **Accessibility**: the role selector in Settings → Users had no label at all — a screen reader
  announced an anonymous list in the middle of a table of accounts. The audit log, the user list and
  the connection address on a phone could be scrolled with a mouse but not reached with a keyboard.
- **Interrupted downloads resume.** Installing a mod or a plugin from a URL used to restart from
  zero when the connection dropped; it now continues where it stopped, and retries by itself.
- Windows: a single slow start of the metrics collector no longer costs per-process memory and CPU
  until the agent is restarted (this one also shipped in 1.0.6).

## 1.0.6 — 2026-09-01

Install the panel with **one command**, on Linux or on Windows — and update it with the same one.

### Install

**Linux** (systemd — Ubuntu, Debian, Fedora, Raspberry Pi OS…):

```bash
curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
```

**Windows** (PowerShell — it asks for elevation itself):

```powershell
& ([scriptblock]::Create((irm https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.ps1)))
```

**Docker** (multi-arch, agents included) — the answer for Alpine/musl: `docker compose up -d`.

The archives still work exactly as before: download, extract, launch. Nothing to install first.

### What the installer does

Code in `/opt/mmo-panel` (`C:\Program Files\mmo-panel`), data in `/var/lib/mmo-panel`
(`C:\ProgramData\mmo-panel`), settings in `/etc/mmo-panel/panel.env` — never overwritten. It
downloads the right archive, checks its SHA-256, registers a hardened service and waits until the
panel actually answers.

Run the same command again to update: the database is backed up first, the code is swapped, the
service restarts — and if the new version does not answer, the previous one is put back. Data from
an existing manual install is detected and preserved; moving it is an explicit choice
(`--migrate-data`, `-MigrateFrom`), checked with `integrity_check`.

### Also in this release

- **A banner when a new version exists**, for administrators (GitHub releases feed, at most every
  6 hours; Settings → General turns the check off).
- **Windows: an icon next to the clock.** Left-click opens the interface, right-click drives the
  service — it never starts a second panel.
- **One access route per machine.** Tailscale for one machine, the direct address for another: the
  panel can answer on both at once, and each pairing code carries the right address.
- **Server duplication, start groups, Velocity proxies.**
- **Console macros**, and completion that asks the server itself what it accepts — modded commands
  included.
- **Schedules in an explicit time zone**, shown under the form.
- **Windows metrics no longer disappear**: a single slow start of the metrics collector used to cost
  per-process memory and CPU until the agent was restarted.

## 1.0.5 — 2026-08-30

No compiler, no prerequisites: the first release where "download, extract, launch" is true
everywhere.

- **The panel contains no compiled module.** SQLite now comes from the Node runtime (`node:sqlite`),
  which was the root cause of the failed install on an Ubuntu 20.04 ARM VM, and of the unusable
  Linux archives of 1.0.2 and 1.0.3. Every glibc-based distribution works, with nothing to install
  beforehand — Alpine and other musl systems remain out of scope for the bundled runtime.
- **`mmo-panel doctor`**: when the panel does not start, it checks the runtime, the data directory
  and its owner, the database, the port and the front-end, and each error says what to do —
  including the exact `chown` command after an archive extracted with `sudo`.
- **`mmo-panel setup`**: create the administrator account from the command line, for a machine with
  no browser (cloud VM, container, cloud-init).
- **The four `panel-<platform>.json` manifests are published**, so a download can be verified.
- Backups prove they ran (state columns, skipped-occurrence event, late-backup alert), alerts have
  state (a machine going down with twelve servers makes one notification, not thirteen), and
  schedules stopped drifting by two hours.
- Two bugs that the CI had been hiding are fixed: the TPS probe locked itself for ten minutes when
  RCON was not ready yet, and an agent update result could be erased before being recorded.
