# agent-board Claude Multi-Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One board for every Claude Code profile (`CLAUDE_CONFIG_DIR` folder): each session shown with its profile, new sessions started in the profile the owner chooses, profiles managed on the board, and never a session in the wrong account.

**Architecture:** A pure profile model in `src/core/profiles.ts` (folders, ids, colors, the env rule, launch and wake decisions) carries every decision; adapters find the folders, keep them in `config.json` and read each profile's own `ClaudeHome`; the hooks and the status line report the session's folder onto its card; launches set `CLAUDE_CONFIG_DIR` through `herdr --env` only when the target is not the board's inherited profile; wakes and MokuPilot calls are refused when the board cannot be sure. The web board reads new payload fields only; with one profile shown it renders exactly as phase 1.

**Tech Stack:** Bun 1.4.3, strict TypeScript, React 19 + react-dom, Biome; herdr CLI (`--env` from 0.9.5).

**Spec:** `docs/superpowers/specs/2026-10-18-multi-profile-design.md` (its "Calls made after the builder check" are part of it). Phase-1 conventions: `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.superpowers/sdd/2026-10-16-ts-bun-react-rework/conventions.md`.

## Global Constraints

- Worktree: `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.claude/worktrees/multi-profile`, branch `feature/multi-profile`. Local commits only, never push.
- Every phase-1 convention binds every task (conventions file above): Bun, strict TS (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `.ts`/`.tsx` import extensions, React and react-dom only, Biome; layers (core pure; adapters and integrations import only core and other adapters; services orchestrate; server, tui, entrypoints wire); no `any`; JSON from disk or network narrowed before use; unknown JSON fields kept on write; Windows first-class, no shell when spawning; port 12422, loopback, `X-Board`/`Origin` checks; paths built with `node:path`, parsed with either separator, compared only through `normDir`/`sameDir` (`src/core/launch/names.ts`).
- Toolchain (Git Bash): `export PATH="$HOME/.bun/bin:$PATH"`, then `bun test <file>`, `bun test`, `bun run check`. Every task ends with `bun test` green (only the 2 symlink tests may skip) and `bun run check` clean.
- **Anti-goal no. 1:** a session started, forked, reminded, woken or called (MokuPilot) in a profile other than the one intended. If the board cannot be sure of the profile it refuses or asks; it never falls back quietly.
- **One profile shown** (every teammate today): no switch, no tags, no profile choice in the new-session window, no `--env` on launches; the page markup, the hook output, the status line output and the `board` command output stay exactly as phase 1. The only allowed difference: the "Profiles…" Settings item (and its panel), only when more than one profile folder is found.
- Payloads: new fields only (`profile`, `profileFolder`, `profileWanted` on items; `profiles` on the board payload; `profile` on categories; `profile`/`parent` on launches). Nothing existing is renamed.
- Profile ids: `~/.claude` → `default`; `~/.claude-<name>` → `<name>`. Renaming or recoloring never changes `id` or `dir`. Profile colors, in this order: `indigo, teal, pink, brown, mint, cyan, yellow` (never the column colors green, orange, purple, blue, gray, nor red, which marks "wrong profile").
- The board writes in a profile folder only its own hook and status line entries in `settings.json` (plus `settings.json.bak-agent-board`); never touches a hidden profile; never reads or writes credentials or `.claude.json`.
- `min_herdr_version` stays `"0.9.2"` in `herdr-plugin.toml`. A launch that needs `--env` on a herdr that rejects it refuses with a message.
- `CLAUDE_CONFIG_DIR` and the home folder are read only through `inheritedProfileDir(env, home, platform)` and `home` parameters (Task 2). Tests pass `env`/`home` explicitly, or run code in `sandbox()` children (their env never has `CLAUDE_CONFIG_DIR` unless the test sets it). The owner's machine has `CLAUDE_CONFIG_DIR=C:/Users/migo/.claude` set user-wide: no test may depend on it. Tests never touch the real `~/.claude*`, `%APPDATA%\herdr`, `%LOCALAPPDATA%\herdr`, a real herdr, or port 12422.
- Texts: every new key in English and Russian in `src/core/i18n/profile-strings.ts` (Task 2 creates it; `strings.ts` merges it like `HELPER_STRINGS`); `missingKeys` stays `[]`. Where a task gives only the English text, write the Russian in the tone of the neighbouring keys.
- New stylesheet rules go only in `web/styles/profiles.css` (Task 10 creates it): `test/web/styles.test.ts` pins the other sheets to upstream rule for rule. Its rules select by class only.
- Commit messages: one plain English sentence in the repo's style (the task gives it); no `feat:` prefix, no trailer, no `Co-Authored-By`, no mention of AI or assistants. No new file name starts with `claude-` (the owner's global gitignore hides those).
- Phase 5 reuses the launch request field `profile` (Task 7): keep its name and meaning.

## Review Focus

1. **The inherited env unset, `~/.claude`, `C:\Users\me\.claude\` and `C:/Users/me/.claude/`** are all the `default` profile: the hook writes `default`, and a launch into `default` from such a board adds no `--env`. → tests in Tasks 1, 3, 7.
2. **Drive-letter case** (`c:\users\me\.claude-work` vs `C:/Users/me/.claude-work`) is the same profile: matched in the list, and no `--env` when it is the inherited one. → tests in Tasks 1, 7.
3. **`~` in a folder** (`CLAUDE_CONFIG_DIR=~/.claude-work`, "Add folder `~/elsewhere/acme`") resolves to the home folder, never to a folder named `~`. → tests in Tasks 1, 2, 3.
4. **A profile folder missing** (listed, then deleted): a launch or `spawn-agent --profile` that would set it refuses with the folder named; Install skips it saying so. → tests in Tasks 5, 6, 7.
5. **herdr rejecting `--env`** (older than 0.9.5): the start fails with a message and no Claude is started (no `pane run`, no `agent start`). → tests in Tasks 6, 7.
6. **Forks and helpers of a non-default session**: `spawn-agent` run from a work session's env starts the child with `--env` work (hidden or not); from a folder the board does not know it refuses; "New here" from a work card starts in work and refuses another profile; a MokuPilot fork from work is refused. → tests in Tasks 6, 7, 8.
7. **Waking a session started outside the board** (`cld-work`): the wake button, focus, a message and a reminder are refused with the spec's text and herdr-wake is never called; a pane the board opened with work's `--env` wakes; a pane record herdr no longer has is dropped. → tests in Task 8.

## Decisions where the spec is silent (the owner can overturn them)

- The folder the board's own environment points to is always a profile and starts shown, like `default` (one teammate whose `CLAUDE_CONFIG_DIR` is set elsewhere keeps a one-profile board).
- A tag also shows, with one profile shown, on a session that runs in another profile (hidden, unknown or wrong): those are exactly the sessions the owner must notice.
- `spawn-agent` run by an agent keeps the environment when its own profile is `default` (herdr's env is taken to be default's, as everywhere today) and sets `--env` for any other; the board tells its own spawn-agent `--keep-env` or `--config-dir`.
- With no profile on the card, a wake or a MokuPilot call is allowed only when the board knows exactly one profile.
- The "notification" of a wrong profile is herdr's (`herdr notification show`), best effort; the card's red tag is the lasting sign.
- Non-default usage goes to `claude-limits-<id>.json` in the state folder; the folder's last launch profile is remembered per browser; the folder-exists check applies only to starts that set `--env`; `launch.command` panes are never recorded as safe to wake.

---

## File map

| Area | Files |
|---|---|
| Profile model | Create `src/core/profiles.ts`; modify `src/core/types.ts` |
| Folders, config | Create `src/adapters/profiles.ts`, `src/core/i18n/profile-strings.ts`; modify `src/adapters/config-file.ts`, `src/core/i18n/strings.ts`, `src/server/routes/settings.ts`, `src/server/app.ts`, `test/support/env.ts` |
| Reporting | Modify `src/entrypoints/hook.ts`, `src/entrypoints/statusline.ts`, `src/adapters/paths.ts` |
| Homes per profile | Create `src/adapters/profile-homes.ts`; modify `src/services/deps.ts`, `src/services/board.ts`, `src/server/board-state.ts`, `src/server/routes/session.ts`, `src/services/launch/launches.ts`, `src/entrypoints/cli.ts` |
| Install, setup | Create `src/adapters/hook-settings.ts`, `src/services/profiles.ts`; modify `src/entrypoints/install.ts`, `src/adapters/setup-facts.ts`, `src/core/setup.ts` |
| Launch | Create `src/adapters/profile-panes.ts`; modify `src/adapters/herdr.ts`, `src/core/launch/spawn-args.ts`, `src/core/launch/launcher-command.ts`, `src/services/launch/{spawn-agent,launcher,run,request,launches}.ts`, `src/entrypoints/spawn-agent.ts` |
| Guards | Modify `src/services/actions.ts`, `src/services/mokupilot.ts`, `src/server/routes/session.ts` |
| Payload | Modify `src/core/payload.ts`, `src/server/board-state.ts`, `src/adapters/claude-home.ts`, `web/src/api/client.ts` |
| Web | Create `web/src/models/profiles.ts`, `web/src/models/launch-profile.ts`, `web/src/components/ProfileSwitch.tsx`, `web/src/components/ProfileTag.tsx`, `web/src/components/profiles/{ProfilesPanel,ProfileRow}.tsx`, `web/styles/profiles.css`; modify toolbar, card, limits, launch window, categories, panel, settings menu, state |
| Terminal board, docs | Modify `src/tui/{state,app,render}.ts`, `README.md` |

---

### Task 1: The profile model

**Spec:** "Profiles", "Which profile a session is in", "Starting a session in a profile" (first bullet).

**Files:**
- Create: `src/core/profiles.ts`
- Modify: `src/core/types.ts`
- Test: `test/core/profiles.test.ts`

**Interfaces:**
- Consumes: `normDir`, `sameDir` (`src/core/launch/names.ts`); `validColor` (`src/core/categories.ts`).
- Produces:
  ```ts
  // core/types.ts (additions)
  interface Card {
    /** The id of the profile its hooks reported (absent when the folder is no known profile). */ profile?: string
    /** Its Claude config folder as the hooks resolved it. */ profileDir?: string
    /** The profile a start asked for (the board's launch or spawn-agent). */ profileWant?: string
  }
  interface Category { /** The lane's usual profile. */ profile?: string }
  interface Item {
    profile?: string | null        // known profile id; null when not known
    profileFolder?: string         // the folder it reported when no profile has it ("unknown profile")
    profileWanted?: string         // the id a start asked for, when it reports another ("wrong profile")
    claudeRoot?: string | null     // the Claude folder its records were read from (server only)
  }
  // core/profiles.ts
  export interface Profile { id: string; title: string; dir: string; color: string; hidden: boolean; args?: string[]; [extra: string]: unknown }
  export interface ProfileSet { list: Profile[]; inheritedDir: string; inherited: Profile | null }
  export const DEFAULT_PROFILE = 'default'
  export const PROFILE_COLORS: readonly string[] // ['indigo','teal','pink','brown','mint','cyan','yellow']
  export function defaultProfileDir(home: string, platform?: string): string            // <home>/.claude, joined with platform's path
  export function resolveProfileDir(value: string | null | undefined, home: string, platform?: string): string
  export function profileIdOf(dir: string, home: string, taken?: ReadonlySet<string>): string
  export function profileTitleOf(id: string): string
  export function profileForDir(list: readonly Profile[], dir: string | null | undefined): Profile | null
  export function mergeProfiles(listed: unknown, found: readonly string[], home: string, shownDir?: string | null): { list: Profile[]; added: Profile[] }
  export function profileSet(list: Profile[], inheritedDir: string): ProfileSet
  export function shownProfiles(list: readonly Profile[]): Profile[]
  export function configDirFor(target: Pick<Profile, 'dir'>, inheritedDir: string): string | null
  export function sessionProfile(card: Pick<Card, 'profile' | 'profileDir' | 'profileWant'> | null | undefined, list: readonly Profile[]): Pick<Item, 'profile' | 'profileFolder' | 'profileWanted'>
  ```
  `platform` defaults to `process.platform` and picks `path.win32` or `path.posix`. Rules the code must follow:
  - `resolveProfileDir`: unset, empty or blank → `defaultProfileDir`; surrounding quotes dropped; `~` or `~/…`/`~\…` → the home folder; on win32 an MSYS form `/c/…` → `c:/…`; trailing separators dropped except a root (`C:\`, `/`). Otherwise as given.
  - `profileIdOf`: `sameDir(dir, defaultProfileDir(home))` → `default`; a last folder `.claude-<rest>` → `<rest>`, else the last folder without leading dots; lower-cased, runs of characters outside `[a-z0-9_-]` become `-`, trimmed of `-`, cut to 32, `profile` when empty; `-2`, `-3`… while `taken` has it.
  - `profileTitleOf`: `default` → `Default`, else the id with its first letter upper-cased (`work` → `Work`).
  - `mergeProfiles`: listed object entries with a string `id` and `dir` become profiles in their order with every own field kept; `title` defaults to `profileTitleOf(id)`; `hidden` is `true` only when it is `true`; a missing or invalid `color` gets the next free `PROFILE_COLORS` entry. Non-object entries are left out of `list` (the writer keeps them in the file, Task 2). `found` (the default folder, and `shownDir` when given, count as found even when absent: the board's own profile is always one) adds every folder no listed profile has (`sameDir`), in found order, with `id` unique against the list, `title = profileTitleOf(id)`, the next free color, `hidden = !(id === 'default' || sameDir(dir, shownDir))`; those are also returned in `added`.
  - `configDirFor`: `null` when `sameDir(target.dir, inheritedDir)` (the start leaves the env as inherited), else `target.dir`.
  - `sessionProfile`: the reported profile is `profileForDir(list, card.profileDir)` when `card.profileDir` is set (unknown folder → `profile: null, profileFolder: card.profileDir`); else `card.profile` when the list has it; else the only profile when the list has exactly one; else `null`. `profileWanted = card.profileWant` only when a folder was reported and its profile id is not `card.profileWant`.

- [ ] **Step 1: Write the failing tests** in `test/core/profiles.test.ts` (home `C:\Users\me`, platform `win32`, unless said). Fixtures, reused by later tasks' tests in this file: `H = 'C:\\Users\\me'`; `DEFAULT = { id: 'default', title: 'Default', dir: 'C:\\Users\\me\\.claude', color: 'indigo', hidden: false }`; `WORK = { id: 'work', title: 'Work', dir: 'C:\\Users\\me\\.claude-work', color: 'teal', hidden: false }`; `GAMEDEV = { id: 'gamedev', title: 'Gamedev', dir: 'C:\\Users\\me\\.claude-gamedev', color: 'pink', hidden: true }`; `LIST = [DEFAULT, WORK]`; `L = [DEFAULT, WORK, GAMEDEV]`; `SET = profileSet(L, DEFAULT.dir)`; `ONE_SHOWN = profileSet([DEFAULT, { ...WORK, hidden: true }], DEFAULT.dir)`.

```ts
test('every spelling of the default folder is the default profile', () => {
  const d = defaultProfileDir(H, 'win32') // 'C:\\Users\\me\\.claude'
  for (const v of [undefined, '', '  ', '~/.claude', '~\\.claude', 'C:\\Users\\me\\.claude\\', 'C:/Users/me/.claude/', 'c:/users/me/.claude', '"C:\\Users\\me\\.claude"', '/c/Users/me/.claude'])
    expect(sameDir(resolveProfileDir(v, H, 'win32'), d)).toBe(true)
  expect(resolveProfileDir('C:\\', H, 'win32')).toBe('C:\\')
  expect(resolveProfileDir('/c/x', '/home/me', 'linux')).toBe('/c/x')
  expect(resolveProfileDir(undefined, '/home/me', 'linux')).toBe('/home/me/.claude')
  expect(resolveProfileDir('~/.claude-work', '/home/me', 'linux')).toBe('/home/me/.claude-work')
})
test('ids and titles from the folder', () => {
  expect(profileIdOf('C:\\Users\\me\\.claude', H)).toBe('default')
  expect(profileIdOf('C:\\Users\\me\\.claude-work', H)).toBe('work')
  expect(profileIdOf('C:\\Users\\me\\.claude-Game Dev', H)).toBe('game-dev')
  expect(profileIdOf('D:\\profiles\\acme', H)).toBe('acme')
  expect(profileIdOf('D:\\x\\.claude-work', H, new Set(['work']))).toBe('work-2')
  expect([profileTitleOf('default'), profileTitleOf('work')]).toEqual(['Default', 'Work'])
})
test('found folders join the list: default shown, the others hidden, colors in order', () => {
  const found = [`${H}\\.claude`, `${H}\\.claude-gamedev`, `${H}\\.claude-work`]
  const { list, added } = mergeProfiles(undefined, found, H)
  expect(list.map(p => [p.id, p.title, p.hidden, p.color])).toEqual([
    ['default', 'Default', false, 'indigo'], ['gamedev', 'Gamedev', true, 'teal'], ['work', 'Work', true, 'pink']])
  expect(added.length).toBe(3)
  expect(mergeProfiles(undefined, found, H, `${H}\\.claude-work`).list.find(p => p.id === 'work')?.hidden).toBe(false)
  expect(mergeProfiles(undefined, [], H).list.map(p => p.id)).toEqual(['default'])
  expect(mergeProfiles(undefined, [], H, 'D:\\claude').list.map(p => [p.id, p.hidden])).toEqual([['default', false], ['claude', false]])
})
test('a listed profile keeps its id, folder, title and unknown fields; only new folders are added', () => {
  const listed = [{ id: 'default', title: 'Private', dir: `${H}\\.claude`, color: 'indigo', hidden: false, note: 'mine' }, 'junk',
    { id: 'work', title: 'Work', dir: 'c:/USERS/me/.claude-work/', color: 'nope', hidden: 'yes' }]
  const { list, added } = mergeProfiles(listed, [`${H}\\.claude`, `${H}\\.claude-gamedev`, `${H}\\.claude-work`], H)
  expect(list.map(p => p.id)).toEqual(['default', 'work', 'gamedev'])
  expect(list[0]).toMatchObject({ title: 'Private', note: 'mine' })
  expect(list[1]).toMatchObject({ dir: 'c:/USERS/me/.claude-work/', color: 'teal', hidden: false })
  expect(added.map(p => [p.id, p.hidden, p.color])).toEqual([['gamedev', true, 'pink']])
})
test('a start leaves the env alone only for the inherited profile', () => {
  expect(configDirFor({ dir: 'c:/users/me/.claude/' }, 'C:\\Users\\me\\.claude')).toBeNull()
  expect(configDirFor({ dir: 'C:\\Users\\me\\.claude-work' }, 'c:/users/me/.claude-work')).toBeNull()
  expect(configDirFor({ dir: 'C:\\Users\\me\\.claude-work' }, 'C:\\Users\\me\\.claude')).toBe('C:\\Users\\me\\.claude-work')
  expect(profileSet(LIST, 'c:/users/me/.claude-work').inherited?.id).toBe('work')
  expect(profileSet(LIST, 'D:\\other').inherited).toBeNull()
})
test('a session’s profile from its card', () => {
  const two = LIST // default, work
  expect(sessionProfile({ profileDir: 'C:\\Users\\me\\.claude-work' }, two)).toEqual({ profile: 'work' })
  expect(sessionProfile({ profileDir: 'D:\\old\\.claude-x' }, two)).toEqual({ profile: null, profileFolder: 'D:\\old\\.claude-x' })
  expect(sessionProfile({}, two)).toEqual({ profile: null })
  expect(sessionProfile(null, [DEFAULT])).toEqual({ profile: 'default' })
  expect(sessionProfile({ profileDir: WORK.dir, profileWant: 'default' }, two)).toEqual({ profile: 'work', profileWanted: 'default' })
  expect(sessionProfile({ profileDir: 'D:\\x', profileWant: 'work' }, two)).toEqual({ profile: null, profileFolder: 'D:\\x', profileWanted: 'work' })
  expect(sessionProfile({ profileWant: 'work' }, two)).toEqual({ profile: null })
  expect(sessionProfile({ profileDir: WORK.dir, profileWant: 'work' }, two)).toEqual({ profile: 'work' })
})
```

- [ ] **Step 2: Run** `bun test test/core/profiles.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/core/profiles.ts` and the `types.ts` additions per the Interfaces.
- [ ] **Step 4: Run** `bun test test/core/profiles.test.ts` → PASS; `bun test` → green; `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/core/profiles.ts src/core/types.ts test/core/profiles.test.ts
git commit -m "Model Claude profiles: their folders, ids, colors and the folder a start sets"
```

### Task 2: Finding the profile folders and keeping them in config.json

**Spec:** "Profiles" (found automatically, stored, rules), "Profiles panel" (rename, show/hide, add a folder: server side), "A lane's usual profile" (server side).

**Files:**
- Create: `src/adapters/profiles.ts`, `src/core/i18n/profile-strings.ts`
- Modify: `src/adapters/config-file.ts`, `src/core/i18n/strings.ts`, `src/server/routes/settings.ts`, `src/server/app.ts`, `test/support/env.ts`
- Test: `test/adapters/profiles.test.ts`, `test/adapters/config-file.test.ts`, `test/server/profiles.test.ts` (new; later tasks add to it)

**Interfaces:**
- Consumes: Task 1 `mergeProfiles`, `resolveProfileDir`, `defaultProfileDir`, `profileIdOf`, `profileTitleOf`, `profileForDir`, `shownProfiles`, `PROFILE_COLORS`; `readJson`/`replaceFile`/`isRecord` (`json-store.ts`); `statOf` (`folders.ts`).
- Produces:
  ```ts
  // adapters/profiles.ts
  export type Env = Record<string, string | undefined>
  /** The default folder first (always, there or not), then every ~/.claude-* folder holding settings.json or projects/, by name. */
  export function findProfileDirs(home?: string): string[]
  /** The profile folder this process's environment points to (unset: ~/.claude). */
  export function inheritedProfileDir(env?: Env, home?: string, platform?: string): string
  /** config.json's `profiles` merged with the found folders; reads, never writes. */
  export function loadProfiles(opts?: { home?: string; shownDir?: string | null }): Profile[]
  // adapters/config-file.ts
  export function readConfigFile(): Record<string, unknown> | null       // today's readRaw, exported
  export function editProfiles(body: unknown, opts?: { home?: string }): EditResult
  /** Adds the found folders config.json does not list (shownDir: shown too); true when it wrote. */
  export function saveFoundProfiles(inheritedDir: string, home?: string): boolean
  // editCategories { op: 'update', profile }: '' removes the field, an id matching /^[a-z0-9_-]{1,32}$/ sets it, anything else is ignored
  // server/routes/settings.ts
  export const profilesRoute: () => Route   // POST /api/profiles, guard ['board-header'], body to editProfiles; 200 or 409
  // core/i18n/profile-strings.ts
  export const PROFILE_STRINGS: Record<Lang, Record<string, string | string[]>>
  ```
  `editProfiles` bodies: `{ op: 'update', id, title?, color?, hidden? }` and `{ op: 'add', dir }`. It works on `mergeProfiles(raw.profiles, findProfileDirs(home), home).list`, writes `raw.profiles` = that list (each profile with its own unknown fields) followed by the file's non-object entries, and keeps every other key of the file. Errors (`EditResult.error`): `err.profile.missing` `{id}` "No profile “{id}”"; `err.profile.title` "A profile needs a name"; `err.profile.lastShown` "At least one profile stays shown"; `err.profile.noFolder` `{path}` "There is no folder {path}"; `err.profile.exists` `{path, title}` "{path} is the profile {title} already". `update` sets `title` (trimmed, ≤ 40), `color` (when `validColor`), `hidden` (boolean); never `id` or `dir`. `add` resolves `dir` with `resolveProfileDir`, needs a folder that is there, gets a unique `profileIdOf` id, `profileTitleOf` title, the next free color, `hidden: false`. `saveFoundProfiles` writes only into a `config.json` that exists (the board's `loadConfig` makes it on first use) and only when `mergeProfiles` added something. `app.ts` registers `profilesRoute()` right after `categoriesRoute()`, and calls `saveFoundProfiles(inheritedProfileDir())` once in `startServer` before the first refresh.
  `test/support/env.ts` `isolatedHome()` also points `HOME` and `USERPROFILE` at `<dir>/home` (created) and removes `CLAUDE_CONFIG_DIR`, restoring all three after the test.

- [ ] **Step 1: Write the failing tests**

`test/adapters/profiles.test.ts` (temp home, `isolatedHome()` where config is read):
```ts
test('found: the default folder always, then ~/.claude-* folders with settings.json or projects/', () => {
  // home: .claude/settings.json, .claude-work/projects/, .claude-gamedev/settings.json, .claude-empty/, files .claude.json and .claude-notes.txt
  expect(findProfileDirs(home)).toEqual([join(home, '.claude'), join(home, '.claude-gamedev'), join(home, '.claude-work')])
  expect(findProfileDirs(emptyHome)).toEqual([join(emptyHome, '.claude')])
})
test('the inherited folder: unset is ~/.claude; ~ is the home folder', () => {
  expect(sameDir(inheritedProfileDir({}, home), join(home, '.claude'))).toBe(true)
  expect(sameDir(inheritedProfileDir({ CLAUDE_CONFIG_DIR: '~/.claude-work' }, home), join(home, '.claude-work'))).toBe(true)
})
test('loadProfiles merges config.json and the folders without writing either', () => {
  expect(loadProfiles({ home }).map(p => [p.id, p.hidden])).toEqual([['default', false], ['gamedev', true], ['work', true]])
  expect(existsSync(configFile())).toBe(false)
})
test('isolatedHome hides the developer’s own home and CLAUDE_CONFIG_DIR', () => {
  const dir = isolatedHome()
  expect(homedir().startsWith(dir)).toBe(true)
  expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined()
})
```
`test/adapters/config-file.test.ts` additions (`ok(r)` stands for `expect(r).toEqual({ ok: true })`, then the saved file is read back):
```ts
test('saveFoundProfiles adds the folders once, the inherited one shown, keeping the rest of the file', () => {
  // config.json { language: 'ru', keep: 1, profiles: [{ id: 'default', title: 'Private', dir: <home>/.claude, color: 'indigo', hidden: false, mine: true }, 7] }
  expect(saveFoundProfiles(join(home, '.claude-work'), home)).toBe(true)
  // file: language 'ru', keep 1; profiles ids ['default','gamedev','work'] then 7; default keeps title 'Private' and mine; work hidden false, gamedev true
  expect(saveFoundProfiles(join(home, '.claude-work'), home)).toBe(false)
})
test('editProfiles renames, recolors, shows and hides by id, never changing id or folder', () => {
  ok(editProfiles({ op: 'update', id: 'default', title: ' Private ', color: 'teal' }, { home }))   // title 'Private', color 'teal'
  ok(editProfiles({ op: 'update', id: 'default', color: 'nope' }, { home }))                       // color stays 'teal'
  expect(editProfiles({ op: 'update', id: 'default', hidden: true }, { home })).toEqual({ ok: false, error: 'At least one profile stays shown' })
  expect(editProfiles({ op: 'update', id: 'nope', title: 'x' }, { home })).toEqual({ ok: false, error: 'No profile “nope”' })
  expect(editProfiles({ op: 'update', id: 'default', title: '  ' }, { home })).toEqual({ ok: false, error: 'A profile needs a name' })
})
test('editProfiles adds a folder somewhere else, ~ included; not twice, not one that is not there', () => {
  ok(editProfiles({ op: 'add', dir: '~/elsewhere/acme' }, { home }))   // id 'acme', title 'Acme', hidden false, sameDir(dir, join(home,'elsewhere','acme'))
  expect(editProfiles({ op: 'add', dir: join(home, 'elsewhere', 'acme') + sep }, { home }).ok).toBe(false)   // err.profile.exists
  expect(editProfiles({ op: 'add', dir: join(home, 'gone') }, { home })).toEqual({ ok: false, error: `There is no folder ${join(home, 'gone')}` })
})
test('a lane’s usual profile: set, cleared, a bad id ignored', () => { /* update profile 'work' → saved; '' → key gone; 'Bad Id' → unchanged */ })
```
`test/server/profiles.test.ts`: `test('POST /api/profiles renames a profile; without X-Board it is refused', …)` through `serveBoard` (sandbox home with `.claude/settings.json`): 200 `{ ok: true }` and the sandbox `config.json` has the title; no header → 403.

- [ ] **Step 2: Run** `bun test test/adapters/profiles.test.ts test/adapters/config-file.test.ts test/server/profiles.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces; add `PROFILE_STRINGS` (the `err.profile.*` keys) and merge it in `strings.ts`.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green; `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/adapters/profiles.ts src/adapters/config-file.ts src/core/i18n/profile-strings.ts src/core/i18n/strings.ts src/server/routes/settings.ts src/server/app.ts test/support/env.ts test/adapters/profiles.test.ts test/adapters/config-file.test.ts test/server/profiles.test.ts
git commit -m "Find the Claude profile folders and keep them in config.json"
```

### Task 3: The hooks and the status line report the profile

**Spec:** "Which profile a session is in" (first bullet), "Usage" (per profile, existing file is the default's), "Scope of changes".

**Files:**
- Modify: `src/entrypoints/hook.ts`, `src/entrypoints/statusline.ts`, `src/adapters/paths.ts`
- Test: `test/entrypoints/hook.test.ts`, `test/entrypoints/statusline.test.ts`

**Interfaces:**
- Consumes: Task 2 `inheritedProfileDir`, `loadProfiles`; Task 1 `profileForDir`, `defaultProfileDir`; `readCard`/`writeCard`.
- Produces:
  - Card fields written by the hook on every event in a herdr pane (`HERDR_PANE_ID` set), only when they differ from the card: `profileDir` = `inheritedProfileDir()`, `profile` = the id of `profileForDir(loadProfiles(), profileDir)`, or `''` (removes it) when none. The status line writes the same two fields the same way, also only in a herdr pane.
  - `paths.ts`: `export const usageFileFor = (id: string): string` → `usageFile()` for `default`; else `join(stateDir(), \`claude-limits-${id with [^A-Za-z0-9_-] as _}.json\`)`.
  - The status line saves usage to `usageFileFor(id)`, `id` = `default` when the folder is the default one (no config read), else the listed profile's id; a folder no profile has: usage not saved. Its stdout and context files are unchanged, and it never writes `config.json` (`loadProfiles` only reads). The hook writes `config.json` only where it did before (`loadConfig` on a first run).

- [ ] **Step 1: Write the failing tests** (sandbox; `home = box.env.USERPROFILE`; `runHook(box, input, pane, extraEnv)` gains an env argument):

```ts
test('every spelling of the default folder reports default, and the brief is as before', async () => {
  const variants = [undefined, join(home, '.claude'), `${join(home, '.claude')}${sep}`, `${home}/.claude/`, '~/.claude',
    ...(process.platform === 'win32' ? [flipDriveCase(join(home, '.claude'))] : [])]
  for (const v of variants) {
    const out = await runHook(box, sessionStart('s1'), 'p1', v === undefined ? {} : { CLAUDE_CONFIG_DIR: v })
    expect(out).toBe(context('SessionStart', brief(normalizeConfig({ language: 'en' }), cardOf(box, 's1'), box.dir)))
    expect(cardOf(box, 's1')?.profile).toBe('default')
    expect(sameDir(String(cardOf(box, 's1')?.profileDir), join(home, '.claude'))).toBe(true)
  }
})
test('a work session reports work; a folder no profile has keeps the folder and no id', async () => {
  // home/.claude-work/settings.json exists
  await runHook(box, sessionStart('s2'), 'p1', { CLAUDE_CONFIG_DIR: join(home, '.claude-work') })
  expect(cardOf(box, 's2')).toMatchObject({ profile: 'work' })
  await runHook(box, sessionStart('s3'), 'p1', { CLAUDE_CONFIG_DIR: join(box.dir, 'odd') })
  expect(cardOf(box, 's3')?.profile).toBeUndefined()
  expect(cardOf(box, 's3')?.profileDir).toBe(join(box.dir, 'odd'))
})
test('outside a herdr pane nothing is written; an unchanged profile is not written again', async () => { /* no pane → no card; two UserPromptSubmit with the same env → updatedAt unchanged */ })
```
`test/entrypoints/statusline.test.ts`:
```ts
test('usage goes to its profile: default as before, work in its own file, an unknown folder nowhere; the line is the same', async () => {
  // runs with CLAUDE_CONFIG_DIR unset, join(home,'.claude-work') (folder with settings.json), join(box.dir,'odd'); HERDR_PANE_ID set
  expect(plain(out.stdout)).toBe('ctx 8% · 5h 24% · 7d 41%')                       // each time
  expect(existsSync(join(state, 'claude-limits-latest.json'))).toBe(true)          // after the unset run
  expect(readJson(join(state, 'claude-limits-work.json')).fiveHour.usedPercentage).toBe(23.5)
  // after the 'odd' run in a fresh sandbox: no claude-limits-*.json at all
  expect(existsSync(join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json'))).toBe(false)
  // with HERDR_PANE_ID the card abc-123 has profile 'work' after the work run; without it no card is written (today's test)
})
```

- [ ] **Step 2: Run** `bun test test/entrypoints/hook.test.ts test/entrypoints/statusline.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces (one card write per hook run, merged with the writes it already makes).
- [ ] **Step 4: Run** both → PASS; `bun test` → green; `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/hook.ts src/entrypoints/statusline.ts src/adapters/paths.ts test/entrypoints/hook.test.ts test/entrypoints/statusline.test.ts
git commit -m "Report each session's Claude profile from the hooks and the status line, and keep usage per profile"
```

### Task 4: Each session's records from its own profile

**Spec:** "Which profile a session is in" (reading records, unknown folder, no card, hidden profile), "The `board` command and the API" (within its own profile).

**Files:**
- Create: `src/adapters/profile-homes.ts`
- Modify: `src/services/deps.ts`, `src/services/board.ts`, `src/server/board-state.ts`, `src/server/routes/session.ts`, `src/services/launch/launches.ts`, `src/entrypoints/cli.ts`
- Test: `test/adapters/profile-homes.test.ts`, `test/server/profiles.test.ts`, `test/entrypoints/cli.test.ts`

**Interfaces:**
- Consumes: `createClaudeHome`, `ClaudeHome`, `LiveSession` (`claude-home.ts`); Task 1 `sessionProfile`, `profileSet`, `mergeProfiles`, `shownProfiles`; Task 2 `findProfileDirs`, `inheritedProfileDir`.
- Produces:
  ```ts
  // adapters/profile-homes.ts
  export interface LiveHit { session: LiveSession; home: ClaudeHome }
  export interface ProfileHomes {
    /** One ClaudeHome per folder (by normDir), made on first use. */
    forDir(dir: string): ClaudeHome
    /** Running sessions in every folder given, each with the home it was found in. */
    liveSessions(dirs: readonly string[]): Map<string, LiveHit>
    /** Recent session folders of the given homes, deduplicated (sameDir), first home first. */
    recentFolders(dirs: readonly string[], limit?: number): Promise<string[]>
  }
  export function createProfileHomes(): ProfileHomes
  // services/deps.ts
  export interface Deps {
    cfg: Config
    claude: ClaudeHome          // the inherited profile's home: homes.forDir(inheritedProfileDir())
    homes: ProfileHomes
    profiles(): ProfileSet      // profileSet(mergeProfiles(cfg.profiles, findProfileDirs(), homedir(), inheritedDir).list, inheritedDir); recomputed when cfg.profiles changes or 60 s passed
    wake: SleepProvider
    log: (text: string) => void
  }
  ```
  `collect`: registries of every profile in the list (shown and hidden) plus the inherited folder; each item gets `...sessionProfile(card, set.list)` and reads its transcript, title and helpers from the home of `card.profileDir`, else the home whose registry has the session, else the first of the inherited and listed homes whose `transcriptPath` finds it; `claudeRoot` = that home's `root` (or `null`). `board-state` and the session detail leave `claudeRoot` out of what they send, as they do `transcript`. History search uses `deps.homes.forDir(item.claudeRoot ?? deps.claude.root)`. Launch options' `recent` = `deps.homes.recentFolders(shown profiles' dirs)`. `cli.ts` uses `deps.claude` (its own env's profile) for its own session's name and folder, and `call-report` looks the session up in every listed profile's registry.

- [ ] **Step 1: Write the failing tests**

`test/adapters/profile-homes.test.ts`:
```ts
test('running sessions of every profile, each with its home; one home per folder', () => {
  // homes A and B: sessions/1.json { sessionId: 'sa', kind: 'interactive', pid: process.pid, name: 'A one' }, sessions/2.json { sessionId: 'sb', ... }
  const homes = createProfileHomes()
  const live = homes.liveSessions([A, B])
  expect([live.get('sa')?.home.root, live.get('sb')?.home.root]).toEqual([A, B])
  expect(homes.forDir(`${A}${sep}`)).toBe(homes.forDir(A.toUpperCase()))
})
```
`test/server/profiles.test.ts` (sandbox home: `.claude` and `.claude-work`, each with `settings.json`; config profiles default and work shown; fake herdr panes s1..s4 in `box.dir`; work's `sessions/` has s1 named "Work one" and `projects/<folder>/s1.jsonl` with an ai-title "Invoices"; cards: s1 `profileDir` = work, s2 `profileDir` = `D:\old\.claude-x`, s3 none, s4 `profileDir` = work and `profileWant: 'default'`):
```ts
test('items carry their profile; records come from that profile; hidden ones keep their title', async () => {
  const items = (await board()).items
  expect(byKey(items, 's1')).toMatchObject({ profile: 'work', name: 'Work one', title: 'Invoices' })
  expect(byKey(items, 's2')).toMatchObject({ profile: null, profileFolder: 'D:\\old\\.claude-x' })
  expect(byKey(items, 's3').profile).toBeNull()
  expect(byKey(items, 's4').profileWanted).toBe('default')
  expect(items.some(i => 'claudeRoot' in i)).toBe(false)
  // POST /api/profiles { op: 'update', id: 'work', hidden: true }, refresh: s1 still { profile: 'work', title: 'Invoices' }
})
```
`test/entrypoints/cli.test.ts`: `test('board remind in a work session names it from the work registry', …)` → runner `cli` with env `CLAUDE_CODE_SESSION_ID=s1`, `CLAUDE_CONFIG_DIR=<home>/.claude-work` → the stored entry's `name` is `'Work one'`; the printed line matches the phase-1 format.

- [ ] **Step 2: Run** `bun test test/adapters/profile-homes.test.ts test/server/profiles.test.ts test/entrypoints/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green; `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/adapters/profile-homes.ts src/services/deps.ts src/services/board.ts src/server/board-state.ts src/server/routes/session.ts src/services/launch/launches.ts src/entrypoints/cli.ts test/adapters/profile-homes.test.ts test/server/profiles.test.ts test/entrypoints/cli.test.ts
git commit -m "Read each session's records from its own profile's Claude folder"
```

### Task 5: Install and the setup check per profile

**Spec:** "Install and setup check".

**Files:**
- Create: `src/adapters/hook-settings.ts`, `src/services/profiles.ts`
- Modify: `src/entrypoints/install.ts`, `src/adapters/setup-facts.ts`, `src/core/setup.ts`, `src/server/routes/settings.ts`, `src/server/app.ts`, `src/core/i18n/profile-strings.ts`, `README.md` (Setup)
- Test: `test/entrypoints/install.test.ts`, `test/core/setup.test.ts`, `test/server/profiles.test.ts`

**Interfaces:**
- Consumes: `planSettings`, `ourCommands`, `commandsOf`, `InstallPaths` (`core/install-plan.ts`); `boardFiles` (`core/setup.ts`); Task 2 `loadProfiles`, `inheritedProfileDir`; Task 4 `Deps.profiles`.
- Produces:
  ```ts
  // adapters/hook-settings.ts
  export interface SettingsRead { file: string; text: string | null; settings: unknown; error: string }
  export function readSettings(dir: string): SettingsRead                 // error: '' or 'not valid JSON (position N)' as gatherFacts words it today
  export interface InstallOutcome { file: string; ok: boolean; error: string; statusLineSet: boolean; toast: boolean }
  /** planSettings into <dir>/settings.json, backup to settings.json.bak-agent-board first; a folder that is not there is created only with `create`. */
  export function installInto(dir: string, paths: InstallPaths, opts?: { toast?: boolean | undefined; create?: boolean }): InstallOutcome
  /** Both board events have a hook of this copy in <dir>/settings.json; cached by the file's mtime. */
  export function hooksInstalled(dir: string, files: Pick<InstallPaths, 'hook' | 'statusline' | 'toast'>): boolean
  // services/profiles.ts
  export function installProfile(deps: Pick<Deps, 'profiles'>, id: string): EditResult   // shown profiles only
  // core/setup.ts
  export interface ProfileSettings { id: string; title: string; dir: string; exists: boolean; settingsFile: string; settings: unknown; settingsError: string }
  // SetupFacts.profiles?: ProfileSettings[]; GatherOptions.profiles?: Profile[]
  ```
  - `install.ts`: profiles = `shownProfiles(loadProfiles({ shownDir: inheritedProfileDir() }))`; every one's `settings.json` is parsed first, and one that does not parse stops the install before anything is written (today's message, naming that file, exit 1). Shims once, then `installInto` per profile (`create: true` for `default` only, as today's `mkdirSync`), printing today's `hooks:` and `status line:` lines per profile; a missing non-default folder prints `skipped <dir>: the folder is not there`. With one profile the output is today's.
  - `gatherFacts`: `profiles` from the option, else the shown profiles of `mergeProfiles(cfg.profiles, findProfileDirs(home), home, inheritedProfileDir(env, home)).list`; `facts.profiles` one `ProfileSettings` each; the top-level `settingsFile`/`settings`/`settingsError` stay those of the first profile.
  - `checkSetup`: with zero or one entry in `facts.profiles`, exactly today's checks; with more, the `hooks` and `statusline` checks per profile with ids `hooks:<id>`/`statusline:<id>` and titles `t('setup.inProfile', { profile: title, check: <today's title> })` = "{profile}: {check}", and a profile whose folder is not there gives `{ id: 'profile:<id>', level: 'warn', title: t('setup.profile.missing', { profile, dir }) }` = "{profile}: its folder {dir} is not there".
  - `profilesRoute` takes `install: (id: string) => EditResult`: body `{ op: 'install', id }` goes to it (`app.ts` passes `id => installProfile(deps, id)`), other ops to `editProfiles`. `installProfile` errors: hidden → `err.profile.hiddenInstall` `{title}` "Show {title} first: the board installs only into shown profiles"; missing folder → `err.profile.noFolder`.

- [ ] **Step 1: Write the failing tests**
```ts
// test/entrypoints/install.test.ts
test('install writes into every shown profile and touches no hidden one', async () => {
  // home: .claude, .claude-work, .claude-gamedev, each settings.json { model: 'x' }; config profiles: default and work shown, gamedev hidden
  const { code, stderr } = await install(box)
  expect(code).toBe(0)
  for (const p of ['.claude', '.claude-work']) {
    expect(JSON.parse(read(home, p, 'settings.json')).hooks.SessionStart.at(-1)).toEqual(ours)
    expect(read(home, p, 'settings.json.bak-agent-board')).toBe(before)
  }
  expect(read(home, '.claude-gamedev', 'settings.json')).toBe(before)
  expect(readdirSync(join(home, '.claude-gamedev'))).toEqual(['settings.json'])
  expect(readdirSync(join(home, '.claude-work')).sort()).toEqual(['settings.json', 'settings.json.bak-agent-board'])
})
test('one shown profile’s settings.json that does not parse: nothing is written anywhere', async () => { /* work's is '{'; exit 1; default's file and folder unchanged; no shims */ })
test('a shown profile whose folder is gone is skipped, saying so', async () => { /* stdout has `skipped <dir>: the folder is not there` */ })
// test/core/setup.test.ts
test('one profile: the same checks as before; two: hooks and status line per profile, by name', () => {
  expect(checkSetup({ ...FACTS, profiles: [one] })).toEqual(checkSetup(FACTS))
  const checks = checkSetup({ ...FACTS, profiles: [privateOk, workWithoutHooks] })
  expect(checks.find(c => c.id === 'hooks:work')).toMatchObject({ level: 'error', title: expect.stringMatching(/^Work: /) })
  expect(checks.find(c => c.id === 'hooks:default')?.level).toBe('ok')
})
// test/server/profiles.test.ts
test('Install from the board writes a shown profile’s hooks and refuses a hidden one', async () => { /* 200, work settings.json has our hook; gamedev → 409 with the hiddenInstall text */ })
```
- [ ] **Step 2: Run** `bun test test/entrypoints/install.test.ts test/core/setup.test.ts test/server/profiles.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces; README "Setup": the install action writes into every shown profile's `settings.json`, hidden ones are left alone, the setup check reports per profile.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green (the existing install and setup tests unchanged); `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/adapters/hook-settings.ts src/services/profiles.ts src/entrypoints/install.ts src/adapters/setup-facts.ts src/core/setup.ts src/server/routes/settings.ts src/server/app.ts src/core/i18n/profile-strings.ts README.md test/entrypoints/install.test.ts test/core/setup.test.ts test/server/profiles.test.ts
git commit -m "Install the hooks into every shown profile and check each one"
```

### Task 6: spawn-agent starts in the parent's profile or the one asked for

**Spec:** "Starting a session in a profile" (spawn-agent, `--env`, args, inherited starts, `--profile`, no silent fallback).

**Files:**
- Create: `src/adapters/profile-panes.ts`
- Modify: `src/core/profiles.ts`, `src/core/launch/spawn-args.ts`, `src/core/launch/launcher-command.ts`, `src/adapters/herdr.ts`, `src/adapters/paths.ts`, `src/services/launch/spawn-agent.ts`, `src/entrypoints/spawn-agent.ts`, `README.md` (spawn-agent)
- Test: `test/core/profiles.test.ts`, `test/core/spawn-args.test.ts`, `test/adapters/profile-panes.test.ts`, `test/entrypoints/spawn-agent.test.ts`

**Interfaces:**
- Consumes: Task 1 `Profile`, `profileForDir`, `resolveProfileDir`, `defaultProfileDir`; Task 2 `loadProfiles`, `Env`; `writeCard`, `updateJson`.
- Produces:
  ```ts
  // core/profiles.ts
  export type SpawnEnv = { ok: true; configDir: string | null; profile: Profile | null } | { ok: false; error: 'missing' | 'hidden' | 'unknown'; detail: string }
  export function spawnEnv(o: Pick<SpawnOptions, 'profile' | 'configDir' | 'keepEnv'>, own: string | undefined, list: readonly Profile[], home: string, platform?: string): SpawnEnv
  /** herdr said it does not take --env (older than 0.9.5). */
  export function envRejected(message: unknown): boolean   // /unexpected argument '--env'|unrecognized (option|argument) '?--env|unknown (option|flag|argument).*--env/i
  // core/launch/spawn-args.ts: SpawnOptions += profile?: string; configDir?: string; keepEnv?: boolean
  //   --profile <id>, --config-dir <dir>, --keep-env (a flag, no value; -KeepEnv too); more than one of them throws
  //   'give one of --profile, --config-dir and --keep-env'; USAGE gains "[--profile <id>]"
  // adapters/herdr.ts
  export async function tabCreate(workspace: string, cwd: string, label: string, env?: Readonly<Record<string, string>>): Promise<string>
  export async function workspaceCreate(cwd: string, label: string, env?: Readonly<Record<string, string>>): Promise<{ id: string; tab: string | null; pane: string | null }>
  //   args: today's, with '--env', 'KEY=VALUE' per entry right before '--no-focus'; no env: exactly today's args
  // adapters/paths.ts
  export const profilePanesFile = (): string    // join(stateDir(), 'profile-panes.json')
  // adapters/profile-panes.ts  ({ "<pane>": { "profile": "<id>", "at": <ms> } }, unknown fields kept)
  export function recordProfilePane(pane: string, profile: string): void
  export function profilePanes(): Map<string, string>
  export function forgetProfilePanes(live: ReadonlySet<string>): void
  // services/launch/spawn-agent.ts
  export async function spawnAgent(o: SpawnOptions, opts?: { claude?: string[]; log?: (text: string) => void; profiles?: Profile[]; env?: Env; home?: string }): Promise<SpawnResult>
  ```
  `spawnEnv` rules: `keepEnv` → `configDir: null`, profile of the own folder; `configDir` → it, as given (the board checked it); `profile` → missing/hidden refused, else its `dir`; none (an agent's own start) → own folder = `resolveProfileDir(own, home)`; no listed profile has it → `unknown` (detail: the folder); the default folder → `configDir: null` (herdr's env is taken to be the default profile's, as on every machine today); any other → its `dir` (hidden profiles included).
  `spawnAgent`: refuses before any herdr call with these exact messages: missing `no profile "<id>": see the board's Settings → Profiles`; hidden `the profile "<id>" is hidden: show it on the board first`; unknown `this session's Claude folder <dir> is not a profile the board knows: pass --profile <id>`; a `configDir` that is not a folder `the profile folder <dir> is not there`. With a `configDir`: the tab gets `{ CLAUDE_CONFIG_DIR: configDir }`; a herdr answer that `envRejected` → `herdr cannot set CLAUDE_CONFIG_DIR for the new tab (--env needs herdr 0.9.5 or newer): nothing was started`; the new pane is recorded (`recordProfilePane(pane, profile.id)`) before `pane run`; with `--pane` and a `configDir`, the pane must be recorded for that profile, else `--pane <pane> was not opened in profile <id>: leave out --pane to get a new tab`. The typed command is `[...claude, ...(profile?.args ?? []), '--session-id', id]`. With `--session-id`, the child's card gets `profileWant: profile.id` whenever the profile is known, a start that keeps the env included (herdr's env may point to another profile: the hooks' report then shows the session in the wrong profile). `failureKind` maps a message containing `CLAUDE_CONFIG_DIR` to `'launcher'`. The entrypoint passes `loadProfiles()`, `process.env`, `homedir()`.

- [ ] **Step 1: Write the failing tests**
```ts
// test/core/profiles.test.ts — spawnEnv table (list: default shown, work shown, gamedev hidden; home H)
expect(spawnEnv({}, undefined, L, H)).toEqual({ ok: true, configDir: null, profile: DEFAULT })
expect(spawnEnv({}, 'c:/users/me/.claude/', L, H)).toEqual({ ok: true, configDir: null, profile: DEFAULT })
expect(spawnEnv({}, '~/.claude-work', L, H)).toEqual({ ok: true, configDir: WORK.dir, profile: WORK })
expect(spawnEnv({}, GAMEDEV.dir, L, H)).toMatchObject({ ok: true, configDir: GAMEDEV.dir })
expect(spawnEnv({}, 'D:\\odd', L, H)).toEqual({ ok: false, error: 'unknown', detail: 'D:\\odd' })
expect(spawnEnv({ profile: 'gamedev' }, undefined, L, H)).toMatchObject({ ok: false, error: 'hidden' })
expect(spawnEnv({ profile: 'nope' }, undefined, L, H)).toMatchObject({ ok: false, error: 'missing' })
expect(spawnEnv({ keepEnv: true }, WORK.dir, L, H)).toEqual({ ok: true, configDir: null, profile: WORK })
expect(spawnEnv({ configDir: 'C:\\x' }, undefined, L, H)).toEqual({ ok: true, configDir: 'C:\\x', profile: null })
expect(envRejected("error: unexpected argument '--env' found")).toBe(true)
expect(envRejected('no such pane')).toBe(false)
// test/core/spawn-args.test.ts
expect(parseArgs(['--name', 'A', '--cwd', 'x', '--profile', 'work'])).toMatchObject({ profile: 'work' })
expect(parseArgs(['-Name', 'A', '-Cwd', 'x', '-KeepEnv'])).toMatchObject({ keepEnv: true })
expect(() => parseArgs(['--name', 'A', '--cwd', 'x', '--profile', 'w', '--keep-env'])).toThrow('give one of --profile, --config-dir and --keep-env')
// test/adapters/profile-panes.test.ts — record two, read both, forget all but one (isolatedHome)
```
`test/entrypoints/spawn-agent.test.ts` (sandbox home with `.claude`, `.claude-work`, `.claude-gamedev`; config profiles default and work shown, gamedev hidden, work `args: ['--model', 'sonnet']`; `STATE` as today):
```ts
test('unset, ~/.claude, a trailing slash and another drive case start the child as before, without --env', …)
  // each variant: the call list equals today's first test's list; no profile-panes.json
test('an agent in a work session starts its helper in work: --env on the tab, the pane recorded, work’s args, the card wants work', …)
  // first call: ['tab','create','--workspace','wA','--cwd',dir,'--label','Acme invoices','--env',`CLAUDE_CONFIG_DIR=${workDir}`,'--no-focus']
  // `pane run wA:p9 claude --model sonnet --session-id <sid>`; profile-panes.json { 'wA:p9': { profile: 'work' } }; card <sid> profileWant 'work'
test('a hidden parent profile is kept: gamedev gets its --env', …)
test('refused before herdr is asked: a folder the board does not know, --profile nope, --profile gamedev, a profile folder that is gone', …)
  // exit 1, stderr has the message, box.calls() empty
test('herdr that refuses --env: nothing was started', …)
  // state 'tab create': { error: "unexpected argument '--env' found" }; exit 1; stderr has 'nothing was started'; no 'pane run' call
test('--keep-env leaves the tab as herdr makes it, even from a work env; --config-dir sets it as given', …)
test('--pane with a profile takes only a pane recorded in it', …)
```
- [ ] **Step 2: Run** `bun test test/core/profiles.test.ts test/core/spawn-args.test.ts test/adapters/profile-panes.test.ts test/entrypoints/spawn-agent.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces; README "spawn-agent": `--profile <id>`, that a started agent's helpers keep its profile, and the refusals.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green (today's spawn-agent and launch tests keep their call lists); `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/adapters/profile-panes.ts src/core/profiles.ts src/core/launch/spawn-args.ts src/core/launch/launcher-command.ts src/adapters/herdr.ts src/adapters/paths.ts src/services/launch/spawn-agent.ts src/entrypoints/spawn-agent.ts README.md test/core/profiles.test.ts test/core/spawn-args.test.ts test/adapters/profile-panes.test.ts test/entrypoints/spawn-agent.test.ts
git commit -m "Start spawn-agent sessions in the parent's profile or the one asked for"
```

### Task 7: Board launches in the chosen profile

**Spec:** "Starting a session in a profile" (the env rule for every launcher, `launch.command` placeholders, args, inherited starts, after-start check, no silent fallback); call 1.

**Files:**
- Modify: `src/core/profiles.ts`, `src/core/types.ts` (`LaunchView`), `src/core/launch/launcher-command.ts`, `src/services/launch/request.ts`, `src/services/launch/launcher.ts`, `src/services/launch/run.ts`, `src/services/launch/launches.ts`, `src/core/i18n/profile-strings.ts`, `test/support/fake-launcher.ts`, `README.md` (New sessions)
- Test: `test/core/profiles.test.ts`, `test/core/launcher-command.test.ts`, `test/services/launch.test.ts`

**Interfaces:**
- Consumes: Task 1 `configDirFor`, `shownProfiles`, `ProfileSet`; Task 4 `Deps.profiles`; Task 6 `tabCreate`/`workspaceCreate` env, `envRejected`, `recordProfilePane`, spawn-agent `--keep-env`/`--config-dir`.
- Produces:
  ```ts
  // core/profiles.ts
  export type LaunchTarget = { ok: true; profile: Profile; configDir: string | null }
    | { ok: false; error: 'choose' | 'hidden' | 'missing' | 'parent' | 'unknownParent'; id: string }
  export function launchTarget(asked: string | undefined, parent: Pick<Item, 'name' | 'profile'> | null, set: ProfileSet): LaunchTarget
  // core/types.ts: LaunchView += profile?: string; parent?: string | null
  // core/launch/launcher-command.ts: PLACEHOLDERS += 'profile', 'profileDir'
  // request.ts — body += profile?: string; parent?: string (the key of the card it was started from)
  export interface LaunchRequest { /* today's */ profile: string; profileDir: string; configDir: string | null; parent: string | null; profileArgs: string[] }
  export function checkRequest(body: unknown, opts: { categories?: Set<string> | null; profiles: ProfileSet; items?: Item[] }): Promise<CheckResult>
  // launcher.ts: LaunchContext += profile, profileDir, configDir, profileArgs (readonly)
  ```
  The existing request test now passes a one-profile set (a temp folder as home) and expects the new fields too: `profile: 'default'`, `profileDir`, `configDir: null`, `parent: null`, `profileArgs: []`.
  `launchTarget`: a parent with a known profile (`parent.profile`, or the only profile when the list has one) fixes the target, hidden or not, and a different `asked` is `parent`; a parent whose profile is not known needs `asked` (`unknownParent`); without a parent, `asked` must be a listed (`missing`), shown (`hidden`) profile, and no `asked` takes the only shown profile, else `choose`. `configDir = configDirFor(profile, set.inheritedDir)`. A `parent` key not among `items` counts as a parent whose profile is not known.
  `checkRequest` fails with `field: 'profile'` and: `launch.err.profileChoose` "Choose a profile"; `launch.err.profileHidden` `{title}` "The profile {title} is hidden: show it in Settings → Profiles"; `err.profile.missing`; `launch.err.profileParent` `{name, title}` "A session started from {name} runs in its profile, {title}"; `launch.err.profileUnknown` `{name}` "The profile of {name} is not one the board knows: choose one"; and, only when `configDir` is set and it is not a folder (`statOf`), `launch.err.profileFolder` `{title, path}` "The folder of the profile {title} is not there: {path}". `profileArgs` = the profile's `args` (strings only).
  Launchers: herdr's (`launch.agent`) passes `{ CLAUDE_CONFIG_DIR: configDir }` to `tabCreate` when set, records the pane, and appends `profileArgs` before `--session-id` for kind `claude`; `run.ts` does the same with `workspaceCreate` for a new workspace and records its root pane; an `envRejected` herdr error becomes `LaunchError(t('launch.err.env', { dir }), 'launcher')` = "herdr cannot set CLAUDE_CONFIG_DIR={dir} for the new tab (--env needs herdr 0.9.5 or newer): update herdr, or start this session yourself". `launch.command` gets `{profile}` (the id) and `{profileDir}` (the folder, set or inherited) and, when set, `CLAUDE_CONFIG_DIR` in its process env; the board never records its panes. The board's spawn-agent gets `--keep-env` when `configDir` is null, else `--config-dir <configDir>`. The card a launch writes (`events.session`, `observe`) gets `profileWant: l.profile`, and `closeTab`'s "lane only" check counts `profileWant` among the board's own fields (`key`, `category`, `updatedAt`); `view()` adds `profile` and `parent`. `launches.start` passes `deps.profiles()` and `items`. `options()` is unchanged.

- [ ] **Step 1: Write the failing tests**
```ts
// test/core/profiles.test.ts — launchTarget (set: default inherited and shown, work shown, gamedev hidden)
expect(launchTarget(undefined, null, SET)).toEqual({ ok: false, error: 'choose', id: '' })
expect(launchTarget('work', null, SET)).toEqual({ ok: true, profile: WORK, configDir: WORK.dir })
expect(launchTarget('default', null, SET)).toMatchObject({ ok: true, configDir: null })
expect(launchTarget('gamedev', null, SET)).toMatchObject({ ok: false, error: 'hidden' })
expect(launchTarget('nope', null, SET)).toMatchObject({ ok: false, error: 'missing' })
expect(launchTarget(undefined, { name: 'G', profile: 'gamedev' }, SET)).toEqual({ ok: true, profile: GAMEDEV, configDir: GAMEDEV.dir })
expect(launchTarget('work', { name: 'G', profile: 'gamedev' }, SET)).toMatchObject({ ok: false, error: 'parent' })
expect(launchTarget(undefined, { name: 'X', profile: null }, SET)).toMatchObject({ ok: false, error: 'unknownParent' })
expect(launchTarget('work', { name: 'X', profile: null }, SET)).toMatchObject({ ok: true, profile: WORK })
expect(launchTarget(undefined, null, ONE_SHOWN)).toEqual({ ok: true, profile: DEFAULT, configDir: null })
expect(launchTarget('default', null, profileSet(LIST, 'c:/users/me/.claude/'))).toMatchObject({ ok: true, configDir: null })
// test/core/launcher-command.test.ts
expect(commandArgs(['x', '{profile}', '{profileDir}'], { profile: 'work', profileDir: 'C:\\w' }).args).toEqual(['work', 'C:\\w'])
```
`test/services/launch.test.ts` (servers as today, the sandbox home given `.claude` and `.claude-work`, config profiles default and work shown, gamedev hidden, work `args: ['--model', 'sonnet']`):
```ts
test('a launch into the board’s own profile is as before however the board’s env spells it: no --env anywhere', …)
  // serveBoard extra env CLAUDE_CONFIG_DIR: unset, `${home}\\.claude\\`, `${home}/.claude/`, the drive letter's case flipped (win32);
  // body without profile, one shown → today's calls; every existing launch test also asserts no call has '--env'
test('through herdr into work: --env on the tab, the pane recorded, work’s args, the card wants work', …)
  // ['tab','create','--workspace','wA','--cwd',dir,'--label','Alpha job','--env',`CLAUDE_CONFIG_DIR=${workDir}`,'--no-focus'];
  // agent start ends ['--model','sonnet','--session-id',sid]; card sid { category, profileWant: 'work' }; profile-panes.json has wA:p9 'work'
test('a new workspace for work is made with the env, and the board’s spawn-agent gets --config-dir and uses its first pane', …)
  // ['workspace','create','--cwd',dir,'--label',label,'--env',`CLAUDE_CONFIG_DIR=${workDir}`,'--no-focus']; spawn-agent's `pane run <root pane>` happens
test('launch.command gets {profile}, {profileDir} and CLAUDE_CONFIG_DIR for work, and the inherited env for default', …)
  // fake-launcher.ts also records configDir: process.env.CLAUDE_CONFIG_DIR ?? null
test('refused before anything runs: two shown and none chosen, hidden, unknown, a folder that is gone', …)
  // 400 { field: 'profile', error: 'Choose a profile' } … ; box.calls() has no 'tab'/'workspace'
test('herdr that refuses --env: the launch fails saying so, and no Claude was started', …)
  // launch state 'failed', kind 'launcher', error starts 'herdr cannot set CLAUDE_CONFIG_DIR='; no 'agent start' call
test('“New here” from a hidden work card starts in work; another profile than its own is refused', …)
  // body { parent: 's1' } → --env work; { parent: 's1', profile: 'default' } → 400 'A session started from Work one runs in its profile, Work'
```
- [ ] **Step 2: Run** `bun test test/core/profiles.test.ts test/core/launcher-command.test.ts test/services/launch.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces; README "New sessions": the profile rule (the board's own profile keeps the environment; any other gets `CLAUDE_CONFIG_DIR` through `herdr --env`, herdr 0.9.5+), `{profile}`/`{profileDir}`, the refusals, the "wrong profile" check.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green; `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/core/profiles.ts src/core/types.ts src/core/launch/launcher-command.ts src/services/launch/request.ts src/services/launch/launcher.ts src/services/launch/run.ts src/services/launch/launches.ts src/core/i18n/profile-strings.ts test/support/fake-launcher.ts README.md test/core/profiles.test.ts test/core/launcher-command.test.ts test/services/launch.test.ts
git commit -m "Start board sessions in the chosen profile and refuse what the board cannot be sure of"
```

### Task 8: Wakes, reminders and MokuPilot calls only where the profile is sure

**Spec:** "Waking a sleeping session (herdr-wake)", "MokuPilot calls", "There are no scheduled launches"; calls 2 and 3.

**Files:**
- Modify: `src/core/profiles.ts`, `src/services/actions.ts`, `src/services/mokupilot.ts`, `src/server/routes/session.ts`, `src/services/board.ts`, `src/server/board-state.ts`, `src/core/i18n/profile-strings.ts`, `README.md` (Schedule, MokuPilot)
- Test: `test/core/profiles.test.ts`, `test/services/actions.test.ts`, `test/services/scheduler.test.ts`, `test/services/mokupilot.test.ts`, `test/server/profiles.test.ts`

**Interfaces:**
- Consumes: Task 4 `Deps.profiles`; Task 6 `profilePanes`, `forgetProfilePanes`.
- Produces:
  ```ts
  // core/profiles.ts
  export type WakeCheck = { ok: true } | { ok: false; profile: string }   // the profile's title, else its folder, else t('profile.unknown')
  export function mayWake(item: Pick<Item, 'profile' | 'profileFolder' | 'pane'>, set: ProfileSet, panes: ReadonlyMap<string, string>): WakeCheck
  export function inBoardProfile(item: Pick<Item, 'profile'>, set: ProfileSet): boolean
  // services/mokupilot.ts: CallOptions += profiles?: ProfileSet  (the route passes deps.profiles())
  // services/board.ts: CollectOptions += seen?: (panes: ReadonlySet<string>) => void   // every pane id in herdr's snapshot
  ```
  The session's profile is `item.profile`, or the only profile when the list has one. `mayWake` allows it when that profile is the inherited one, or when `panes.get(item.pane)` is that profile; everything else is refused. `actions.wake` checks before herdr-wake is called and answers `{ ok: false, error: t('err.wakeProfile', { profile }) }` with the spec's text: en "Started outside the board in profile {profile}, so waking could resume it in the wrong account; wake it in herdr where you started it", ru "Запущена вне доски в профиле {profile}: пробуждение может продолжить её не в том аккаунте; разбудите её в herdr, там, где запускали". `focus`, `send` and the scheduler go through `wake`, so a reminder that needs that wake stays due with `why` = that text (the scheduler code is unchanged). `startCall` refuses with `t('mokupilot.err.profile', { board, profile })` = "MokuPilot takes the profile of its running copy, {board}: a call from {profile} would run in the wrong account" before anything starts when `!inBoardProfile`. `board-state` passes `seen: panes => forgetProfilePanes(panes)` on each successful refresh. `profile.unknown` = "unknown profile".

- [ ] **Step 1: Write the failing tests**
```ts
// test/core/profiles.test.ts — mayWake / inBoardProfile (Task 1 fixtures; LIST1_SET = profileSet([DEFAULT], DEFAULT.dir); useLanguage('en'))
expect(mayWake({ profile: 'work', pane: 'p1' }, SET, new Map())).toEqual({ ok: false, profile: 'Work' })
expect(mayWake({ profile: 'work', pane: 'p1' }, SET, new Map([['p1', 'work']]))).toEqual({ ok: true })
expect(mayWake({ profile: 'work', pane: 'p1' }, SET, new Map([['p1', 'default']]))).toEqual({ ok: false, profile: 'Work' })
expect(mayWake({ profile: 'default', pane: 'p1' }, SET, new Map())).toEqual({ ok: true })
expect(mayWake({ profile: null, pane: 'p1' }, SET, new Map())).toEqual({ ok: false, profile: 'unknown profile' })
expect(mayWake({ profile: null, profileFolder: 'D:\\x', pane: 'p1' }, SET, new Map())).toEqual({ ok: false, profile: 'D:\\x' })
expect(mayWake({ profile: null, pane: 'p1' }, LIST1_SET, new Map())).toEqual({ ok: true })
expect([inBoardProfile({ profile: 'default' }, SET), inBoardProfile({ profile: 'work' }, SET)]).toEqual([true, false])
```
```ts
// test/services/actions.test.ts — runner 'send', sleeping item { pane: 'pane1', session: 'expected', profile: 'work' },
// cfg profiles default+work (sandbox home folders), a herdr-wake stand-in counting /wake
test('a session started outside the board in work is not woken: the reason, and herdr-wake never asked', …)
  // { ok: false, error: 'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it' }; wakes === 0
test('a pane the board opened with work’s --env is woken', …)   // profile-panes.json { pane1: { profile: 'work' } } → ok, wakes === 1
// test/services/scheduler.test.ts
test('a reminder that would wake a work session started outside the board is held with the reason', …)
  // sleeper card profileDir = work; after two ticks the entry is still there, pendingSince set, why = that text; no /wake
// test/services/mokupilot.test.ts
test('a call from a session in another profile than the board’s is refused before anything starts', …)
  // startCall(cfg, { agent: 'claude', session: UUID, cwd, transcript: null, profile: 'work' }, { profiles: SET, run }) →
  // { ok: false, error: 'MokuPilot takes the profile of its running copy, Default: a call from Work would run in the wrong account' }; run not called;
  // profile 'default' → run called once
// test/server/profiles.test.ts
test('a pane record herdr no longer has is dropped at the next refresh', …)   // file { gone: …, p1: … }, snapshot pane p1 → only p1 left
```
- [ ] **Step 2: Run** `bun test test/core/profiles.test.ts test/services/actions.test.ts test/services/scheduler.test.ts test/services/mokupilot.test.ts test/server/profiles.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces; README: "Schedule" (held reminders) and the MokuPilot section (calls only from the board's own profile).
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green (today's sleeping-session tests still wake: one profile in their sandbox); `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/core/profiles.ts src/services/actions.ts src/services/mokupilot.ts src/server/routes/session.ts src/services/board.ts src/server/board-state.ts src/core/i18n/profile-strings.ts README.md test/core/profiles.test.ts test/services/actions.test.ts test/services/scheduler.test.ts test/services/mokupilot.test.ts test/server/profiles.test.ts
git commit -m "Refuse wakes, reminders and MokuPilot calls the board cannot keep in the right profile"
```

### Task 9: The profiles in the board payload, and the one-profile page pinned

**Spec:** "Payloads", "Usage" (read side, usagebar per profile), after-start check (the notification), "Testing" (web markup with one profile).

**Files:**
- Modify: `src/core/payload.ts`, `src/server/board-state.ts`, `src/adapters/claude-home.ts`, `src/adapters/herdr.ts`, `web/src/api/client.ts`, `src/core/i18n/profile-strings.ts`
- Create: `test/web/single-profile.test.tsx`
- Test: `test/server/profiles.test.ts`, `test/web/client.test.ts`, `test/web/single-profile.test.tsx`

**Interfaces:**
- Consumes: Task 3 `usageFileFor`; Task 4 `Deps.profiles`; Task 5 `hooksInstalled`; `boardFiles(ROOT)`.
- Produces:
  ```ts
  // core/payload.ts
  export interface BoardProfile {
    id: string; title: string; color: string /* hex */; colorName: string; dir: string
    hidden: boolean
    inherited: boolean        // the board's own environment points to it
    exists: boolean           // its folder is there
    hooks: boolean | null     // the board's hooks are in its settings.json; null for a hidden one
    sessions: number          // items in it now
    limits: BoardLimits | null
  }
  // BoardPayload += profiles?: BoardProfile[] (every profile, shown and hidden, in list order); BoardCategory += profile?: string
  // adapters/claude-home.ts
  export function readUsageFile(file: string, now?: number): LocalUsage   // readUsageCache(dir) = readUsageFile(join(dir, 'claude-limits-latest.json'))
  // adapters/herdr.ts
  export async function notify(title: string, body: string): Promise<void>  // herdr notification show <title> --body <body> --sound request
  // web/src/api/client.ts
  export const isBoardProfile: Guard<BoardProfile>   // id, title, color strings; hidden boolean
  // isBoardPayload also accepts profiles: undefined, or a list of what isBoardProfile accepts
  ```
  A profile's limits: its status-line file (`usageFileFor(id)`, source `statusline`), else `<dir>/herdr-usagebar` (`usagebar`), with today's rules (expired windows left out, `stale` after 30 min). `payload.limits` = the inherited profile's (else `default`'s): on a phase-1 machine exactly today's value. Categories carry `profile` when the config has one. After each refresh, an item with `profileWanted` not warned of yet in this process gets one `notify(t('profile.wrongTitle', { name }), t('profile.wrongBody', { name, want, got }))` ("Wrong profile: {name}" / "{name} was started in {want} but runs in {got}"); a failure is logged. Test fixtures: `test/web/support/board.tsx` `payload()` is unchanged.

- [ ] **Step 1: Write the failing tests**
```ts
// test/server/profiles.test.ts (home .claude and .claude-work; state claude-limits-latest.json and claude-limits-work.json; work's herdr-usagebar too;
// three panes whose cards report default, default and work)
test('the board sends every profile with its usage, sessions, hooks and folder, and the page’s check takes it', async () => {
  const body = await (await fetch(`${url}/api/board`)).json()
  expect(isBoardPayload(body)).toBe(true)
  expect(body.profiles.map(p => [p.id, p.hidden, p.inherited, p.exists, p.sessions])).toEqual([['default', false, true, true, 2], ['work', false, false, true, 1]])
  expect(body.profiles[1].limits.source).toBe('statusline')
  expect(body.limits).toEqual(body.profiles[0].limits)
})
test('a session in the wrong profile: one herdr notification, not one per refresh', …)   // 'notification show' logged once after two refreshes
// test/web/client.test.ts
expect(isBoardPayload({ ...payload(), profiles: [PROFILE] })).toBe(true)
expect(isBoardPayload({ ...payload(), profiles: [{ ...PROFILE, hidden: 'no' }] })).toBe(false)
expect(isBoardPayload({ ...payload(), profiles: 'x' })).toBe(false)
```
`test/web/single-profile.test.tsx` — one test per surface; each renders the same scene twice (as the surface's own parity test renders it) and expects the two `canonical` markups equal. `PHASE1` = `payload({ items, categories, limits: READING })`; `ONE` = the same with `items.map(i => ({ ...i, profile: 'default' }))` and `profiles: [{ id: 'default', title: 'Default', color: '#5856D6', colorName: 'indigo', dir: 'C:\\Users\\me\\.claude', hidden: false, inherited: true, exists: true, hooks: true, sessions: 5, limits: READING }]`; `FOLDERS` = `ONE` plus a hidden `work` profile:
```ts
test('one profile: the board, its lanes and cards are phase 1’s', () => expect(board(ONE)).toBe(board(PHASE1)))
test('one profile: the toolbar is phase 1’s', …)
test('one profile: the usage popover is phase 1’s', …)
test('one profile: the categories panel is phase 1’s', …)
test('several folders, one shown: the board and toolbar are still phase 1’s', …)
```
(The phase-1 render is itself pinned to upstream's page by the existing parity tests, so equality here pins the one-profile page to phase 1. Tasks 10–14 add their surfaces to this file.)
- [ ] **Step 2: Run** `bun test test/server/profiles.test.ts test/web/client.test.ts test/web/single-profile.test.tsx` → FAIL (the single-profile file fails to compile until `BoardProfile` exists).
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green; `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/core/payload.ts src/server/board-state.ts src/adapters/claude-home.ts src/adapters/herdr.ts web/src/api/client.ts src/core/i18n/profile-strings.ts test/server/profiles.test.ts test/web/client.test.ts test/web/single-profile.test.tsx
git commit -m "Send the profiles with the board, warn of a session in the wrong profile, and pin the one-profile page"
```

### Task 10: The profile switch and the profile tag

**Spec:** "What the owner sees" 1, 2, 7; "Which profile a session is in" (unknown folder tag, no tag without a card, hidden profiles under All profiles); after-start check (red warning).

**Files:**
- Modify: `src/core/profiles.ts`, `web/src/state/board-ui.ts`, `web/src/state/BoardProvider.tsx`, `web/src/models/board-view.ts`, `web/src/hooks/useBoardView.ts`, `web/src/components/Toolbar.tsx`, `web/src/components/Card.tsx`, `web/index.html`, `src/core/i18n/profile-strings.ts`, `test/server/routes.test.ts` (the page's links)
- Create: `web/src/models/profiles.ts`, `web/src/components/ProfileSwitch.tsx`, `web/src/components/ProfileTag.tsx`, `web/styles/profiles.css`
- Test: `test/core/profiles.test.ts`, `test/web/profiles.test.tsx`, `test/web/single-profile.test.tsx`

**Interfaces:**
- Consumes: Task 9 `BoardProfile`, `profiles` on the payload; item fields from Task 1.
- Produces:
  ```ts
  // core/profiles.ts (shared with the terminal board, Task 15)
  export type ProfileTag<P> = { kind: 'profile'; profile: P } | { kind: 'unknown'; folder: string } | { kind: 'wrong'; wantId: string; want: P | null }
  export function profileTag<P extends { id: string; hidden: boolean }>(item: Pick<Item, 'profile' | 'profileFolder' | 'profileWanted'>, list: readonly P[], picked?: string): ProfileTag<P> | null
  // web/src/models/profiles.ts
  export type ProfileOption = { id: string; title: string; color: string; n: number }
  export function profileOptions(profiles: BoardProfile[] | undefined, visible: Item[], t: Translator): ProfileOption[] | null   // null with fewer than 2 shown
  export function pickedProfile(picked: string, profiles: BoardProfile[] | undefined): string                                 // 'all' unless a shown profile
  export const profileShown: (picked: string, item: Pick<Item, 'profile'>) => boolean
  export function tagView(tag: ProfileTag<BoardProfile>, t: Translator): { kind: string; text: string; title: string; color: string }
  // web/src/state/board-ui.ts: BoardUi.profile: string ('all' or an id; localStorage 'board.profile'); BoardAction | { type: 'profile'; id: string }
  // ViewOptions += profile: string (filters like the lanes control)
  ```
  `profileTag`: `profileWanted` → `wrong` (always); `profileFolder` → `unknown`; no `profile`, or one the list lacks → null; a known one → shown when it is hidden, or when two or more are shown and `picked` is `all` (default `all`), or when exactly one is shown and it is another; else null. Markup: the switch is `<div className="segmented profiles" id="profiles" role="tablist" aria-label={t('tb.profiles')}>` with a thumb and one `button role="tab" data-id aria-selected style={{'--c': color}}>{title}<span className="n">{n}</span>` per option ("All profiles" first, `profile.all`), right after `<Lanes>`, only when `profileOptions` is not null. The tag is `<span className={`profile-tag ${kind}`} style={{'--c': color}} title={title}>{text}</span>` right after the card's `.name`: text = the profile's title; `unknown` → `t('profile.unknown')` (Task 8) with the folder as its title; `wrong` → `t('profile.wrong', { want })` "Wrong profile: started for {want}" in `var(--red)`. Keys: `tb.profiles` "Profiles", `profile.all` "All profiles". `web/styles/profiles.css` (linked in `index.html` after `helpers.css`) styles `.profiles`, `.profile-tag`, `.profile-tag.unknown`, `.profile-tag.wrong` by class only.

- [ ] **Step 1: Write the failing tests**
```ts
// test/core/profiles.test.ts — profileTag (Task 1 fixtures: L has default and work shown, gamedev hidden)
expect(profileTag({ profile: 'work' }, L)).toEqual({ kind: 'profile', profile: WORK })
expect(profileTag({ profile: 'work' }, L, 'work')).toBeNull()
expect(profileTag({ profile: null }, L)).toBeNull()
expect(profileTag({ profile: null, profileFolder: 'D:\\x' }, L)).toEqual({ kind: 'unknown', folder: 'D:\\x' })
expect(profileTag({ profile: 'default', profileWanted: 'work' }, L)).toEqual({ kind: 'wrong', wantId: 'work', want: WORK })
expect(profileTag({ profile: 'gamedev' }, L, 'work')).toEqual({ kind: 'profile', profile: GAMEDEV })
expect(profileTag({ profile: 'default' }, ONE_SHOWN.list)).toBeNull()
expect(profileTag({ profile: 'work' }, ONE_SHOWN.list)).toEqual({ kind: 'profile', profile: { ...WORK, hidden: true } })
// test/web/profiles.test.tsx (profiles Private #5856D6 and Work #30B0C7 shown; items a default, b work, c none, d unknown folder, e wrong)
test('two shown profiles: the switch after the lanes, All profiles first, each with its count and color', …)
  // texts ['All profiles5', 'Private2', 'Work1'] (a and e are default), data-id ['all','default','work'], aria-selected on 'all'
test('one shown profile: no switch', …)
test('Work picked: only its cards and lanes, no tags; kept as board.profile; a hidden pick reads as All profiles', …)
test('tags on All profiles: each known profile, none without a report, unknown names the folder, wrong profile in red', …)
// test/web/single-profile.test.tsx: ui.profile 'work' left from before, one shown → board and toolbar still phase 1's
```
- [ ] **Step 2: Run** `bun test test/core/profiles.test.ts test/web/profiles.test.tsx test/web/single-profile.test.tsx` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces; add `styles/profiles.css` to the page's links in `test/server/routes.test.ts`.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green (`styles.test.ts`, `style-attributes.test.ts` included); `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/core/profiles.ts src/core/i18n/profile-strings.ts web/src/models/profiles.ts web/src/components/ProfileSwitch.tsx web/src/components/ProfileTag.tsx web/styles/profiles.css web/index.html web/src/state/board-ui.ts web/src/state/BoardProvider.tsx web/src/models/board-view.ts web/src/hooks/useBoardView.ts web/src/components/Toolbar.tsx web/src/components/Card.tsx test/server/routes.test.ts test/core/profiles.test.ts test/web/profiles.test.tsx test/web/single-profile.test.tsx
git commit -m "Show a profile switch and profile tags on the web board"
```

### Task 11: Usage per profile in the pill and its popover

**Spec:** "What the owner sees" 3.

**Files:**
- Modify: `web/src/models/limits.ts`, `web/src/components/Limits.tsx`, `web/src/components/LimitsPop.tsx`, `web/styles/profiles.css`, `src/core/i18n/profile-strings.ts`
- Test: `test/web/limits-profiles.test.tsx`, `test/web/single-profile.test.tsx`

**Interfaces:**
- Consumes: Task 9 `BoardProfile.limits`; `limitInfo`, `LimitInfo` (`models/limits.ts`).
- Produces:
  ```ts
  export interface ProfileUsage { id: string; title: string; color: string; lim: LimitInfo; recent: boolean }   // recent: windows and not stale
  export function profileUsage(profiles: BoardProfile[] | undefined, opts: { connected: boolean; now?: number }): ProfileUsage[] | null   // shown ones; null with fewer than 2 shown
  ```
  With two or more shown: the pill shows, per recent profile, `<span className="limits-profile" style={{'--c': color}}>{title}</span>` then its windows as today, and `limits.unknown` when none is recent; the popover's `#limits-content` holds per shown profile `<section className="limits-for" data-profile={id}><h4 style={{'--c': color}}>{title}</h4>` and today's `LimitsReport` for it, or `<p className="limits-none">{t('limits.noSession')}</p>` ("No session lately") when it has no windows. With one shown: exactly today's markup.

- [ ] **Step 1: Write the failing tests**
```ts
test('the pill: each profile with recent usage, by name and color', …)          // Private 5h 92% 7d 40%, Work left out when stale; texts in order
test('the popover: every shown profile, its windows or "No session lately"', …)  // two sections; Work's has 'No session lately'
test('no recent usage in any profile: "Usage —"', …)
// single-profile.test.tsx: one shown → pill and popover equal phase 1's
```
- [ ] **Step 2: Run** `bun test test/web/limits-profiles.test.tsx test/web/single-profile.test.tsx` → FAIL.
- [ ] **Step 3: Implement** `profileUsage` and the two components per the Interfaces.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green (`limits-pop.test.tsx` unchanged); `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add web/src/models/limits.ts web/src/components/Limits.tsx web/src/components/LimitsPop.tsx web/styles/profiles.css src/core/i18n/profile-strings.ts test/web/limits-profiles.test.tsx test/web/single-profile.test.tsx
git commit -m "Show Claude usage per profile in the pill and its popover"
```

### Task 12: A lane's usual profile

**Spec:** "What the owner sees" 6.

**Files:**
- Modify: `web/src/components/categories/CategoryRow.tsx`, `web/src/components/categories/CategoriesPanel.tsx`, `web/src/models/categories.ts`, `web/styles/profiles.css`, `src/core/i18n/profile-strings.ts`
- Test: `test/web/categories-panel.test.tsx`, `test/web/single-profile.test.tsx`

**Interfaces:**
- Consumes: Task 2 `editCategories` `profile`; Task 9 `BoardCategory.profile`, `BoardProfile`.
- Produces: `export function profileChoices(profiles: BoardProfile[] | undefined): { id: string; title: string }[] | null` (shown ones; null with fewer than 2). `CategoryRowProps`/`CategoryRowViewProps` += `profiles: { id: string; title: string }[] | null`. A configured lane's row, when `profiles` is not null, has `<label className="cat-profile"><span>{t('cat.profile')}</span><select value={c.profile ?? ''}>` with `<option value="">{t('cat.profileNone')}</option>` and one option per shown profile; a change sends `{ op: 'update', id, profile }` through the row's `edit`. An agent's lane (not configured) has none. Keys: `cat.profile` "Usual profile", `cat.profileNone` "None".

- [ ] **Step 1: Write the failing tests**
```ts
test('two shown profiles: a configured lane offers its usual profile; a pick saves it', …)   // select value 'work' for a lane with profile 'work'; change → body { op: 'update', id: 'proj', profile: 'work' }
test('an agent’s lane has no usual profile; one shown profile: no field at all', …)
// single-profile.test.tsx: categories panel equal to phase 1's (already there; must stay green)
```
- [ ] **Step 2: Run** `bun test test/web/categories-panel.test.tsx` → FAIL.
- [ ] **Step 3: Implement** `profileChoices` and the row's field per the Interfaces.
- [ ] **Step 4: Run** `bun test test/web/categories-panel.test.tsx test/web/single-profile.test.tsx` → PASS; `bun test` → green; `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add web/src/components/categories/CategoryRow.tsx web/src/components/categories/CategoriesPanel.tsx web/src/models/categories.ts web/styles/profiles.css src/core/i18n/profile-strings.ts test/web/categories-panel.test.tsx test/web/single-profile.test.tsx
git commit -m "Let a lane have a usual profile in the categories panel"
```

### Task 13: The profile choice in the new-session window

**Spec:** "What the owner sees" 4 (preselection 1–4, Start disabled, chosen profile beside Start); "Inherited starts keep the parent's profile… If the parent's profile is unknown, the board asks".

**Files:**
- Create: `web/src/models/launch-profile.ts`
- Modify: `web/src/models/launch-form.ts`, `web/src/components/launch/launch-window.ts`, `web/src/components/launch/LaunchDialog.tsx`, `web/styles/profiles.css`, `src/core/i18n/profile-strings.ts`
- Test: `test/web/launch-profile.test.ts`, `test/web/launch-dialog.test.tsx`, `test/web/single-profile.test.tsx`

**Interfaces:**
- Consumes: Task 7 request fields `profile`, `parent`, `LaunchView.profile`/`parent`; Task 9 `BoardProfile`, `BoardCategory.profile`; `normDir`.
- Produces:
  ```ts
  // models/launch-profile.ts
  export const LAUNCH_PROFILES = 'board.launch.profiles'      // localStorage: { [normDir(cwd)]: profileId }, newest 50
  export interface ProfilePick { picked: string | null; locked: boolean; offered: boolean }
  export function profileStart(ctx: LaunchContext, s: { profiles: BoardProfile[]; categories: BoardCategory[]; category: string; cwd: string; remembered: Record<string, string> }): ProfilePick
  export function rememberedProfiles(text: string | null): Record<string, string>
  export function rememberProfile(book: Record<string, string>, cwd: string, id: string): Record<string, string>
  export interface ProfileRow { offered: boolean; options: { id: string; title: string; color: string; pressed: boolean }[]; chosen: { title: string; color: string } | null }
  export function profileRow(pick: ProfilePick, profiles: BoardProfile[]): ProfileRow
  // models/launch-form.ts: StartBody += profile?: string; parent?: string; ProblemField += 'profile'; formProblems/goButton take the pick
  // launch-window.ts: LaunchWindowView += profile: ProfileRow; handler pickProfile(id: string)
  ```
  `profileStart`, first match wins: (1) `ctx.item` with a known profile, or `ctx.retry` with one → `locked`, not offered; `ctx.item` without one → nothing picked, offered when the payload has more than one profile; (2) the lane's (`category`) usual profile, if shown; (3) `remembered[normDir(cwd)]`, if shown; (4) nothing. `offered` otherwise = two or more shown. While the user has not picked, (2)–(3) follow the folder and lane as they change. Start stays disabled with title `t('launch.err.profileChoose')` while offered and nothing is picked. `chosen` (a tag beside Start, `<span className="launch-profile" style={{'--c': color}}>{title}</span>` before `.launch-go`) shows when offered or when the locked profile is not the only shown one. The row (`<div className="row profile-row">`, label `t('launch.profile')` "Profile", one chip per shown profile like `.launch-cats`) shows only when offered. The body carries `profile` when offered or locked to a profile that is not the only shown one, and `parent: ctx.item.key` (or the retry's `parent`) whenever it carries a locked profile; a successful start with `profile` remembers it for the folder. With one shown profile and a card in it, the body and the window are exactly today's.

- [ ] **Step 1: Write the failing tests**
```ts
// test/web/launch-profile.test.ts
test('from a card: its profile, locked; a card whose profile is unknown: the choice, nothing picked', …)
test('from a lane’s +: its usual profile; else the folder’s last profile; else nothing', …)
test('a hidden or gone profile is never preselected; remembered profiles keep the newest 50', …)
// test/web/launch-dialog.test.tsx
test('two shown: Start waits for a profile; a pick enables it, shows it beside Start, and goes in the body', …)
test('New here from a Work card: no row, Work beside Start, the body has profile and parent', …)
test('the folder’s last profile is picked next time', …)
// test/web/single-profile.test.tsx: one shown → the window from the toolbar, a lane's + and a card equals phase 1's; the body has no profile or parent
```
- [ ] **Step 2: Run** `bun test test/web/launch-profile.test.ts test/web/launch-dialog.test.tsx test/web/single-profile.test.tsx` → FAIL.
- [ ] **Step 3: Implement** `launch-profile.ts`, then the form, window and dialog changes per the Interfaces.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green (`launch-model.test.ts`, `launch-cards.test.tsx` unchanged); `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add web/src/models/launch-profile.ts web/src/models/launch-form.ts web/src/components/launch/launch-window.ts web/src/components/launch/LaunchDialog.tsx web/styles/profiles.css src/core/i18n/profile-strings.ts test/web/launch-profile.test.ts test/web/launch-dialog.test.tsx test/web/single-profile.test.tsx
git commit -m "Choose the profile in the new-session window"
```

### Task 14: The Profiles panel in the Settings menu

**Spec:** "What the owner sees" 5 and 7; "A session whose folder is not a known profile… the Profiles panel offers to add it"; "Showing a profile later offers Install for it".

**Files:**
- Create: `web/src/components/profiles/ProfilesPanel.tsx`, `web/src/components/profiles/ProfileRow.tsx`
- Modify: `web/src/models/profiles.ts`, `web/src/models/settings-menu.ts`, `web/src/hooks/useSettingsMenu.ts`, `web/src/components/panel/Panel.tsx`, `web/src/components/SidePanels.tsx`, `web/src/App.tsx`, `web/styles/profiles.css`, `src/core/i18n/profile-strings.ts`, `test/web/support/panel-sides.tsx` (if its kinds table needs the new kind)
- Test: `test/web/profiles-panel.test.tsx`, `test/web/settings.test.tsx`, `test/web/single-profile.test.tsx`

**Interfaces:**
- Consumes: Task 2/5 `POST /api/profiles` ops `update`, `add`, `install`; Task 9 `BoardProfile`; item `profileFolder`.
- Produces:
  ```ts
  // models/profiles.ts
  export interface ProfileRowView { id: string; title: string; color: string; dir: string; sessions: string; shown: boolean; missing: boolean; noHooks: boolean }
  export function profileRows(profiles: BoardProfile[], t: Translator): ProfileRowView[]       // noHooks: shown && hooks === false
  export function unknownFolders(items: Item[]): string[]                                      // distinct profileFolder values (sameDir)
  // models/settings-menu.ts: SettingsNow += profiles: boolean; item { id: 'profiles', label: t('set.profiles') } after the 'panel' item when true; SettingPick += { kind: 'profiles' }
  // useSettingsMenu: SettingsDeps += profiles(): boolean (payload profiles longer than 1); openProfiles(): void
  // Panel.tsx: PanelKind += 'profiles' (label 'prof.title'); SidePanels renders <ProfilesPanel> only when the payload has more than one profile
  ```
  The panel (`id="profiles-sheet"`, built like `CategoriesPanel`): one row per profile — its color dot, the title in a text field (blur or Enter sends `{ op: 'update', id, title }`), the folder read-only, `t('prof.sessions', { n })` "{n} session now"/"{n} sessions now", a Shown/Hidden toggle (`prof.shown`/`prof.hidden`) sending `{ op: 'update', id, hidden }`, and `t('prof.missing')` "Folder not found" when `!exists`. Below the rows: per unknown folder an "Add {path}" button (`prof.addUnknown`); "Add a folder somewhere else" (`prof.add`) with a folder field sending `{ op: 'add', dir }`; per shown profile with `hooks === false` a note `t('prof.noHooks', { title })` "The board's hooks are not in {title}'s settings.json: its sessions show no status or title" with an Install button (`prof.install` "Install") sending `{ op: 'install', id }`. Errors toast as the categories panel does. Other keys: `set.profiles` "Profiles…", `prof.title` "Profiles", `prof.about` "The Claude Code folders the board found (CLAUDE_CONFIG_DIR). A hidden profile is left out of the switch, new sessions and Install."

- [ ] **Step 1: Write the failing tests**
```ts
// test/web/settings.test.tsx
test('the Settings menu offers Profiles… only when more than one profile folder is found', …)   // settingsMenu ids with profiles false equal today's list exactly
// test/web/profiles-panel.test.tsx
test('a row per profile: color, name, folder, sessions now, shown or hidden', …)
test('renaming, hiding and showing send the profile’s id', …)        // bodies { op: 'update', id: 'work', title: 'Job' } and { op: 'update', id: 'work', hidden: true }
test('adding a folder somewhere else, and a folder a session reported', …)   // { op: 'add', dir: 'D:\\p\\acme' }; 'Add D:\\old\\.claude-x' from an item's profileFolder
test('a shown profile without the hooks offers Install; a hidden one does not; a gone folder says so', …)
// test/web/single-profile.test.tsx: one folder → the Settings menu's entries equal phase 1's; no #profiles-sheet in the side panels
```
- [ ] **Step 2: Run** `bun test test/web/profiles-panel.test.tsx test/web/settings.test.tsx test/web/single-profile.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the model functions, the menu item and the panel per the Interfaces.
- [ ] **Step 4: Run** the same files → PASS; `bun test` → green (`panel*.test.tsx` unchanged); `bun run check` → clean.
- [ ] **Step 5: Commit**

```bash
git add web/src/components/profiles/ProfilesPanel.tsx web/src/components/profiles/ProfileRow.tsx web/src/models/profiles.ts web/src/models/settings-menu.ts web/src/hooks/useSettingsMenu.ts web/src/components/panel/Panel.tsx web/src/components/SidePanels.tsx web/src/App.tsx web/styles/profiles.css src/core/i18n/profile-strings.ts test/web/support/panel-sides.tsx test/web/profiles-panel.test.tsx test/web/settings.test.tsx test/web/single-profile.test.tsx
git commit -m "Manage the profiles in a panel from the Settings menu"
```

### Task 15: The terminal board's tag and the profiles guide

**Spec:** "What the owner sees" (the terminal board's tag; its filter is the builder's call: none in this phase); "Waking a sleeping session" (the usage guide).

**Files:**
- Modify: `src/tui/state.ts`, `src/tui/app.ts`, `src/tui/render.ts`, `README.md`
- Test: `test/tui/render.test.ts`

**Interfaces:**
- Consumes: Task 10 `profileTag`; Task 4 `Deps.profiles`.
- Produces: `TuiState.profiles: Profile[]` (`[]` from `createState`; `app.ts` sets `deps.profiles().list` on each refresh). `cardLines` and the narrow layout put the tag before the right-hand part: the profile's title painted in its ANSI color (`indigo`→blue, `teal`→cyan, `pink`→magenta, `brown`→yellow, `mint`→green, `cyan`→cyan, `yellow`→yellow), `unknown profile` in gray, `wrong profile` in red. No filter on the terminal board in this phase.

- [ ] **Step 1: Write the failing test** `test('a profile tag with two shown profiles; none with one', …)`: `fixedState()` with `profiles` Private and Work shown and `k1.profile = 'work'` → the plain render of `k1`'s line contains `Work`; with `profiles` = Private only → the render equals today's snapshot.
- [ ] **Step 2: Run** `bun test test/tui/render.test.ts` → FAIL.
- [ ] **Step 3: Implement**; README: a new "## Claude profiles" section — what the board finds and shows, renaming and hiding, the switch and tags, usage per profile, starting in a profile (the env rule, herdr 0.9.5 for `--env`, the refusals, "wrong profile"), `spawn-agent --profile` and helpers keeping their parent's profile, and how to start work sessions so that waking stays safe: from the board, or in a pane whose shell has `CLAUDE_CONFIG_DIR` exported (an alias like `cld-work` sets it for Claude alone, so the board refuses to wake those); MokuPilot calls only from the board's own profile.
- [ ] **Step 4: Run** → PASS (existing snapshots unchanged); `bun test`; `bun run check`.
- [ ] **Step 5: Commit**

```bash
git add src/tui/state.ts src/tui/app.ts src/tui/render.ts README.md test/tui/render.test.ts
git commit -m "Tag sessions by profile on the terminal board and describe profiles in the README"
```

---

## After the last task (the owner, by hand)

The spec's manual run on the owner's machine: `cld` and `cld-work` side by side; starting from the board in each profile; a fork and a helper; a reminder into a work session; waking a work session started from the board, and the board refusing one started with `cld-work`; a MokuPilot call refused from a work session; usage per profile; hiding gamedev. Also check that herdr-wake, resuming a `cld-work` session in a default pane on its own, fails rather than running in the wrong account.
