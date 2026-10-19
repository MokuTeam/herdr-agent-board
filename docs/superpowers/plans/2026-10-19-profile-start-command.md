# agent-board: a Start Command per Claude Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each Claude profile may name the command the board types into a new tab instead of `launch.claude` (`cld-work`, say), edited in the Profiles panel.

**Architecture:** One pure reader in `src/core/launch/spawn-args.ts` (`profileCommand`) turns a profile's `command` into words and checks them by `launch.claude`'s own typing rules (`typingProblem`, which `shellLine` now uses too). spawn-agent puts those words in place of `launch.claude`. The board's request check reads them, only for its own launcher, so a bad command is refused before anything runs, and the launcher's session-id rule sees them. `editProfiles` gains `command`, and the payload carries it to the Profiles panel's new field.

**Tech Stack:** Bun 1.4.3, strict TypeScript, React 19 + react-dom, Biome; herdr CLI.

**Spec:** `docs/superpowers/specs/2026-10-19-profile-start-command-design.md`. Multi-profile spec and plan: `docs/superpowers/specs/2026-10-18-multi-profile-design.md`, `docs/superpowers/plans/2026-10-18-multi-profile.md`. Phase-1 conventions: `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.superpowers/sdd/2026-10-16-ts-bun-react-rework/conventions.md` (read it, never edit it).

## Global Constraints

- Worktree: `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.claude/worktrees/profile-command`, branch `feature/profile-command`. Work only there. Never touch the main checkout one level up: herdr runs the owner's live board from it. Commit locally, never push.
- Phase-1 conventions bind every task:
  - Bun and strict TS (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `.ts`/`.tsx` import extensions, no `any`;
  - React and react-dom only, Biome;
  - layers: core pure; adapters import only core and adapters; services orchestrate; server, tui and entrypoints wire;
  - JSON from disk or network narrowed before use, unknown fields kept on write;
  - Windows first-class, no shell when spawning.
- Web code never imports `src/core/profiles.ts` (it uses `node:path`) nor `src/core/launch/spawn-args.ts`.
- Toolchain (Git Bash): `export PATH="$HOME/.bun/bin:$PATH"`, then `bun test <file>`, `bun test`, `bun run check`. Every task ends with `bun test` green (only the 2 symlink tests may skip) and `bun run check` clean.
- Sandboxes only: tests use temp folders, `isolatedHome()`, `sandbox()` and the other `test/support` fakes. Never run the owner's real herdr or claude, never read or write the real `~/.claude*`, `%APPDATA%\herdr` or `%LOCALAPPDATA%\herdr`, never use port 12422. The owner's machine has `CLAUDE_CONFIG_DIR` set user-wide: no test may depend on it.
- What is typed: `[...(profile.command ?? launch.claude), ...profile.args, '--session-id', <id>]`. `--session-id` is left out when `choosesSession` finds a session option anywhere in that line.
- The command applies to every start that types one: the board's default launcher (spawn-agent, in any profile, the inherited one included), "New here", and agents' own spawn-agent starts. `launch.agent` and `launch.command` never read it, a bad one included. The env rule is unchanged: `--env CLAUDE_CONFIG_DIR=<folder>` for a non-inherited profile, with or without a command.
- One profile shown and no command set (every teammate): byte-for-byte today's behaviour, call lists and page.
- Texts: every new key in English and Russian in `src/core/i18n/profile-strings.ts`; `missingKeys` stays `[]`. New CSS only in `web/styles/profiles.css`, selecting by class only.
- Commit messages: the plain English sentence each task gives, with no prefix, no trailer, no `Co-Authored-By`, and no mention of AI or assistants. The author is the repo's git user. No new file name starts with `claude-`.

## Review Focus

1. **A blank command** (`''`, `'   '`, `null`) is no command: `launch.claude` is typed exactly as today, and a blank field over no command sends nothing. → Task 1 (core, spawn-agent), Task 2 (`commandEdited`).
2. **Runs of spaces in a string** (`'  cld-work   --verbose '`) type `cld-work --verbose`, with no empty words. → Task 1 (core, spawn-agent).
3. **A command that picks its own session** (`cld-work --resume`, `["cld-work", "--continue"]`): no `--session-id` from spawn-agent or from the board, and the board writes no card for an id. → Task 1 (spawn-agent, launch).
4. **A bad command written by hand in config.json:**
   - the board's own launcher refuses it with a 400, before any tab or workspace;
   - `launch.agent` and `launch.command` start as before;
   - an agent's spawn-agent exits 1 before herdr is asked.
   → Task 1 (request, launch, spawn-agent).
5. **A list command** (`["cld-work", "--append-system-prompt", "be brief"]`) shows in the panel as one line. Leaving the field unchanged sends nothing, so the list stays a list. → Task 1 (`commandText`), Task 2 (`commandEdited`).

## Decisions where the spec is silent (the owner can overturn them)

- **Where a bad command is refused.** For the board's own launcher, at the request check (`checkRequest`, 400 on `field: 'profile'`), before a worktree, workspace or tab. spawn-agent checks it again before herdr.
- **Unset vs. invalid.** Unset, `null`, `''` and blank strings are "no command". `[]`, a list with a non-string, or a blank program are refused, as for `launch.claude`.
- **`launch.args`** never follow a profile's command (`launch.args` belong to `launch.claude`).
- **The board's session-id rule** reads the whole line, the profile's `args` included, as spawn-agent's already does.
- **The check's messages** come in the board's language, from profile-strings.ts, wherever they show: toast, launch refusal, spawn-agent's stderr.
- **The placeholder's program** comes from a new optional payload field, `claudeProgram`: `launch.claude`'s program, `claude` when it is unset or invalid. `BoardProfile.command` is optional in the type so today's typed fixtures stay valid; the server always sends it, `''` when none.
- **The panel's display and save.** It shows a list command joined with spaces. A changed field saves a string, trimmed. The hint shows once, under the rows.

---

### Task 1: The start command: its check, spawn-agent, board launches, the edit and the payload

**Spec:** "New profile field", "What is typed", "Where it applies", "Safety"; "Profiles panel" (server side: the op, `''` clears, refused with the check's message as a 409); "The payload"; "One profile shown".

**Files:**
- Modify:
  - core: `src/core/launch/spawn-args.ts`, `src/core/profiles.ts` (the `Profile` field, doc only), `src/core/i18n/profile-strings.ts`, `src/core/payload.ts`;
  - launch: `src/services/launch/spawn-agent.ts`, `src/entrypoints/spawn-agent.ts` (header comment only), `src/services/launch/request.ts`, `src/services/launch/launcher.ts`, `src/services/launch/launches.ts`;
  - edit and payload: `src/adapters/config-file.ts`, `src/server/board-state.ts`, `web/src/api/client.ts`.
- Test: `test/core/spawn-args.test.ts`, `test/core/profiles.test.ts`, `test/adapters/config-file.test.ts`, `test/entrypoints/spawn-agent.test.ts`, `test/services/launch.test.ts`, `test/server/profiles.test.ts`, `test/web/client.test.ts`

**Interfaces:**
- Consumes (existing):
  - `claudeCommand`, `choosesSession`, `shellLine` (`spawn-args.ts`);
  - `Profile`, `spawnEnv`, `launchTarget` (`profiles.ts`);
  - `t` (`src/core/lang.ts`);
  - `launcherFor(spec).kind` (`'builtin'` for the board's spawn-agent);
  - `profilesIn(raw, home).entryOf(p)` in `config-file.ts`.
- Produces:
  ```ts
  // core/launch/spawn-args.ts
  /** What keeps argv from being typed by shellLine's rules: the program starts with a dash, or is no
   *  plain word (/^[\w=:./~+-]+$/, backslash too when win), or an argument holds UNTYPABLE. */
  export type TypingProblem = { why: 'dash' | 'program' | 'chars'; word: string }
  export function typingProblem(argv: readonly string[], win: boolean): TypingProblem | null
  //   shellLine keeps its signature and its exact launch.claude messages, its checks now through typingProblem
  export function profileCommand(value: unknown, win: boolean = process.platform === 'win32'): string[] | null
  export function commandText(value: unknown): string        // string → trimmed; list of strings → joined by ' '; else ''
  export function claudeProgram(setting: unknown, args?: unknown): string  // claudeCommand(...)[0]; 'claude' when it throws
  // core/profiles.ts: Profile += /** typed instead of launch.claude (profileCommand reads it) */ command?: unknown
  //   mergeProfiles is unchanged: its `...e` keeps `command` as written
  // core/payload.ts
  interface BoardProfile { /* today's */ command?: string }      // the server always sends it: commandText, '' for none
  interface BoardPayload { /* today's */ claudeProgram?: string } // claudeProgram(cfg.launch?.claude, cfg.launch?.args)
  // services/launch/request.ts
  interface LaunchRequest { /* today's */ profileCommand: string[] | null }
  function checkRequest(body: unknown, opts: { categories?: Set<string> | null; profiles: ProfileSet; items?: Item[]; typesCommand?: boolean }): Promise<CheckResult>
  // services/launch/launcher.ts
  interface LaunchContext { /* today's */ readonly profileCommand: readonly string[] | null }
  // adapters/config-file.ts: editProfiles { op: 'update', id, command } (see the rules below)
  // web/src/api/client.ts: isBoardProfile accepts command undefined | string; isBoardPayload accepts claudeProgram undefined | string
  ```

**Rules the code must follow:**

- **`profileCommand(value, win)` reads a profile's `command`:**
  - `undefined`, `null`, or a string that is blank once trimmed → `null`.
  - A string → split on spaces (`.split(' ')`), empty words dropped.
  - An array → taken as it is. It must be non-empty, all strings, with a non-blank first word.
  - Anything else, or a failing array → throws `t('err.profile.commandShape')`.
  - Then `typingProblem(words, win)` throws, by `why`:
    - `dash` → `t('err.profile.commandDash', { word })`, the word as it is;
    - `program` → `t('err.profile.commandProgram', { word })`, the word as it is;
    - `chars` → `t('err.profile.commandChars', { word: JSON.stringify(word) })`.
  - Otherwise it returns the words.
- **New keys** in `profile-strings.ts`. Copy them exactly; the curly quotes and `’` are part of the text:

  | key | en | ru |
  |---|---|---|
  | `err.profile.commandShape` | `A start command is a program, or a list of the program and its arguments: "cld-work" or ["cld-work", "--model", "opus"]` | `Команда запуска — это программа или список из программы и её аргументов: "cld-work" или ["cld-work", "--model", "opus"]` |
  | `err.profile.commandDash` | `A start command begins with a program, not “{word}”, which starts with a dash` | `Команда запуска начинается с программы, а не с «{word}»: здесь в начале дефис` |
  | `err.profile.commandProgram` | `The start command is typed at the new tab’s shell prompt, so its program “{word}” must be one word: a name the shell knows (cld-work) or a path, without spaces or quotes` | `Команда запуска набирается в оболочке новой вкладки, поэтому её программа «{word}» должна быть одним словом: имя, которое знает оболочка (cld-work), или путь без пробелов и кавычек` |
  | `err.profile.commandChars` | `The start command’s argument {word} has a quote or a control character in it, which cannot be typed into a shell` | `В аргументе команды запуска {word} есть кавычка или управляющий символ: такое не набрать в оболочке` |

- **spawn-agent** (`services/launch/spawn-agent.ts`):
  - `program = [...(profileCommand(profile?.command) ?? claude), ...(profile?.args ?? [])]`, computed where `program` is today, so a bad command throws before any herdr call.
  - The session-id rule and `shellLine` are unchanged.
  - The entrypoint still passes `claudeCommand(launch.claude, launch.args)` as `claude`.
- **`checkRequest`:**
  - With `typesCommand` true, `profileCommand: profileCommand(profile.command)`. Its throw becomes `{ ok: false, field: 'profile', error: <its message> }`.
  - With `typesCommand` false or left out, `profileCommand: null` and `command` is not read.
  - `launches.start` passes `typesCommand: launcherFor(deps.cfg.launch).kind === 'builtin'`.
- **The board's launcher:**
  - `spawnAgentLauncher.start` gives a session id unless `choosesSession([...(l.profileCommand ?? claudeCommand(spec.claude, spec.args)), ...l.profileArgs])`.
  - Nothing else in the launchers changes: spawn-agent reads the command from config.json itself.
- **`editProfiles` op `update`:** when `b.command !== undefined`:
  - `words = profileCommand(b.command)` (its throw → `{ ok: false, error }`, nothing written);
  - `words === null` → `delete entry.command`;
  - else `entry.command` = the string trimmed, or the list as given.
  - Other fields keep today's rules.
- **`boardProfiles`** adds `command: commandText(p.command)`. `board()` adds `claudeProgram: claudeProgram(cfg.launch?.claude, cfg.launch?.args)`.

- [ ] **Step 1: Write the failing core tests.**

  `test/core/spawn-args.test.ts`: import `profileCommand`, `typingProblem`, `commandText`, `claudeProgram`, and `useLanguage` from `../../src/core/lang.ts`. The existing `shellLine` and `claudeCommand` tests stay as they are.
```ts
describe('a profile’s start command', () => {
  test('none, a string split on spaces, a list as it is', () => {
    for (const none of [undefined, null, '', '   ']) expect(profileCommand(none, false)).toBeNull()
    expect(profileCommand('cld-work', false)).toEqual(['cld-work'])
    expect(profileCommand('  cld-work   --verbose ', false)).toEqual(['cld-work', '--verbose'])
    expect(profileCommand(['cld-work', '--append-system-prompt', 'be brief'], false)).toEqual(['cld-work', '--append-system-prompt', 'be brief'])
    // A path with backslashes only on Windows, as for launch.claude.
    expect(profileCommand('C:\\tools\\cld.cmd', true)).toEqual(['C:\\tools\\cld.cmd'])
  })
  test('refused by launch.claude’s rules, in the board’s words', () => {
    useLanguage('en')
    const shape = 'A start command is a program, or a list of the program and its arguments: "cld-work" or ["cld-work", "--model", "opus"]'
    for (const bad of [[], [''], ['  '], ['cld-work', 3], 42, {}, true]) expect(() => profileCommand(bad, false)).toThrow(shape)
    expect(() => profileCommand('-cld', false)).toThrow('A start command begins with a program, not “-cld”, which starts with a dash')
    expect(() => profileCommand(['cld work'], true)).toThrow(
      'The start command is typed at the new tab’s shell prompt, so its program “cld work” must be one word: a name the shell knows (cld-work) or a path, without spaces or quotes',
    )
    expect(() => profileCommand('C:\\tools\\cld.cmd', false)).toThrow('its program “C:\\tools\\cld.cmd” must be one word')
    expect(() => profileCommand("cld-work --name 'x'", false)).toThrow(
      'The start command’s argument "\'x\'" has a quote or a control character in it, which cannot be typed into a shell',
    )
    expect(() => profileCommand(['cld-work', 'a\nb'], false)).toThrow('argument "a\\nb" has a quote')
    expect(() => profileCommand('cld-work Don’t', true)).toThrow('argument "Don’t" has a quote')
    useLanguage('ru')
    expect(() => profileCommand('-cld', false)).toThrow('Команда запуска начинается с программы, а не с «-cld»: здесь в начале дефис')
    useLanguage('en')
  })
  test('shellLine’s rules, named', () => {
    expect(typingProblem(['cld-work', '--model', 'opus 4'], false)).toBeNull()
    expect(typingProblem(['-x'], false)).toEqual({ why: 'dash', word: '-x' })
    expect(typingProblem(['C:\\tools\\cld.cmd'], false)).toEqual({ why: 'program', word: 'C:\\tools\\cld.cmd' })
    expect(typingProblem(['C:\\tools\\cld.cmd'], true)).toBeNull()
    expect(typingProblem(['cld', "it's"], true)).toEqual({ why: 'chars', word: "it's" })
  })
  test('as the Profiles panel shows it, and the program a profile without one types', () => {
    expect(commandText('  cld-work --verbose ')).toBe('cld-work --verbose')
    expect(commandText(['cld-work', '--append-system-prompt', 'be brief'])).toBe('cld-work --append-system-prompt be brief')
    for (const none of [undefined, null, 42, ['cld', 3], {}]) expect(commandText(none)).toBe('')
    expect(claudeProgram(undefined)).toBe('claude')
    expect(claudeProgram(undefined, ['--model', 'opus'])).toBe('claude')
    expect(claudeProgram('claude-tg')).toBe('claude-tg')
    expect(claudeProgram(['claude-tg', '--model', 'opus'])).toBe('claude-tg')
    expect(claudeProgram([])).toBe('claude')
  })
})
```
  `test/core/profiles.test.ts`:
```ts
test('a listed profile keeps its start command as written, a bad one too: the start says what is wrong', () => {
  const listed = [DEFAULT, { ...WORK, command: 'cld-work' }, { ...GAMEDEV, command: ['cld-g', 3] }]
  const { list } = mergeProfiles(listed, [], H, null, 'win32')
  expect(list.map(p => [p.id, p.command])).toEqual([['default', undefined], ['work', 'cld-work'], ['gamedev', ['cld-g', 3]]])
})
```
- [ ] **Step 2: Run** `bun test test/core/spawn-args.test.ts test/core/profiles.test.ts`. Expected: FAIL (`profileCommand` is not exported; `command` is not a known `Profile` field).
- [ ] **Step 3: Implement the core:**
  - `typingProblem`, `shellLine` through it, `profileCommand`, `commandText` and `claudeProgram` in `spawn-args.ts` (it imports `t` from `../lang.ts`);
  - the `Profile.command` field;
  - the four `err.profile.command*` keys, in English and Russian.
- [ ] **Step 4: Run** the same files. Expected: PASS, the existing `shellLine` tests included.
- [ ] **Step 5: Write the failing spawn-agent and edit tests.**

  `test/entrypoints/spawn-agent.test.ts`:
  - `profileBox` gains a third parameter, `fields: { default?: Record<string, unknown>; work?: Record<string, unknown> } = {}`, spread into those two entries.
  - Its config gains `language: 'en'`.
  - Today's tests pass unchanged.
```ts
test('a work agent’s helper types work’s start command, a string or a list, with --env and work’s args; launch.claude and launch.args go', async () => {
  const cases: [unknown, string][] = [
    ['cld-work', `cld-work --model sonnet --session-id ${SID}`],
    [' cld-work  --verbose ', `cld-work --verbose --model sonnet --session-id ${SID}`],
    [['cld-work', '--append-system-prompt', 'be brief'], `cld-work --append-system-prompt 'be brief' --model sonnet --session-id ${SID}`],
  ]
  for (const [command, typed] of cases) {
    // No launch.claude: claudeCommand gives ['claude', '--x'], and the start command replaces all of it.
    const { box, dir, work } = await profileBox({ args: ['--x'] }, () => [], { work: { command } })
    const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], { CLAUDE_CONFIG_DIR: work })
    assert.equal(r.code, 0, r.stderr)
    const calls = callList(box)
    assert.equal(calls[0], `tab create --workspace wA --cwd ${dir} --label Helper --env CLAUDE_CONFIG_DIR=${work} --no-focus`)
    assert.equal(calls[1], `pane run wA:p9 ${typed}`)
    expect(cardOf(box, SID)).toMatchObject({ profileWant: 'work' })
  }
}, 60_000)
test('no start command, or a blank one, types launch.claude as before', async () => {
  for (const work of [{}, { command: '' }, { command: '   ' }, { command: null }]) {
    const { box, dir, work: workDir } = await profileBox({}, () => [], { work })
    const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], { CLAUDE_CONFIG_DIR: workDir })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(callList(box)[1], `pane run wA:p9 claude --model sonnet --session-id ${SID}`, JSON.stringify(work))
  }
}, 60_000)
test('the board’s own profile types its start command too, its env left alone; --keep-env and --config-dir alike', async () => {
  const own = await profileBox({}, () => [], { default: { command: 'cld' } })
  const r = await runSpawn(own.box, ['--name', 'Helper', '--cwd', own.dir, '--workspace', 'wA', '--session-id', SID, '--keep-env'])
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(callList(own.box).slice(0, 2), [
    `tab create --workspace wA --cwd ${own.dir} --label Helper --no-focus`,
    `pane run wA:p9 cld --session-id ${SID}`,
  ])
  const set = await profileBox({}, () => [], { work: { command: 'cld-work' } })
  const s = await runSpawn(set.box, ['--name', 'Set', '--cwd', set.dir, '--workspace', 'wA', '--session-id', SID, '--config-dir', set.work])
  assert.equal(s.code, 0, s.stderr)
  assert.equal(callList(set.box)[1], `pane run wA:p9 cld-work --model sonnet --session-id ${SID}`)
}, 60_000)
test('a start command that picks its session itself gets no --session-id', async () => {
  const { box, dir, work } = await profileBox({}, () => [], { work: { command: 'cld-work --resume' } })
  const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], { CLAUDE_CONFIG_DIR: work })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(callList(box)[1], 'pane run wA:p9 cld-work --resume --model sonnet')
}, 30_000)
test('a bad start command is refused before herdr is asked', async () => {
  const cases: [unknown, string][] = [
    ['-cld', 'A start command begins with a program, not “-cld”, which starts with a dash'],
    ["cld-work 'x'", 'The start command’s argument "\'x\'" has a quote or a control character in it, which cannot be typed into a shell'],
    [['cld-work', 3], 'A start command is a program, or a list of the program and its arguments: "cld-work" or ["cld-work", "--model", "opus"]'],
  ]
  for (const [command, message] of cases) {
    const { box, dir, work } = await profileBox({}, () => [], { work: { command } })
    const r = await runSpawn(box, ['--name', 'Helper', '--cwd', dir, '--workspace', 'wA', '--session-id', SID], { CLAUDE_CONFIG_DIR: work })
    assert.equal(r.code, 1)
    assert.equal(r.stderr.trim(), `spawn-agent: ${message}`)
    assert.deepEqual(box.calls(), [], message)
  }
}, 60_000)
```
  `test/adapters/config-file.test.ts` (`profileHome`, `seed`, `ok`, `savedProfile` as there):
```ts
test('editProfiles sets a profile’s start command, clears it with "", and refuses a bad one, writing nothing', () => {
  const home = profileHome()
  useLanguage('en')
  seed({ language: 'en', profiles: [{ id: 'work', dir: join(home, '.claude-work'), args: ['--model', 'sonnet'], note: 'mine' }] })
  ok(editProfiles({ op: 'update', id: 'work', command: ' cld-work ' }, { home }))
  expect(savedProfile('work')).toMatchObject({ command: 'cld-work', args: ['--model', 'sonnet'], note: 'mine' })
  ok(editProfiles({ op: 'update', id: 'work', command: ['cld-work', '--verbose'] }, { home }))
  expect(savedProfile('work')?.command).toEqual(['cld-work', '--verbose'])
  ok(editProfiles({ op: 'update', id: 'work', title: 'Job' }, { home }))
  expect(savedProfile('work')?.command).toEqual(['cld-work', '--verbose'])
  const before = readFileSync(configFile(), 'utf8')
  expect(editProfiles({ op: 'update', id: 'work', command: '-cld' }, { home })).toEqual({
    ok: false,
    error: 'A start command begins with a program, not “-cld”, which starts with a dash',
  })
  expect(editProfiles({ op: 'update', id: 'work', title: 'Other', command: "cld-work 'x'" }, { home })).toEqual({
    ok: false,
    error: 'The start command’s argument "\'x\'" has a quote or a control character in it, which cannot be typed into a shell',
  })
  expect(editProfiles({ op: 'update', id: 'work', command: 42 }, { home })).toEqual({
    ok: false,
    error: 'A start command is a program, or a list of the program and its arguments: "cld-work" or ["cld-work", "--model", "opus"]',
  })
  useLanguage('ru')
  expect(editProfiles({ op: 'update', id: 'work', command: '-cld' }, { home })).toEqual({
    ok: false,
    error: 'Команда запуска начинается с программы, а не с «-cld»: здесь в начале дефис',
  })
  useLanguage('en')
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
  for (const none of ['', '   ']) {
    ok(editProfiles({ op: 'update', id: 'work', command: none }, { home }))
    expect('command' in (savedProfile('work') ?? {})).toBe(false)
  }
  expect(savedProfile('work')).toMatchObject({ title: 'Job', args: ['--model', 'sonnet'], note: 'mine' })
})
```
- [ ] **Step 6: Run** `bun test test/entrypoints/spawn-agent.test.ts test/adapters/config-file.test.ts`. Expected: FAIL (`claude` is typed in place of `cld-work`; `command` is not saved).
- [ ] **Step 7: Implement** the spawn-agent `program` line, `editProfiles`' `command`, and the entrypoint's header comment (the profile's `command` is typed in place of `launch.claude`).
- [ ] **Step 8: Run** the same files. Expected: PASS, today's spawn-agent call lists unchanged.
- [ ] **Step 9: Write the failing board-launch and payload tests.**

  `test/services/launch.test.ts`:
  - The first test's `deepEqual` gains `profileCommand: null`.
  - Two new helpers, beside `PROFILES`:
    - `profilesWith(box, fields: Record<string, Record<string, unknown>>)`: `{ profiles: PROFILES(box).profiles.map(p => ({ ...p, ...fields[p.id] })) }`;
    - `writeConfig(box, cfg)`: writes `<APPDATA>/herdr/plugins/config/agent-board/config.json`, as the new-workspace test does, since spawn-agent reads its profiles there.
```ts
test('a profile’s start command is read only for the board’s own launcher, and a bad one refuses the launch', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  const home = join(box.dir, 'home folder')
  const own = defaultProfileDir(home)
  const workDir = join(home, '.claude-work')
  mkdirSync(workDir, { recursive: true })
  const set = (command: unknown) =>
    profileSet([...mergeProfiles([], [], home).list, { id: 'work', title: 'Work', dir: workDir, color: 'teal', hidden: false, args: ['--model', 'sonnet'], command }], own)
  const body = { name: 'A', cwd: dir, workspace: { id: 'w2' }, profile: 'work' }
  const launchOf = async (command: unknown, typesCommand: boolean) => {
    const r = await checkRequest(body, { profiles: set(command), typesCommand })
    assert.ok(r.ok, JSON.stringify(r))
    return r.launch
  }
  assert.deepEqual((await launchOf('cld-work --verbose', true)).profileCommand, ['cld-work', '--verbose'])
  assert.deepEqual((await launchOf(['cld-work'], true)).profileArgs, ['--model', 'sonnet'])
  for (const none of [undefined, '', '  ']) assert.equal((await launchOf(none, true)).profileCommand, null)
  // launch.agent and launch.command type none: never read, a bad one not refused.
  for (const command of ['cld-work', '-cld']) assert.equal((await launchOf(command, false)).profileCommand, null)
  assert.deepEqual(await checkRequest(body, { profiles: set('-cld'), typesCommand: true }), {
    ok: false,
    field: 'profile',
    error: 'A start command begins with a program, not “-cld”, which starts with a dash',
  })
})
test('the board’s spawn-agent types the profile’s start command: work’s with --env and its args, the board’s own without --env', async () => {
  const cfg = (box: Sandbox) => profilesWith(box, { default: { command: 'cld' }, work: { command: 'cld-work' } })
  const { box, started, launched } = await boardServer(cfg)
  writeConfig(box, cfg(box))
  box.state({ ...HERDR, ...OPENED, 'pane get': PANE_READY, 'pane run': { result: null } })
  for (const [name, profile] of [['Work job', 'work'], ['Own job', 'default']]) {
    const l = await launched(await started({ name, cwd: box.dir, category: 'acme', workspace: { id: 'wA' }, profile }))
    assert.equal(l.state, 'done', l.error)
  }
  const tabs = box.calls().filter(a => a[0] === 'tab' && a[1] === 'create')
  assert.deepEqual(tabs.map(a => a.slice(-3)), [
    ['--env', `CLAUDE_CONFIG_DIR=${workDirOf(box)}`, '--no-focus'],
    ['--label', 'Own job', '--no-focus'],
  ])
  const runs = box.calls().filter(a => a[0] === 'pane' && a[1] === 'run').map(a => a[3] ?? '')
  assert.equal(runs.length, 2)
  assert.match(runs[0] ?? '', /^cld-work --model sonnet --session-id [0-9a-f-]{36}$/)
  assert.match(runs[1] ?? '', /^cld --session-id [0-9a-f-]{36}$/)
  assert.equal(cardOf(box.cards, runs[0]?.split(' ').at(-1)).profileWant, 'work')
  assert.equal(cardOf(box.cards, runs[1]?.split(' ').at(-1)).profileWant, 'default')
}, 60_000)
test('a start command that picks its session itself gets no --session-id from the board', async () => {
  const cfg = (box: Sandbox) => profilesWith(box, { work: { command: ['cld-work', '--continue'] } })
  const { box, started, launched } = await boardServer(cfg)
  writeConfig(box, cfg(box))
  box.state({ ...HERDR, ...OPENED, 'pane get': PANE_READY, 'pane run': { result: null } })
  const l = await launched(await started({ name: 'Work job', cwd: box.dir, category: 'acme', workspace: { id: 'wA' }, profile: 'work' }))
  assert.equal(l.state, 'done', l.error)
  assert.equal(callOf(box, 'pane', 'run')[3], 'cld-work --continue --model sonnet')
  // The board gave it no id, so it wrote no card for one.
  const cards = existsSync(box.cards) ? readdirSync(box.cards).filter(f => f.endsWith('.json')) : []
  assert.deepEqual(cards.filter(f => cardOf(box.cards, f.slice(0, -5)).profileWant), [])
}, 40_000)
test('a bad start command refuses the board’s own launch before anything runs', async () => {
  const { box, post, board } = await boardServer(box => profilesWith(box, { work: { command: '-cld' } }))
  for (const workspace of [{ id: 'wA' }, { create: 'Fresh' }]) {
    const r = await post('/api/launch', { name: 'Nope', cwd: box.dir, category: 'acme', workspace, profile: 'work' })
    assert.equal(r.status, 400)
    assert.deepEqual(await r.json(), { ok: false, field: 'profile', error: 'A start command begins with a program, not “-cld”, which starts with a dash' })
  }
  assert.equal(
    box.calls().some(a => a[0] === 'tab' || (a[0] === 'workspace' && a[1] === 'create') || (a[0] === 'pane' && a[1] === 'run')),
    false,
  )
  assert.deepEqual((await board()).launches, [])
}, 30_000)
test('launch.agent and launch.command never read a profile’s start command, a bad one included', async () => {
  for (const command of ['cld-work', '-cld']) {
    const { box, started, launched } = await boardServer(box => ({ ...VIA_HERDR, ...profilesWith(box, { work: { command } }) }))
    box.state({ ...HERDR, ...OPENED })
    const l = await launched(await started({ name: 'Alpha job', cwd: box.dir, category: 'acme', workspace: { id: 'wA' }, profile: 'work' }))
    assert.equal(l.state, 'done', l.error)
    assert.deepEqual(callOf(box, 'agent', 'start').slice(-5, -1), ['--', '--model', 'sonnet', '--session-id'])
    assert.equal(box.calls().some(a => a.includes(command)), false)
  }
  // …then the launch.command half, below.
}, 90_000)
```
  The last test ends with a `launch.command` half, built as the existing `launch.command gets {profile}…` test is: the same `command` template, the same fake launcher recording into a file, the same `profile: 'work'` start, and `profilesWith(box, { work: { command: 'cld-work' } })` as the profiles. It expects:
  - the launch `done`;
  - `seen().args.slice(2)` to be `['-Profile', 'work', '-Dir', workDirOf(box)]`;
  - `seen().args.includes('cld-work')` to be false.

  `test/server/profiles.test.ts`:
```ts
test('the board sends each profile’s start command ("" for none) and launch.claude’s program; a bad one is refused with 409', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const home = join(box.dir, 'home')
  const listed = [
    { id: 'default', title: 'Private', dir: join(home, '.claude'), color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false, command: ['cld-work', '--verbose'] },
  ]
  // config.json too: the panel's edits go there.
  mkdirSync(join(configOf(box), '..'), { recursive: true })
  writeFileSync(configOf(box), JSON.stringify({ language: 'en', profiles: listed }))
  const { url, proc } = await serveBoard(box, { language: 'en', launch: { claude: ['claude-tg', '--model', 'opus'] }, profiles: listed })
  const body = await boardOf(url, proc, 0)
  expect(body.profiles?.map(p => [p.id, p.command])).toEqual([['default', ''], ['work', 'cld-work --verbose']])
  expect(body.claudeProgram).toBe('claude-tg')
  const post = (b: unknown) =>
    fetch(`${url}/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(b) })
  const bad = await post({ op: 'update', id: 'work', command: '-cld' })
  expect([bad.status, await bad.json()]).toEqual([409, { ok: false, error: 'A start command begins with a program, not “-cld”, which starts with a dash' }])
  expect((await post({ op: 'update', id: 'work', command: 'cld-work' })).status).toBe(200)
  expect(profilesIn(box).find(p => p.id === 'work')?.command).toBe('cld-work')
}, 20_000)
```
  `test/web/client.test.ts` (`PROFILE` and `payload()` as there):
```ts
test('a profile’s start command, and launch.claude’s program: strings, or none from a board before them', () => {
  expect(isBoardProfile({ ...PROFILE, command: 'cld-work' })).toBe(true)
  expect(isBoardProfile({ ...PROFILE, command: '' })).toBe(true)
  expect(isBoardProfile(PROFILE)).toBe(true)
  for (const command of [3, null, ['cld-work'], true])
    expect([command, isBoardProfile({ ...PROFILE, command })]).toEqual([command, false])
  expect(isBoardPayload({ ...payload(), claudeProgram: 'claude-tg' })).toBe(true)
  expect(isBoardPayload({ ...payload(), claudeProgram: undefined })).toBe(true)
  expect(isBoardPayload({ ...payload(), claudeProgram: 3 })).toBe(false)
})
```
- [ ] **Step 10: Run** `bun test test/services/launch.test.ts test/server/profiles.test.ts test/web/client.test.ts`. Expected: FAIL (`typesCommand` is not read, there is no `profileCommand` field, and no `command`/`claudeProgram` in the payload).
- [ ] **Step 11: Implement** the board-launch and payload rules:
  - `LaunchRequest.profileCommand`, `typesCommand` and the refusal (`request.ts`);
  - `LaunchContext.profileCommand` and the session-id line (`launcher.ts`);
  - `typesCommand` passed in from `launches.ts`;
  - `command` and `claudeProgram` in `payload.ts` and `board-state.ts`;
  - the two guards in `client.ts`.
- [ ] **Step 12: Run** the same files. Expected: PASS. Then `bun test`: green, with every existing test unchanged apart from the request test's `profileCommand: null` line (no command means today's call lists). Then `bun run check`: clean.
- [ ] **Step 13: Commit**

```bash
git add src/core/launch/spawn-args.ts src/core/profiles.ts src/core/i18n/profile-strings.ts src/core/payload.ts src/services/launch/spawn-agent.ts src/entrypoints/spawn-agent.ts src/services/launch/request.ts src/services/launch/launcher.ts src/services/launch/launches.ts src/adapters/config-file.ts src/server/board-state.ts web/src/api/client.ts test/core/spawn-args.test.ts test/core/profiles.test.ts test/adapters/config-file.test.ts test/entrypoints/spawn-agent.test.ts test/services/launch.test.ts test/server/profiles.test.ts test/web/client.test.ts
git commit -m "Type a profile's start command instead of launch.claude, and refuse a bad one before anything runs"
```

### Task 2: The Start command field in the Profiles panel

**Spec:** "Profiles panel" (the field, its placeholder, the hint, the body sent, `''` clears, refused as a toast, English and Russian); "One profile shown, with no command set".

**Files:**
- Modify: `web/src/models/profiles.ts`, `web/src/components/profiles/ProfileRow.tsx`, `web/src/components/profiles/ProfilesPanel.tsx`, `web/styles/profiles.css`, `src/core/i18n/profile-strings.ts`
- Test: `test/web/profiles-panel.test.tsx`, `test/web/single-profile.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1's `BoardProfile.command?: string` (`''` for none) and `BoardPayload.claudeProgram?: string`;
  - `POST /api/profiles` `{ op: 'update', id, command }`, which answers 409 `{ ok: false, error }` for a bad one.
- Produces:
  ```ts
  // web/src/models/profiles.ts
  interface ProfileRowView { /* today's */ command: string }   // p.command ?? ''
  /** A start command as typed, when it changed: trimmed ('' clears it); null when it is the same. */
  export function commandEdited(command: string, value: string): string | null
  // ProfileRow.tsx
  interface ProfileRowProps { /* today's */ program?: string }  // the field's placeholder; default 'claude'
  ```
- **The row:** below its `.cat-sub` line it gets `<label className="profile-command">`. Inside: `<span>{t('prof.command')}</span>`, then an input.
  - The input: `className="path-add profile-command-field"`, `aria-label={t('prof.command')}`, `placeholder={program}`, `spellCheck={false}`, `disabled={disabled}`.
  - It behaves as the name field does: the typed text is kept while the field has the focus, then until the board says another command. Enter blurs. Escape puts the board's value back, stops the event and blurs.
  - On blur it sends `{ op: 'update', id, command }` when `commandEdited(row.command, value)` is not null. A refusal (`edit` resolves false) shows the board's value again.
- **The panel:** passes `program={data?.claudeProgram || 'claude'}` to each row. After `.cats-list` it renders `<p className="profile-command-hint">{t('prof.commandHint', { program })}</p>`.
- **New keys:**

  | key | en | ru |
  |---|---|---|
  | `prof.command` | `Start command` | `Команда запуска` |
  | `prof.commandHint` | `Start command: typed in the new tab instead of {program}. An alias like cld-work works; the board adds its own arguments.` | `Команда запуска: набирается в новой вкладке вместо {program}. Подойдёт и алиас вроде cld-work; свои аргументы доска добавит сама.` |

- **CSS** (`profiles.css`, class selectors only): `.profile-command` is a line under the folder, indented as `.prof-row .cat-sub` is, with its label quiet like `.profile-add > span`. `.profile-command-hint` is quiet 12px text.

- [ ] **Step 1: Write the failing tests.**

  `test/web/profiles-panel.test.tsx`:
  - In today's first test, each `profileRows` object gains `command: ''`.
  - The work row's inputs become `['Name', 'Start command']`.
  - New tests:
```ts
test('the start command: a field per row, launch.claude’s program as its placeholder, and one hint', () => {
  const panel = panelOf(payload({ items: ITEMS, profiles: [PRIVATE, { ...WORK, command: 'cld-work' }], claudeProgram: 'claude-tg' }))
  const fields = findAll([panel], el => hasClass(el, 'profile-command-field'))
  expect(fields.map(el => [el.attrs.get('aria-label'), el.attrs.get('value') ?? '', el.attrs.get('placeholder')])).toEqual([
    ['Start command', '', 'claude-tg'],
    ['Start command', 'cld-work', 'claude-tg'],
  ])
  expect(findAll([panel], el => hasClass(el, 'profile-command-hint')).map(textOf)).toEqual([
    'Start command: typed in the new tab instead of claude-tg. An alias like cld-work works; the board adds its own arguments.',
  ])
  // A board that does not say: claude.
  const plain = panelOf(dataOf([PRIVATE, WORK]))
  expect(findAll([plain], el => hasClass(el, 'profile-command-field')).map(el => el.attrs.get('placeholder'))).toEqual(['claude', 'claude'])
  expect(profileRows([WORK, { ...WORK, command: 'cld-work' }], t).map(r => r.command)).toEqual(['', 'cld-work'])
  // In Russian.
  const ru = panelOf(payload({ lang: 'ru', items: ITEMS, profiles: [PRIVATE, WORK], claudeProgram: 'claude-tg' }), {}, 'ru')
  expect(textOf(find([ru], el => hasClass(el, 'profile-command-hint')))).toBe(
    'Команда запуска: набирается в новой вкладке вместо claude-tg. Подойдёт и алиас вроде cld-work; свои аргументы доска добавит сама.',
  )
  expect(find([ru], el => hasClass(el, 'profile-command-field')).attrs.get('aria-label')).toBe('Команда запуска')
})
test('the start command goes on Enter or leaving the field; "" clears it; the same, blanks over none, or Escape send nothing', async () => {
  expect(commandEdited('', ' cld-work ')).toBe('cld-work')
  expect(commandEdited('cld-work', '')).toBe('')
  expect(commandEdited('cld-work', '  cld-work ')).toBeNull()
  expect(commandEdited('', '   ')).toBeNull()
  const typed = async (row: ProfileRowView, value: string, key?: string) => {
    const side = liveRow(row)
    const field = side.pick('.profile-command-field')
    field.focus()
    await side.world.fire(field, 'focusin')
    field.value = value
    await side.world.fire(field, 'input')
    if (key) await side.world.fire(field, 'keydown', { key })
    await side.world.fire(field, 'focusout')
    return side.posts
  }
  expect(await typed(viewOf(WORK), ' cld-work ')).toEqual([{ op: 'update', id: 'work', command: 'cld-work' }])
  expect(await typed(viewOf(WORK), 'cld-work --verbose', 'Enter')).toEqual([{ op: 'update', id: 'work', command: 'cld-work --verbose' }])
  expect(await typed(viewOf({ ...WORK, command: 'cld-work' }), '')).toEqual([{ op: 'update', id: 'work', command: '' }])
  expect(await typed(viewOf({ ...WORK, command: 'cld-work' }), ' cld-work ')).toEqual([])
  expect(await typed(viewOf(WORK), '   ')).toEqual([])
  expect(await typed(viewOf(WORK), 'cld-work', 'Escape')).toEqual([])
})
test('a start command the board refuses is toasted', async () => {
  const refusal = 'A start command begins with a program, not “-cld”, which starts with a dash'
  const calls = answers([409, { ok: false, error: refusal }])
  const panel = livePanel(dataOf([PRIVATE, WORK]))
  const [, work] = panel.el.querySelectorAll('.profile-command-field')
  if (!work) throw new Error('no field')
  work.focus()
  await panel.world.fire(work, 'focusin')
  work.value = '-cld'
  await panel.world.fire(work, 'input')
  await panel.world.fire(work, 'focusout')
  for (let i = 0; i < 4; i++) await panel.world.flush()
  expect(sent(calls)).toEqual([['/api/profiles', 'POST', '1', { op: 'update', id: 'work', command: '-cld' }]])
  expect(panel.toasts).toEqual([[refusal, true]])
})
```
  `test/web/single-profile.test.tsx`:
```ts
test('one profile with no start command, and launch.claude’s program sent: the page is still phase 1’s', () => {
  const sent: BoardPayload = { ...ONE, claudeProgram: 'claude', profiles: [{ ...DEFAULT, command: '' }] }
  expect(board(sent)).toBe(board(PHASE1))
  expect(toolbar(sent)).toBe(toolbar(PHASE1))
  expect(usagePop(sent)).toBe(usagePop(PHASE1))
  expect(categoriesPanel(sent)).toBe(categoriesPanel(PHASE1))
  expect(JSON.stringify(settingsItems(sent))).toBe(JSON.stringify(settingsItems(PHASE1)))
  for (const open of [false, true]) expect(canonical(sidePanels(sent, open))).toBe(canonical(sidePanels(PHASE1, open)))
})
```
- [ ] **Step 2: Run** `bun test test/web/profiles-panel.test.tsx test/web/single-profile.test.tsx`. Expected: FAIL (there is no `.profile-command-field`, and `commandEdited` is not exported).
- [ ] **Step 3: Implement** the model function, the row field, the panel's `program` and hint, the two keys in English and Russian, and the CSS.
- [ ] **Step 4: Run** the same files. Expected: PASS. Then `bun test`: green (`test/web/styles.test.ts` included). Then `bun run check`: clean.
- [ ] **Step 5: Commit**

```bash
git add web/src/models/profiles.ts web/src/components/profiles/ProfileRow.tsx web/src/components/profiles/ProfilesPanel.tsx web/styles/profiles.css src/core/i18n/profile-strings.ts test/web/profiles-panel.test.tsx test/web/single-profile.test.tsx
git commit -m "Edit a profile's start command in the Profiles panel"
```

### Task 3: The start command in the README

**Spec:** "README 'Claude profiles': the start command, with the owner's example (`cld` / `cld-work`)".

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the behaviour from Tasks 1 and 2, in the Global Constraints' terms.
- Produces: no code.

- [ ] **Step 1: Edit `README.md`.** In the same voice as the sections around it:
  - **"## Claude profiles", "What it finds":** the list of a profile's fields gains `command` (its start command).
  - **"## Claude profiles", a new paragraph "A start command per profile."**, after "The Profiles panel". It says:
    - what `command` is: what the board types at the new tab's shell prompt instead of `launch.claude` for every start that types one ("New here", forks and helpers, the default launcher, `spawn-agent`), in the board's own profile too;
    - it is a program, alias or function the tab's shell knows, with arguments if you like: a string split on spaces, or a list, under `launch.claude`'s typing rules;
    - the board adds the profile's `args` and `--session-id` (none when the command picks its session itself);
    - `launch.agent` and `launch.command` do not use it;
    - a profile other than the board's own still gets `CLAUDE_CONFIG_DIR` through `--env`.
    - Then the owner's example, as a Git Bash block:
      ```bash
      alias cld='CLAUDE_CONFIG_DIR=$HOME/.claude command claude --allow-dangerously-skip-permissions'
      alias cld-work='CLAUDE_CONFIG_DIR=$HOME/.claude-work command claude --allow-dangerously-skip-permissions'
      ```
      followed by the profiles with `"command": "cld"` and `"command": "cld-work"`. A Work session from the board then types `cld-work --session-id <id>`, so a flag added to the alias reaches it without touching the board.
    - An alias that names another profile's folder runs its session there: the card's red "Wrong profile" tag and herdr's notification say so.
    - A command that breaks the rules is refused with the reason: on save in the panel, and at a start before anything runs.
  - **"## Claude profiles", "The Profiles panel":** a row also has its "Start command":
    - Enter or leaving the field keeps it, Esc puts it back, empty clears it;
    - its placeholder is what is typed without one;
    - the hint under the rows.
  - **"## Claude profiles", "Waking stays in the profile":** after the `cld-work` alias paragraph, one sentence: a session the board starts with `"command": "cld-work"` still opens its tab with work's `CLAUDE_CONFIG_DIR`, so waking it stays in work.
  - **"## spawn-agent":** "The profile's `args` go after `launch.claude`" becomes "after the profile's `command`, or `launch.claude`".
- [ ] **Step 2: Check:**
  - `grep -n "A start command per profile\|cld-work --session-id\|\"command\": \"cld-work\"\|Start command" README.md` shows each new part once or more;
  - `git diff --stat` touches only `README.md`;
  - `bun test` is green;
  - `bun run check` is clean.
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Describe the start command per Claude profile in the README"
```

---

## After the last task (the owner, by hand)

On the owner's machine, with `cld` and `cld-work` defined in the Git Bash the herdr tabs run:
1. Set "Start command" `cld-work` on Work in the Profiles panel.
2. Start a Work session from the board: the tab shows `cld-work --session-id …` and the card has no red tag.
3. Run "New here" from it, and have one of its agents start a helper.
4. Point `cld-work` at `~/.claude` for a moment: the next Work start shows "Wrong profile".
