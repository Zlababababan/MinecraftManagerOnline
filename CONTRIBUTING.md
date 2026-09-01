# Contributing to MinecraftManagerOnline

**English** · [Français](CONTRIBUTING.fr.md)

Project conventions, settled in phase 1 (doc 07). The design reference remains `docs/` (in French): this file only sets the working rules. For a map of the codebase in English, start with [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

- **Node.js 24 LTS** (version pinned in `.node-version`; absolute floor 22.12). A version manager (`fnm`, `nvm`, `pnpm env`) reads `.node-version`.
- **pnpm 11** (version pinned in `package.json › packageManager`; `corepack enable` or a global install).
- Java is only needed for manual tests against real servers — CI does not need it (fake Java server, doc 03 §9).

## Commands

```bash
pnpm install            # install the whole workspace
pnpm build              # build every package (Turborepo, dependency order respected)
pnpm typecheck          # tsc --noEmit everywhere
pnpm lint               # ESLint everywhere
pnpm test               # Vitest everywhere
pnpm check              # build + typecheck + lint + test
pnpm format             # Prettier --write; `pnpm format:check` in CI
```

A targeted command: `pnpm --filter @mmo/panel test`, `pnpm --filter @mmo/web dev`.

Front-end development: `pnpm --filter @mmo/panel dev` (API on 127.0.0.1:3000) then `pnpm --filter @mmo/web dev` (Vite on 5173, proxying `/api` and `/ws`). In production the panel serves `apps/web/dist` (`pnpm build`). E2E: `pnpm --filter @mmo/web e2e` (Playwright, Chromium via `pnpm --filter @mmo/web exec playwright install chromium` the first time; builds the front end, launches a real panel + agent + fake Java server). The `whitelist.spec.ts` scenario (phase 6) reads the e2e server's files on disk: do not run it in parallel with another run. The `backups.spec.ts` scenario (phase 8) creates then deletes archives in the e2e agent's temporary state folder. The `phase9.test.ts` integration test (panel + two agents) redirects the panel's outbound calls (Temurin/Zulu APIs) to a fake local provider: no Internet access required. The phase 10 tests (`access.test.ts`) open an HTTPS listener on 127.0.0.1 with a test CA and a local reverse proxy: no Internet access, no calls to DuckDNS/Cloudflare/Let's Encrypt (everything is simulated through the injected `fetch`). The agent tests launch a PowerShell sidecar and a "burner" process on Windows (`monitoring/sampler.test.ts`): `pnpm check` can be CPU-noisy for ~20 s.

## Layout

```
apps/panel      Fastify 5, ws, Drizzle, web-push; serves the built front end + the agent artifacts
apps/web        React 19 + Vite PWA (Mantine, TanStack, xterm)
apps/agent      universal esbuild bundle (CJS) + launcher — NO native modules
packages/protocol   Zod schemas of the protocol + typed RPC client/server
packages/shared     fr/en i18n, MC→Java mapping, log parsing, detection heuristics
packages/config     shared tsconfig / ESLint / Prettier
docs/               design docs (source of truth, in French) + docs/spikes/ (validation notes)
```

All packages are ESM (`"type": "module"`), **strict** TypeScript (`@mmo/config/tsconfig.base.json`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`…). Internal imports carry the `.js` extension.

## Non-negotiable rules (tool-checked where possible)

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Where                                          | Checked by                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **No native module in the agent** (universal bundle, same artifact for every OS/arch)                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/agent`                                   | ESLint `no-restricted-imports` + `main.test.ts` scanning `dist/agent.js` (`.node`, `process.dlopen`, `bindings`, `node-gyp-build`)       |
| **Never `.strict()` on a protocol schema** — the protocol evolves by addition, an N/N-1 peer ignores unknown fields                                                                                                                                                                                                                                                                                                                                                                                            | `packages/protocol`                            | ESLint `no-restricted-syntax`                                                                                                            |
| **The protocol only evolves by addition** (optional fields, new types); any break = `PROTOCOL_VERSION` bump + N-1 support panel-side                                                                                                                                                                                                                                                                                                                                                                           | `packages/protocol`                            | review + contract tests (phase 2)                                                                                                        |
| **i18n from the very first string**: no hard-coded visible text in the front end nor in pushes; errors are **codes**, the UI translates                                                                                                                                                                                                                                                                                                                                                                        | `apps/web`, `apps/panel`, `packages/shared`    | review; `no-console` as an error in `apps/web`                                                                                           |
| **A merged migration is never modified**: add a new one instead (Drizzle, committed SQL)                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/panel`                                   | review; "migrations replayed from scratch" tests (phase 4)                                                                               |
| **Timestamps = epoch milliseconds**, everywhere (DB, protocol, API)                                                                                                                                                                                                                                                                                                                                                                                                                                            | everywhere                                     | Zod schemas                                                                                                                              |
| **Never `ZSTD_c_nbWorkers`** (silent data loss, spike #3); the integrity of an archive or transfer rests on **sha256 + size**, never on the codec                                                                                                                                                                                                                                                                                                                                                              | `apps/agent`, `packages/shared`, `apps/panel`  | ESLint `no-restricted-syntax` (phase 8); backup tests (tampered archive refused)                                                         |
| **Pinned versions** (`save-exact`), no dependency published less than 3 days ago (pnpm `minimumReleaseAge`), postinstall scripts allow-listed (`allowBuilds`)                                                                                                                                                                                                                                                                                                                                                   | `pnpm-workspace.yaml`, `.npmrc`                | pnpm                                                                                                                                     |
| The panel is the authority on server identifiers                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `apps/panel`                                   | doc 04                                                                                                                                   |
| **The agent launcher is frozen** (`apps/agent/launcher/launcher.cjs`: CommonJS, zero dependencies, never touches the network, never updated by `agent.update`); **the signing private key never lives on the panel** (`tools/signing/`; the committed development key is replaced by an out-of-repo release key in phase 11)                                                                                                                                                                                     | `apps/agent`, `tools/signing`                  | review; `launcher.test.ts` (rollback with a broken bundle); `updater.test.ts` (invalid signature refused)                                |
| **Zero Tailscale API in the code** (doc 03 §5): the `tailscale` mode is limited to displaying `tailscale serve` and passively reading the `Tailscale-User-*` headers; **the panel never listens on `::`/`0.0.0.0`**, including the `direct` mode HTTPS listener (explicit address); **Web Push and ACME are home-grown** (`services/push/webpush.ts`, `services/access/acme.ts`) — any change is verified against the RFC 8291 vector and the fake ACME server (`test/acme-fake.ts`), never against Let's Encrypt production (staging selectable in the settings) | `apps/panel`                                   | review; `webpush.test.ts`, `acme.test.ts`, `access.test.ts`                                                                              |

## Phases and documentation

- **A phase = code + tests + amended docs + commit(s)** (doc 07, rule 1). Tests ship with the code, never "later".
- Any **deviation** from docs 03–06 is recorded in the relevant doc the moment it is decided (dedicated section or dated note), and summarized in `CLAUDE.md › État › Dérogations`.
- "Future" features from doc 02 are not built in 1.0, but every phase checks that it does not block them.

## Commits

- **In French**, present tense or infinitive, `Subject : description` format — the subject is the area touched (`Panel`, `Agent`, `Web`, `Protocol`, `Shared`, `CI`, `Docs`, `Spikes`, `Monorepo`…).
  Examples: `Protocol : schémas du jalon A (enveloppe, erreurs, console)`, `Agent : ré-adoption des serveurs après redémarrage`.
- One commit = one intention. Phase commits stay coherent (build and tests green at every commit).
- Git identity: the one configured locally on the repo (`MinecraftManagerOnline` / noreply address). No personal identity.

## Tests

| Level             | Tool                                          | Note                                                                                                                                    |
| ----------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unit              | Vitest (`*.test.ts` next to the code)         | fixtures copied from real folders for detection/parsing                                                                                  |
| Panel integration | Vitest + `fastify.inject` + temporary SQLite  |                                                                                                                                          |
| Agent integration | "fake Java server" (Node script)              | no Java in CI; phase 9: two in-process agents for the migration, fake JRE (`major=N` + injected probe), launcher with fake bundles       |
| E2E               | Playwright (from phase 5 on)                  | mobile + desktop, fr + en                                                                                                                |

CI (`.github/workflows/ci.yml`) runs format, build, typecheck, lint and tests on **windows / ubuntu / ubuntu-arm / macos**. A phase is only done when all four are green.

## Spikes

Validation notes live in `docs/spikes/` (one note per spike, reproducible scripts in `docs/spikes/scripts/`, outside the pnpm workspace). They are authoritative on the points they settle and are referenced from docs 03–06.

## Deliberately out of scope

These come up regularly, and they are all reasonable ideas. They are refused here on purpose, with
the reason — a refusal written down in advance is a policy, not a personal answer to your pull
request. If you disagree, open an issue and argue the case; what will not happen is a large branch
landing unannounced.

**Storage and runtime**

- _`node-sqlite3-wasm` as a safety net_ — measured: `PRAGMA journal_mode = WAL` silently stays on
  `delete`, there is no array mode, no transaction, and errors carry no code. A third code path
  exactly where support is hardest.
- _Waiting for an official `node:sqlite` driver in Drizzle_ — the published version has none.
  Waiting on upstream is not a strategy; twenty-five lines of hand-written session are.
- _musl build targets_ — Node publishes no official musl binary. With the native modules gone,
  Alpine is served by the Docker image or by the distribution's own Node.

**Distribution**

- _Panel self-update like the agent's launcher_ — an XL restructuring of the archive plus a new
  failure surface at startup, for something updated three times a year by one command.
- _`.deb`, Homebrew, winget packages_ — three channels to re-test at every release, for a need the
  one-command installer and Docker already cover.
- _A published OpenAPI specification_ — the contract deliberately puts `/api` out of scope for
  compatibility. Publishing it would freeze a surface we want to keep free.
- _CycloneDX SBOM_ — close to zero value for this audience. An hour's work the day an organization
  actually evaluates the project, and not before.

**Backups and integrations**

- _S3 / Backblaze destinations_ — roughly 200 lines of SigV4 to maintain for a need that replicating
  to another machine on the tailnet already covers, for free.
- _SFTP_ — no acceptable SSH stack without a heavy dependency. The honest escape hatch is an
  optional post-backup command passed as argv, never through a shell, for people who already run
  `rclone` or `restic`.
- _A two-way Discord bot_ — it depends entirely on per-server permissions to be safe, and adds a
  permanent connection to maintain. Outgoing webhooks cover 80% of the value for 20% of the cost.
- _SMTP e-mail notifications_ — writing an SMTP client that tolerates real-world servers is a pit
  with no bottom, while push already works, encrypted and localized.

**Project and community**

- _A public demo instance, or a read-only mode_ — a server to run and defend, for a project whose
  whole promise is self-hosting. A 15-second GIF and `docker compose up` give 90% of the value.
- _A generated documentation site_ — GitHub renders the 21 pages correctly as they are. Half a day
  the day the demand shows up.
- _Translating the application into five languages_ — the translated docs diverged within five days,
  without a single outside contributor. The signal to wait for is a native speaker contributing at
  least once; it has not happened yet.
- _Weblate / Crowdin_ — one more integration to maintain, for zero volunteer translators.
- _Rewriting git history_ — it breaks every clone and every commit reference while repairing
  nothing: what is in the history stays in forks and caches.

**Product scope**

- _Writing a world map renderer_ — BlueMap already does it for every loader we target. The only
  legitimate piece of work is an "install the map" button plus a proxy so the map inherits the
  panel's authentication.
- _Automatic modpack updates_ — merging user configuration silently breaks worlds. A separate piece
  of work, not something to bolt onto installation.
- _Multi-panel federation, a marketplace, a plugin system_ — none of it helps someone hosting for
  their friends, and each one is maintenance for life.
- _Wake-on-LAN_ — the magic packet requires another machine on the same subnet to have an agent
  online. In the real use case, there is usually nobody there to send it.

**Tooling**

- _A blocking coverage threshold in CI_ — mostly noise on plumbing files. Publishing the report as
  an artifact is the useful part.
- _Adding the `doctor` codes to the protocol error codes_ — those are closed enums crossing the
  protocol; widening them for codes that never travel over the wire would break parsing on an N-1
  peer for nothing.
