# Changelog

What changed in each release, written for the people who download it. The section for a tag becomes
the release notes on GitHub — a release fails to publish if its section is missing.

Releases before 1.0.5 have their notes on the [releases page](https://github.com/Zlababababan/MinecraftManagerOnline/releases)
only; 1.0.2 and 1.0.3 are marked as pre-releases because their Linux panel archives were unusable.

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
