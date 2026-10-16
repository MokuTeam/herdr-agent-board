# agent-board: TypeScript + Bun + React rework — design (phase 1 of 5)

Date: 2026-10-16 · Branch: `feature/ts-rework` (local commits only, never pushed)

## Intent

The owner wants to add features (Claude multi-profile, a plugin system, Slack / email / Jira
sources, a watcher agent). Before that, the codebase should have a clean structure, strict
types, and code that is easy for them to read. The branch is a proposal: the rest of the team
decides later whether to adopt it, so the board must behave exactly as it does on `main`.

## Roadmap (context; each later phase gets its own design before it is built)

1. **This document**: rework to TypeScript, Bun and React. Same behaviour.
2. Claude multi-profile: several Claude config dirs (`CLAUDE_CONFIG_DIR`), each possibly its own
   subscription; launch a session with a chosen profile; the board reads every profile.
3. Plugin core: contracts for sources (events in), actions (things done), notifiers; built-in
   integrations (herdr-wake first) moved behind them.
4. Source plugins: Slack mentions, then Jira assignments and email.
5. Watcher agent: receives source events, picks the project / profile / folder (or asks), hands
   the work to a running session or launches one, reports a summary, drafts (never sends) replies.

Phase 1 builds none of 2–5, but it must leave clean seams for them (see "Seams").

## Goals

- All code in TypeScript, `strict` on, run by Bun. Latest ES syntax Bun supports.
- Web board rewritten in React (TSX), bundled by Bun.
- Structure that follows SOLID / DRY / KISS: small modules with one job, shared domain types,
  side effects (herdr CLI, file system, HTTP, Claude's files) behind narrow adapters, pure logic
  separate and unit-tested.
- Every existing behaviour preserved (see "Parity").
- The existing test suite ported to `bun test` and green (except the 2 symlink tests noted below).

## Non-goals

- No new user-facing features, no UI redesign. The board should look and act the same.
- No plugin registry, no profiles, no new integrations yet (phases 2–5).
- No change to the agent-facing `board` command contract, the Claude hook output, or the
  status line output.

## Anti-goals (failure even if it "works")

- Behaviour drift a teammate would notice when switching between `main` and this branch.
- Data loss or format changes in existing state: cards, `config.json`, `board.json`, schedule,
  context / limits caches, `return.json`, launch drafts in the browser.
- A big-bang rewrite that is never green in between: work lands as small commits, tests passing
  at each one.
- Abstraction for its own sake (interfaces with one implementation and no foreseeable second
  one, frameworks inside frameworks). KISS beats speculative SOLID.

## Constraints

- **Runtime**: Bun (owner has 1.2.8; target `>=1.2`). Node is no longer required.
- **herdr plugin manifest** (`herdr-plugin.toml`): every command changes from `node …` to `bun …`.
  herdr runs `[[build]]` commands on `herdr plugin install` from GitHub (not on `plugin link`),
  with the plugin dir as cwd; add `[[build]] command = ["bun", "install", "--production"]` so
  React is present. Document that local `plugin link` users run `bun install` themselves.
- **Claude Code integration** written by the install action into `~/.claude/settings.json`:
  hooks and status line become `bun "<path>"`; the `board` shims in `~/.local/bin` (sh and
  `.cmd`) call `bun`. Install stays idempotent and recognises its old `node` entries as its own
  so it replaces rather than duplicates them.
- **Windows first-class** (owner is on Windows; Git Bash and PowerShell). Keep every existing
  Windows path (taskkill tree kill, `%APPDATA%` / `%LOCALAPPDATA%` dirs, `.cmd` shim, Edge app
  window, no-shell process spawning, refusal of `cmd`/`.bat`/`.cmd` launchers).
- **Paths and formats unchanged**: config under `%APPDATA%\herdr\plugins\config\agent-board`,
  state under `%LOCALAPPDATA%\herdr\plugins\agent-board` (and the non-Windows equivalents), same
  file names and JSON shapes.
- **HTTP surface unchanged**: port 12422, loopback only, every route, payload, header check
  (`X-Board`, `Origin`, `fsToken`), SSE event shapes, CSP on raw responses.
- **Languages**: English and Russian texts kept, same keys.
- **Commits**: local only; no AI attribution of any kind in commit messages or files.

## Decided by the owner

- Bun as runtime, package manager and test runner.
- TypeScript everywhere.
- React for the web board.
- Everything (all 5 phases) on this one branch, local commits only.
- **Parity target is frozen at `main` @ `94fdde6`** (what the branch was cut from). `main` keeps
  moving (≈43 commits on 2026-10-16 from three teammates); those changes are carried over **once,
  at the end of phase 1**, as a dedicated catch-up step: diff `94fdde6..origin/main`, port each
  change into the TS code, port their new tests. No incremental merging along the way.
- **Bun is installed natively** on the owner's machine (official installer, latest stable, a real
  `bun.exe` on PATH), replacing the npm-shim 1.2.8 that lives under nvm's Node folder. Minimum
  supported version is whatever that latest stable is at the time (≥ 1.2 features may be assumed).
- **The builder may install the plugin on the owner's machine for the manual parity run — with
  care**: back up `~/.claude/settings.json` and anything else touched before the first install,
  never remove the owner's own hooks or status line (the install keeps a status line set by
  someone else; the owner's existing hooks stay), check the result by diff, and record how to undo
  it. Install `main` @ `94fdde6` first to have a live baseline (cards, config, `node` entries),
  then the branch over it to check the upgrade path.

## Stack (builder's calls already made — owner can veto)

- **TypeScript**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `moduleResolution: "bundler"`, `target: "ESNext"`. Type-check with
  `tsc --noEmit` (Bun runs TS but does not type-check).
- **Lint / format**: Biome (one fast tool for both). One `bun run check` = tsc + biome.
- **React 19** + `react-dom`, function components and hooks only, no state library, no CSS-in-JS,
  no router. Shared state via a small context + `useReducer`; live data via an SSE hook.
- **Web bundling**: the server bundles `web/src/main.tsx` with `Bun.build` in memory at start and
  re-bundles when a file under `web/` changes (keeps today's "no build step" developer feel and
  the existing auto-reload of open pages). No committed build output.
- **CSS**: keep the existing stylesheets (≈1.8k lines) so the look is unchanged; split per
  component only where it falls out naturally. Class names may stay as they are.
- **HTTP**: `Bun.serve` with a small typed route table instead of `node:http`, as long as SSE,
  byte ranges and the security checks behave identically. If any of those is awkward in
  `Bun.serve`, keeping `node:http` (which Bun supports) is acceptable.
- **Terminal board (TUI)**: stays hand-written TS on raw ANSI, no React/Ink.
- **Runtime dependencies**: only `react`, `react-dom`. Dev: `typescript`, `@types/bun`,
  `@types/react`, `@types/react-dom`, `@biomejs/biome`. Anything else must earn its place.

## Install / runtime calls (builder's calls, made after the review)

- **Absolute Bun path where it can be recorded**: the install action writes the absolute path of
  the Bun executable running it (`process.execPath`) into the Claude hooks, the status line and
  the `board` shims, so they work without a shell or PATH lookup. `herdr-plugin.toml` is static and
  says `bun`; that relies on the native install being on PATH.
- **Switching branches**: this branch's install recognises and replaces `main`'s `node …hook.mjs`
  / `…statusline.mjs` / shim entries. `main`'s install does not know the new entries, so going back
  to `main` means re-running `main`'s install after removing the branch's entries (README says
  how). No compatibility files are kept at the old `.mjs` paths.
- **Test fixtures without `NODE_OPTIONS`**: the fake herdr becomes a small executable script the
  tests point `HERDR_BIN_PATH` at (or a preload set through `bunfig.toml` in a test-only dir) —
  builder picks whichever works on Windows with the native Bun.

## Target structure (shape, not a contract — builder may adjust names)

```
src/
  core/         domain types (Session/Item, Card, Category, Launch, ScheduleEntry, Dialog…) and
                pure logic: columns & attention, when-parsing, question/permission parsing,
                trust & input-box screen reading, name rules, i18n dictionaries. No I/O.
  adapters/     the only places that touch the outside world:
                herdr CLI client · Claude home (sessions registry, transcripts, settings) ·
                file store (cards, config, schedule, board.json, caches) · process runner
                (spawn, tree kill) · herdr-wake HTTP client · OS opener (explorer/open/xdg-open,
                Edge app window) · git (changes view)
  services/     use-cases composed from core + adapters: collect board, actions (send, focus,
                sleep, wake), launches, answering dialogs, scheduler, history search, files
  server/       Bun HTTP app: routes grouped by resource, guards (X-Board, Origin, fsToken),
                SSE broadcaster, web bundle serving
  tui/          terminal board
  entrypoints/  thin executables: board CLI, Claude hook, status line, install, open, web-open,
                run (supervisor), server
web/
  src/          main.tsx, components/, hooks/, models/ (pure logic, today's *-model.js files)
  styles/       existing CSS
test/           bun test; pure logic tests + the existing fixture-based integration tests
```

Rules: `core` imports nothing from the other layers; `adapters` import only `core`; `services`
compose; `entrypoints`/`server`/`tui` wire. Code shared by browser and server (i18n, launch name
rules, question model, panel geometry) lives in `src/core` and is imported by `web/` — that
replaces today's server-imports-from-`web/`. One shared types module per domain object; no
duplicated shapes between server payloads and the React side.

## Seams for later phases (interfaces only, one implementation each in phase 1)

- **Claude home**: everything that reads `~/.claude` goes through one adapter constructed with a
  root dir. Phase 1: a single root (`~/.claude`), same as today. Phase 2 turns it into a list of
  profiles without touching callers beyond the composition root.
- **Launcher**: one interface, two implementations matching today (herdr `agent start`, custom
  `launch.command`). Phase 2 adds profile selection; phase 5 calls it from the watcher.
- **Integrations**: herdr-wake (sleep / wake / sleepers), the Telegram-envelope prompt cleanup and
  the Edge app window each sit in their own module behind a small interface, so phase 3 can move
  them behind the plugin contract. No registry or plugin loading yet.
- **Notifications / inbound events**: nothing built; just don't weld the scheduler's "deliver text
  to a session" path to the scheduler — keep "send to session" a service the watcher can reuse.

## Parity (what must be checked, not only tested)

- Existing tests ported one-to-one in meaning; renamed only where modules moved. A test may be
  rewritten for the new structure but must keep asserting the same behaviour.
- The 2 tests that create symlinks (`history`, `usage`) fail on this Windows machine without
  Developer Mode (EPERM, also on `main`). Keep them; skip them only when symlink creation is not
  permitted, with a clear skip reason.
- Manual run on the owner's machine before calling it done: terminal board opens via the herdr
  action and key; web board opens in the Edge window; live updates; drag between lanes/columns;
  session sheet (conversation, files, changes, answer a question form and a permission prompt);
  new-session launch including folder trust; rename; schedule; install action re-run updates
  `settings.json` to `bun` entries without duplicates; English and Russian.
- React components: logic that decides things lives in pure `models/` and is unit-tested;
  components themselves are verified by the manual run. Component tests are optional and only
  where cheap.

## Left to the builder

- Exact file / module names and how far to split each large file (`launch` 849 lines, `app.js`
  2142, `tui` 634, `server` 583, `panel.js` 732, `launch.js` 819, `files.js` 590).
- Order of migration (suggested: tooling → core → adapters → services → server/entrypoints →
  TUI → web/React → manifest/install → docs → manual parity run → catch-up with `origin/main`),
  as long as the suite is green at each commit.
- How the test fixtures (fake herdr, fake launcher, sandbox runner) are ported to Bun
  (`--preload` replaces `NODE_OPTIONS=--import`).
- README updates: install now needs Bun; commands and paths in the docs updated.
