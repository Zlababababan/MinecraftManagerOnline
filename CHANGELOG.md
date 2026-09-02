# Changelog

What changed in each release, written for the people who download it. The section for a tag becomes
the release notes on GitHub — a release fails to publish if its section is missing.

Releases before 1.0.5 have their notes on the [releases page](https://github.com/Zlababababan/MinecraftManagerOnline/releases)
only; 1.0.2 and 1.0.3 are marked as pre-releases because their Linux panel archives were unusable.

## Unreleased

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
