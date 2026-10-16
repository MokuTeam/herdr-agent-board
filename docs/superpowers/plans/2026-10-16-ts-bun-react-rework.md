# agent-board TypeScript + Bun + React Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port agent-board from Node/JavaScript to Bun/TypeScript with a React web board, restructured into small single-purpose modules, with behaviour identical to `main` @ `94fdde6`.

**Architecture:** Strangler-style port, one module at a time, suite green at every commit. Bun runs `.mjs` and `.ts` side by side, so unported `.mjs` files import ported `.ts` files during the migration. Layers: `src/core` (pure), `src/adapters` (I/O), `src/integrations` (herdr-wake, Edge window, terminal raise), `src/services` (use-cases), `src/server`, `src/tui`, `src/entrypoints`, `web/src` (React). The web board is bundled in memory by `Bun.build` from Task 3 on, which is what lets browser code import shared TS from `src/core`.

**Tech Stack:** Bun ≥ 1.4.3 (runtime, package manager, bundler, test runner), TypeScript (strict), React 19 + react-dom, Biome.

**Spec:** `docs/superpowers/specs/2026-10-16-ts-bun-react-rework-design.md`

## Global Constraints

- Behaviour parity with `main` @ `94fdde6`: same HTTP routes/payloads/headers, same SSE shapes, same `board` CLI output, same hook and status-line output, same English/Russian keys.
- File locations and JSON shapes unchanged: config `%APPDATA%\herdr\plugins\config\agent-board\config.json` (else `~/.config/...`), state `%LOCALAPPDATA%\herdr\plugins\agent-board\` (else `~/.local/state/...`): `cards/`, `schedule/`, `board.json`, `claude-limits-latest.json`, `context/`, `uploads/`, `return.json`.
- Unknown fields in any JSON file the board reads and writes are preserved on write.
- Port 12422, loopback only; `X-Board` header on POSTs, `Origin` check on launch/answer, `fsToken` on `/api/fs/raw`, CSP on raw responses.
- Runtime deps: `react`, `react-dom` only. Dev deps: `typescript`, `@types/bun`, `@types/react`, `@types/react-dom`, `@biomejs/biome`.
- TS: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`, `target: "ESNext"`; imports use explicit `.ts` / `.tsx` extensions.
- Layer rule: `core` imports nothing outside `core`; `adapters` / `integrations` import only `core`; `services` import `core` + `adapters` + `integrations`; `server` / `tui` / `entrypoints` wire.
- No `any` in new code (use `unknown` + narrowing). JSON read from disk or network is validated by a narrowing function before use.
- Windows first-class: no shell when spawning, tree-kill via `taskkill /T /F`, `cmd`/`.bat`/`.cmd` refused as launcher program.
- Each commit: `bun test` green (the 2 symlink tests may report *skip* on machines without symlink permission) and `bun run check` clean for TS files.
- Commit messages: plain capitalised sentence like the repo's history (e.g. "Port the board rules to TypeScript"). No AI attribution, no `Co-Authored-By`. Local commits only — never push.
- Shell: run Bun as `bun` with `~/.bun/bin` first on PATH (`export PATH="$HOME/.bun/bin:$PATH"` in Git Bash if the session predates the install).

## Review Focus

1. **Paths with spaces or non-ASCII in the Bun or plugin path** (e.g. `C:\Program Files\…`, a Cyrillic user name) written into `settings.json` hooks, the status line and the `board` shims must be quoted and still run. → test in Task 20.
2. **State written by `main` with fields the TS types don't name** must round-trip untouched (cards, config, schedule entries). → tests in Task 11.
3. **SSE clients that disconnect mid-stream and reconnect repeatedly** must not throw or leak; **byte-range requests** on `/api/fs/raw` (video seek), including an unsatisfiable range, must answer like `main` (206 / 416). → tests in Task 19.
4. **A web source file with a syntax error** while the board runs must not crash the server: the last good bundle keeps being served and the error is logged. → test in Task 3.
5. **Hook and status line run with empty or malformed stdin** must exit 0 quickly with no output (never block Claude Code). → test in Task 20.

---

## Target file map (old → new)

| Old | New |
|---|---|
| `src/lang.mjs` | `src/core/lang.ts` |
| `web/i18n.js`, `web/i18n-launch.js` | `src/core/i18n/strings.ts`, `src/core/i18n/launch-strings.ts`, `src/core/i18n/translator.ts` |
| `src/when.mjs`, `web/when.js` | `src/core/when.ts`, `src/core/when-format.ts` |
| `src/model.mjs` (pure part) | `src/core/board.ts` |
| `src/config.mjs` (pure part) | `src/core/categories.ts` |
| `src/claude.mjs` (pure part) | `src/core/transcript.ts`, `src/core/prompt-filters.ts` |
| `src/questions.mjs`, `src/screen.mjs`, `src/trust.mjs` | `src/core/dialogs/questions.ts`, `src/core/dialogs/input-box.ts`, `src/core/dialogs/trust.ts` |
| `web/launch-model.js`, `src/launch.mjs` (pure part) | `src/core/launch/names.ts`, `src/core/launch/launcher-command.ts` |
| `src/brief.mjs`, `src/statusline.mjs` (pure), `src/schedule.mjs` (pure), `src/scheduler.mjs` (pure), `src/message-gate.mjs`, `src/usage.mjs` (parse) | `src/core/brief.ts`, `src/core/statusline.ts`, `src/core/schedule-rules.ts`, `src/core/message-gate.ts`, `src/core/limits.ts` |
| `src/paths.mjs`, `src/store.mjs`, `src/config.mjs` (I/O), `src/schedule.mjs` (I/O) | `src/adapters/paths.ts`, `src/adapters/json-store.ts`, `src/adapters/cards.ts`, `src/adapters/config-file.ts`, `src/adapters/schedule-store.ts` |
| `src/herdr.mjs`, process parts of `src/launch.mjs`, `src/changes.mjs`, folder parts of `src/launch.mjs`, `src/files.mjs` | `src/adapters/herdr.ts`, `src/adapters/process.ts`, `src/adapters/git.ts`, `src/adapters/folders.ts`, `src/adapters/files.ts` |
| `src/claude.mjs` (I/O), `src/history.mjs`, `src/usage.mjs` (I/O), `recentFolders` | `src/adapters/claude-home.ts` |
| herdr-wake parts of `src/actions.mjs` / `src/model.mjs`, `src/web-open.mjs`, `raiseWindow`/`raiseTerminal` | `src/integrations/herdr-wake.ts`, `src/integrations/edge-window.ts`, `src/integrations/terminal-window.ts` |
| `src/model.mjs` (collect), `src/actions.mjs`, `src/nav.mjs` | `src/services/board.ts`, `src/services/actions.ts`, `src/services/nav.ts` |
| `src/answer.mjs` | `src/services/answer.ts` |
| `src/launch.mjs` (rest) | `src/services/launch/launcher.ts`, `src/services/launch/launches.ts`, `src/services/launch/request.ts`, `src/services/launch/rename.ts` |
| `src/scheduler.mjs` (I/O) | `src/services/scheduler.ts` |
| `src/server.mjs` | `src/server/app.ts`, `src/server/http.ts`, `src/server/sse.ts`, `src/server/uploads.ts`, `src/server/web-bundle.ts`, `src/server/routes/*.ts` |
| `src/cli.mjs`, `src/hook.mjs`, `src/statusline.mjs`, `src/install.mjs`, `src/open.mjs`, `src/web-open.mjs`, `src/run.mjs`, `src/tui.mjs` | `src/entrypoints/{cli,hook,statusline,install,open,web-open,run,tui}.ts` (+ `src/core/install-plan.ts`, `src/tui/*.ts`) |
| `web/*.js`, `web/index.html`, `web/*.css` | `web/src/**/*.tsx|ts`, `web/index.html`, `web/styles/*.css` |
| `test/*.test.mjs`, `test/fixtures/*` | `test/{core,adapters,integrations,services,server,entrypoints,tui,web}/*.test.ts`, `test/support/*` |

**Porting recipe used by every port task (referred to as "the recipe"):**
1. Move the test file(s) named in the task to their new `test/<layer>/…test.ts` path; switch `import { test } from 'node:test'` to `import { test, describe } from 'bun:test'` (keeping `node:assert/strict` is fine); point imports at the new module path; add types where TS needs them. Assertions keep their meaning.
2. `bun test <new test path>` → FAIL ("Cannot find module").
3. Create the new module(s) with the exact exports in the task's Interfaces block; move the code over, typed; delete the old file (or the moved part of it); update every importer (`grep -rn "<old file name>" src web test`).
4. `bun test <new test path>` → PASS; then `bun test` (full) → green; `bun run check` → clean.
5. Commit with the task's message.

---

### Task 1: Bun + TypeScript tooling

**Files:**
- Modify: `package.json`, `.gitignore`
- Create: `tsconfig.json`, `biome.json`, `bunfig.toml`, `bun.lock` (generated)

**Interfaces:**
- Produces: scripts `bun test`, `bun run check` (= `bun run typecheck && bun run lint`), `bun run typecheck` (`tsc --noEmit`), `bun run lint` (`biome check src web/src test`), `bun run format` (`biome check --write src web/src test`), `bun run board` (`bun src/tui.mjs` for now).

- [ ] **Step 1: Write `package.json`**: `"type": "module"`, `"engines": { "bun": ">=1.4.3" }` (drop `node`), the scripts above, deps/devDeps from Global Constraints.
- [ ] **Step 2: `bun install`** → `bun.lock` created; add `node_modules/` already ignored.
- [ ] **Step 3: Write `tsconfig.json`** with the compiler options from Global Constraints plus `"module": "Preserve"`, `"jsx": "react-jsx"`, `"lib": ["ESNext", "DOM", "DOM.Iterable"]`, `"types": ["bun"]`, `"noEmit": true`, `"allowImportingTsExtensions": true`, `"allowJs": true`, `"checkJs": false`, `"skipLibCheck": true`; `include`: `src`, `web/src`, `test`.
- [ ] **Step 4: Write `biome.json`**: formatter indent 2 spaces, `lineWidth: 120`; JS `quoteStyle: "single"`, `semicolons: "asNeeded"`, `arrowParentheses: "asNeeded"` (matches the existing code); linter recommended rules; `files.includes` limited to `**/*.ts`, `**/*.tsx` (old `.mjs`/`.js` are left alone until ported).
- [ ] **Step 5: Write `bunfig.toml`**: `[test] root = "./test"`, `timeout = 30000`.
- [ ] **Step 6: Verify**: `bun run check` → exit 0 (no TS files yet). `bun test` → runs the existing `node:test` suite under Bun: expected ≈148 pass; failures are only the fixture-based files (`actions`, `answer-gate`, `drafts`, `launch`, `lifecycle`, `open`, `scheduler`, `server`, `store`, `files` fixtures) and the 2 symlink tests. Record the exact numbers in the commit body.
- [ ] **Step 7: Commit** — "Add Bun and TypeScript tooling"

### Task 2: Test harness on Bun

The old harness preloads a fake herdr through `NODE_OPTIONS=--import` and runs `node` as the herdr binary. Bun has no equivalent preload for a non-script argv, so the fake herdr becomes a compiled executable.

**Files:**
- Create: `test/support/fake-herdr.ts` (port of `fake-herdr.mjs`, same state/seq/waitFor/text/error behaviour, reading argv from `process.argv.slice(2)`), `test/support/fake-herdr-bin.ts`, `test/support/sandbox.ts`, `test/support/runner.ts`, `test/support/fake-launcher.ts`, `test/support/fake-dialog.ts`, `test/support/trust-screen.ts`, `test/support/fs.ts`
- Delete: `test/fixtures/*.mjs` (screens `test/fixtures/screens/*.txt` move to `test/support/screens/`)
- Modify: every test importing `./fixtures/…`

**Interfaces:**
- Produces:
  - `fakeHerdrBin(): Promise<string>` — compiles `fake-herdr.ts` with `bun build --compile` once into `join(tmpdir(), 'agent-board-test', `fake-herdr-${hash}${ext}`)` where `hash` = first 12 hex chars of SHA-256 of the source; reuses an existing file (avoids repeated antivirus scans).
  - `sandbox(t): Promise<Sandbox>` with `Sandbox = { dir: string; env: Record<string,string>; state(value: unknown): void; calls(): string[][]; run(mode: RunnerMode, input?: unknown, extra?: Record<string,string>): Child; open(background?: boolean): Child; cards: string }`; `Child = { messages: unknown[]; exited: Promise<{ code: number | null; stdout: string; stderr: string }>; send(message: unknown): void; kill(): void }`. Spawned with `Bun.spawn([process.execPath, runnerPath, mode, …], { ipc })`; `env.HERDR_BIN_PATH` = `await fakeHerdrBin()`; `env.PATH` = dir of `process.execPath`. Cleanup registered with `afterEach` semantics equivalent to today's `t.after` (kill live children, await exit, remove dir).
  - `until(fn: () => unknown, timeout = 5000): Promise<void>` (unchanged semantics).
  - `symlinkOrSkip(target: string, path: string): boolean` — returns `false` on `EPERM`; tests call `test.skipIf`-style skip with reason "symlinks need Developer Mode or admin on Windows".
  - `RunnerMode = 'open' | 'send' | 'answer' | 'server' | 'cli' | 'scheduler' | 'write'` — `runner.ts` keeps each mode's behaviour from `runner.mjs`; it no longer overrides `HERDR_BIN_PATH` or sets `NODE_OPTIONS`.

- [ ] **Step 1: Port the fixtures** to `test/support/` per the Interfaces. Keep the old tests on `node:test` for now; only their fixture imports change.
- [ ] **Step 2: Run** `bun test` → every test that failed in Task 1 for fixture reasons now passes. Expected: all pass except the 2 symlink tests.
- [ ] **Step 3: Apply `symlinkOrSkip`** in `history.test.mjs` and `usage.test.mjs` at the symlink line, skipping only that assertion block, with the reason string above.
- [ ] **Step 4: Run** `bun test` → 0 fail; 2 skipped on this machine. Run it 3 times in a row to catch flakiness from timing (process start under Bun is ~40 ms); fix any flaky wait by waiting on a signal, not a longer sleep.
- [ ] **Step 5: Commit** — "Run the test suite on Bun with a compiled fake herdr"

### Task 3: Serve the web board as an in-memory Bun bundle

Done before any shared module moves, so `web/*.js` can import TS from `src/core` from here on.

**Files:**
- Create: `src/server/web-bundle.ts`
- Modify: `src/server.mjs` (static serving + `assetsVersion`), `web/index.html` (script tag unchanged: `app.js`)
- Test: `test/server/web-bundle.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WebBundle {
    js(): string            // last good bundle of web/app.js (later web/src/main.tsx)
    version(): string       // hash of bundle + every web/**/*.css + web/index.html; replaces assetsVersion()
    rebuild(): Promise<void>
    close(): void           // stop watching
  }
  export function createWebBundle(opts: { root: string; entry: string; log: (text: string) => void; watch?: boolean }): Promise<WebBundle>
  ```
  `Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: false, sourcemap: 'inline' })` with no `outdir` (in-memory). With `watch`, a `fs.watch(join(root,'web'), { recursive: true })` debounced 100 ms triggers `rebuild()`. A failed build logs `web bundle: <first error message>` and keeps the previous `js()`/`version()`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** in `test/server/web-bundle.test.ts` against a temp `web/` dir:
  - `bundles imports into one script`: entry `app.js` importing `./b.js` → `js()` contains b's code and no line matching `/^import .* from ['"]\.\//m`.
  - `keeps the last good bundle when a file breaks`: build OK, write `b.js` with `export const x = (`, `await rebuild()` → `js()` unchanged, `log` called once with a string starting `web bundle:`.
  - `version changes when css changes`: write a css file, `rebuild()`, version differs.
- [ ] **Step 2: Run** `bun test test/server/web-bundle.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `createWebBundle`** per the Interfaces.
- [ ] **Step 4: Wire into `src/server.mjs`**: `GET /app.js` returns `bundle.js()` with `text/javascript; charset=utf-8`; other files under `web/` (css, svg, html) are served as before; the board payload's `version` is `bundle.version()`; the existing web-change watcher that bumps `version` now calls `bundle.rebuild()` first.
- [ ] **Step 5: Run** `bun test` → green (server tests included); open `http://127.0.0.1:12422` is part of the manual run in Task 30, not here.
- [ ] **Step 6: Commit** — "Serve the web board as an in-memory Bun bundle"

### Task 4: Core — i18n and language

**Files:**
- Create: `src/core/types.ts` (start; grows in later tasks), `src/core/i18n/strings.ts`, `src/core/i18n/launch-strings.ts`, `src/core/i18n/translator.ts`, `src/core/lang.ts`
- Delete: `web/i18n.js`, `web/i18n-launch.js`, `src/lang.mjs`
- Test: `test/core/i18n.test.ts` (new) + importers in `board.test.mjs`, `server.test.mjs`, `launch.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  // translator.ts
  export type Lang = 'en' | 'ru'
  export type Vars = Record<string, string | number>
  export interface Translator { (key: string, vars?: Vars): string; lang: Lang }
  export const LANGUAGES: Record<Lang, string>        // { en: 'English', ru: 'Русский' }
  export const LANGUAGE_NAMES: Record<Lang, string>   // { en: 'English', ru: 'Russian' }
  export function resolveLanguage(pref: string | undefined, locale: string | undefined): Lang
  export function translator(lang: string): Translator
  export function missingKeys(lang: Lang): string[]
  // lang.ts (process-wide current language, same semantics as lang.mjs)
  export const t: (key: string, vars?: Vars) => string
  export const lang: () => Lang
  export const languageName: () => string
  export function useLanguage(pref: string | undefined): void
  export function onLanguage(fn: (lang: Lang) => void): void
  ```
  `strings.ts` exports `STRINGS: Record<Lang, Record<string, string | ((v: Vars) => string)>>` exactly as today's dictionaries (keep plural/function entries as they are).

- [ ] **Step 1: Write the failing test** `test/core/i18n.test.ts`: `missingKeys('ru')` and `missingKeys('en')` deep-equal `[]`; `translator('ru')('col.me')` equals today's Russian value (copy it from `web/i18n.js`); `resolveLanguage('auto', 'ru-RU') === 'ru'`, `resolveLanguage('auto', 'de-DE') === 'en'`, `resolveLanguage('en', 'ru-RU') === 'en'`.
- [ ] **Step 2–5: Apply the recipe.** `web/*.js` importers switch to `../src/core/i18n/translator.ts` (works because of Task 3). Commit — "Port texts and language to TypeScript"

### Task 5: Core — times

**Files:**
- Create: `src/core/when.ts`, `src/core/when-format.ts`
- Delete: `src/when.mjs`, `web/when.js`
- Test: `test/core/when.test.ts` (from `test/when.test.mjs`)

**Interfaces:**
- Produces: `when.ts`: `parseDuration(text: string): number | null`, `parseWhen(text: string, now?: number): number | null`, `parseCron(text: string): Cron | null`, `nextRun(cron: Cron, after: number): number | null`, `shortestGap(cron: Cron, after: number, runs?: number): number`, `countRuns(cron: Cron, from: number, to: number, cap?: number): number`, `type Cron` (the parsed shape `parseCron` returns today). `when-format.ts`: `daysFrom`, `timeOf`, `span`, `shortWhen`, `capital`, `dayLabel`, `longWhen` with `t: Translator` in place of the untyped `t`. Return values identical to today (keep `null` where today returns `null`).

- [ ] **Steps: Apply the recipe.** Commit — "Port time parsing and formatting to TypeScript"

### Task 6: Core — board rules and categories

**Files:**
- Create: `src/core/board.ts`, `src/core/categories.ts`; extend `src/core/types.ts`
- Modify: `src/model.mjs` (keeps only `collect`/sleepers for now, importing from `core/board.ts`), `src/config.mjs` (keeps file I/O, imports from `core/categories.ts`)
- Test: `test/core/board.test.ts`, `test/core/categories.test.ts` (the model/config parts of `test/board.test.mjs` move here; the rest stays until its module moves)

**Interfaces:**
- Produces (types.ts additions):
  ```ts
  export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
  export type ColumnId = 'work' | 'me' | 'ext' | 'done' | 'idle'
  export type Pin = 'me' | 'ext' | 'done' | 'idle'
  export type Attention = '' | 'decision' | 'ask' | 'question' | 'later'
  export interface Card { key?: string; category?: string; doing?: string; wait?: string; waitSince?: number; result?: string; ask?: string; askSince?: number; pin?: Pin; dismissed?: string; name?: string; updatedAt?: number; [extra: string]: unknown }
  export interface Category { id: string; title?: string; color: string; paths: string[] }
  export interface Config { language: string; categories: Category[]; placement: 'workspace' | 'tab' | 'overlay'; workspace: string; refreshSec: number; wakeUrl: string | null; scheduleWaitMin: number; launch?: LaunchSpec; [extra: string]: unknown }
  export interface LaunchSpec { command?: (string | string[])[]; agent?: string; args?: string[]; timeoutSec?: number }
  export interface TranscriptInfo { title?: string; prompt?: string; lastText?: string; tool?: ToolCall | null; question?: string; replied?: boolean; activity?: number; tokens?: number }
  export interface ToolCall { id: string; name: string; input: unknown; label?: string; detail?: string }
  export interface Item { key: string; session: string | null; pane: string | null; workspace: string | null; cwd: string; status: AgentStatus; name: string; autoName: string; category: string; categorySet: boolean; column: ColumnId; attention: Attention; sleeping?: boolean; /* + every field collect() emits today */ }
  ```
  (Field lists are a floor: add every field the current code reads or writes; the index signature keeps unknown fields. `Item` is the board item the server sends and the web board renders; Tasks 10, 15, 23 use it from here.)
  `board.ts`: `COLUMNS: readonly { id: ColumnId; icon: string; color: string; readonly title: string }[]` (title via `t`), `PINS: ReadonlySet<Pin>`, `busy(status): boolean`, `statusText(status): string`, `attentionOf(status, card, info): Attention`, `columnOf(status, card, info): ColumnId`, `noteOf(item): string`.
  `categories.ts`: `PALETTE`, `validColor(c): boolean`, `colorHex(c): string`, `DEFAULT_CONFIG: Config`, `normalizeConfig(raw: unknown): Config` (today's merge-with-defaults logic from `loadConfig`), `categoryFor(cfg, cwd): string | null`, `laneRank(cfg, id): number`, `categoryInfo(cfg, id): Category & { title: string }`.

- [ ] **Steps: Apply the recipe.** Extra test in `categories.test.ts`: `normalizeConfig({ language: 'ru', futureKey: 1 })` keeps `futureKey: 1`. Commit — "Port board rules and categories to TypeScript"

### Task 7: Core — transcripts and prompt filters

**Files:**
- Create: `src/core/transcript.ts`, `src/core/prompt-filters.ts`
- Modify: `src/claude.mjs` (keeps file reading, imports parsing from core)
- Test: `test/core/transcript.test.ts` (claude parts of `board.test.mjs`, plus what `question-model.test.mjs` needs from claude)

**Interfaces:**
- Produces:
  ```ts
  // prompt-filters.ts — the Telegram envelope becomes the first named filter (integration seam)
  export type PromptFilter = (text: string) => string
  export const telegramEnvelope: PromptFilter          // strips a leading "[telegram …] "
  export const DEFAULT_PROMPT_FILTERS: readonly PromptFilter[]   // [telegramEnvelope]
  // transcript.ts
  export function cleanPrompt(text: string, filters?: readonly PromptFilter[]): string
  export function userText(text: string, filters?: readonly PromptFilter[]): string   // today's claude.mjs:148 helper
  export function toolLabel(name: string): string
  export function toolPath(name: string, input: unknown): string | null
  export function toolDetail(name: string, input: unknown): string
  export function trailingQuestion(text: string): string | null
  export function parseTranscriptTail(lines: string[]): TranscriptInfo      // the parsing half of transcriptInfo
  export function parseConversation(lines: string[], limit?: number): ConversationTurn[]  // the parsing half of conversation
  export type ConversationTurn = /* the shape conversation() returns today */
  ```
- [ ] **Steps: Apply the recipe.** Keep `toolLabel('mcp__plugin_slack_slack__slack_read_channel') === 'slack · read_channel'`. Commit — "Port transcript parsing to TypeScript"

### Task 8: Core — terminal dialogs

**Files:**
- Create: `src/core/dialogs/questions.ts`, `src/core/dialogs/input-box.ts`, `src/core/dialogs/trust.ts`
- Delete: `src/questions.mjs`, `src/screen.mjs`, `src/trust.mjs`
- Test: `test/core/questions.test.ts` (from `questions.test.mjs`; it still imports `driveQuestions` from `src/answer.mjs` until Task 16), `test/core/trust.test.ts`

**Interfaces:**
- Produces: every export listed for `questions.mjs` (`OTHER_LIMIT`, `norm`, `LIMITS`, `questionsOf`, `cleanOther`, `resolveAnswers`, `answerText`, `parseDialog`, `publicDialog`, `onQuestion`, `screenIndex`, `typedOther`, `sameText`, `reviewMatches`, `arrows`, `cursorRow`), `screen.mjs` (`stripAnsi`, `inputDraft`), `trust.mjs` (`trustDialog`, `sameFolder`, `keyTowardYes`), typed with `Question`, `Pick`, `Dialog` (discriminated union `{ kind: 'question' … } | { kind: 'permission' … } | { kind: 'review' … }` following what `parseDialog` returns today) and `TrustDialog`. Types live next to their functions and are re-exported from `types.ts` only if another layer needs them.
- [ ] **Steps: Apply the recipe.** Commit — "Port terminal dialog reading to TypeScript"

### Task 9: Core — launch names and launcher command

**Files:**
- Create: `src/core/launch/names.ts`, `src/core/launch/launcher-command.ts`
- Delete: `web/launch-model.js`
- Modify: `src/launch.mjs` (imports the pure parts), `web/launch.js`, `web/rename.js`
- Test: pure parts of `launch.test.mjs` → `test/core/launch-names.test.ts`, `test/core/launcher-command.test.ts`

**Interfaces:**
- Produces: `names.ts`: `NAME_MAX = 60`, `UNSAFE_CHARS`, `checkName`, `slugName`, `uniqueSlug`, `checkBranch`, `worktreePath`, `isAbsolutePath`, `normDir`, `sameDir`, `baseName`, `splitPathInput`, `completions`, `categoryForDir`, `folderSuggestions`, `suggestName`, `defaultWorkspace` (signatures as today, typed). `launcher-command.ts`: `PLACEHOLDERS` (as const tuple), `type Placeholder`, `usesPlaceholder(template, key): boolean`, `commandArgs(template, vars): { file: string; args: string[] }`, `parseLauncherOutput(stdout): { pane: string | null }` (today's shape), `launcherError(stdout, stderr): string`, `failureKind(message, code?): FailureKind`, `launcherLabel(command): string`; `isRefusedProgram(file: string): boolean` (the `cmd`/`.bat`/`.cmd` rule pulled into one named function).
- [ ] **Steps: Apply the recipe.** Commit — "Port launch naming and launcher command rules to TypeScript"

### Task 10: Core — brief, status line, schedule rules, message gate, limits

**Files:**
- Create: `src/core/brief.ts`, `src/core/statusline.ts`, `src/core/schedule-rules.ts`, `src/core/message-gate.ts`, `src/core/limits.ts`
- Delete: `src/brief.mjs`, `src/message-gate.mjs`; `src/statusline.mjs`, `src/schedule.mjs`, `src/scheduler.mjs`, `src/usage.mjs` keep only their I/O
- Test: `test/core/brief.test.ts` (brief parts of `board.test.mjs`), `test/core/statusline.test.ts`, `test/core/limits.test.ts` (parse parts of `usage.test.mjs`), `test/core/message-gate.test.ts` (from `drafts.test.mjs` gate parts), `test/core/schedule-rules.test.ts`

**Interfaces:**
- Produces: `BRIEF_VERSION = 3`, `brief(cfg, card, cwd): string`, `waitReminder(card): string`; `digest(input: unknown, now?: number): StatusDigest`, `statusText(d: StatusDigest): string`; `MAX_PER_SESSION = 30`, `MAX_TEXT = 2000`, `cleanText`, `cleanName`, `promptOf(entry, now): string`, `targetOf(entry, items): Item | null`, `type ScheduleEntry`; `messageGate(): MessageGate`; `parseLimits(raw: unknown, now: number): Limits` with `Limits = { available: boolean; stale?: boolean; windows?: LimitWindow[]; observedAt: number | null; source: string; sessionAccountVerified: boolean }` (today's `localUsage().limits` shape).
- [ ] **Steps: Apply the recipe.** Commit — "Port brief, status line, schedule rules and limits to TypeScript"

### Task 11: Adapters — paths, JSON store, cards, config file, schedule store

**Files:**
- Create: `src/adapters/paths.ts`, `src/adapters/json-store.ts`, `src/adapters/cards.ts`, `src/adapters/config-file.ts`, `src/adapters/schedule-store.ts`
- Delete: `src/paths.mjs`, `src/store.mjs`, `src/config.mjs`, `src/schedule.mjs`
- Test: `test/adapters/store.test.ts` (from `store.test.mjs`), `test/adapters/config-file.test.ts`, `test/adapters/schedule-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // paths.ts — computed from env at call time (tests set APPDATA/LOCALAPPDATA/HOME per process)
  export const PLUGIN_ID = 'agent-board'
  export const ROOT: string
  export function configDir(): string; export function stateDir(): string
  export function cardsDir(): string; export function scheduleDir(): string
  export function boardFile(): string; export function usageFile(): string; export function contextDir(): string; export function uploadsDir(): string
  // json-store.ts — the mkdir lock, LOCK_STALE_MS takeover and tmp+rename, unchanged
  export function readJson<T>(path: string, guard: (v: unknown) => v is T): T | null
  export function updateJson<T>(path: string, change: (current: T | null) => T, guard: (v: unknown) => v is T): T
  // cards.ts
  export function readCard(key: string): Card | null
  export function writeCard(key: string, patch: Partial<Card>): Card
  export function allCards(): Map<string, Card>
  // config-file.ts
  export const configFile: () => string
  export function loadConfig(): Config
  export function editSettings(body: unknown): Config
  export function editCategories(body: unknown): Config
  export function liveConfig(onChange?: (cfg: Config) => void): Config
  // schedule-store.ts — listEntries, getEntry, addEntry, updateEntry, removeEntry, logRun, readLog (signatures as today, typed)
  ```
- [ ] **Step 1: Write the failing round-trip tests**: `writeCard('k', { doing: 'x' })` on a file already holding `{ "futureField": 7 }` keeps `futureField: 7`; `editSettings({ language: 'ru' })` on a config holding `"futureKey": 1` keeps it; a schedule entry file with an extra field keeps it through `updateEntry`.
- [ ] **Steps 2–5: Apply the recipe** (store contention test ported unchanged in meaning). Commit — "Port state files to TypeScript adapters"

### Task 12: Adapters — herdr, processes, git, folders, files

**Files:**
- Create: `src/adapters/herdr.ts`, `src/adapters/process.ts`, `src/adapters/git.ts`, `src/adapters/folders.ts`, `src/adapters/files.ts`
- Delete: `src/herdr.mjs`, `src/changes.mjs`, `src/files.mjs`; the process/folder/git parts leave `src/launch.mjs`
- Test: `test/adapters/changes.test.ts`, `test/adapters/files.test.ts`, `test/adapters/folders.test.ts` (folder-picker part of `launch.test.mjs`), `test/adapters/process.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // herdr.ts
  export class HerdrError extends Error { code: string | undefined }
  export function herdr<T = unknown>(args: string[], timeoutMs?: number): Promise<T>   // HERDR_BIN_PATH, JSON result, HerdrError on {error}
  export function herdrText(args: string[], timeoutMs?: number): Promise<string>
  export function snapshot(): Promise<HerdrSnapshot>
  export interface HerdrSnapshot { workspaces: HerdrWorkspace[]; panes: HerdrPane[] /* + every field collect() reads today */ }
  // process.ts
  export function runTree(file: string, args: string[], opts?: { timeout?: number; env?: Record<string,string|undefined>; cwd?: string }): Promise<RunResult>
  export function run(file: string, args: string[], opts?: …): Promise<RunResult>
  export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
  // git.ts: gitInfo(dir), checkoutChanges(cwd), isCheckout(cwd)
  // folders.ts: listDirs(raw, { git? }), roots()
  // files.ts: FILE_TOKEN, MEDIA_TYPES, kindOf, resolvePath, describe, parseCsv, preview, openCommand, openWith
  ```
- [ ] **Step 1: New test** `process.test.ts`: `runTree(process.execPath, [script that spawns a grandchild sleeping 60 s], { timeout: 500 })` resolves with `timedOut: true` and the grandchild pid is gone within 2 s (check with `process.kill(pid, 0)` throwing).
- [ ] **Steps 2–5: Apply the recipe.** Commit — "Port herdr, process, git and file adapters to TypeScript"

### Task 13: Adapters — Claude home (the profile seam)

**Files:**
- Create: `src/adapters/claude-home.ts`
- Delete: `src/claude.mjs`, `src/history.mjs`, `src/usage.mjs`; `recentFolders` leaves `src/launch.mjs`
- Test: `test/adapters/claude-home.test.ts` (from `history.test.mjs`, `usage.test.mjs`, and the file-reading parts of `board.test.mjs`)

**Interfaces:**
- Produces:
  ```ts
  export interface ClaudeHome {
    readonly root: string                     // ~/.claude today; one per profile in phase 2
    liveSessions(): Map<string, LiveSession>  // sessions/<pid>.json registry
    transcriptPath(sessionId: string, cwd: string): string | null
    transcriptInfo(path: string | null): TranscriptInfo | null   // tail read + core parseTranscriptTail
    conversation(path: string, limit?: number): ConversationTurn[]
    searchHistory(cwd: string, query: string | null, excludeSession?: string | null): Promise<HistoryResult>
    recentFolders(limit?: number): Promise<string[]>
    localUsage(now?: number): { context: unknown; limits: Limits }   // reads <root>/herdr-usagebar via core parseLimits
  }
  export function createClaudeHome(root: string): ClaudeHome
  export function defaultClaudeHome(): ClaudeHome    // createClaudeHome(join(homedir(), '.claude'))
  ```
  Callers receive a `ClaudeHome` (parameter or deps object); only entrypoints call `defaultClaudeHome()`.
- [ ] **Steps: Apply the recipe**, with `symlinkOrSkip` kept. Commit — "Read Claude Code's files through one ClaudeHome adapter"

### Task 14: Integrations — herdr-wake, Edge window, terminal window

**Files:**
- Create: `src/integrations/herdr-wake.ts`, `src/integrations/edge-window.ts`, `src/integrations/terminal-window.ts`
- Modify: `src/actions.mjs`, `src/model.mjs`, `src/web-open.mjs` (use them)
- Test: `test/integrations/herdr-wake.test.ts` (new), `test/integrations/edge-window.test.ts` (new, command building only)

**Interfaces:**
- Produces:
  ```ts
  // herdr-wake.ts
  export interface SleepProvider {
    sleepers(): Promise<SleepingSession[]>          // cached 5 s; [] on error/timeout(2 s)/no url
    forget(): void                                  // next sleepers() reads again
    wake(item: Item): Promise<WakeResult>
    sleep(item: Item): Promise<SleepResult>
  }
  export function createHerdrWake(url: string | null, fetchFn?: typeof fetch, now?: () => number): SleepProvider
  // edge-window.ts
  export interface BoardWindow { open(url: string): Promise<void> }
  export function edgeWindow(): BoardWindow          // today's web-open behaviour (app window, raise if open)
  export function edgeCommand(url: string, platform?: NodeJS.Platform): { file: string; args: string[] } | null
  // terminal-window.ts
  export function raiseWindow(pattern: string): void
  export function raiseTerminal(cfg: Config): void
  ```
- [ ] **Step 1: Failing tests**: `createHerdrWake(null).sleepers()` → `[]` with no fetch call; two calls within 5 s → one fetch; after `forget()` → second fetch; a fetch rejecting → `[]`; `wake` posts to `${url}/wake` with today's body.
- [ ] **Steps 2–5: Apply the recipe.** Commit — "Move herdr-wake, Edge window and terminal raise behind small interfaces"

### Task 15: Services — board, actions, navigation

**Files:**
- Create: `src/services/deps.ts`, `src/services/board.ts`, `src/services/actions.ts`, `src/services/nav.ts`
- Delete: `src/model.mjs`, `src/actions.mjs`, `src/nav.mjs`
- Test: `test/services/actions.test.ts` (from `actions.test.mjs`), `test/services/board.test.ts` (remaining `board.test.mjs`)

**Interfaces:**
- Produces:
  ```ts
  // deps.ts — the composition root's shape; built once per process by entrypoints
  export interface Deps { cfg: Config; claude: ClaudeHome; wake: SleepProvider; log: (text: string) => void }
  export function defaultDeps(cfg: Config, log?: (text: string) => void): Deps
  // board.ts (Item from core/types.ts, Task 6)
  export function collect(deps: Deps): Promise<Item[]>
  // actions.ts
  export function wake(deps: Deps, item: Item): Promise<ActionResult>
  export function sleepSession(deps: Deps, item: Item): Promise<ActionResult>
  export function focus(deps: Deps, item: Item, opts?: { raise?: boolean }): Promise<ActionResult>
  export function send(deps: Deps, item: Item, text: string, opts?: { free?: boolean; draft?: boolean }): Promise<ActionResult>
  // nav.ts: rememberReturn(snap, boardPane), goBack()
  ```
  `send` stays a standalone service (phase 5's watcher reuses it).
- [ ] **Steps: Apply the recipe.** Commit — "Port board collection and session actions to services"

### Task 16: Services — answering dialogs

**Files:**
- Create: `src/services/answer.ts`
- Delete: `src/answer.mjs`
- Test: `test/services/answer.test.ts` (from `answer-gate.test.mjs`), update `test/core/questions.test.ts` import

**Interfaces:**
- Produces: `paneIO(pane: string): PaneIO`, `driveQuestions({ questions, picks, io, timing }): Promise<DriveResult>`, `drivePermission({ fingerprint, n, io, timing }): Promise<DriveResult>`, `checkPane(item): Promise<PaneCheck>`, `answerQuestions(item, body, io?)`, `answerPermission(item, body, io?)`; `PaneIO = { screen(): Promise<string>; keys(...k: string[]): Promise<void>; text(s: string): Promise<void> }` (today's object, typed).
- [ ] **Steps: Apply the recipe.** Commit — "Port dialog answering to a service"

### Task 17: Services — launches (the launcher seam)

**Files:**
- Create: `src/services/launch/launcher.ts`, `src/services/launch/launches.ts`, `src/services/launch/request.ts`, `src/services/launch/rename.ts`
- Delete: `src/launch.mjs`
- Test: `test/services/launch.test.ts` (rest of `launch.test.mjs`)

**Interfaces:**
- Produces:
  ```ts
  // launcher.ts
  export interface LaunchContext { name: string; label: string; cwd: string; workspaceId: string; workspaceLabel: string; category: string; message: string; sessionId: string | null; pane: string | null }
  export interface Launcher {
    readonly kind: 'herdr' | 'command'
    start(l: LaunchContext, onStep: (step: LaunchStep) => void): Promise<{ pane: string; sessionId: string | null }>
  }
  export function herdrLauncher(spec: LaunchSpec): Launcher      // `agent start … --kind <agent> -- --session-id <id>`
  export function commandLauncher(spec: LaunchSpec): Launcher    // launch.command, runTree, pane=<id>, timeout tree-kill
  export function launcherFor(spec: LaunchSpec | undefined): Launcher
  // request.ts
  export function checkRequest(body: unknown, opts?: { categories?: Set<string> | null }): Promise<{ ok: true; launch: LaunchRequest } | { ok: false; field: string; error: string }>
  // rename.ts
  export function renameSession(item: Item, name: string): Promise<RenameResult>
  // launches.ts
  export interface Launches { options(): Promise<LaunchOptions>; start(body: unknown): Promise<StartResult>; dismiss(id: string): void; focus(id: string): Promise<void>; trust(id: string): Promise<…>; closeTab(id: string): Promise<…>; retry(id: string): Promise<…>; list(): LaunchView[]; attach(items: Item[]): Item[] }
  export function createLaunches(opts: { deps: Deps; onChange?: () => void }): Launches
  ```
  Method names follow today's `createLaunches` return object exactly; the list above is a floor.
- [ ] **Steps: Apply the recipe.** Commit — "Split launches into launcher, request, rename and state services"

### Task 18: Services — scheduler

**Files:**
- Create: `src/services/scheduler.ts`
- Delete: `src/scheduler.mjs`
- Test: `test/services/scheduler.test.ts` (from `scheduler.test.mjs`)

**Interfaces:**
- Produces: `startScheduler(opts: { deps: Deps; onChange?: () => void }): { stop(): void }`; delivery to a session goes through `services/actions.send` (not a private copy).
- [ ] **Steps: Apply the recipe.** Commit — "Port the scheduler to a service"

### Task 19: Server on Bun.serve

**Files:**
- Create: `src/server/app.ts`, `src/server/http.ts`, `src/server/sse.ts`, `src/server/uploads.ts`, `src/server/routes/{board,fs,session,launch,settings,schedule,static}.ts`
- Delete: `src/server.mjs`
- Test: `test/server/server.test.ts` (from `server.test.mjs`), `test/server/drafts.test.ts` (HTTP parts of `drafts.test.mjs`), `test/server/files-routes.test.ts` (route parts of `files.test.mjs`), `test/server/sse.test.ts` (new), `test/server/raw-range.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface BoardServer { port: number; refresh(): Promise<void>; close(): Promise<void> }
  export function startServer(opts: { deps: Deps; port?: number }): Promise<BoardServer>   // default 12422, hostname 127.0.0.1
  // http.ts
  export type Handler = (req: Request, ctx: RouteContext) => Promise<Response> | Response
  export interface Route { method: 'GET' | 'POST'; path: string | RegExp; guard?: Guard[]; handle: Handler }
  export type Guard = 'board-header' | 'origin' | 'fresh-data' | 'fs-token'
  export function json(status: number, body: unknown): Response
  // sse.ts
  export interface Broadcaster { response(req: Request): Response; send(payload: unknown): void; size(): number }
  ```
  Route table order and matching reproduce today's `if` chain exactly (first match wins). If `Bun.serve` cannot reproduce SSE, ranges or the guards byte-for-byte, keep `node:http` inside `app.ts` and say so in the commit body.
- [ ] **Step 1: New failing tests**: `sse.test.ts` — open and abort 50 SSE connections in a loop, then `size()` is 0 and no unhandled rejection; `raw-range.test.ts` — `Range: bytes=0-9` on a 100-byte file → 206, `Content-Range: bytes 0-9/100`, 10 bytes; `Range: bytes=200-` → 416 with `Content-Range: bytes */100` (match whatever `main` returns — check `src/server.mjs` @ `94fdde6` and pin that).
- [ ] **Steps 2–5: Apply the recipe.** Commit — "Port the web server to Bun.serve with a typed route table"

### Task 20: Entrypoints and install

**Files:**
- Create: `src/entrypoints/{cli,hook,statusline,install,open,web-open,run,tui,server}.ts`, `src/core/install-plan.ts`
- Delete: `src/cli.mjs`, `src/hook.mjs`, `src/statusline.mjs`, `src/install.mjs`, `src/open.mjs`, `src/web-open.mjs`, `src/run.mjs` (`src/tui.mjs` is only renamed here; split in Task 21)
- Test: `test/entrypoints/open.test.ts` (from `open.test.mjs`), `test/entrypoints/cli.test.ts` (cli parts of `scheduler.test.mjs`), `test/entrypoints/statusline.test.ts` (from `statusline.test.mjs`), `test/core/install-plan.test.ts` (new), `test/entrypoints/hook-stdin.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // install-plan.ts — pure: given today's settings.json object and paths, return the new one
  export interface InstallPaths { bun: string; hook: string; statusline: string; cli: string; binDir: string }
  export function planSettings(settings: unknown, paths: InstallPaths): { settings: Record<string, unknown>; replaced: string[] }
  export function planShims(paths: InstallPaths): Record<string, string>   // { board: sh script, 'board.cmd': cmd script }
  export function isOurCommand(command: string): boolean                    // true for main's `node …agent-board…hook.mjs|statusline.mjs` and the new `"<bun>" "…agent-board…entrypoints/hook.ts|statusline.ts"`
  export const quote: (path: string) => string                              // "…", forward slashes for sh
  ```
  `install.ts` reads/backs up (`settings.json.bak-agent-board`, as today)/writes, using `process.execPath` as `paths.bun`.
- [ ] **Step 1: Failing tests** `install-plan.test.ts`:
  - settings with main's entries (`node "C:\…\agent-board\src\hook.mjs"` under SessionStart and UserPromptSubmit, statusLine `node "…/statusline.mjs"`) → replaced by one `"<bun>" "<hook>"` entry per event and the new statusLine; `replaced` lists them.
  - settings with the user's own hook under SessionStart and their own statusLine → both kept untouched.
  - running `planSettings` twice → identical output (idempotent, no duplicates).
  - `paths.bun = 'C:\\Program Files\\Bun\\bun.exe'`, `paths.hook` under `C:\\Users\\Имя\\…` → the command string is `"C:/Program Files/Bun/bun.exe" "C:/Users/Имя/…/hook.ts"` (Review Focus 1) and `planShims` quotes both in the sh and cmd scripts.
- [ ] **Step 2: Failing test** `hook-stdin.test.ts`: spawn `bun src/entrypoints/hook.ts` and `bun src/entrypoints/statusline.ts` with stdin `''` and with stdin `'{not json'` → exit code 0, stdout `''` (statusline may print today's fallback line — pin `main`'s exact output), finishes under 2 s (Review Focus 5).
- [ ] **Steps 3–5: Apply the recipe** for the rest. Commit — "Port entrypoints and make install record the Bun path"

### Task 21: Terminal board split

**Files:**
- Create: `src/tui/terminal.ts` (CSI, `paint`, `charWidth`, `width`, `fit`, `age`), `src/tui/input.ts` (`KEYMAP`, `ACTION`, `tokens(data: string): string[]`, mouse hit parsing), `src/tui/render.ts` (`cardLines`, `laneHeader`, `bodyWide`, `bodyNarrow`, `header`, `footer`, `render(state, size): string`), `src/tui/state.ts` (`TuiState`, `build`, `move`), `src/tui/app.ts` (refresh loop, actions, lifecycle, `serve`)
- Delete: `src/entrypoints/tui.ts` content moves to `src/tui/app.ts`; the entrypoint becomes a 1-line import
- Test: `test/tui/terminal.test.ts`, `test/tui/input.test.ts`, `test/tui/render.test.ts` (all new)

**Interfaces:**
- Produces: `render(state: TuiState, size: { columns: number; rows: number }): string` is pure (no `process.stdout` access); `app.ts` owns stdout.
- [ ] **Step 1: Failing tests**: `width('abc') === 3`, `width('Привет') === 6`, `width('日本') === 4`, `width('✓') === 1`, `fit('Привет мир', 6)` has width 6; `tokens('\x1b[A' + 'j' + '\x1b[<0;10;5M')` → `['\x1b[A', 'j', '\x1b[<0;10;5M']`; `render` of a fixed 2-lane, 3-item state at 120×40 and at 80×30 matches a stored snapshot (`toMatchSnapshot()`), generated once from the pre-split code by running the old functions on the same state.
- [ ] **Steps 2–5: Split per the Files list**; behaviour identical. Commit — "Split the terminal board into terminal, input, render and app modules"

### Task 22: Manifest, scripts, last `.mjs`

**Files:**
- Modify: `herdr-plugin.toml`, `package.json` (`board` script → `bun src/entrypoints/tui.ts`)
- Test: `test/manifest.test.ts` (new)

- [ ] **Step 1: Failing test** `manifest.test.ts`: `import manifest from '../herdr-plugin.toml'`; every `command` in `startup`, `actions`, `panes` has `command[0] === 'bun'` and `command[1]` an existing file under `src/entrypoints/`; there is a `build` entry equal to `["bun", "install", "--production"]`; `platforms` unchanged (`windows`, `linux`, `macos`); ids unchanged (`open`, `web`, `install`, pane `board`).
- [ ] **Step 2: Update the manifest**; `find src -name '*.mjs'` → empty.
- [ ] **Step 3: Verify** `bun test`, `bun run check` (now also covers everything under `src`). Commit — "Run the plugin with Bun from the manifest"

### Task 23: Web — React shell, data and toolbar

**Files:**
- Create: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api/client.ts`, `web/src/api/useBoard.ts`, `web/src/i18n/I18nProvider.tsx`, `web/src/components/{Toolbar,Limits,LiveDot,Toasts}.tsx`, `web/src/models/{lifecycle,limits,live,attention}.ts`
- Modify: `web/index.html` (`<div id="root"></div>` + existing CSS links + `<script type="module" src="app.js">`), `src/server/web-bundle.ts` entry → `web/src/main.tsx`
- Delete: `web/lifecycle.js`, `web/limits-model.js`, `web/live.js`, `web/attention.js` (and the parts of `web/app.js` now rendered by React — `app.js` is deleted at the end of Task 27; until then the old page stays the entry and the React tree is built behind it)
- Test: `test/web/{lifecycle,limits,live,attention}.test.ts` (moved)

**Interfaces:**
- Produces:
  ```ts
  // client.ts
  export interface BoardPayload { version: string; lang: Lang; language: string; languages: Record<Lang,string>; fsToken: string; stale: boolean; lastSuccessfulRefreshAt: number | null; limits: Limits; items: Item[]; launches: LaunchView[]; categories: (Category & { title: string })[]; swatches: [string, string][]; columns: { id: ColumnId; title: string }[]; schedules: ScheduleEntry[]; scheduleLog: ScheduleLogRecord[] }
  export const api: { board(): Promise<BoardPayload>; post<T>(path: string, body?: unknown): Promise<T>; get<T>(path: string): Promise<T> }   // post adds X-Board
  // useBoard.ts — boardConnection() semantics from lifecycle.js
  export function useBoard(): { data: BoardPayload | null; connected: boolean; canMutate: boolean; canEdit: boolean; resume(): void }
  // I18nProvider.tsx
  export function useT(): Translator
  ```
  Cut-over rule for Tasks 23–27: build the React tree in `web/src` while `web/app.js` keeps serving; switch the bundle entry to `web/src/main.tsx` only in Task 27 Step "cut over", when every part of `app.js` has a React counterpart.
- [ ] **Steps: Apply the recipe** for the 4 models; build the components; `bun run check` clean. Commit — "Start the React web board: data, language and toolbar"

### Task 24: Web — board, cards, motion, drag

**Files:**
- Create: `web/src/components/{Board,Lane,Card,AlarmBadge}.tsx`, `web/src/hooks/{useFlip,useSpring,useCardDrag,useBoardKeys}.ts`, `web/src/models/{spring,click-away,board-view}.ts`
- Delete: `web/spring.js`, `web/click-away.js`
- Test: `test/web/click-away.test.ts` (moved), `test/web/spring.test.ts` (new: `Spring` settles to target with damping 1 and no overshoot; `rubberband` and `velocityOf` values pinned from the old functions), `test/web/board-view.test.ts` (new: `visibleItems`, lane order, `catOf`/`colOf` with pending moves — logic pulled out of `app.js:105-125,429-451`)

**Interfaces:**
- Produces: `useFlip(container: RefObject<HTMLElement>, keys: string[]): void` (measure before commit with `useLayoutEffect`, animate with `Spring`, respects `reducedMotion`); `useCardDrag(opts: { onDrop(key: string, target: { cat: string | null; column: ColumnId | null }): void }): DragHandlers`; `board-view.ts`: `visibleItems(data, filter, moved, movedCol): Item[]`, `lanesOf(data, filter): LaneView[]`.
- [ ] **Steps**: tests first for the pure models, then components; parity points to preserve: FLIP springs on every position change, appear animation, drag ghost following 1:1, drop targets for lane and column, compact sleeping cards, keyboard navigation from `app.js:1923-2007`. Commit — "Board, cards, motion and drag in React"

### Task 25: Web — side panel and session sheet

**Files:**
- Create: `web/src/components/panel/{Panel,PanelHead}.tsx`, `web/src/hooks/{usePanelLayout,useModalFocus}.ts`, `web/src/components/sheet/{Sheet,SheetHead,SheetCard,Thread,Composer,Attachments,Changes,ScheduleRow}.tsx`, `web/src/components/questions/{QuestionForm,PermissionPrompt}.tsx`, `web/src/components/files/{FileChip,QuickLook}.tsx`, `web/src/models/{panel-layout,detail-resource,drafts,diff,markdown,question-model,modal-focus,files}.ts`
- Delete: `web/panel.js`, `web/panel-layout.js`, `web/detail-resource.js`, `web/drafts.js`, `web/diff.js`, `web/markdown.js`, `web/question-model.js`, `web/modal-focus.js`, `web/questions.js`, `web/files.js`
- Test: `test/web/{panel-layout,detail-resource,drafts,diff,question-model,modal-focus}.test.ts` (moved), `test/web/markdown.test.ts` (markdown parts of `board.test.mjs`/`files.test.mjs`)

**Interfaces:**
- Produces: `markdown(src: string, opts?: MarkdownOptions): string` stays an HTML-string renderer used via `dangerouslySetInnerHTML` **only** for its own escaped output (it escapes today — keep the escaping tests); `usePanelLayout(): { layout: PanelLayout; dockTo(d: Dock): void; … }` over the pure `panel-layout.ts`; `useModalFocus(layerRef)` over `modalFocusManager`.
- [ ] **Steps**: models first (recipe), then components. Parity points: dock right/left/bottom/float, pull-loose and throw with preview, edge resize with double-click reset and arrow keys, fold-away, layout persisted in `localStorage` under today's key, composer Enter/Shift+Enter, attachments upload, drafts per session, question form keys 1–9, permission fingerprint, "Go to herdr", "Put to sleep", "Wake". Commit — "Side panel, session sheet and question forms in React"

### Task 26: Web — categories and schedule panels

**Files:**
- Create: `web/src/components/categories/{CategoriesPanel,CategoryRow,CategoryDraft}.tsx`, `web/src/components/schedule/{SchedulePanel,ScheduleEntry,ScheduleLog}.tsx`, `web/src/hooks/useRowReorder.ts`, `web/src/models/categories.ts` (`slug`, draft validation from `app.js:1385-1395`)
- Test: `test/web/categories.test.ts` (new: `slug('Новый клиент')` and `slug('Acme Corp!')` pinned from the old function)

- [ ] **Steps**: model test first, then components. Parity: reorder row follows pointer 1:1 with springs, colors from swatches, folder paths, cancel-arms-then-confirms ("Cancel?"), collapse animation, mode toggle, count badge. Commit — "Categories and schedule panels in React"

### Task 27: Web — launch dialog, menus, rename; cut over

**Files:**
- Create: `web/src/components/launch/{LaunchDialog,FolderPicker,LaunchCard}.tsx`, `web/src/components/menu/{ContextMenu,MenuItem}.tsx`, `web/src/hooks/{useContextMenus,useRenameInPlace}.ts`, `web/src/models/{menu-model,board-menus,launch-drafts}.ts`
- Delete: `web/launch.js`, `web/launch-drafts.js`, `web/menu.js`, `web/menu-model.js`, `web/board-menus.js`, `web/rename.js`, `web/app.js`; move `web/*.css` → `web/styles/*.css` and update `index.html`
- Test: `test/web/{menu,launch-drafts}.test.ts` (moved), `test/web/board-menus.test.ts` (new: which menu opens for card / lane / board / launch / chip, `wantsNativeMenu` cases)

- [ ] **Steps**: models (recipe), components, then **cut over**: bundle entry `web/src/main.tsx`; delete `web/app.js` and every remaining `web/*.js`; `ls web` → `index.html icon.svg src styles`. `bun test`, `bun run check`. Commit — "Launch dialog, menus and rename in React; serve the React board"

### Task 28: README and docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1**: Install section: requires Bun ≥ 1.4.3 (official installer link), `herdr plugin install MokuTeam/herdr-agent-board` runs `bun install --production`; `plugin link` users run `bun install`; switching back to `main` (remove the branch's hook/status-line entries, then run `main`'s install). Every `node …` command and `src/*.mjs` path in the README updated; the "Code:" pointers updated to the new files.
- [ ] **Step 2**: `grep -nE "node |\.mjs" README.md` → only intentional mentions (the `main` switch-back note).
- [ ] **Step 3: Commit** — "Update README for Bun and the new layout"

### Task 29: Whole-branch review fixes

- [ ] **Step 1**: Run a whole-branch review (requesting-code-review) against the spec and this plan; fix findings; `bun test` ×3, `bun run check`.
- [ ] **Step 2: Commit** — "Review fixes for the TypeScript rework"

### Task 30: Manual parity run on the owner's machine (careful)

- [ ] **Step 1: Backups** — copy `~/.claude/settings.json`, `%APPDATA%\herdr\config.toml`, and (if present) `%APPDATA%\herdr\plugins`, `%LOCALAPPDATA%\herdr\plugins` to `scratchpad/parity-backup/`; write `scratchpad/parity-backup/UNDO.md` listing every path touched and how to restore.
- [ ] **Step 2: Baseline** — `git worktree add <scratch>/board-main 94fdde6`; `herdr plugin link <scratch>/board-main`; run its install action; diff `settings.json` against the backup (only agent-board entries added; the owner's own hooks and status line untouched — if the owner has a status line, agent-board must not replace it). Open board, create a few cards/categories/schedule entries.
- [ ] **Step 3: Branch** — `herdr plugin unlink agent-board`; `herdr plugin link <repo>`; `bun install`; run the install action; diff again: `node` entries replaced, no duplicates, owner's entries untouched; existing cards/categories/schedule still there.
- [ ] **Step 4: Checklist** (each ticked or written up): terminal board via action and `prefix+a`; web board in Edge window; live updates and the stale indicator; drag between lanes/columns; session sheet (conversation, files, changes, answer a question form and a permission prompt from a real session); new-session launch incl. folder trust; rename; schedule add/cancel; language switch EN↔RU; reload-on-change of a `web/src` file.
- [ ] **Step 5: Leave the machine as the owner wants** — ask before leaving the plugin installed; otherwise restore from `UNDO.md` and diff to prove it. Record results in `docs/superpowers/plans/2026-10-16-ts-bun-react-rework-parity.md`; commit — "Record the manual parity run"

### Task 31: Catch up with `origin/main`

- [ ] **Step 1**: `git fetch origin`; `git log --oneline 94fdde6..origin/main` and `git diff --stat 94fdde6..origin/main` → list each change.
- [ ] **Step 2**: For each change (oldest first): port it into the TS code at its new location; port its tests into `test/…`; `bun test`; commit "Catch up: <original subject>" (one commit per upstream PR).
- [ ] **Step 3**: Re-run the Task 30 checklist items touched by the catch-up. Final `bun test` ×3 and `bun run check`.
