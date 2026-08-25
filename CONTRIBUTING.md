# Contributing to MinecraftManagerOnline

**English** · [Français](CONTRIBUTING.fr.md)

Project conventions, settled in phase 1 (doc 07). The design reference remains `docs/` (in French): this file only sets the working rules.

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
