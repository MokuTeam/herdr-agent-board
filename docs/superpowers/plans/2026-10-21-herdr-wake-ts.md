# agent-board: herdr-wake in the Board, on Bun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** herdr-wake's every function (sessions seen, reaper, sleep, wake, the local API, the ListAgents and SendMessage hooks, the Telegram router, claude-tg, the actions) runs from the board's `src/` on Bun, started by itself with the board, switched from Settings → "Sleep and wake…", for every Claude profile; the separate Node plugin is taken over once.

**Architecture:** Pure rules in `src/core/wake/` (settings and the kill switch, reaper plan, routing and topic keys, screens, the "can wake" rule, the typed wake line, the hooks' profile filter, the session file's model, the status file's model, the takeover's rules) and `board resume`'s folder choice in `src/core/resume.ts`. Adapters read and write wake's files in the board's state folder and speak to herdr (`src/adapters/wake-*.ts`). Services: the pane operations shared by the wake process and the board's own wake (`services/wake/pane-ops.ts`), the engine (`services/wake/engine.ts`), the supervisor, the start, the control the board uses, the Telegram router and the takeover. Entrypoints: `wake.ts` (the process, its API on `127.0.0.1:<wake.port>`), `wake-run.ts` (the supervisor the pane runs), `wake-start.ts` (the startup entry), `wake-hook.ts` (ListAgents, SendMessage), `wake-action.ts` (herdr actions). The board talks to it over the same API as today; it never waits for it.

**Tech Stack:** Bun 1.4.3, strict TypeScript, React 19, Biome; herdr's CLI (`HERDR_BIN_PATH`) through `src/adapters/herdr.ts`; no new dependency; no Node.

**Spec:** `docs/superpowers/specs/2026-10-21-herdr-wake-ts-design.md` (approved by the owner; its numbered decisions and calls are part of it). Earlier plans for the conventions: `docs/superpowers/plans/2026-10-18-multi-profile.md`, `docs/superpowers/plans/2026-10-19-profile-start-command.md`. Phase-1 conventions (read, never edit): `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.superpowers/sdd/2026-10-16-ts-bun-react-rework/conventions.md`. Project rules: `AGENTS.md`.

## Global Constraints

- **Where:** each task runs in the worktree and on the branch the controller names (one branch per PR, `wake/pr<N>-<slug>`, from `main` after the previous PR merged, or stacked on the previous PR's branch until it merges). Commit locally, never push. Never touch the main checkout (`C:/migo/development/projects/external/mokuhub/herdr-agent-board`, herdr runs the owner's live board from it) nor `.superpowers/`.
- **Toolchain (Git Bash):** `export PATH="$HOME/.bun/bin:$PATH"`; `bun install` once in a fresh worktree; then `bun test <file>`, `bun test`, `bun run check`. Write files with Write/Edit, never heredocs (they strip backslashes; compare every regex with its original).
- **Green means:** `bun test` passes everything but the failures Task 0 records as already failing on `main` (expected: `the skill install copies is upstream’s, word for word, but for what \`board sleep\` added` in `test/entrypoints/install.test.ts`; the 2 symlink tests may skip). `bun run check` clean. Every task ends green; a task that sees another failure stops and reports it, never fixes it in passing.
- **Layers:** `src/core` pure (no I/O; imports only core); `src/adapters`, `src/integrations` do I/O and import only core and adapters; `src/services` orchestrate; `src/entrypoints`, `src/server`, `src/tui` wire; `web/src` the page. Strict TS (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `.ts`/`.tsx` import extensions, no `any`, JSON from disk or network narrowed by a guard, unknown JSON fields kept on write.
- **Windows first:** no shell when spawning (`spawn(file, args)` / `Bun.spawn([...])`); programs in System32 by full path; paths built with `node:path`; paths from users, config, herdr or Claude parsed with either separator and compared through `sameDir`/`normDir`.
- **Sandboxes and fakes only:** `sandbox()` (`test/support/sandbox.ts`, its compiled fake herdr as `HERDR_BIN_PATH`), the in-memory `fakeWakeHerdr` (Task 2.3), temp folders, `unusedPort()` (`test/support/board-server.ts`). Never the owner's herdr, `~/.claude*`, `%APPDATA%\herdr`, `%LOCALAPPDATA%\herdr`, never ports **12421** or **12422**: every test that starts a wake writes a `wake.port` from `unusedPort()` (the helper of Task 2.5 refuses 12421). Before the takeover nothing of the new wake runs on the owner's machine outside tests: no task links, installs or starts it there.
- **Dormant until PR 7:** `WAKE_SHIPPED` (Task 1.1) is `false` until Task 7.3; it is the default of `wake.enabled` and gates the Settings item. `herdr-plugin.toml` gets no wake entry before Task 7.3. Tests that need wake on write `"wake": { "enabled": true, "port": <unused> }`.
- **Texts:** where the board shows text, English and Russian. PR 4's keys live in `src/core/i18n/wake-strings.ts` (Task 4.1 creates it with every key PR 4 needs; `src/core/i18n/strings.ts` merges `WAKE_STRINGS` as it merges `PROFILE_STRINGS`); later PRs add theirs there. `missingKeys` stays `[]`. English given in this plan is **exact**; write the Russian in the tone of `src/core/i18n/profile-strings.ts`. What goes to agents (API errors, hook context, CLI) stays English, as today.
- **CSS:** the six upstream sheets (`app.css`, `menu.css`, `launch.css`, `questions.css`, `terminal.css`, `helpers.css`) are never touched (`test/web/styles.test.ts`). Wake's rules go in `web/styles/wake.css` (Task 4.6), linked from `web/index.html`; rules select by class only.
- **File names:** no new file name starts with `claude-` (the owner's global gitignore hides them; see the conventions file).
- **Commit messages:** the plain English sentence the task gives; no prefix, no trailer, no `Co-Authored-By`, no mention of an assistant or AI anywhere (code, comments, docs, commits, PR text).
- **Every PR** (AGENTS.md): from an issue under #119 (the controller opens it, saying who works on it); its new tests fail on `main`'s files and pass with the change; it shows the setups it must not touch are unchanged (Claude session ids, `pane-<id>` keys, Windows paths, names with spaces, other alphabets, `%`); its body says whom it touches, whom not, what was compared, and names any test already failing on `main`. The PR gate at the end of each PR group lists what to run.

## Review Focus

1. **Folders with spaces, Cyrillic and `%`, on Windows and POSIX** (a profile `C:\Users\Иван Петров\.claude-work 100%`, a project `C:\Work\Проект x 50%`): the typed wake line carries only the session id and a plain profile id, never a path; `board resume` reaches the recorded project folder as one argument; the hooks' profile filter matches such a folder spelled with another case, a trailing separator or `~`. → Task 1.5 (`wakeLine`, `ownSleepers`), Task 2.7 (resume into such a folder), Task 5.1 (hook from such a profile).
2. **The pane's shell is cmd, Windows PowerShell, pwsh, bash or zsh** (herdr restores whatever the user had): the one typed line runs in each (no `cd '…';`, no quotes), the prompt line is cleared with Esc for cmd/PowerShell and Ctrl+U for POSIX shells, an unknown shell by the OS as today. → Task 1.5 (`clearKeyFor`), Task 2.3 (`wakeInPane` per shell).
3. **Wake accepts connections but never answers** (hung, or busy waking): no board refresh waits on it, a click on Wake while it is slow types no second wake into the pane, a reminder for such a sleeper waits without being counted missed. → Task 4.2 (sleepers), Task 4.3 (no second wake), Task 4.4 (reminder waits).
4. **A broken config.json or wake-sessions.json** (half-written by an editor, a crash, a BOM): config that does not parse is wake off for the start, the process and the hooks, with no herdr call and no HTTP call; a broken session file is set aside, never overwritten, and its loss is logged. → Task 1.1 (`wakeSwitch`), Task 2.2 (`readWakeSessions`), Task 3.3 (start), Task 5.1 (hooks).
5. **Two wakes on one machine** (the old plugin still installed, a second wake process, 12421 held by another program): the new wake is held by the old plugin and starts nothing, a second process exits 0 quietly, a foreign program on the port is a status the panel shows; the install never writes new hooks beside the old plugin's. → Task 3.3 (held), Task 3.4 (port), Task 5.2 (hooks).

## Decisions where the spec is silent (the owner can overturn them)

- **One constant ships it:** `WAKE_SHIPPED` in `src/core/wake/config.ts`: the default of `wake.enabled` and the switch that shows "Sleep and wake…" without a hand-written `wake` section. Task 7.3 sets it to `true` with the manifest entries.
- **Files** in the board's state folder: `wake-sessions.json` (pane id → entry; the old `sessions.json` keys plus `profileDir`, `profile`), `wake-status.json` (the supervisor's and the start's record, below), `wake.log` (rotated to `wake.log.1` past 2 000 000 bytes), `wake-takeover.json` (the takeover's marker, PR 7). A broken `wake-sessions.json` is renamed to `wake-sessions.json.broken-<ms>` and wake starts from `{}`.
- **Status file:** `{ state: 'starting' | 'running' | 'crashed' | 'stopped' | 'held' | 'portTaken' | 'failed', at, pane?, pid?, error?, crashes?, port? }`; `pane` and `pid` are the wake pane and the supervisor's process, as `board.json` records the board's.
- **Which wake the board uses** (call 4, safeguard 13): the new one only when `wakeSwitch` says on **and** the status file exists with a state other than `held`; otherwise `wakeUrl` and the old guard exactly as today. A missing status file (wake's start never ran) is the old path: the board then starts wake once (safeguard 3), which writes the file.
- **Numbers:** port `12421`; workspace `Wake`; start deadline 20 s, `herdr api snapshot` tried 4 times (0, 0.5 s, 1 s, 2 s after); health check every 15 s, 5 s timeout, 3 misses in a row end the process (a crash); before the process says it listens, 30 s grace; crash backoff `core/crash-policy.ts` `afterCrash` (2 s, 10 s, 30 s, stop at 5 in 10 min); sessions seen every 15 s; reaper every 60 s; a code change restarts the wake process once no wake, sleep or delivery is under way (180 s at most); the board's sleepers refresh in the background every 5 s, 2 s timeout; "Starting…" lasts at most 60 s after the status file's `at`; the toolbar note after 60 s not running.
- **Profile in the answers:** `profile: { dir, id? }` on each `/sleeping` and `/awake` entry when the folder is known (`id` when a listed profile has it). An entry without `profile` (taken over from the old plugin) is the default folder's.
- **Hook commands:** `"<bun>" "<root>/src/entrypoints/wake-hook.ts" pre-send` (PreToolUse, matcher `SendMessage`, timeout 180) and `… post-list` (PostToolUse, matcher `ListAgents`, timeout 10). The old plugin's are recognised by `/herdr-wake.*hook\.mjs"? (pre-send|post-list|session-start)$/` (its `install-hooks.mjs`).
- **The pane's shell:** `herdr pane process-info --pane <id>` answers `{ process_info: { shell_pid, foreground_processes: [{ pid, name, … }] } }` (herdr 0.9.5's schema); the shell is the foreground process whose `pid` is `shell_pid`, its `name` lower-cased without `.exe`.
- **Old plugin installed:** `herdr plugin list --json` → `plugins[].plugin_id === 'herdr-wake'`; an answer that is not JSON is searched for a line holding `herdr-wake` (0.9.2 may lack `--json`).
- **A wake answers** at a port when `GET /status` is an object with a numeric `pid` and an object `sessions` (the old router's and the new wake's alike).
- **Routes:** `GET /api/wake` and `POST /api/wake { op, … }`, local only (refused on every remote listener, both spellings); the payload's `wake` (the state line) reaches phones read only.
- **claude-tg's mark:** new launchers start with `agent-board: claude-tg`; files starting with `herdr-wake: ` or `agent-board: ` comments are ours to replace.
- **The board's tests never start a real wake start:** `startServer` takes a `wakeStarter` option (Task 4.5); `test/support/runner.ts` server mode passes a recorder.
- **Two test-only environment variables**, read where the value is used, unset in production: `BOARD_WAKE_ROUND_MS` (both of the wake process's loops, Task 2.5) and `BOARD_WAKE_START_DEADLINE_MS` (wake's start, Task 3.3).

---

## File map

| Area | Files |
|---|---|
| Pure rules | Create `src/core/wake/{config,reaper,route,topics,screens,rules,sessions,status,launchers,takeover}.ts`; modify `src/core/resume.ts`, `src/core/types.ts`, `src/core/setup.ts`, `src/core/install-plan.ts`, `src/core/i18n/strings.ts`; create `src/core/i18n/wake-strings.ts` |
| Adapters | Create `src/adapters/wake-files.ts`, `src/adapters/wake-herdr.ts`, `src/adapters/wake-transcripts.ts`, `src/adapters/launchers.ts`; modify `src/adapters/process.ts`, `src/adapters/config-file.ts`, `src/adapters/hook-settings.ts`, `src/adapters/setup-facts.ts`, `src/adapters/claude-home.ts` |
| Services | Create `src/services/wake/{pane-ops,engine,supervisor,start,control,telegram,takeover}.ts`; modify `src/services/actions.ts`, `src/services/deps.ts`, `src/services/board.ts`, `src/services/scheduler.ts`, `src/services/sleep.ts`, `src/services/profiles.ts` |
| Integrations | Create `src/integrations/wake.ts` |
| Entrypoints | Create `src/entrypoints/{wake,wake-run,wake-start,wake-hook,wake-action}.ts`; modify `src/entrypoints/cli.ts`, `src/entrypoints/install.ts`, `src/entrypoints/hook.ts` (SessionStart report only) |
| Server | Create `src/server/routes/wake.ts`; modify `src/server/app.ts`, `src/server/remote.ts`, `src/server/routes/sleep.ts`, `src/server/routes/session.ts`, `src/core/payload.ts` |
| Web | Create `web/src/components/wake/WakePanel.tsx`, `web/src/models/wake.ts`, `web/src/hooks/useWake.ts`, `web/styles/wake.css`; modify `settings-menu.ts`, `useSettingsMenu.ts`, `SidePanels.tsx`, `App.tsx`, `Toolbar.tsx`, `web/index.html` |
| Tests support | Create `test/support/fake-wake-herdr.ts`, `test/support/wake-fixtures.ts`, `test/support/wake-process.ts`, `test/support/fake-wake.ts`, `test/fixtures/wake-manifest.toml` (removed in 7.3); modify `test/support/runner.ts` |
| Manifest, docs | `herdr-plugin.toml` (7.3), `README.md`, `herdr-wake/README.md`, `herdr-wake/herdr-plugin.toml` (7.4) |

## Dependency waves (for the controller)

Tasks in one bracket run in parallel, each in its own worktree from the PR's branch, merged back before the next bracket. A PR's gate runs after its last bracket; the next PR starts from its merge (or stacks on its branch).

| PR | Waves |
|---|---|
| 1 | [1.1, 1.2, 1.3, 1.4, 1.5] (+ 3.1, research only, any time before 7.3) |
| 2 | [2.1, 2.7] → [2.2] → [2.3] → [2.4] → [2.5] → [2.6] |
| 3 | [3.1, 3.2] → [3.3, 3.4] |
| 4 | [4.1] → [4.2, 4.5, 4.7] → [4.3, 4.6] → [4.4] |
| 5 | [5.1, 5.3] → [5.2] (may be built beside PR 4; merges after it) |
| 6 | [6.1, 6.2] |
| 7 | [7.1, 7.3] → [7.2] → [7.4] → **STOP** (the owner's live check) |

---

### Task 0: Baseline (controller, before PR 1)

- [ ] In a fresh worktree of `main` @ `6ae35a5` (or the branch's merge base): `bun install`, `bun test`, `bun run check`. Record every failing test name; that list replaces the expected one under "Green means" for every task and goes into each PR body.
- [ ] Confirm #119, #150, #151 are open and #119 names the owner as taken. Nothing is committed.

---

## PR 1 — Pure parts into `src/core/wake/`

**Issue:** under #119, "Port herdr-wake's pure rules to src/core/wake" (refs #119). **Touches no setup:** nothing imports the new modules yet. **Gate:** see "PR gate" after Task 1.5.

Tasks 1.1–1.5 are independent: one wave, five worktrees. Shared files: none (each creates its own files; 1.5 alone edits `src/core/resume.ts`).

### Task 1.1: Wake's settings and the kill switch

**Depends on:** nothing. **Parallel with:** 1.2–1.5.

**Files:**
- Create: `src/core/wake/config.ts`
- Test: `test/core/wake/config.test.ts` (ports `herdr-wake/test/config.test.mjs`, 4 tests, plus 2 new)

**Interfaces (produces):**
```ts
export const WAKE_SHIPPED = false // Task 7.3: true, with the manifest's wake entries
export const WAKE_PORT = 12421
export type TelegramMode = 'off' | 'auto'
export interface ReaperConfig { enabled: boolean; idleMinutes: number; exclude: string[]; maxPerRound: number }
export interface WakeConfig {
  enabled: boolean
  reaper: ReaperConfig
  telegram: TelegramMode
  port: number
  workspace: string
  url: string | null
  authorization: string | null
  server: string
  wakeTimeoutSec: number
  pollTimeoutSec: number
  listSleepingDays: number
}
/** config.json's `wake` (undefined, true, false or an object) with the defaults; a wrong type is the default. */
export function wakeConfig(section: unknown): WakeConfig
/** The kill switch, read before anything else: config.json missing → WAKE_SHIPPED; there but not an object (does not parse) → off. */
export function wakeSwitch(file: { exists: boolean; raw: unknown }): boolean
export interface TelegramTarget { url: string; authorization: string; host: string }
/** tg-mcp's url and token: the section's, else the `<server>` MCP server in ~/.claude.json (`/mcp` taken off the url); null when Telegram is off or either is missing. */
export function telegramTarget(cfg: WakeConfig, claudeJson: unknown): TelegramTarget | null
```

**Rules:** defaults `enabled: WAKE_SHIPPED`, reaper `{ enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 }`, `telegram: 'off'`, `port: 12421`, `workspace: 'Wake'`, `url: null`, `authorization: null`, `server: 'telegram'`, `wakeTimeoutSec: 120`, `pollTimeoutSec: 25`, `listSleepingDays: 7`. `true` → enabled; `false` → disabled. Numbers: integers ≥ 1 (port 1–65535); `exclude`: the strings only; `telegram` is `'auto'` only when exactly `'auto'`; `workspace` a non-blank string. No `wakeCommand` (every wake is `board resume`).

- [ ] **Step 1: Write the failing tests** in `test/core/wake/config.test.ts`:
```ts
const TELEGRAM = { mcpServers: { telegram: { url: 'http://127.0.0.1:8787/mcp', headers: { Authorization: 'Bearer t' } } } }
test('without a wake section: the defaults, and no Telegram even with tg-mcp in ~/.claude.json', () => {
  const c = wakeConfig(undefined)
  expect(c).toEqual({ enabled: WAKE_SHIPPED, reaper: { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 }, telegram: 'off', port: 12421, workspace: 'Wake', url: null, authorization: null, server: 'telegram', wakeTimeoutSec: 120, pollTimeoutSec: 25, listSleepingDays: 7 })
  expect(telegramTarget(c, TELEGRAM)).toBeNull()
})
test('auto: the telegram MCP server in ~/.claude.json gives the url and token, as before', () => {
  expect(telegramTarget(wakeConfig({ telegram: 'auto' }), TELEGRAM)).toEqual({ url: 'http://127.0.0.1:8787', authorization: 'Bearer t', host: '127.0.0.1:8787' })
})
test('the wake section wins over ~/.claude.json, and its reaper over the defaults', () => {
  const c = wakeConfig({ telegram: 'auto', url: 'http://box:1', authorization: 'Bearer own', reaper: { enabled: true, idleMinutes: 30 } })
  expect(telegramTarget(c, TELEGRAM)).toEqual({ url: 'http://box:1', authorization: 'Bearer own', host: 'box:1' })
  expect(c.reaper).toEqual({ enabled: true, idleMinutes: 30, exclude: [], maxPerRound: 3 })
})
test('a url without a token is no Telegram', () => {
  expect(telegramTarget(wakeConfig({ telegram: 'auto', url: 'http://box:1' }), {})).toBeNull()
})
test('true, false, and wrong types fall back to the defaults', () => {
  expect([wakeConfig(true).enabled, wakeConfig(false).enabled]).toEqual([true, false])
  const c = wakeConfig({ port: 0, telegram: 'on', workspace: ' ', reaper: { exclude: ['a', 1], idleMinutes: '5' } })
  expect([c.port, c.telegram, c.workspace, c.reaper.exclude, c.reaper.idleMinutes]).toEqual([12421, 'off', 'Wake', ['a'], 60])
})
test('the kill switch: no config.json is the default, one that does not parse is off', () => {
  expect(wakeSwitch({ exists: false, raw: null })).toBe(WAKE_SHIPPED)
  expect(wakeSwitch({ exists: true, raw: null })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: [] })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: { wake: false } })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: { wake: { enabled: false } } })).toBe(false)
  expect(wakeSwitch({ exists: true, raw: { wake: { enabled: true } } })).toBe(true)
  expect(wakeSwitch({ exists: true, raw: {} })).toBe(WAKE_SHIPPED)
})
```
- [ ] **Step 2:** `bun test test/core/wake/config.test.ts` → FAIL (cannot find module).
- [ ] **Step 3:** Implement `src/core/wake/config.ts` (no `node:` import; `new URL(url).host` for `host`, an invalid url is no Telegram).
- [ ] **Step 4:** the test → PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add wake's settings to the board's core: the wake section's defaults, the kill switch and tg-mcp's url and token"`

### Task 1.2: The reaper's rules

**Depends on:** nothing. **Parallel with:** 1.1, 1.3–1.5.

**Files:**
- Create: `src/core/wake/reaper.ts`
- Test: `test/core/wake/reaper.test.ts` (ports `herdr-wake/test/reaper.test.mjs`: who sleeps, exited by hand, exclude patterns, scheduled jobs), `test/adapters/wake-transcript-path.test.ts` (ports "transcript path follows the cwd slug, else any project folder" against `createClaudeHome(root).transcriptPath`, root's `projects/`)

**Interfaces (produces):**
```ts
export interface ReapPane { pane_id: string; workspace_id?: string; agent?: string | null; agent_status?: string; agent_session?: { value?: string | null } | null; terminal_title_stripped?: string; focused?: boolean; cwd?: string }
export interface ReapSnapshot { workspaces: { workspace_id: string; label?: string }[]; panes: ReapPane[] }
export interface Running { sessionId: string; name?: string; status?: string; statusUpdatedAt?: number; cwd?: string; [extra: string]: unknown }
export interface ReapEntry { pane: string; name: string; workspace: string; sleep: boolean; reason: string; status?: string; since?: number; idleMin?: number; waiting?: true; session?: string; cwd?: string }
export function matchesAny(patterns: readonly string[], values: readonly (string | null | undefined)[]): boolean
export function exitedPanes(snap: { panes: readonly ReapPane[] }, known: Readonly<Record<string, { session?: string; seen_at?: number; slept_at?: number }>>, live: ReadonlyMap<string, unknown>, now?: number, windowMs?: number): string[]
export function reapPlan(snap: ReapSnapshot, live: ReadonlyMap<string, Running>, o: { idleMinutes: number; exclude?: readonly string[]; now?: number; scheduled?: (s: Running) => boolean; cannotWake?: (s: Running, pane: ReapPane) => string | null }): ReapEntry[]
/** A transcript's text calls CronCreate or ScheduleWakeup within 7 days of `now` (herdr-wake's hasSchedules on the text). */
export function scheduledIn(text: string, now: number): boolean
```

**Rules:** the port of `herdr-wake/src/reaper.mjs` and `claude.mjs` `hasSchedules`, same order of checks, plus `cannotWake` (call 9): checked after "has scheduled jobs" and before the idle time, so a session that cannot be woken is kept with that reason and never `waiting`. A `/regex/` that does not compile never matches (today it throws).

- [ ] **Step 1: Write the failing tests:** move the four reaper tests over (`bun:test`, `node:assert/strict` allowed), the scheduled-jobs test reading the same lines as text (`scheduledIn(lines.join('\n'), now)`); add:
```ts
test('a session the board could not wake again is kept up, with the reason, and never counts down', () => {
  const plan = reapPlan(snap, live, { idleMinutes: 60, now, cannotWake: s => (s.name === 'Billing-master' ? 'cannot wake: no transcript in its profile folder' : s.name === 'recent' ? 'cannot wake: board is not on PATH' : null) })
  expect(plan.find(p => p.pane === 'w1:p1')).toMatchObject({ sleep: false, reason: 'cannot wake: no transcript in its profile folder' })
  expect(plan.find(p => p.pane === 'w1:p2')?.waiting).toBeUndefined()
})
test('an exclude pattern that is no regex never matches and never throws', () => {
  expect(matchesAny(['/[/'], ['['])).toBe(false)
})
```
- [ ] **Step 2:** both files → FAIL.
- [ ] **Step 3:** Implement `src/core/wake/reaper.ts`.
- [ ] **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Port herdr-wake's reaper rules to the board's core, with a reason for a session the board could not wake again"`

### Task 1.3: Routing and topic keys

**Depends on:** nothing. **Parallel with:** 1.1, 1.2, 1.4, 1.5.

**Files:**
- Create: `src/core/wake/route.ts`, `src/core/wake/topics.ts`
- Test: `test/core/wake/route.test.ts` (ports `herdr-wake/test/route.test.mjs`, 8 tests) and `test/core/wake/topics.test.ts` (ports "the launcher’s topic…" from `herdr-wake/test/launcher.test.mjs`)

**Interfaces (produces):**
```ts
// topics.ts — the claude-tg key, as herdr-wake/src/tg-key.mjs and topics.mjs compute it
export function asciiKey(raw: unknown): string
export interface TopicSnapshot { workspaces: { workspace_id: string; label?: string }[]; tabs: { tab_id: string; workspace_id: string; label?: string; number?: number }[]; panes: { pane_id: string; tab_id?: string; workspace_id?: string }[] }
export function workspaceTabs(snap: TopicSnapshot | null | undefined, workspaceId: string): TopicSnapshot['tabs']
export function tabKey(workspace: string, index: number, tabLabel: string | undefined): string
export function keyFor(snap: TopicSnapshot | null | undefined, paneId: string | undefined, cwd: string): string
export function tabKeys(snap: TopicSnapshot): Map<string, string[]>
// route.ts
export function samePath(p: unknown): string
export function localPane(hint: string | null | undefined, machine: string): string | null
export interface RouteItem { key: string; pane?: string; live_panes?: string[]; topic?: string; text?: string; meta?: Record<string, string | undefined>; queued_at?: string; id?: number | string }
export interface RouteTarget { pane: string; title: string; session?: string }
export function resolve(item: RouteItem, snap: TopicSnapshot & { panes: { pane_id: string; tab_id?: string; agent?: string | null; cwd?: string; terminal_title_stripped?: string }[]; agents?: { pane_id: string; state_change_seq?: number }[] }, known: Readonly<Record<string, { session: string; title?: string }>>, machine: string): RouteTarget | null
export function formatPrompt(items: readonly RouteItem[], now?: number): string
```

**Rules:** a port of `route.mjs`, `topics.mjs` and `tg-key.mjs` (`keyFor` without its CLI part); behaviour identical.

- [ ] **Step 1:** Move the tests over (assertions unchanged). → **Step 2:** FAIL.
- [ ] **Step 3:** Implement both modules (no `node:` import).
- [ ] **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Port herdr-wake's Telegram routing and topic keys to the board's core"`

### Task 1.4: The screens wake reads

**Depends on:** nothing. **Parallel with:** 1.1–1.3, 1.5.

**Files:**
- Create: `src/core/wake/screens.ts`
- Test: `test/core/wake/screens.test.ts` (ports `herdr-wake/test/screen.test.mjs`, 10 tests; the input-box ones run against `inputDraft` of `src/core/dialogs/input-box.ts`, "colour arguments are not mistaken for dim" as `inputDraft(screen(\`❯ ${E}[38;2;2;2;2mvisible${E}[0m\`)) === 'visible'`)

**Interfaces (produces):** `export function isExitTasksDialog(plain: string): boolean`, `export function isTrustDialog(plain: string): boolean`, `export function isChannelsWarning(plain: string): boolean` (the regexes of `screen.mjs`, verbatim).

- [ ] **Step 1:** Move the tests. → **Step 2:** FAIL.
- [ ] **Step 3:** Implement. Do **not** change `src/core/dialogs/input-box.ts`: if one ported input-box test fails against it, stop and report it (the board's own reading would differ from herdr-wake's).
- [ ] **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Port the screens herdr-wake recognises to the board's core, read with the board's own input box"`

### Task 1.5: The rules new to the port: can wake, the wake line, the prompt key, the hooks' filter, board resume's folder

**Depends on:** nothing. **Parallel with:** 1.1–1.4. **Shared file:** `src/core/resume.ts` (also Task 2.7, 5.3, later).

**Files:**
- Create: `src/core/wake/rules.ts`
- Modify: `src/core/resume.ts` (add two exports at the end)
- Test: `test/core/wake/rules.test.ts`, `test/core/resume.test.ts` (append)

**Interfaces (produces):**
```ts
// rules.ts
export interface WakeProfile { dir: string; id?: string }
export type CannotWake = 'board' | 'profile' | 'transcript'
/** English, for the API and the reaper's reasons. */
export const CANNOT_WAKE: Record<CannotWake, string> = { board: 'board is not on PATH', profile: 'its profile folder is not known', transcript: 'no transcript in its profile folder' }
/** Call 9: what keeps a session from being put to sleep, or null when it could be woken again. */
export function canWake(f: { boardOnPath: boolean; profileDir: string | null | undefined; transcript: string | null | undefined }): CannotWake | null
/** The one line typed into a pane to wake a session; null for what is not a session id (pi's and Codex's keys, `pane-<id>`). */
export function wakeLine(session: string, profile?: string | null): string | null
export type ClearKey = 'esc' | 'ctrl+u'
/** Call 18: by the pane's shell; an unknown one by the OS, as today. */
export function clearKeyFor(shell: string | null | undefined, platform?: string): ClearKey
/** Decision 9: the entries of the caller's own profile (CLAUDE_CONFIG_DIR; unset: the default folder). An entry without a profile is the default folder's. */
export function ownSleepers<T extends { profile?: WakeProfile | undefined }>(list: readonly T[], o: { configDir: string | undefined; home: string; platform?: string }): T[]
// resume.ts
/** The folder Claude keeps a project's transcripts in under projects/: the cwd without trailing separators, every other character than A-Z a-z 0-9 a dash. */
export const projectFolderName = (cwd: string): string => cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-')
export interface ResumeDirFacts { cwd: string; transcriptHere: boolean; recorded: string | null; recordedExists: boolean }
/** Call 29: null stays in `cwd` (its transcript is there, or nothing better is found); else the folder the transcript recorded. */
export function resumeDir(f: ResumeDirFacts): string | null
```

**Rules:**
- `wakeLine`: `board resume <session>` plus ` --profile <id>` when `id` matches `/^[A-Za-z0-9_.-]+$/`; `null` unless `SESSION_ID.test(session)` (`src/core/resume.ts`).
- `clearKeyFor`: name lower-cased, a trailing `.exe` dropped; `pwsh`, `powershell`, `cmd` → `esc`; `bash`, `zsh`, `fish`, `sh`, `dash`, `ksh` → `ctrl+u`; else `platform === 'win32' ? 'esc' : 'ctrl+u'`.
- `ownSleepers`: caller's folder `resolveProfileDir(configDir, home, platform)`; an entry's `absoluteProfileDir(entry.profile?.dir, home, platform) ?? defaultProfileDir(home, platform)`; kept when `sameDir` (as `core/resume.ts` compares folders).
- `resumeDir`: `transcriptHere` → null; else `recorded && recordedExists && !sameDir(recorded, cwd)` → `recorded`; else null.

- [ ] **Step 1: Write the failing tests:**
```ts
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
test('can wake: board on PATH, the profile folder known, the transcript in it', () => {
  expect(canWake({ boardOnPath: true, profileDir: 'C:\\Users\\a\\.claude-work', transcript: 'x.jsonl' })).toBeNull()
  expect(canWake({ boardOnPath: false, profileDir: 'd', transcript: 't' })).toBe('board')
  expect(canWake({ boardOnPath: true, profileDir: null, transcript: 't' })).toBe('profile')
  expect(canWake({ boardOnPath: true, profileDir: 'd', transcript: null })).toBe('transcript')
})
test('the wake line: one command every shell runs, no folder, no quotes; the profile only as a plain id', () => {
  expect(wakeLine(SID, 'work')).toBe(`board resume ${SID} --profile work`)
  expect(wakeLine(SID)).toBe(`board resume ${SID}`)
  for (const id of ['Иван', 'a b', '100%', "o'k"]) expect(wakeLine(SID, id)).toBe(`board resume ${SID}`)
  for (const key of ['pane-w1:p2', 'pi-session-file.jsonl', '']) expect(wakeLine(key, 'work')).toBeNull()
})
test('the prompt line is cleared by the pane’s shell; an unknown one by the OS', () => {
  expect(['pwsh.exe', 'powershell.exe', 'cmd.exe', 'PWSH'].map(s => clearKeyFor(s, 'linux'))).toEqual(['esc', 'esc', 'esc', 'esc'])
  expect(['bash', 'zsh', 'fish', 'sh', 'bash.exe'].map(s => clearKeyFor(s, 'win32'))).toEqual(['ctrl+u', 'ctrl+u', 'ctrl+u', 'ctrl+u', 'ctrl+u'])
  expect([clearKeyFor(null, 'win32'), clearKeyFor('nu', 'darwin')]).toEqual(['esc', 'ctrl+u'])
})
test('the hooks keep their own profile’s sleepers, the folder spelled any way', () => {
  const home = 'C:\\Users\\Иван Петров'
  const work = { name: 'w', profile: { dir: 'C:\\Users\\Иван Петров\\.claude-work 100%', id: 'work' } }
  const dflt = { name: 'd', profile: { dir: 'C:\\Users\\Иван Петров\\.claude' } }
  const legacy = { name: 'old' }
  const list = [work, dflt, legacy]
  expect(ownSleepers(list, { configDir: undefined, home, platform: 'win32' })).toEqual([dflt, legacy])
  expect(ownSleepers(list, { configDir: 'c:/users/иван петров/.CLAUDE-WORK 100%/', home, platform: 'win32' })).toEqual([work])
  expect(ownSleepers(list, { configDir: '~/.claude', home, platform: 'win32' })).toEqual([dflt, legacy])
  expect(ownSleepers([{ name: 'p', profile: { dir: '/home/u/.claude-work' } }], { configDir: '/home/u/.claude-work/', home: '/home/u', platform: 'linux' })).toHaveLength(1)
})
// test/core/resume.test.ts
test('board resume’s folder: the pane’s when the transcript is there, else the one the transcript recorded, else as today', () => {
  expect(projectFolderName('C:\\Work\\Проект x 50%\\')).toBe('C--Work--------x-50-')
  expect(resumeDir({ cwd: 'C:\\Work\\Acme', transcriptHere: true, recorded: 'C:\\Elsewhere', recordedExists: true })).toBeNull()
  expect(resumeDir({ cwd: 'C:\\Users\\me', transcriptHere: false, recorded: 'C:\\Work\\Проект x 50%', recordedExists: true })).toBe('C:\\Work\\Проект x 50%')
  expect(resumeDir({ cwd: 'C:\\Users\\me', transcriptHere: false, recorded: 'C:\\Gone', recordedExists: false })).toBeNull()
  expect(resumeDir({ cwd: 'C:\\Users\\me', transcriptHere: false, recorded: null, recordedExists: false })).toBeNull()
  expect(resumeDir({ cwd: 'c:/work/acme/', transcriptHere: false, recorded: 'C:\\Work\\Acme', recordedExists: true })).toBeNull()
})
```
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`rules.ts` imports `core/profiles.ts`, `core/launch/names.ts`, `core/resume.ts`; no `node:` import). **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add the rules wake gains in the board: can wake, one wake line for every shell, the prompt key by shell, the hooks' own profile and board resume's folder"`

### PR 1 gate (controller)

- [ ] Each new test file run against `main`'s files fails (the modules do not exist there); with the branch, passes.
- [ ] `bun test` and `bun run check` green but Task 0's list.
- [ ] PR "Port herdr-wake's pure rules to src/core/wake", body: refs #119, "Touches no setup: nothing imports these modules yet; `src/core/resume.ts` only gains exports". Lists the 34 ported tests by file and which were adapted and why (Task 1.1: `wakeCommand` gone, Telegram Off by default; the launcher tests that move later: Tasks 5.2, 5.3, 6.2).

---

## PR 2 — The wake process

**Issue:** under #119, "The wake process on Bun: sessions seen, sleep, wake through board resume, per profile, its API" (refs #119, #150, #151; they close with PR 7). **Touches:** `board resume` (every setup's restored panes run it): Task 2.7 compares it. Everything else is new and not started by anything (no manifest entry).

Waves: **[2.1, 2.7]** → **[2.2]** → **[2.3]** → **[2.4]** → **[2.5]** → **[2.6]**. Shared files: `test/support/runner.ts` (2.2 only), `src/entrypoints/cli.ts` (2.7 only).

### Task 2.1: The session file's model

**Depends on:** PR 1 (Task 1.2 types, 1.5 `WakeProfile`). **Parallel with:** 2.2, 2.7.

**Files:**
- Create: `src/core/wake/sessions.ts`
- Test: `test/core/wake/sessions.test.ts`

**Interfaces (produces):**
```ts
export interface WakeEntry { session: string; name: string; cwd?: string; title?: string; seen_at: number; slept_at?: number; exited?: boolean; profileDir?: string; profile?: string; [extra: string]: unknown }
export type WakeSessions = Record<string, WakeEntry> // pane id → its last Claude session
/** null for what is not an object; entries without a string `session` and a number `seen_at` dropped; unknown fields kept. */
export function asWakeSessions(value: unknown): WakeSessions | null
export interface SeenSnapshot extends ReapSnapshot { takenAt?: number }
/** A running session as the registries show it: its name and the profile folder whose registry has it. */
export interface Seen { name?: string; profileDir: string; profile?: string }
export interface Remembered { sessions: WakeSessions; changed: boolean; renames: { pane: string; label: string | null }[]; exited: string[] }
/** router.mjs remember(), pure: who runs where, who was exited by hand (renamed `💤 <name>`), who is awake again (rename cleared), what is gone for 7 days. `going`: panes between /exit and the shell prompt. */
export function rememberSeen(snap: SeenSnapshot, prev: WakeSessions, live: ReadonlyMap<string, Seen>, now: number, going?: ReadonlySet<string>): Remembered
export const KEEP_GONE_MS = 7 * 86_400_000
export interface SleepingAnswer { name: string; pane: string; session: string; workspace: string; slept_at: string; exited: boolean; profile?: WakeProfile }
export function sleepingOf(snap: SeenSnapshot, sessions: WakeSessions): SleepingAnswer[]
export interface AwakeAnswer { name: string; pane: string; workspace: string; status: string; since: string; sleeps_in_min: number | null; kept: string | null; profile?: WakeProfile }
export function awakeOf(plan: readonly ReapEntry[], reaper: Pick<ReaperConfig, 'enabled' | 'idleMinutes'>, profiles: ReadonlyMap<string, WakeProfile>): AwakeAnswer[]
export interface Found extends WakeEntry { pane: string; live: boolean }
/** By name (a trailing " [hex]" dropped), pane id or session id, any case, among panes herdr still has. */
export function findSession(target: unknown, snap: SeenSnapshot, sessions: WakeSessions): Found | undefined
```

**Rules:** a port of `router.mjs` `remember`, `markAwake`, `sleeping`, `awake`, `findSession` without I/O; the order of fields in the answers as the old router's (`name, pane, session, workspace, slept_at, exited` then `profile`). `rememberSeen` stores `profileDir` and `profile` from `Seen` on each entry it writes, keeps them on entries it does not touch. `profile` in an answer: `{ dir: profileDir, ...(profile && { id: profile }) }` when the entry has `profileDir`, else absent.

- [ ] **Step 1: Write the failing tests** (`now = Date.parse('2026-10-21T12:00:00Z')`, ids from `SESSION_ID` shape):
  - `a Claude seen in a pane is remembered with its name and its profile folder` → entry `{ session, name, cwd, title, seen_at: now, profileDir: 'C:\\h\\.claude-work', profile: 'work' }`, `changed: true`.
  - `a session the user exited counts as asleep, its pane renamed 💤 <name>` → `slept_at === seen_at`, `exited: true`, `renames: [{ pane, label: '💤 Billing' }]`.
  - `Claude back in a sleeping pane after the sleep is awake; a view older than the sleep is not` (`takenAt` before/after `slept_at`) → rename `{ label: null }` only for the newer view.
  - `a session running in another pane is awake there; a pane gone for 7 days is forgotten, one gone for 6 is kept`.
  - `the sleeping list: field for field as the old router’s, plus each session’s profile` → `toEqual([{ name: 'Billing', pane: 'w1:p2', session: SID, workspace: 'Счета 100%', slept_at: '2026-10-21T11:00:00.000Z', exited: false, profile: { dir: 'C:\\h\\.claude-work', id: 'work' } }])`; an entry without `profileDir` has no `profile` key.
  - `findSession: by name with a [hex] suffix, by pane, by session id, any case; a pane herdr no longer has finds nothing`.
  - `asWakeSessions keeps unknown fields and drops what is not an entry` (`{ 'w1:p1': { session: 's', seen_at: 1, extra: 1 }, bad: 3, 'w1:p2': { session: 2 } }` → only `w1:p1`, with `extra`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add the model of wake's session file: sessions seen per pane with their profile, the sleeping and awake lists, and finding a session"`

### Task 2.2: Wake's files, herdr calls and transcript reads (adapters)

**Depends on:** PR 1, Task 2.1 (`WakeSessions`). **Parallel with:** 2.7 (when 2.7 is still running). **Shared file:** `test/support/runner.ts` (adds the mode `'wake-io'` to `RunnerMode` and its branch).

**Files:**
- Create: `src/adapters/wake-files.ts`, `src/adapters/wake-herdr.ts`, `src/adapters/wake-transcripts.ts`
- Modify: `test/support/runner.ts` (mode `'wake-io'`: `{ method, args }` → calls `cliWakeHerdr[method](...args)`, prints the JSON result)
- Test: `test/adapters/wake-files.test.ts`, `test/adapters/wake-herdr.test.ts`, `test/adapters/wake-transcripts.test.ts`

**Interfaces (produces):**
```ts
// wake-files.ts (paths computed at call time from stateDir(), as paths.ts does)
export const wakeSessionsFile = (): string => join(stateDir(), 'wake-sessions.json')
export const wakeLogFile = (): string => join(stateDir(), 'wake.log')
/** {} when there is none; a file that does not read as sessions is renamed `<file>.broken-<ms>` (never overwritten) and {} returned; `log` hears it. */
export function readWakeSessions(file?: string, log?: (text: string) => void): WakeSessions
/** Atomic: a temporary file, then a rename (json-store.ts replaceFile). */
export function saveWakeSessions(sessions: WakeSessions, file?: string): void
/** One line `<ISO time> <text>`; past 2_000_000 bytes the file becomes `wake.log.1` first. Never throws. */
export function wakeLog(text: string, file?: string): void
export function wakeLogTail(lines: number, file?: string): string
// wake-herdr.ts
export interface ProcessInfo { shellPid: number | null; foreground: { pid: number; name: string }[]; shell: string | null }
export function asProcessInfo(answer: unknown): ProcessInfo
export interface WakeHerdr {
  snapshot(): Promise<HerdrSnapshot>                        // api snapshot (unknown fields such as `agents` kept)
  pane(pane: string): Promise<HerdrPane | null>             // pane get <pane>
  agent(pane: string): Promise<HerdrAgent | null>           // agent get <pane>
  processInfo(pane: string): Promise<ProcessInfo>           // pane process-info --pane <pane>
  run(pane: string, line: string): Promise<void>            // pane run <pane> <line>
  sendKeys(pane: string, key: string): Promise<void>        // pane send-keys <pane> <key>
  sendText(pane: string, text: string): Promise<void>       // pane send-text <pane> <text>
  rename(pane: string, label: string | null): Promise<void> // pane rename <pane> <label> | pane rename <pane> --clear
  prompt(pane: string, text: string): Promise<void>         // agent prompt <pane> <text>
  screen(pane: string): Promise<string>                     // pane read <pane> --source visible
  inputBox(pane: string): Promise<string>                   // agent read <pane> --source recent --lines 40 --ansi
}
export const cliWakeHerdr: WakeHerdr // over herdr()/herdrText() of adapters/herdr.ts
// wake-transcripts.ts
/** scheduledIn() on the transcript's text, read asynchronously, cached by path until its mtime or size changes; null → false; a file that cannot be read → true (kept up, as today). */
export function scheduledJobs(path: string | null, now?: number): Promise<boolean>
```

**Rules:** `asProcessInfo`: `answer.process_info.shell_pid` (number or null), `foreground_processes` entries with numeric `pid` and string `name`; `shell` = the `name` of the foreground process whose `pid` is `shell_pid`, lower-cased, `.exe` dropped; else null. A leading `-` in `prompt` text gets a space in front (as `services/actions.ts send` does).

- [ ] **Step 1: Write the failing tests:**
  - `wake-files`: `the session file is written atomically and read back with unknown fields` (no `*.tmp*` left in the folder); `a broken session file is set aside, never overwritten, and said` (write `{"w1:p1":` → `readWakeSessions` gives `{}`, a `wake-sessions.json.broken-<n>` holds the bytes, `log` got one line naming it; a later `saveWakeSessions` leaves the broken copy); `the log rotates past 2 MB` (a 2_000_001-byte log → `wake.log.1` has it, `wake.log` one new line); `the log never throws` (a file path in a folder that is a file).
  - `wake-herdr` (sandbox, compiled fake herdr, runner mode `wake-io`): `each call is the herdr command herdr-wake made` → e.g. `run('w1:p1', 'board resume <SID> --profile work')` logs `['pane','run','w1:p1','board resume <SID> --profile work']`; `rename('w1:p1', null)` logs `['pane','rename','w1:p1','--clear']`; `prompt('w1:p1', '-x')` logs `['agent','prompt','w1:p1',' -x']`. `asProcessInfo` unit test: `{ process_info: { shell_pid: 10, foreground_processes: [{ pid: 10, name: 'PWSH.EXE' }, { pid: 11, name: 'claude' }] } }` → `{ shellPid: 10, foreground: [...2], shell: 'pwsh' }`; no match → `shell: null`.
  - `wake-transcripts`: `a CronCreate within 7 days keeps it up; read once until the file changes` (spy: rewrite the file with the same mtime and size → cached answer; touch → new answer); `an unreadable path counts as scheduled`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add wake's files, herdr calls and transcript reads: an atomic session file set aside when broken, a rotated log, the pane's shell from herdr"`

### Task 2.3: Waking and putting to sleep in a pane (shared by the wake process and the board)

**Depends on:** Task 2.2 (`WakeHerdr`), PR 1 (Tasks 1.4, 1.5). **Parallel with:** nothing in PR 2 (2.4 needs it).

**Files:**
- Create: `src/services/wake/pane-ops.ts`, `test/support/fake-wake-herdr.ts`
- Test: `test/services/wake-pane-ops.test.ts`

**Interfaces:**
- Consumes: `WakeHerdr`, `ProcessInfo` (2.2); `wakeLine`, `clearKeyFor` (1.5); `isTrustDialog`, `isChannelsWarning`, `isExitTasksDialog` (1.4); `inputDraft` (`core/dialogs/input-box.ts`).
- Produces:
```ts
export type WakeOutcome = { ok: true } | { ok: false; why: 'busy' | 'timeout' | 'trust' | 'blocked' | 'line'; error: string }
export interface Timing { sleep?(ms: number): Promise<void>; now?(): number; log?(text: string): void }
/** One operation per pane at a time, in this process. */
export function withPane<T>(pane: string, fn: () => Promise<T>): Promise<T>
export function waitReady(io: WakeHerdr, pane: string, timeoutMs: number, t?: Timing): Promise<'ready' | 'trust' | 'blocked' | 'timeout'>
export function wakeInPane(io: WakeHerdr, target: { pane: string; session: string; profile?: string | null }, o: Timing & { timeoutMs: number; platform?: string }): Promise<WakeOutcome>
export interface SleepMarks { going(now: number): void; slept(now: number): void; stayed(): void }
export function putToSleep(io: WakeHerdr, target: { pane: string; session: string; name: string; profile?: string | null }, marks: SleepMarks, t?: Timing): Promise<boolean>
// test/support/fake-wake-herdr.ts
export interface FakePane { pane_id: string; tab_id?: string; workspace_id?: string; agent?: string | null; agent_status?: string; agent_session?: { value: string } | null; cwd?: string; terminal_title_stripped?: string; focused?: boolean }
export interface FakeWakeHerdr extends WakeHerdr {
  calls: string[][]                                   // each call as herdr's argv, as 2.2 maps them
  panes: FakePane[]; workspaces: { workspace_id: string; label?: string }[]; tabs: { tab_id: string; workspace_id: string; label?: string; number?: number }[]
  shells: Record<string, string>                      // pane → shell name for processInfo
  busy: Set<string>                                   // panes whose foreground runs another program
  screens: Record<string, string>; inputBoxes: Record<string, string>
  on(match: (argv: string[]) => boolean, effect: (argv: string[]) => void): void
}
export function fakeWakeHerdr(init?: Partial<Pick<FakeWakeHerdr, 'panes' | 'workspaces' | 'tabs' | 'shells' | 'screens' | 'inputBoxes'>>): FakeWakeHerdr
```

**Rules (the port of `router.mjs` `wake`, `waitReady`, `putToSleep`, with calls 17 and 18):**
- `wakeInPane`: line = `wakeLine(session, profile)`, null → `{ ok: false, why: 'line' }` with no herdr call; `processInfo`: a foreground pid other than `shellPid` → `busy`; `sendKeys(pane, clearKeyFor(info.shell, platform))`; `run(pane, line)` (no `cd`); `waitReady(timeoutMs)`. Errors in English: busy `'its pane runs another program'`, timeout `'it did not start in time'`, trust `'it asks whether to trust the folder: answer in its terminal'`, blocked `'it waits for an answer in its terminal'`.
- `waitReady`: polls `pane(pane)` every 1.5 s; Claude idle/done → ready; blocked → read `screen`: trust → `trust`; the development-channels warning → `sendKeys('enter')`, at most 3 times, 5 s apart; else `blocked`.
- `putToSleep`: inside `withPane`; refuses (false, no `/exit`) unless the pane holds Claude with this session, idle or done, and `inputDraft(inputBox)` is `''`; then `marks.going(now)`, `prompt('/exit')`, polls `pane()` each second for 30 s: the exit-tasks dialog → `sendKeys('esc')`, `marks.stayed()`, false; no agent → `marks.slept(now)`, `rename('💤 ' + name)`, wait 500 ms, `sendText(wakeLine(...))` (typed, not run), true; time out → `marks.stayed()`, false.

- [ ] **Step 1: Write the failing tests** (fake clock: `sleep` resolves at once):
  - `wake types board resume with the profile into the pane, after clearing the line by its shell` — for each `[shell, key]` of `[['pwsh', 'esc'], ['cmd', 'esc'], ['bash', 'ctrl+u'], ['zsh', 'ctrl+u']]`: calls contain `['pane','send-keys','p1',key]` then `['pane','run','p1',\`board resume ${SID} --profile work\`]`, and no call's argv holds `cd `.
  - `a pane running another program is not typed into` → `{ ok: false, why: 'busy' }`, no `send-keys`, no `run`.
  - `pi’s and Codex’s keys never reach board resume` → `wakeInPane(io, { pane: 'p1', session: 'pane-p1' })` → `why: 'line'`, `calls` empty.
  - `the development-channels warning is answered, the trust question is left to the user`.
  - `put to sleep: /exit, the pane renamed 💤 <name>, the wake line typed at its prompt, not run`.
  - `a draft, a busy session, or another session in the pane is never put to sleep` (no `agent prompt` call).
  - `background tasks on /exit: Esc, and it stays up` (`marks.stayed` called).
  - `two operations on one pane run one after the other` (`withPane`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement `fake-wake-herdr.ts` (each method pushes the argv of 2.2's mapping, then reads or changes its state; `on()` effects run after the push), then `pane-ops.ts`. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add waking and putting to sleep in a pane for wake and the board alike: board resume typed with the profile, the line cleared by the pane's shell"`

### Task 2.4: The wake engine, per profile

**Depends on:** Tasks 2.1, 2.2, 2.3. **Fixes** #150 and #151 for the new wake.

**Files:**
- Create: `src/services/wake/engine.ts`, `test/support/wake-fixtures.ts`
- Test: `test/services/wake-engine.test.ts`

**Interfaces:**
```ts
export interface WakeEngineDeps {
  herdr: WakeHerdr
  homes: ProfileHomes                 // services/deps.ts defaultDeps(cfg).homes
  profiles(): ProfileSet              // defaultDeps(cfg).profiles
  settings(): WakeConfig              // live
  sessionsFile: string
  boardOnPath(): boolean              // adapters/resume-report.ts boardOnPath
  scheduled(path: string | null): Promise<boolean> // adapters/wake-transcripts.ts scheduledJobs
  log(text: string): void
  now?(): number
  platform?: string
  sleep?(ms: number): Promise<void>
}
export type TargetAnswer = { ok: true; pane: string; name: string; already?: true } | { ok: false; error: string }
export interface StatusAnswer { pid: number; started: string; lastPoll: string | null; lastError: string | null; reaper: ReaperConfig; sleeping: SleepingAnswer[]; sessions: WakeSessions }
export interface WakeEngine {
  remember(): Promise<void>
  sleeping(): Promise<SleepingAnswer[]>
  awake(): Promise<AwakeAnswer[]>
  status(): Promise<StatusAnswer>
  wake(target: unknown): Promise<TargetAnswer>
  sleep(target: unknown): Promise<TargetAnswer>
  reapRound(): Promise<void>
  plan(): Promise<ReapEntry[]>                       // --reap-dry
  /** Wakes, sleeps and deliveries under way. */
  busy(): number
  /** For the Telegram router (Task 6.1): the pane's known session woken in it. */
  wakePane(pane: string): Promise<WakeOutcome>
  telegram: { lastPoll: string | null; lastError: string | null } // written by Task 6.1
}
export function createWakeEngine(deps: WakeEngineDeps): WakeEngine
// test/support/wake-fixtures.ts
export const SID: string; export const SID2: string // two session ids
/** Claude's registry entry (<dir>/sessions/<n>.json, this test's pid, so it counts as running) and its transcript (<dir>/projects/<projectFolderName(cwd)>/<id>.jsonl, a first line with "cwd"). */
export function runningSession(dir: string, s: { id: string; name: string; cwd: string; status?: string; statusUpdatedAt?: number; n?: number; lines?: string[] }): void
export function profilesConfig(appData: string, profiles: { id: string; title?: string; dir: string }[], extra?: Record<string, unknown>): void // the board's config.json
```

**Rules:**
- Running sessions from every folder the board reads: `homes.liveSessions([profiles().inheritedDir, ...profiles().list.map(p => p.dir)])`; each hit's `home.root` is its `profileDir`, `profileForDir(list, root)?.id` its `profile`.
- One writer: the engine owns the session file (`readWakeSessions` once at creation, `saveWakeSessions` after each change); renames from `rememberSeen` go to herdr, errors ignored.
- `reapPlan` with `scheduled` from a set precomputed by awaiting `deps.scheduled(home.transcriptPath(id, cwd))` per idle session, and `cannotWake` = `canWake({ boardOnPath, profileDir, transcript })` → `` `cannot wake: ${CANNOT_WAKE[why]}` ``.
- `sleep(target)`: running, idle in **its own profile's** registry (#150), `canWake` passes (else `{ ok: false, error: \`${name} cannot be put to sleep: ${CANNOT_WAKE[why]}\` }`), then `putToSleep` with marks writing `slept_at`, `profileDir`, `profile` on the entry. Old error texts kept: `no running session named <target>`, `<name> is not idle`, `<name> did not go to sleep (busy, or text in its input box)`.
- `wake(target)`: `already` when live; else `wakeInPane` with the entry's `profile` (#151), `markAwake`, then waits up to 20 s for the session in any profile's registry. Error `no session named <target> in herdr`, or the outcome's `error`.
- `reapRound`: only while `settings().reaper.enabled`; at most `maxPerRound`.
- Only panes with `agent === 'claude'` and sessions matching `SESSION_ID`.

- [ ] **Step 1: Write the failing tests** (`fakeWakeHerdr`, a temp HOME with `.claude` and `.claude-work`, `defaultDeps`-like homes from `createProfileHomes()`, profiles from a `ProfileSet` built with `profileSet(mergeProfiles(...))` or a literal):
  - `#150: a Work session is put to sleep, its registry read in Work’s folder` → `sleep(SID)` ok; the entry has `profileDir: <home>/.claude-work`, `profile: 'work'`; calls end with `['pane','send-text','w1:p1',\`board resume ${SID} --profile work\`]`.
  - `#151: a sleeping Work session wakes through board resume --profile work, wherever the shell’s profile points` → calls include `['pane','run','w1:p1',\`board resume ${SID} --profile work\`]`.
  - `a profile folder with spaces, Cyrillic and %: the line carries its id only` (profile `{ id: 'ivan', dir: '<home>/Профиль 100%' }`).
  - `a folder no listed profile has: board resume without --profile` (registry in an unlisted folder → `board resume <SID>`).
  - `no board on PATH, an unknown profile folder, no transcript: not put to sleep, and the reason said` (three cases; no `agent prompt` call).
  - `the reaper puts nobody to sleep while it is off; on, at most maxPerRound, never a session it could not wake`.
  - `a pane-<id> key and a pi pane are never woken nor put to sleep`.
  - `the sleeping list carries each session’s profile; /awake too` (two profiles, `profile.id` `default` and `work`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement `wake-fixtures.ts`, then `engine.ts`. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add the wake engine: sessions seen, sleep, wake and the reaper for every Claude profile, waking through board resume in the session's profile"`

### Task 2.5: The wake process and its API

**Depends on:** Task 2.4.

**Files:**
- Create: `src/entrypoints/wake.ts`, `test/support/wake-process.ts`
- Test: `test/entrypoints/wake.test.ts`

**Interfaces:**
```ts
// src/entrypoints/wake.ts
//   bun src/entrypoints/wake.ts              the process: API on 127.0.0.1:<wake.port>, sessions seen every 15 s, the reaper every 60 s while on
//   bun src/entrypoints/wake.ts --reap-dry   the reaper's verdict for every Claude pane, one line each (router.mjs's format)
// After it listens: process.send?.({ up: port }) when it has an IPC channel (the supervisor, Task 3.2).
// test/support/wake-process.ts
export async function startWakeProcess(box: Sandbox, o: { port: number; wake?: Record<string, unknown>; config?: Record<string, unknown> }): Promise<{ url: string; proc: Bun.Subprocess; stop(): Promise<void> }> // throws when o.port is 12421 or 12422
```

**Rules:**
- First thing: `wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })`; off → exit 0 with no herdr call. Then `liveConfig(onChange)`: turned off → `server.stop()`, exit 0; reaper switched → its loop started or stopped; no restart needed.
- `Bun.serve({ hostname: '127.0.0.1', port })`. Paths and answers as the old router: `GET /status`, `GET /sleeping`, `GET /awake` → 200 JSON (pretty-printed with one-space indent, as `JSON.stringify(out, null, 1)`); `POST /wake`, `POST /sleep` read `{ target }` (a body that does not parse is `{}`); anything else 404 with an empty body; a thrown error 500 `{ ok: false, error }`. The port taken is Task 3.4's; here, an error that ends the process with 1 and a line in `wake.log`.
- Logs (`wakeLog`) the start line `wake up: <Telegram off|host>, <reaper on (N min)|reaper off>, state <dir>, API http://127.0.0.1:<port>`.

- [ ] **Step 1: Write the failing tests** (sandbox + compiled fake herdr; `unusedPort()`; registry and transcripts under the sandbox HOME):
  - `the API answers today’s paths, plus each session’s profile` (/status keys exactly `['pid','started','lastPoll','lastError','reaper','sleeping','sessions']`; /sleeping entry with `profile`; unknown path 404).
  - `"wake": false, or a config.json that does not parse: the process ends at once and asks herdr nothing` → exit code 0, `box.calls()` empty, nothing listens on the port.
  - `on by default doing nothing by itself: idle sessions past idleMinutes and tg-mcp in ~/.claude.json, and over many rounds nobody is put to sleep, woken, renamed or typed into` (config `wake: { enabled: true, port, reaper: { enabled: false, idleMinutes: 1 } }`, registry idle for 2 h, `~/.claude.json` with a telegram server, a stub tg-mcp `Bun.serve` that counts requests; set `BOARD_WAKE_ROUND_MS=50` — a test-only env the process reads for both loops, default unset; wait 1 s) → no call starting `agent prompt`, `pane run`, `pane rename`, `pane send-keys`, `pane send-text`; the stub got 0 requests.
  - `it listens on 127.0.0.1 only` → a fetch to the first non-internal IPv4 of `os.networkInterfaces()` on the port fails (`test.skipIf` none).
  - `turned off in config.json while it runs: its API closes and it ends with 0`.
  - `--reap-dry prints one line per Claude pane`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement `wake-process.ts` (writes `<APPDATA>/herdr/plugins/config/agent-board/config.json` with `language: 'en', port: 9` and the wake section, spawns with `box.env`, waits ≤ 10 s for `/status`), then `wake.ts`. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add the wake process: today's local API on 127.0.0.1 with each session's profile, the kill switch read first, settings followed live"`

### Task 2.6: The API compared with the old router's

**Depends on:** Task 2.5.

**Files:**
- Test: `test/entrypoints/wake-parity.test.ts`

**Rules:** both on the same compiled fake herdr and the same registry: the old router as `node herdr-wake/src/router.mjs` with `HERDR_PLUGIN_CONFIG_DIR` (its `config.json` with an unused `port`), `HERDR_PLUGIN_STATE_DIR` (its `sessions.json`) and the sandbox HOME; the new one with `startWakeProcess` and a `wake-sessions.json` holding the same entries. `test.skipIf(!Bun.which('node'))` — the PR names the skip where Node is missing.

- [ ] **Step 1: Write the test** `the new wake answers /sleeping, /awake and /status field for field as the old router, but each session’s profile`: a Default idle session in `w1:p1`, a sleeper in `w1:p2` (a shell); compare `/sleeping` and `/awake` with `profile` deleted from each entry (`toEqual`), `/status` by keys and value types (`pid`, `started` differ in value), `/wake {target:'nobody'}` and `/sleep {target:'nobody'}` bodies equal; unknown path both 404.
- [ ] **Step 2:** Run it against PR 1's tree: FAIL (no `src/entrypoints/wake.ts`); with the branch: PASS (where Node is present). `bun test`; `bun run check`.
- [ ] **Step 3: Commit** `git commit -m "Compare the new wake's API with the old router's on the same fake herdr, field for field but the profile"`

### Task 2.7: `board resume` goes to the session's project folder

**Depends on:** PR 1 (Task 1.5). **Parallel with:** 2.1, 2.2. **Shared files:** `src/entrypoints/cli.ts` (resume only), `src/adapters/process.ts`, `src/adapters/claude-home.ts`.

**Files:**
- Modify: `src/adapters/process.ts` (`runHere(file, args, env?, cwd?)`), `src/entrypoints/cli.ts` (`resume()`), `src/adapters/claude-home.ts` (its private `projectFolder` replaced by `projectFolderName` from `core/resume.ts`, identical)
- Test: `test/entrypoints/resume.test.ts` (append)

**Interfaces:** `export function runHere(file: string, args: string[], env?: Record<string, string | undefined>, cwd?: string): Promise<{ code: number; error: (Error & { code?: unknown }) | null }>`.

**Rules:** in `resume()`: the folder `dir = plan.dir ?? resolveProfileDir(process.env.CLAUDE_CONFIG_DIR, homedir())`; `transcriptHere` = `<dir>/projects/<projectFolderName(cwd)>/<id>.jsonl` exists; otherwise the first `<dir>/projects/*/<id>.jsonl` found, its recorded folder by `cwdOf(file)` (`adapters/claude-home.ts`), `recordedExists` = a folder; `resumeDir(...)` → Claude runs there (`runHere(..., cwd)`), else in the current folder as today. Nothing is printed; herdr is asked nothing.

- [ ] **Step 1: Write the failing tests** (the existing `setUp`, `boardResume`; the fake claude logs its `cwd`):
  - `board resume stays in the pane’s folder when the transcript is there (a restored pane)` → `claude.cwd === box.dir` (transcript under `.claude-work/projects/<projectFolderName(box.dir)>/`).
  - `in a folder that is not the project, it goes to the folder the transcript recorded` — for each of `join(box.dir, 'Проект x 50%')` and `join(box.dir, 'a b')`: the transcript under another project folder name with first line `{"cwd": <that folder>}`; started from `box.env.USERPROFILE` → `claude.cwd` is that folder.
  - `found nowhere, or that folder gone: the current folder, as today`.
  - `the same in every profile: the default one, Work, and a listed profile with spaces and Cyrillic in its folder` (card `profileDir` each).
  - The existing resume and hook tests stay as they are (the SessionStart report is untouched).
- [ ] **Step 2:** Run the new tests against `main`'s `cli.ts` and `process.ts` (`git show origin/main:<file> > <file>`, then back): FAIL on the second and fourth; with the change: PASS. `bun test`; `bun run check`.
- [ ] **Step 3: Commit** `git commit -m "board resume goes to the session's project folder when it is started elsewhere, found from its transcript, so a wake types no cd"`

### PR 2 gate (controller)

- [ ] New tests fail on PR 1's tree and pass on the branch; `bun test`, `bun run check`.
- [ ] PR body: refs #119, #150, #151 (fixed for the new wake, closed by PR 7). **Touches** `board resume`: compared on restored panes of the default profile, Work, and a listed profile with spaces/Cyrillic/`%` in its folder, in a folder that is the project, one that is not, one with no transcript (Task 2.7 tests); `pane-<id>` keys never typed (Task 2.3, 2.4). **Not touched:** nothing starts the wake process (no manifest entry). Parity with the old router (Task 2.6), or its skip named.

---

## PR 3 — Lifecycle (dormant)

**Issue:** under #119, "Start, supervise and keep one wake: startup entry, supervisor, health check, stale pane, old-plugin hold, kill switch". **Touches no setup:** the manifest entries are written on a copy (`test/fixtures/wake-manifest.toml`).

Waves: **[3.1, 3.2]** → **[3.3, 3.4]**. Shared file: `src/entrypoints/wake.ts` (3.2 the IPC part, 3.4 the port part: 3.4 after 3.2).

### Task 3.1: The open question, step 1: how herdr runs several `[[startup]]` entries

**Depends on:** nothing (may run any time before Task 7.3). **No code.**

**Files:** Modify `docs/superpowers/specs/2026-10-21-herdr-wake-ts-design.md` (append under "The open question…" a block `**Read in herdr's documentation and source (<date>):**`).

- [ ] **Step 1:** Read herdr's plugin documentation and source on startup hooks for 0.9.2 and 0.9.5: `https://herdr.dev/llms.txt`, the agent guide and plugin pages it links, and herdr's source if published (the startup runner: in parallel or in order, awaited or not, stopping on failure, the order kept). Never run anything against a herdr server; `herdr <cmd> --help` is allowed.
- [ ] **Step 2:** Write what each source says, with links and versions, and which of the design's four answers it supports; mark what stays unknown for the live check (step 1 of "The one real check").
- [ ] **Step 3:** Draft a comment for #119 in the report (the controller posts it).
- [ ] **Step 4: Commit** `git commit -m "Record what herdr's documentation and source say about running several startup entries"`
- If the owner provides a VM or a second machine: the throwaway plugin of the design (entries A–D) runs there, its times are added to the same block, the controller passes the owner's access details; otherwise that step waits for the live check.

### Task 3.2: The status file and the supervisor

**Depends on:** PR 2. **Parallel with:** 3.1. **Shared file:** `src/entrypoints/wake.ts` (IPC restart, `busy`).

**Files:**
- Create: `src/core/wake/status.ts`, `src/services/wake/supervisor.ts`, `src/entrypoints/wake-run.ts`
- Modify: `src/adapters/wake-files.ts` (status file read/write), `src/entrypoints/wake.ts` (IPC `'restart'`)
- Test: `test/core/wake/status.test.ts`, `test/services/wake-supervisor.test.ts`, `test/entrypoints/wake-run.test.ts`

**Interfaces (produces):**
```ts
// core/wake/status.ts
export type WakeStatusState = 'starting' | 'running' | 'crashed' | 'stopped' | 'held' | 'portTaken' | 'failed'
export interface WakeStatusFile { state: WakeStatusState; at: number; pane?: string; pid?: number; error?: string; crashes?: number[]; port?: number }
export function asWakeStatus(value: unknown): WakeStatusFile | null
export type WakeState = 'off' | 'starting' | 'running' | 'crashed' | 'notRunning' | 'held' | 'portTaken'
export const STARTING_MS = 60_000
/** What the panel, the toolbar and the doctor show (Task 4.5). */
export function wakeState(f: { on: boolean; status: WakeStatusFile | null; answers: boolean; now: number }): WakeState
/** Whether a /status answer is a wake's (the old router's or the new one's): an object with a number `pid` and an object `sessions`. */
export function isWakeStatus(value: unknown): boolean
// adapters/wake-files.ts
export const wakeStatusFile = (): string => join(stateDir(), 'wake-status.json')
export function readWakeStatus(file?: string): WakeStatusFile | null
export function writeWakeStatus(status: WakeStatusFile, file?: string): void // atomic; unknown fields of the file kept
// services/wake/supervisor.ts
export interface WakeChild { onExit(cb: (code: number | null) => void): void; onMessage(cb: (m: unknown) => void): void; onErrorLine(cb: (line: string) => void): void; send(m: unknown): void; kill(): void }
export interface SupervisorDeps { spawn(): WakeChild; health(): Promise<boolean>; writeStatus(s: WakeStatusFile): void; print(text: string): void; log(text: string): void; now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void; exit(code: number): void; pane?: string; pid: number }
export const HEALTH_EVERY_MS = 15_000; export const HEALTH_MISSES = 3; export const UP_GRACE_MS = 30_000; export const RESTART_EXIT = 75
export function createSupervisor(deps: SupervisorDeps): { start(): void; codeChanged(): void }
```

**Rules:**
- `wakeState`: `!on` → off; `status?.state === 'held'` → held; `answers` → running; `crashed` → crashed; `portTaken` → portTaken; `starting` and `now - at < STARTING_MS` → starting; else notRunning.
- Supervisor: status `starting` on each start (with `pane` = `HERDR_PANE_ID`, `pid` = its own), `running` on the child's `{ up }` message; child exit 0 → status `stopped`, `exit(0)` (wake turned off); 75 → start again at once; otherwise a crash → `afterCrash` (`core/crash-policy.ts`): wait → `print` "wake stopped (exit N). It starts again in S s." and start later; `wait === 0` → status `crashed` with `error` (the child's last stderr line) and `crashes`, `print` the error, no more starts. Health: from `up` (or `UP_GRACE_MS` after the start) every `HEALTH_EVERY_MS`; `HEALTH_MISSES` misses in a row → `kill()`, counted as a crash. `codeChanged()`: crashes reset; child running → `send('restart')`; crashed and waiting → start.
- `wake.ts` on `'restart'`: new `POST /wake`, `/sleep` answer 503 `{ ok: false, error: 'wake is restarting' }`; exit 75 once `engine.busy() === 0` or after 180 s.
- `wake-run.ts`: spawns `bun src/entrypoints/wake.ts` with stdio `['inherit', 'inherit', 'pipe', 'ipc']` (stderr shown on screen and its last line kept); health = `GET http://127.0.0.1:<port>/status` within 5 s and `isWakeStatus`; watches `src/**/*.ts` with its own copy of `run.ts`'s watcher (stamp by mtime and size, re-made on error); `run.ts` is not changed.

- [ ] **Step 1: Write the failing tests:**
  - `status.test.ts`: `wakeState` table (each row of the rule), `isWakeStatus` (the old router's `{ pid, started, …, sessions: {} }` → true; `{}`, `[]`, `{ pid: '1', sessions: {} }` → false).
  - `wake-supervisor.test.ts` (fake child and clock): `a crash starts it again after 2 s, 10 s, 30 s`; `5 crashes in 10 minutes stop it, the last error on screen and in the status file` (`state: 'crashed'`, `error` the last stderr line, 5 `crashes`); `a hung API is ended after three missed health checks and counts as a crash`; `turned off: the child ends with 0 and so does the supervisor, status stopped`; `a code change asks the child to restart, which it does at once with 75; crashes start over`.
  - `wake-run.test.ts` (sandbox, a `wake.port` from `unusedPort()`): `the pane’s supervisor runs the wake process and records its pane and pid` (`HERDR_PANE_ID=w9:p1` → status `running`, `pane: 'w9:p1'`, `pid` the supervisor's); `wake off: it ends with 0 and starts nothing`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add wake's supervisor: restarts after a crash with backoff, stops after five in ten minutes with the error in its status, ends a hung process"`

### Task 3.3: Wake's start (the startup entry)

**Depends on:** Task 3.2. **Parallel with:** 3.4.

**Files:**
- Create: `src/services/wake/start.ts`, `src/entrypoints/wake-start.ts`
- Test: `test/entrypoints/wake-start.test.ts`

**Interfaces (produces):**
```ts
export interface StartDeps { herdr<T = unknown>(args: string[], timeoutMs?: number): Promise<T>; answers(port: number): Promise<boolean>; readStatus(): WakeStatusFile | null; writeStatus(s: WakeStatusFile): void; alive(pid: number): boolean; log(text: string): void; sleep(ms: number): Promise<void>; now(): number; root: string }
export type StartResult = 'off' | 'held' | 'answers' | 'present' | 'opened' | 'failed'
export function startWake(deps: StartDeps, o: { on: boolean; settings: WakeConfig; again?: boolean }): Promise<StartResult>
export const START_DEADLINE_MS = 20_000
// src/entrypoints/wake-start.ts — `bun src/entrypoints/wake-start.ts [--again]`; always exits 0 within START_DEADLINE_MS (env BOARD_WAKE_START_DEADLINE_MS overrides it for tests); errors to wake.log
```

**Rules (safeguards 2, 6, 7, 8, 12):**
1. Off (`wakeSwitch`) → `'off'`, no herdr call, nothing written.
2. `herdr plugin list --json` once: `herdr-wake` installed → status `held`, `'held'`. Not installed and the status file says `held` → it is rewritten `stopped`.
3. `answers(port)` (a `/status` that `isWakeStatus`) and not `--again` → `'answers'`.
4. `herdr api snapshot`, tried at 0, 0.5, 1 and 2 s.
5. The recorded pane (status `pane`, `pid`): `lastBoard` of `core/board-pane.ts` with `alive`; there and not stale, and not `--again` → `'present'` (the supervisor runs, crashed or starting); stale, or `--again` → `tab close` of its tab.
6. The workspace labelled `settings.workspace`: its tabs whose panes are all shells (no agent) or `herdr-sidebar*` token panes are closed; a tab with an agent never.
7. No such workspace → `workspace create --label <Wake> --cwd <root> --no-focus` (its first tab closed after the pane opens). `plugin pane open --plugin agent-board --entrypoint wake --placement tab --workspace <id> --cwd <root> --no-focus` → `'opened'`; status `starting`.
8. Any error → `log`, `'failed'`, status `failed` with the error's first line. The entrypoint exits 0 in every case.

- [ ] **Step 1: Write the failing tests** (sandbox, the entrypoint as a child, `BOARD_WAKE_START_DEADLINE_MS=3000`):
  - `wake off, by "wake": false or a config.json that does not parse: exits 0 and asks herdr nothing`.
  - `the old plugin installed: one herdr plugin list, status held, nothing opened` → `box.calls()` equals `[['plugin','list','--json']]`.
  - `a wake answering already: nothing opened` (a stub `/status` on the configured port).
  - `a restored bare-shell wake pane is replaced: its tab closed, a new wake pane opened in Wake` (status with `pane: 'wW:p1'`, `pid` of an ended process; the snapshot shows `wW:p1` as a shell).
  - `tabs in Wake with only shells or sidebar panes are closed; a tab with an agent never`.
  - `no Wake workspace: one is made, the pane opened there, its first tab closed`.
  - `herdr does not answer: snapshot tried four times, exits 0 within the deadline, the error in wake.log and the status file`.
  - `herdr hangs: exits 0 at the deadline` (`waitFor` a file that never comes).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add wake's start: reads the kill switch first, holds while the old plugin is installed, replaces a restored bare-shell pane, always ends within its deadline"`

### Task 3.4: One instance, the manifest on a copy, the actions, and the board opening whatever wake does

**Depends on:** Task 3.2. **Parallel with:** 3.3. **Shared file:** `src/entrypoints/wake.ts`.

**Files:**
- Create: `test/fixtures/wake-manifest.toml`, `src/entrypoints/wake-action.ts`
- Modify: `src/entrypoints/wake.ts` (port taken)
- Test: `test/entrypoints/wake-instance.test.ts`, `test/manifest.test.ts` (append a `describe` for the copy), `test/entrypoints/open.test.ts` (append)

**The fragment (exact):**
```toml
# Wake: puts sessions to sleep and wakes them (src/entrypoints/wake-start.ts). Never awaited by the board's own start.
[[startup]]
command = ["bun", "src/entrypoints/wake-start.ts"]

[[actions]]
id = "sleep"
title = "Put this Claude session to sleep"
contexts = ["pane"]
command = ["bun", "src/entrypoints/wake-action.ts", "sleep"]

[[actions]]
id = "wake"
title = "Wake the Claude session in this pane"
contexts = ["pane"]
command = ["bun", "src/entrypoints/wake-action.ts", "wake"]

# The wake process under its supervisor (src/entrypoints/wake-run.ts), in a tab of the Wake workspace.
[[panes]]
id = "wake"
title = "Wake"
placement = "tab"
command = ["bun", "src/entrypoints/wake-run.ts"]
```

**Rules:**
- `wake.ts` on EADDRINUSE: `GET /status` there; `isWakeStatus` → exit 0 quietly (a line in `wake.log`); else status `portTaken` with `error: 'Port <port> is taken by another program'`, exit 1 (the supervisor shows it; it counts as a crash).
- `wake-action.ts sleep|wake [pane]`: the pane from `HERDR_PLUGIN_CONTEXT_JSON`'s `focused_pane_id`, else `HERDR_PANE_ID`; `POST http://127.0.0.1:<wake.port>/<mode> { target: pane }` (180 s); prints `asleep: <name> (<pane>)` / `awake: …` or the error; exit 0/1; wake off → prints `wake is off` and exits 1 without a request.
- The board's own `herdr-plugin.toml` and `src/entrypoints/open.ts` are not changed.

- [ ] **Step 1: Write the failing tests:**
  - `a second wake process finds the port held by a wake and exits 0 quietly`; `a port held by another program: status portTaken, exit 1`.
  - `test/manifest.test.ts`: `the wake entries on a copy run existing Bun entrypoints` (parse `herdr-plugin.toml` + the fragment with `Bun.TOML.parse`; every command `bun src/entrypoints/<name>.ts` and the file exists; ids `sleep`, `wake`, pane `wake`; the board's own entries and counts unchanged — the existing tests stay as they are).
  - `test/entrypoints/open.test.ts`: `the board opens whatever wake’s start does: failing, hanging, or missing` → `open.ts` source imports nothing under `wake`; `box.open(true)` run while `wake-start.ts` runs beside it against a fake herdr whose `plugin list` hangs (`waitFor` a file never written) and, in a second case, errors → the board's open exits 0 in the time it takes alone, and the calls other than `plugin list` (wake's start makes no other one when that fails) equal the list the existing `open: existing=…, background=true` cases expect for the same state.
  - `wake-action: the focused pane goes to the wake’s API; wake off sends nothing`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Keep one wake per machine by its port, write wake's manifest entries on a copy, add the sleep and wake actions, and show the board opens whatever wake does"`

### PR 3 gate (controller)

- [ ] New tests fail on PR 2's tree, pass on the branch; `bun test`; `bun run check`.
- [ ] PR body: refs #119; the open question's step 1 result (Task 3.1) quoted; **touches no setup**: `herdr-plugin.toml`, `open.ts`, `run.ts` unchanged (diff empty), the entries live on a copy.

---

## PR 4 — The board side

**Issue:** under #119, "The board side of wake: Settings → Sleep and wake…, its state, the URL from the wake section, never waiting on wake, waking without it". **Touches** (only once `wake.enabled` is true, by hand until PR 7): the board's wake calls, the guard, `board sleep`/`restart`, the scheduler, the doctor line, the payload's `wake` field. With wake off and no wake file, every call is today's (Task 4.2's comparison).

Waves: **[4.1]** → **[4.2, 4.5, 4.7]** → **[4.3, 4.6]** → **[4.4]**.

### Task 4.1: The wake section on the board: its texts, its edits, which wake the board uses

**Depends on:** PR 3. **Shared files:** `src/core/types.ts`, `src/adapters/config-file.ts`, `src/core/i18n/strings.ts`.

**Files:**
- Create: `src/core/i18n/wake-strings.ts`, `src/services/wake/mode.ts`
- Modify: `src/core/types.ts` (`Config.wake?: unknown`), `src/adapters/config-file.ts` (`editWake`), `src/core/i18n/strings.ts` (merge `WAKE_STRINGS`)
- Test: `test/adapters/config-file.test.ts` (append), `test/services/wake-mode.test.ts`, `test/core/i18n.test.ts` (keys present in both languages, as the file checks others)

**Interfaces (produces):**
```ts
// services/wake/mode.ts
export type WakeMode = { kind: 'new'; url: string; settings: WakeConfig } | { kind: 'old'; url: string | null; on: boolean; held: boolean }
/** Call 4: new only while on and the status file exists with a state other than held. */
export function wakeMode(cfg: Pick<Config, 'wake' | 'wakeUrl'>, status: WakeStatusFile | null): WakeMode
/** wakeMode with the status file read now. */
export function currentWakeMode(cfg: Pick<Config, 'wake' | 'wakeUrl'>): WakeMode
// adapters/config-file.ts
/** { on?: boolean; reaper?: { enabled?: boolean; idleMinutes?: number; exclude?: string[] }; telegram?: 'auto' | 'off' }, merged into config.json's wake section, its other fields kept; `"wake": false` becomes { enabled: false } before the patch is applied. */
export function editWake(body: unknown): EditResult
```

**Texts** (`wake-strings.ts`, `WAKE_STRINGS: Record<Lang, Record<string, string>>`; English exact):

| key | en |
|---|---|
| `set.wake` | `Sleep and wake…` |
| `wake.title` | `Sleep and wake` |
| `wake.switch` | `Sleep and wake` |
| `wake.switchHint` | `Put to sleep, Wake and Restart, in every profile` |
| `wake.state.off` | `Off` |
| `wake.state.offAsleep` | `Off. {n} asleep still wake from their cards` |
| `wake.state.starting` | `Starting…` |
| `wake.state.running` | `Running since {time}, {n} asleep` |
| `wake.state.crashed` | `Crashed: stopped after {n} crashes in 10 minutes. {error}` |
| `wake.state.notRunning` | `Not running` |
| `wake.state.held` | `The separate herdr-wake plugin does this now` |
| `wake.state.portTaken` | `Port {port} is taken by another program` |
| `wake.start` | `Start` |
| `wake.again` | `Start again` |
| `wake.log` | `Log` |
| `wake.reaper` | `Put idle sessions to sleep` |
| `wake.reaper.after` | `after {min} minutes` |
| `wake.reaper.minutes` | `Minutes idle` |
| `wake.reaper.exclude` | `Never put to sleep` |
| `wake.reaper.excludeHint` | `Names, workspaces or /regex/, one per line` |
| `wake.telegram` | `Telegram messages (tg-mcp)` |
| `wake.telegram.auto` | `Auto` |
| `wake.telegram.off` | `Off` |
| `wake.telegram.connected` | `connected to {host}` |
| `wake.telegram.none` | `no tg-mcp set up` |
| `wake.telegram.error` | `last poll: {error}` |
| `wake.stopped` | `Wake stopped` |
| `wake.stoppedHint` | `Sleep and wake is on but not running: open its settings` |
| `wake.readOnly` | `Changed on the computer only` |
| `err.wakeOff` | `Sleep and wake is off (Settings → Sleep and wake…)` |
| `err.wakeBusy` | `Wake is slow to answer and may be waking {name} already; try again in a minute` |
| `err.canWake.board` | `{name} could not be woken again: the board command is not on PATH` |
| `err.canWake.profile` | `{name} could not be woken again: its profile is not known` |
| `err.canWake.transcript` | `{name} could not be woken again: its conversation is not in its profile's folder` |
| `err.wakeSetting` | `{field}: {why}` |
| `setup.wake.running` | `Sleep and wake runs` |
| `setup.wake.runningDetail` | `on 127.0.0.1:{port}, {n} asleep` |
| `setup.wake.newOff` | `Sleep and wake is off` |
| `setup.wake.newOffFix` | `Turn it on in Settings → Sleep and wake…, or set "wake": { "enabled": true } in the board's config.json` |
| `setup.wake.crashed` | `Sleep and wake crashed` |
| `setup.wake.crashedFix` | `Settings → Sleep and wake… → Start again. Its log: {file}` |
| `setup.wake.held` | `The separate herdr-wake plugin puts sessions to sleep` |
| `setup.wake.heldFix` | `Settings → Sleep and wake… → Switch over…` |
| `setup.wake.notAnswering` | `Sleep and wake is on but does not answer on port {port}` |
| `setup.wake.notAnsweringFix` | `Settings → Sleep and wake… → Start. Its log: {file}` |
| `setup.wake.portTaken` | `Port {port} is taken by another program` |
| `setup.wake.portTakenFix` | `Set another "port" in the wake section of the board's config.json` |
| `setup.wake.urlUnused` | `wakeUrl in config.json is not used while Sleep and wake is on` |

- [ ] **Step 1: Write the failing tests:**
  - `wake-mode`: `off, or no status file: the old wakeUrl and the old guard` (`{ kind: 'old', url: 'http://127.0.0.1:12421', on: false, held: false }` for `wake` absent with `WAKE_SHIPPED` false); `on and held: the old path`; `on, the status file there and not held: the wake port` (`wake: { enabled: true, port: 23456 }` → `{ kind: 'new', url: 'http://127.0.0.1:23456' }`); `wakeUrl set elsewhere is kept on the old path`.
  - `config-file`: `editWake turns wake on and off, keeps the section's other fields and the file's`; `"wake": false is replaced by an object`; `an idleMinutes below 1, a telegram mode other than auto or off, an exclude that is not strings: refused, config.json unchanged` (409 text `err.wakeSetting`).
  - `i18n`: the new keys in `en` and `ru`, `missingKeys` `[]`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add the wake section to the board: its texts in English and Russian, its edits, and which wake the board talks to"`

### Task 4.2: Never waiting on wake: the board's provider and the file fallback

**Depends on:** Task 4.1. **Parallel with:** 4.5, 4.7. **Shared files:** `src/services/deps.ts`, `src/services/board.ts`.

**Files:**
- Create: `src/integrations/wake.ts`, `test/support/fake-wake.ts` (a `Bun.serve` stand-in for wake's API: `/status`, `/sleeping`, `/awake`, `/wake`, `/sleep`, with `slow` and `down` switches; extracted from `test/services/restart.test.ts`'s `fakeWake`, which then imports it)
- Modify: `src/integrations/herdr-wake.ts` (the two optional fields only), `src/services/deps.ts` (the `wake` getter by `currentWakeMode`), `src/services/board.ts` (`collect`: sleepers marked `fromFile` kept only where herdr shows their pane as a shell; their workspace label from the snapshot)
- Test: `test/integrations/wake.test.ts`, `test/services/board-sleepers.test.ts`

**Interfaces (produces):**
```ts
export type Reach = 'up' | 'down' | 'slow' // down: nothing listens (ECONNREFUSED) or wake is off; slow: it took the connection but did not answer in time
export interface BoardWake extends SleepProvider {
  /** Whether wake answers now (GET /status, 2 s). */
  reach(): Promise<Reach>
  readonly mode: 'new'
}
/** Call 10, safeguard 14: sleepers() gives the last list at once and asks again in the background (every 5 s, 2 s timeout); while wake does not answer, or is off, the list is wake's session file's (read only), each entry `fromFile: true`. */
export function createBoardWake(o: { url: string; sessionsFile: string; fetch?: typeof fetch; now?: () => number }): BoardWake
export function sharedBoardWake(url: string, sessionsFile: string): BoardWake
/** Call 28 with wake off: the old provider's list, completed by the file's sleepers (marked fromFile) it does not already have. */
export function withFileSleepers(provider: SleepProvider, sessionsFile: string): SleepProvider
```
`SleepingSession` (`src/integrations/herdr-wake.ts`, listed under Modify) gains `fromFile?: true` and `profile?: { dir: string; id?: string }` (optional fields; that file's code unchanged otherwise).

**Rules:** `deps.wake`: mode `new` → `sharedBoardWake(url, wakeSessionsFile())`; mode `old` with `on: false` and the wake file present → `sharedHerdrWake(cfg.wakeUrl)` whose empty answer is completed by the file's sleepers (call 28: "the board lists sleepers from wake's file even while wake is off") — implemented as a thin wrapper in `integrations/wake.ts` (`withFileSleepers(provider, file)`), used only when the file exists; mode `old` otherwise → `sharedHerdrWake(cfg.wakeUrl)` exactly as today. `wake(item)` and `sleep(item)` post `{ target: item.pane }` as today.

- [ ] **Step 1: Write the failing tests:**
  - `wake.test.ts` (fake fetch, fake clock): `the first call gives [] at once and asks; the next gives the answer`; `a wake that hangs never holds sleepers() up` (fetch never resolves → each call returns within 10 ms); `down or off: the file's sleepers, marked fromFile`; `reach: up, down (ECONNREFUSED), slow (timeout)`.
  - `board-sleepers.test.ts` (sandbox, runner `cli` `board list` or `collect` through the `server` mode): `with wake off and no wake file, the board’s calls are today’s` → herdr gets `api snapshot` only, the one HTTP request is `GET <wakeUrl>/sleeping` (a counting stub at `wakeUrl`), and the items equal the ones the same test gives against `main`'s `services/deps.ts` and `services/board.ts` (run it there once, as AGENTS.md says, and keep the expected items in the test); `wake off with sessions asleep in its file: their cards stay, workspace from the snapshot`; `a file sleeper whose pane runs Claude again, or is gone, is not shown`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Never wait on the new wake: sleeping sessions from its last answer at once, from its file while it is down or off"`

### Task 4.3: Waking without the wake process, and the guard that goes with it

**Depends on:** Task 4.2. **Parallel with:** 4.6. **Shared files:** `src/services/actions.ts`, `src/services/sleep.ts`, `src/entrypoints/cli.ts`, `src/server/routes/sleep.ts`, `src/server/routes/session.ts`.

**Files:**
- Modify: `src/services/actions.ts`, `src/services/sleep.ts`, `src/entrypoints/cli.ts` (`restart`, `sleep` refusals), `src/server/routes/sleep.ts`, `src/server/routes/session.ts`
- Test: `test/services/wake-direct.test.ts`; `test/services/restart.test.ts` and `test/services/sleep.test.ts` stay green untouched

**Interfaces (changes):**
```ts
// services/actions.ts
/** Calls 19, 28: the old path (mode old, wake on or wakeUrl) → mayWake as today; new mode or wake off with a file sleeper → the "can wake" rule. */
export async function checkWake(deps: Deps, item: Pick<Item, 'name' | 'pane' | 'profile' | 'profileFolder'> & Partial<Pick<Item, 'session' | 'cwd'>>, set?: ProfileSet): Promise<WakeGuard> // callers that pass no session (cli.ts restart from a card) keep compiling
/** Up → wake's API; down or off → the board types the wake itself (pane-ops wakeInPane with cliWakeHerdr and the session's profile id); slow → refused (err.wakeBusy), nothing typed. */
export async function wake(deps: Deps, item: Item): Promise<ActionResult>
/** As today for the old path; new mode: wake's reach, 'down' with wake on is { ok: false, why: 'down' }; off: { ok: false, why: 'off', error: t('err.wakeOff') }. */
export async function wakeAnswers(deps: Pick<Deps, 'cfg' | 'wake'>): Promise<{ ok: true } | { ok: false; why: string; error: string }>
```

**Rules:**
- The direct wake's profile id: `itemProfile(item, set.list)?.id`, else the wake file entry's `profile` for that pane; `canWake` with `boardOnPath()`, the folder, `deps.homes.forDir(dir).transcriptPath(session, cwd)`; refused → `err.canWake.<why>`.
- `sleepSession`, `sleepMany`, `board sleep`, a new `board restart`, the sheet's Put to sleep and Restart: wake off (new mode's section off) → refuse with `err.wakeOff` (CLI: `putting sessions to sleep needs wake, and it is off (Settings → Sleep and wake…); nothing was put to sleep` / `a restart needs wake, and it is off (Settings → Sleep and wake…); nothing was scheduled`). The old path's texts and checks stay exactly as today.
- A restart already in its wake step (`step === 'wake'`) goes through `wake()`, so it finishes the same way when wake goes off.
- The board never writes wake's session file (one writer: the wake process). A session the board woke is dropped from the file's list by `collect` (its pane runs Claude again) and marked awake by wake's next round once it runs.

- [ ] **Step 1: Write the failing tests** (sandbox, compiled fake herdr, `fake-wake.ts`, wake file written by hand, config `wake: { enabled: false }` or `enabled: true, port`):
  - `wake off with a Work session asleep: Wake types board resume <id> --profile work into its pane` → calls include `['pane','process-info','--pane','p1']`, `['pane','send-keys','p1',<key>]`, `['pane','run','p1',\`board resume ${SID} --profile work\`]`.
  - `wake on but nothing listening on its port: the same`.
  - `wake slow to answer: no second wake is typed, and the user is told why` (`fake-wake` `slow`) → no `pane run` call; error `err.wakeBusy`.
  - `the guard: the new path refuses only what it could not wake again` (no transcript → `err.canWake.transcript`; a Work session in a pane the board did not open wakes, where `mayWake` would have refused).
  - `with wake off, Put to sleep, board sleep and a new board restart refuse and say it is off` (no herdr `agent prompt`).
  - `a restart in its wake step when wake goes off finishes: woken by the board, then its note`.
  - `the old path is today’s: wakeUrl, its guard and its texts` (old mode with a `fake-wake` at `wakeUrl`: the existing restart and sleep tests unchanged prove it; add one asserting the request went to `wakeUrl`).
- [ ] **Step 2:** FAIL against PR 3's tree. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Wake a sleeping session from the board when the wake process is off or down, through the same board resume, and refuse sleep and restart while wake is off"`

### Task 4.4: Reminders wait for a sleeper while wake is down or off

**Depends on:** Task 4.3. **Shared file:** `src/services/scheduler.ts`.

**Files:**
- Modify: `src/services/scheduler.ts`
- Test: `test/services/scheduler-wake.test.ts`

**Rules (safeguard 14, call 28):** when the item is a sleeper (`sleeping: true`) and `wake()` was refused as `slow` (or the session is a `fromFile` sleeper the board could not reach), the run waits with `why: 'wake'` and **without** adding to `waited` and without counting `gone`; once wake answers or the session is awake, it goes as usual. A cron entry is never dropped for this. The old path's counting stays as today.

- [ ] **Step 1: Write the failing tests:** `a reminder for a sleeper waits while wake is slow, and is not counted missed past scheduleWaitMin` (`scheduleWaitMin: 0.001`, several ticks, entry still there, `waited` unchanged); `a cron reminder for a sleeper is kept past three runs while wake is down`; `wake off: the reminder wakes the session through the board and is sent`; `the old path counts as today` (the existing scheduler tests stay green).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Keep reminders for sleeping sessions waiting, not missed, while wake is slow or down"`

### Task 4.5: Wake's control on the board: state, switches, Start, Start again, Log, local-only routes

**Depends on:** Task 4.1. **Parallel with:** 4.2, 4.7. **Shared files:** `src/server/app.ts`, `src/server/remote.ts`, `src/core/payload.ts`, `src/server/board-state.ts`, `test/support/runner.ts`. `feature/remote-tunnel` also changes `localOnly` in `src/server/remote.ts` (it adds `/api/access`): whichever merges second keeps both.

**Files:**
- Create: `src/services/wake/control.ts`, `src/server/routes/wake.ts`
- Modify: `src/server/app.ts` (routes; `wakeStarter` option; start once after the server is up; liveConfig switch-on), `src/server/remote.ts` (`localOnly` adds `/api/wake` and `/api/wake/…`), `src/core/payload.ts` (`wake?: WakeView`), `src/server/board-state.ts` (fills it), `test/support/runner.ts` (server mode passes a recording `wakeStarter`)
- Test: `test/services/wake-control.test.ts`, `test/server/wake-routes.test.ts`, `test/server/remote.test.ts` (append)

**Interfaces (produces):**
```ts
export interface WakeView { on: boolean; state: WakeState; since: number | null; asleep: number; port: number; error?: string; downSince?: number | null }
export interface WakeSettingsView { reaper: ReaperConfig; telegram: TelegramMode; found: { host: string } | null; lastError: string | null; log: string }
export interface WakeControl {
  view(): Promise<WakeView>                         // status file + reach + the sleepers' count; cached 2 s
  settings(): Promise<WakeSettingsView>             // GET /api/wake
  turn(on: boolean): Promise<EditResult>            // editWake; on → start(); off → wake ends by itself (liveConfig), then the Wake workspace closes when nothing but shells and sidebar panes is in it
  start(): Promise<EditResult>                      // wakeStarter() unless wake answers or is held
  again(): Promise<EditResult>                      // wakeStarter(['--again'])
  logTail(): string                                 // the last 200 lines of wake.log
  /** Safeguard 3: once after the server is up, and when config.json turns wake on: started when on, not held and not answering. */
  ensure(): Promise<void>
}
// answers: by default GET http://127.0.0.1:<wake.port>/status within 2 s and isWakeStatus (no dependency on Task 4.2); the asleep count from readWakeSessions (entries with slept_at whose pane herdr still has, as sleepingOf)
export function createWakeControl(o: { cfg: Config; answers?: () => Promise<boolean>; starter: (args?: string[]) => void; herdr?: <T = unknown>(args: string[], timeoutMs?: number) => Promise<T>; now?: () => number }): WakeControl // herdr: adapters/herdr.ts herdr() by default (snapshot and workspace close on Off)
// the real starter: spawn(process.execPath, [<root>/src/entrypoints/wake-start.ts, ...args], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
// startServer options: wakeStarter?: (args?: string[]) => void
```
Routes: `GET /api/wake` → `{ view, settings }`; `POST /api/wake { op: 'on' | 'off' | 'reaper' | 'telegram' | 'start' | 'again' | 'log', … }` (guards `board-header`, `origin`); `reaper` takes `{ enabled?, idleMinutes?, exclude? }`, `telegram` `{ mode }`; `log` answers `{ ok: true, text }`. The payload carries `wake` only when `WAKE_SHIPPED || wakeConfig(cfg.wake).enabled || the wake file has sleepers`.

- [ ] **Step 1: Write the failing tests:**
  - `wake-control`: `ensure starts wake once when it is on, not held and not answering; never when off or held` (recording starter); `turned on in config.json by hand: started at once`; `off: the Wake workspace is closed only when nothing but shells and sidebar panes is in it`; `view: each WakeState from the status file and reach`; `Log: the tail of wake.log`.
  - `wake-routes` (`serveBoard`): `the panel’s switches edit config.json; Start and Start again call the starter; the payload carries the state line`.
  - `remote.test.ts`: `every wake route is refused on the tailnet and the serve listener, in both spellings` (`/api/wake`, `/api/wak%65`, `POST` and `GET`) → 403 `{ error: 'local' }`; `the phone reads the state line in the payload`.
  - `with wake off and no wake file the payload has no wake field and nothing is started` (dormant).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add wake's control on the board: its state in the payload, local-only routes for its switches, Start, Start again and Log, and starting it once when it is on but not running"`

### Task 4.6: Settings → "Sleep and wake…" and the toolbar note

**Depends on:** Task 4.5. **Parallel with:** 4.3. **Shared files:** `web/src/models/settings-menu.ts`, `web/src/hooks/useSettingsMenu.ts`, `web/src/components/SidePanels.tsx`, `web/src/App.tsx`, `web/src/components/Toolbar.tsx`, `web/index.html`.

**Files:**
- Create: `web/src/components/wake/WakePanel.tsx`, `web/src/models/wake.ts`, `web/src/hooks/useWake.ts`, `web/styles/wake.css`
- Modify: the shared files above (a `wake` item in Settings after `phones`, shown when the payload has `wake`; the panel in `SidePanels` like `PhonesPanel`; the note in the toolbar beside the setup note)
- Test: `test/web/wake-panel.test.tsx`, `test/web/wake-model.test.ts`, `test/web/settings.test.tsx` (append)

**Interfaces (produces):**
```ts
// web/src/models/wake.ts (pure)
export function stateLine(view: WakeView, t: Translator, now: number): string
export function noteShown(view: WakeView | undefined, now: number): boolean // on, not running ('crashed' | 'notRunning' | 'portTaken' | 'starting' past 60 s) for more than 60 s by downSince
```
**Rules:** the panel follows `PhonesPanel.tsx` (a `Panel`, `api.post('/api/wake', { op, … })`, errors as toasts, the board's answer back over the live stream): the switch (`wake.switch`), the state line, buttons by state (notRunning → Start; crashed → Start again and Log; held → nothing yet, PR 7 adds Switch over…), the reaper (switch, minutes, exclude textarea saved on blur), Telegram (Auto/Off segmented, the found host / none / last error). On a phone (`remotePage()`) the panel shows the state line and `wake.readOnly` only. The note: `wake.stopped`, opens the panel; hidden on a phone.

- [ ] **Step 1: Write the failing tests:** `stateLine` for each state (`Running since 09:12, 4 asleep` with the board's time format); `noteShown` after 60 s only; the menu offers `Sleep and wake…` only with `wake` in the payload; the panel's switch posts `{ op: 'off' }`; crashed shows Start again and Log, Log shows the text; a phone sees no switch and no button; the note opens the panel.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`wake.css` linked in `web/index.html` after `profiles.css`; class selectors only). **Step 4:** PASS; `bun test` (`test/web/styles.test.ts` unchanged and green); `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add Settings → Sleep and wake… with its state, switches and log, and a quiet Wake stopped note on the toolbar"`

### Task 4.7: `board doctor`'s wake line

**Depends on:** Task 4.1. **Parallel with:** 4.2, 4.5. **Shared files:** `src/core/setup.ts`, `src/adapters/setup-facts.ts`.

**Files:**
- Modify: `src/core/setup.ts` (`SetupFacts.wakeNew?: { state: WakeState; port: number; error?: string; asleep: number; log: string; wakeUrlSet: boolean } | null`), `src/adapters/setup-facts.ts` (fills it in new mode: status file, `GET /status` with the existing `probe`)
- Test: `test/core/setup.test.ts` (append), `test/entrypoints/doctor.test.ts` (append)

**Rules:** old mode → the `wake` check exactly as today (texts, levels, `WAKE_INSTALL`). New mode: running → `ok` `setup.wake.running`; off → `off` `setup.wake.newOff` with `setup.wake.newOffFix`; crashed → `error` with the error and `setup.wake.crashedFix`; held → `warn` `setup.wake.held` / `setup.wake.heldFix`; notRunning/starting past its time → `warn` `setup.wake.notAnswering`; portTaken → `error`; `wakeUrl` set to something else than the default while new → a second line `setup.wake.urlUnused` (`na`). No "Node.js 20" in any new-mode text.

- [ ] **Step 1: Write the failing tests:** one per state; `old mode: the line is today’s` (the existing doctor test unchanged).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "board doctor says whether wake is on, off, running, crashed, held by the old plugin or not answering, and how to fix it"`

### PR 4 gate (controller)

- [ ] New tests fail on PR 3's tree, pass on the branch; `bun test`; `bun run check`.
- [ ] PR body: refs #119. **Compared:** with wake off and no wake file, `collect`, Put to sleep, Wake, Restart, `board sleep`, `board restart`, the scheduler and the doctor make today's calls and say today's texts (Tasks 4.2, 4.3, 4.7 tests and the untouched restart/sleep suites); the remote listeners refuse `/api/wake` in both spellings. **Dormant:** nothing new shows or runs without `"wake": { "enabled": true }` by hand.

---

## PR 5 — Hooks in every profile

**Issue:** under #119, "ListAgents and SendMessage hooks in every profile, each for its own; one SessionStart report". **Touches:** the install (only while wake is on), the SessionStart report (only with Telegram on and a launcher). Waves: **[5.1, 5.3]** → **[5.2]**. It needs nothing of PR 4's code (hooks speak English; it uses PR 1's `wakeSwitch` and `ownSleepers`, PR 2's API), so it may be built beside PR 4 on its own branch from PR 3's merge; it merges after PR 4.

### Task 5.1: The hooks' entrypoint

**Depends on:** PR 2 (the API's `profile`), PR 1 (`ownSleepers`, `wakeSwitch`). **Parallel with:** 5.3.

**Files:**
- Create: `src/entrypoints/wake-hook.ts`
- Test: `test/entrypoints/wake-hook.test.ts`

**Interfaces:** `bun src/entrypoints/wake-hook.ts pre-send|post-list` reading Claude's hook JSON on stdin (`readStdin`), port from the wake section.

**Rules:** first `wakeSwitch` (off → exit 0, no HTTP); stdin `{}` or broken → exit 0. **post-list:** `GET /sleeping` and `/awake` (3 s each, `/awake` failing is fine), both through `ownSleepers` (`CLAUDE_CONFIG_DIR` of this process); the context text exactly as `herdr-wake/src/hook.mjs` builds it (`activity`, `ago`, `KEPT`, `LIST_DAYS = listSleepingDays`, `LIST_MAX = 15`, the full-list hint) with "herdr-wake" replaced by "the board's wake". **pre-send:** `to` with a trailing ` [hex]` dropped, lower-cased; the caller's own sleepers by name; one found → `POST /wake { target: <its session id> }` (170 s); refused → the PreToolUse `deny` JSON with `<name> is asleep (the board's wake) and could not be woken: <error>`; a name no own sleeper has → nothing (left to Claude Code). Any error → silent, exit 0.

- [ ] **Step 1: Write the failing tests** (`fake-wake.ts` serving sleepers of two profiles: `default` `"Billing"`, `work` `"Billing"` and `"Ledger"`; HOME with spaces and Cyrillic; `wake.port` unused):
  - `a Default session’s ListAgents never shows a Work sleeper, nor the other way round`.
  - `SendMessage from Default to a name both profiles use wakes only Default’s, by its session id` (the stub saw `{ target: <default SID> }` only).
  - `SendMessage from Default to a name only Work has: nothing woken, nothing said`.
  - `an unset CLAUDE_CONFIG_DIR is the default folder; one folder spelled with another case, a trailing separator or ~ matches`.
  - `wake off, or config.json broken: no HTTP call at all` (the stub counts 0).
  - `the context text is herdr-wake’s, word for word but the name` (compare with `hook.mjs`'s output for the same answers, the name swapped).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add the ListAgents and SendMessage hooks on Bun, each showing and waking only its own profile's sleeping sessions"`

### Task 5.2: The install writes them, only while wake is on, never beside the old ones

**Depends on:** Task 5.1. **Shared files:** `src/core/install-plan.ts`, `src/adapters/hook-settings.ts`, `src/entrypoints/install.ts`, `src/services/profiles.ts`, `src/core/setup.ts` (`boardFiles` gains `wakeHook`).

**Files:**
- Modify: the shared files above
- Test: `test/core/install-plan.test.ts` (append), `test/entrypoints/install.test.ts` (append), `test/server/profiles.test.ts` (append)

**Interfaces:**
```ts
export const OLD_WAKE_HOOK = /herdr-wake.*hook\.mjs"? (pre-send|post-list|session-start)$/
export const WAKE_HOOKS = [['PreToolUse', 'SendMessage', 'pre-send', 180], ['PostToolUse', 'ListAgents', 'post-list', 10]] as const
/** planSettings' new option: `wake: true` adds ours (replacing earlier ones of ours); never when a hook the old plugin wrote is in the file (`oldWake: true` in the plan). */
export function planSettings(settings: unknown, paths: InstallPaths & { wakeHook: string }, o?: { toast?: boolean | undefined; wake?: boolean }): SettingsPlan & { oldWake: boolean }
```
**Rules:** `wake` is `wakeSwitch` of the board's config.json at install time; off → ours are neither added nor removed (inert). The `SessionStart`/`UserPromptSubmit` entries are byte-for-byte as before. Install prints `wake hooks: ListAgents, SendMessage -> <file> in <settings>` or `wake hooks: not added: the separate herdr-wake plugin's are there (Settings → Sleep and wake… → Switch over…)`. The Profiles panel's Install does the same per profile.

- [ ] **Step 1: Write the failing tests:** `install with wake on writes the two hooks into every shown profile, once, with a backup` (port of herdr-wake's "install-hooks: … once, and everyone else’s left alone"); `with wake off, no wake hook is written`; `never beside the old plugin’s hooks`; `the every-prompt hook and SessionStart entries are as on main` (the settings.json of `main`'s install, compared entry by entry for those events); `the Profiles panel’s Install adds them to that profile only`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Install the wake hooks into every shown profile while wake is on, never beside the separate plugin's"`

### Task 5.3: One SessionStart report

**Depends on:** PR 1 (Task 1.1). **Parallel with:** 5.1. **Shared files:** `src/core/resume.ts`, `src/entrypoints/hook.ts`.

**Files:**
- Modify: `src/core/resume.ts` (`ResumeFacts.wakeTelegram?: boolean`, `ResumeFacts.launchProgram?: string`), `src/entrypoints/hook.ts` (`reportResume` passes both, from the config the SessionStart already loads)
- Test: `test/core/resume.test.ts` (append; ports herdr-wake's `resumeArgs` test as cases of `resumeCommand`), `test/entrypoints/hook.test.ts` (append)

**Rules (call 21):** outside the default folder: as today. In the default folder: `['board', 'resume', <id>]` only when `wakeTelegram` (wake on and `telegram === 'auto'`) and `launchProgram` (first word of `launch.claude`, else `claude`) is not `claude`; else null as today. `herdrWakeResumes` stays and still wins where the old plugin's hook is.

- [ ] **Step 1: Write the failing tests:** `with Telegram off, every setup’s report is main’s` (the existing tests, plus a launcher with Telegram off → null); `Telegram on and a launcher in launch.claude: board resume in the default folder`; `Telegram on and plain claude: nothing`; the hook test `SessionStart in ~/.claude with claude-tg and Telegram on: the reporter starts with board resume <id>`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "One SessionStart report: board resume in the default profile too while wake's Telegram router is on and sessions start through a launcher"`

### PR 5 gate (controller)

- [ ] New tests fail on PR 4's tree, pass on the branch; `bun test`; `bun run check`.
- [ ] PR body: **compared** the every-prompt hook and the SessionStart report byte for byte with `main` (Telegram off), the install with wake off (no wake hook) and with the old plugin's hooks present (none added); a Default and a Work caller with the same name in both.

---

## PR 6 — Telegram router and claude-tg

**Issue:** under #119, "Wake's Telegram router and claude-tg without Node". Waves: **[6.1, 6.2]**.

### Task 6.1: The Telegram router

**Depends on:** PR 2 (engine), PR 4 (the panel shows its state). **Shared files:** `src/services/wake/engine.ts`, `src/entrypoints/wake.ts`.

**Files:**
- Create: `src/services/wake/telegram.ts`
- Modify: `src/services/wake/engine.ts` (`deliver(items)` for `--deliver`), `src/entrypoints/wake.ts` (start/stop the poll on `telegram` and `telegramTarget`, live; `--deliver <key> <text>`)
- Test: `test/services/wake-telegram.test.ts`

**Interfaces:** `export function createTelegram(o: { engine: WakeEngine; herdr: WakeHerdr; target: () => TelegramTarget | null; machine: string; fetch?: typeof fetch; log(text: string): void }): { start(): void; stop(): void; route(items: RouteItem[]): Promise<RouteResult> }` with `RouteResult = { ok: true; note?: string } | { skip: true; note: string } | { retry: number; note?: string }`.

**Rules:** the port of `router.mjs` `route`, `deliverLive`, `ack`, `handleGroup`, `groupByKey`, `pollLoop` (backoff 1 s doubling to 60 s; the 404 text `the server has no router endpoints (ROUTER=1 not set?)`), its Russian notes to Telegram kept verbatim (BLOCKED, TRUST, the busy-pane, dialog, draft, timeout and "Разбудил" notes); waking through `engine.wakePane` (so `board resume --profile`); `engine.telegram.lastPoll/lastError` updated. Off by default: no request while `telegram !== 'auto'`.

- [ ] **Step 1: Write the failing tests** (a stub tg-mcp on an unused port, `fakeWakeHerdr`): `off by default even with tg-mcp in ~/.claude.json: no poll`; `auto: a message for a sleeping Work session wakes it with --profile work, then is typed, then acked delivered with the wake note`; `a draft in the input box: retried, its note said once`; `no pane for the key: skipped with the note`; `switched off live: the poll stops`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add wake's Telegram router through tg-mcp, off until turned on, waking sessions in their own profile"`

### Task 6.2: `board tg-key` and claude-tg without Node

**Depends on:** PR 1 (Task 1.3 `keyFor`), PR 4 (panel). **Parallel with:** 6.1. **Shared files:** `src/entrypoints/cli.ts`, `src/entrypoints/install.ts`, `src/server/routes/wake.ts`, `web/src/components/wake/WakePanel.tsx`.

**Files:**
- Create: `src/core/wake/launchers.ts`, `src/adapters/launchers.ts`
- Modify: `src/entrypoints/cli.ts` (`board tg-key`), `src/entrypoints/install.ts` (refresh only where a herdr-wake claude-tg is there), `src/server/routes/wake.ts` (`op: 'launcher'`), the panel (an "Install claude-tg" button once Telegram is Auto and found; text keys `wake.launcher`, `wake.launcherDone` added to `wake-strings.ts`: `Install claude-tg`, `claude-tg is in {dir}`)
- Test: `test/core/wake/launchers.test.ts`, `test/entrypoints/tg-key.test.ts`, `test/entrypoints/launchers.test.ts` (ports herdr-wake's install-launcher, claude-tg.cmd and sh tests with a fake `board` on PATH instead of node)

**Interfaces:**
```ts
export const LAUNCHER_MARK = /^(#|rem|\/\/) (herdr-wake|agent-board): /m
/** 'claude-tg' (sh) and 'claude-tg.cmd': the key from `board tg-key`, else the folder; first comment line `agent-board: claude-tg, …`. */
export function launcherFiles(): { 'claude-tg': string; 'claude-tg.cmd': string }
export function installLaunchers(binDir: string, o: { onlyWhereThere: boolean }): { written: string[]; foreign: string[] }
```
**Rules:** sh: `TG_KEY="$(board tg-key 2>/dev/null)"`, then as today (`[ -n "$TG_KEY" ] || TG_KEY="$(pwd)"`, `export TG_KEY`, `exec claude "$@"`). cmd: `for /f "usebackq delims=" %%k in (\`board tg-key 2^>nul\`) do set "TG_KEY=%%k"`, the rest as today (CRLF, `DisableDelayedExpansion`). `board tg-key`: `keyFor` with `herdr api snapshot` when `HERDR_PANE_ID` is set (5 s), else the folder; prints the key, exit 0 always. The old `claude-tg-key.mjs` beside them is left alone. A file without our mark is never replaced.

- [ ] **Step 1: Write the failing tests:** `board tg-key: the tab’s topic in herdr, the folder outside` (port of the `keyFor` cases through the CLI with the compiled fake herdr); `claude-tg.cmd: the key in TG_KEY, the arguments and the exit code passed on` (Windows only, `test.skipIf`); `claude-tg (sh)` (skip without sh); `the install refreshes a herdr-wake claude-tg and writes none where there is none`; `someone else’s claude-tg is never replaced`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add board tg-key and claude-tg launchers that need no Node, refreshed only where a herdr-wake one is already there"`

### PR 6 gate (controller)

- [ ] New tests fail on PR 5's tree, pass on the branch; `bun test`; `bun run check`. PR body: Telegram Off by default, compared with tg-mcp present (no request); launchers replaced only where marked.

---

## PR 7 — Takeover, migration, docs, and wake on by default

**Issue:** under #119, "Switch over from the herdr-wake plugin and start wake with the board" (Closes #119, #150, #151). Waves: **[7.1, 7.3]** → **[7.2]** → **[7.4]** → **STOP: the one real check (owner)**.

### Task 7.1: The takeover's rules

**Depends on:** PR 6. **Parallel with:** 7.3.

**Files:** Create `src/core/wake/takeover.ts`; Test `test/core/wake/takeover.test.ts`.

**Interfaces:**
```ts
/** The old config.json → the wake section: reaper (enabled, idleMinutes, exclude, maxPerRound), url, authorization, server, port, wakeTimeoutSec, pollTimeoutSec, listSleepingDays, workspace only when not 'tg-router'; telegram 'auto' when the old router had a url and token (its own or ~/.claude.json's); keys it does not know kept as they are; wakeCommand dropped. */
export function takeOverConfig(old: unknown, claudeJson: unknown): Record<string, unknown>
/** The old sessions.json → wake's entries, each with the default folder as profileDir (the old router knew ~/.claude only). */
export function takeOverSessions(old: unknown, defaultDir: string): WakeSessions
/** Call 25: the old wakeCommand's program against launch.claude's; null when they agree or the old one is the default. */
export function launcherNote(wakeCommand: unknown, launchClaude: unknown): { old: string; now: string } | null
export function withoutOldHooks(settings: unknown): { settings: unknown; removed: string[] }
/** Call 26: herdr key bindings ([[keys.command]] … plugin_action "herdr-wake.sleep" | "herdr-wake.wake") with their new names. */
export function oldActionBindings(configToml: string | null): { key: string; old: string; now: string }[]
```
- [ ] **Step 1:** Tests for each (an old config with reaper on, 2 excluded, Telegram from `~/.claude.json` → `telegram: 'auto'`; `"workspace": "tg-router"` not carried; an unknown key kept; `claude-tg --resume {session}` vs `["claude"]` → note; settings.json with old and other hooks → only old removed; a config.toml binding → `agent-board.sleep`). **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add the rules for taking over the herdr-wake plugin's config, sleeping list, hooks and key bindings"`

### Task 7.2: "Switch over…" and the takeover at first start

**Depends on:** Task 7.1. **Shared files:** `src/services/wake/start.ts`, `src/services/wake/control.ts`, `src/server/routes/wake.ts`, `src/adapters/wake-files.ts`, the panel, `wake-strings.ts`.

**Files:** Create `src/services/wake/takeover.ts`; modify the shared files; Test `test/services/wake-takeover.test.ts`, `test/web/wake-panel.test.tsx` (append).

**Interfaces:** `export function switchOver(o: { uninstall: boolean; herdr: <T = unknown>(args: string[], timeoutMs?: number) => Promise<T>; home: string; env: Env; log(text: string): void }): Promise<{ ok: true; did: string[]; summary: { reaper: string; telegram: boolean; asleep: number; excluded: number }; launcher: { old: string; now: string } | null; bindings: { key: string; old: string; now: string }[] } | { ok: false; error: string }>`; `wakeTakeoverFile()` in `wake-files.ts`; route `op: 'switch'` (local only); panel "Switch over…" in the held state: one confirm listing the steps, then the summary ("reaper on, 60 min, 2 excluded; Telegram; 4 sleeping sessions"), the launcher note and bindings. Texts (exact English): `wake.switchOver` `Switch over…`, `wake.switchConfirm` `Take over the herdr-wake plugin's settings and sleeping sessions, uninstall it, move its hooks to the board's in every profile, close its tg-router workspace and start the board's wake?`, `wake.switched` `Taken over: {summary}`, `wake.launcherNote` `herdr-wake woke sessions with {old}; the board starts them with {now}. Set launch.claude in the board's config.json to keep {old}.`, `wake.bindings` `Rename in herdr's config.toml: {list}`.

**Rules:** steps 1–8 of the design's Migration in that order (config and sleeping list before the uninstall; the uninstall `herdr plugin uninstall herdr-wake`; each settings.json backed up to `settings.json.bak-agent-board` before the old hooks go and ours go in; `tg-router` closed with `workspace close` only when nothing but shells and sidebar panes is in it; wake turned on and started). The marker `wake-takeover.json` `{ at, did }`. **At first start** (`startWake`, not held, no marker, the old config or state folder there): the same without the uninstall, once.

- [ ] **Step 1: Write the failing tests** (sandbox with the old plugin's folders under the sandbox APPDATA/LOCALAPPDATA, two profiles with old hooks, a `tg-router` workspace in the fake snapshot): `Switch over takes over the config and the sleeping list before uninstalling, then hooks, tg-router, start, in that order`; `what it did is said, with the launcher note and the bindings`; `uninstalled by hand: the takeover runs once at the first start, without the uninstall; the marker stops a second`; `a tg-router workspace with an agent in it is left open`; `the old config and state folders are left where they are`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Add Switch over from the herdr-wake plugin, and the same takeover once at wake's first start after it was removed by hand"`

### Task 7.3: Wake starts with the board: the manifest and the default

**Depends on:** PR 6; Task 3.1's answer read (if it needs the last fallback, stop: the controller asks the owner before going on, and the `open.ts` change is planned with the owner). **Parallel with:** 7.1.

**Files:**
- Modify: `herdr-plugin.toml` (the fragment of Task 3.4 appended verbatim), delete `test/fixtures/wake-manifest.toml`, `src/core/wake/config.ts` (`WAKE_SHIPPED = true`), `src/core/setup.ts` (old-mode fix text: no Node, the three herdr-wake commands replaced by `setup.wake.heldFix`'s Switch over or `newOffFix`), `test/manifest.test.ts` (11 entries; actions `['open','web','install','notifications','doctor','sleep','wake']`; panes `['board','wake']`), and the tests whose expectations change because wake is now on by default (install writes the wake hooks; the doctor line; the payload's `wake`; the Settings item) — each named in the PR
- Test: `test/entrypoints/wake-default.test.ts`

**Rules:** nothing else changes: `open.ts`, `run.ts`, the every-prompt hook and, with Telegram off, the SessionStart report stay byte for byte as on `main`.

- [ ] **Step 1: Write the failing tests:** `with no wake section, wake starts` (`wake-start` opens the pane); `the board’s start is today’s: open.ts, run.ts, the board’s manifest entries` (diff of those against `main` empty; the manifest's board entries equal `main`'s); `with the old plugin installed, wake’s start makes one plugin list and exits; the board’s calls are today’s` (`wakeUrl`, the guard).
- [ ] **Step 2:** FAIL on PR 6's tree. **Step 3:** Implement; update the named tests. **Step 4:** PASS; `bun test`; `bun run check`.
- [ ] **Step 5: Commit** `git commit -m "Start wake with the board on every install, doing nothing by itself until someone acts"`

### Task 7.4: Docs, and herdr-wake marked deprecated

**Depends on:** Tasks 7.2, 7.3.

**Files:** `README.md` (Setup step 4 → "Sleep and wake starts with the board"; Claude profiles → "Waking stays in the profile"; Restart; Several to sleep; Settings → Sleep and wake…; Development: the new entrypoints and `bun test` covering wake), `herdr-wake/README.md` (a first paragraph: deprecated, the board does this now, Switch over…), `herdr-wake/herdr-plugin.toml` (`description` starts with `Deprecated: the agent board does this now.`).

- [ ] **Step 1:** Write the sections; every command and setting named exists (grep each). **Step 2:** `bun test`; `bun run check`. **Step 3: Commit** `git commit -m "Document sleep and wake in the board and mark the separate herdr-wake plugin deprecated"`

### PR 7 gate (controller), before the live check

- [ ] New tests fail on PR 6's tree, pass on the branch; `bun test`; `bun run check`.
- [ ] PR body names the one difference for every setup ("Everyone's setup"): a wake process in a `Wake` workspace on 127.0.0.1 only; the ListAgents and SendMessage hooks in each shown profile; a user's `/exit` counts as asleep; a new Settings item; the doctor line without Node. Lists the tests whose expectations changed (Task 7.3) and why. **Not merged** until the live check below passes.

---

## STOP — the one real check on the owner's machine (decision 10)

The controller does not start this. It hands the owner this checklist and waits for "go", at a time the owner chooses, after they saved their work. With a VM or a second machine from the owner, everything runs there first; the owner's machine still gets only this one check.

1. **Open question, live** (only if Task 3.1 left it open and no VM answered it): link a throwaway plugin with four startup entries (A: writes the time to a file and exits 0; B: sleeps two minutes; C: exits 1 at once; D: writes the time to another file), restart herdr, read the times; again with B and C first; unlink it. Nothing of the new wake is on the machine yet. An answer that needs the last fallback ends the check here: the `open.ts` change is built and tested on fakes, and the owner is asked again.
2. The board's checkout on the PR 7 branch, the old plugin still installed (wake held: the panel says so); **Switch over…**; check what it says it did (config, sleepers, hooks per profile with backups, `tg-router` closed, the launcher note, bindings).
3. A Work and a Default session asleep; **herdr restarted**; the board opens; wake answers; both are woken in their profiles and their project folders.
4. ListAgents and SendMessage from a Work and from a Default session: each sees and wakes only its own profile's sleepers.
5. Telegram to a sleeping Work session, when the old router routed Telegram.
6. Wake turned off with a session asleep: its card stays and its Wake works; then on again.
7. Wake's pane closed by hand: the panel says Not running; Start brings it back.

**Backing out at any step:** `"wake": false` in the board's config.json, the board's checkout back on `main`, the old plugin installed again; its config and state folders were left as they were, and each settings.json has its backup (`settings.json.bak-agent-board`).

After the owner reports each step's result: the answer to the open question goes into #119 and the PR; PR 7 merges only when all seven pass.
