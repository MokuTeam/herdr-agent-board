# Catch up with `main` @ f0cef14 (PRs #52–#59) — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One task per
> dispatch; each task's text below is its brief. Every task, fix and review is a **new** subagent,
> never a resumed one. Lanes run **in parallel**, each in its own worktree; Task 10 merges them.

**Goal:** port into `feature/ts-rework` (TS/Bun/React, with multi-profile and the start command per
profile) the PRs `origin/main` merged after `513e441`, as upstream wrote them, **fast**: the PRs are
grouped into lanes that touch (nearly) disjoint TS files and run at the same time. **Nothing goes to
`main`:** the destination is `feature/ts-rework`. #59 is lane E (Task P); its resume rule is part of
Task 6. After this plan the branch is synced to `main` @ `f0cef14`; the history merge
(`git merge -s ours f0cef14`, as `738b30f` did for `513e441`) comes after Task 11, not in this plan.

**Spec:** the upstream PRs themselves. Read a PR with `git diff <merge>^1 <merge>` and
`git show <merge>:<path>`. Phase-1 conventions:
`C:/migo/development/projects/external/mokuhub/herdr-agent-board/.superpowers/sdd/2026-10-16-ts-bun-react-rework/conventions.md`.
Multi-profile spec: `docs/superpowers/specs/2026-10-18-multi-profile-design.md`. Start-command
spec: `docs/superpowers/specs/2026-10-19-profile-start-command-design.md`. The previous catch-up:
`docs/superpowers/plans/2026-10-19-catch-up-main-513e441.md`.

| Task | Lane | Merge | PR | Upstream subject |
|---|---|---|---|---|
| 1 | A | 1a9987b | #52 | Board pane survives crashes: run.mjs starts the board again and logs why |
| 2 | A | 513e441..b2c5afa | — | (the stylesheets of #53–#58, one commit; see Lanes) |
| 3 | B | b5a96b8 | #53 | Queued messages show in the session's thread |
| 4 | C | 3105958 | #54 | Session panel actions fit any width: four in the row, the rest under More |
| 4 | C | 8745585 | #55 | Session panel: the call joins the row, History goes under More |
| 5 | D | 2b9e6b7 | #56 | Archive: take sessions off the board, and bring them back (model and texts) |
| 6 | D | 2b9e6b7 | #56 | Archive: take sessions off the board, and bring them back (server, CLI, launch) |
| 7 | C | 2b9e6b7 | #56 | Archive: take sessions off the board, and bring them back (web) |
| 8 | C2 | 98e1f7a | #57 | Archive by dragging a card onto a place that comes up with the drag |
| 9 | C | b2c5afa | #58 | Session panel row shows as many actions as fit, the rest under More |
| 10 | — | — | — | Integration: merge the lanes, pins to b2c5afa, full suite |
| P | E | f0cef14 | #59 | Respect CLAUDE_CONFIG_DIR and Claude profiles beside ~/.claude (resume part in Task 6) |
| 11 | — | — | — | Final seams review of the whole branch |

## Global Constraints

- Catch-up branch `feature/catchup-main-f0cef14` (from `feature/ts-rework` @ 738b30f) in
  `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.claude/worktrees/catchup-f0cef14`.
  Each lane works in a worktree of its own, made from that branch at the commit that adds this plan:
  `git worktree add -b feature/cu-f0cef14-<lane> .claude/worktrees/cu-f0cef14-<lane> feature/catchup-main-f0cef14`
  (lanes `a`, `b`, `c`, `d`; `c2` is made from `feature/cu-f0cef14-c` once Task 7 is in). Work only
  in your lane's worktree. A new worktree has no `node_modules`: `bun install --frozen-lockfile`
  first. **Never touch the main checkout (`C:/migo/development/projects/external/mokuhub/herdr-agent-board`):
  herdr runs the owner's live board from it.** Commit locally, never push.
- **Port, don't merge.** Bring every hunk of the PR to its place in the TS layout:
  - pure → `src/core`, I/O → `src/adapters`, herdr/OS glue → `src/integrations`;
  - orchestration → `src/services`, HTTP → `src/server/routes`, entrypoints → `src/entrypoints`;
  - browser → `web/src/{models,hooks,components}`, CSS → `web/styles`.

  New i18n keys go into `src/core/i18n/` in **English and Russian, exactly as upstream wrote them**.
  README prose is applied with paths pointing at the TS/React files. Tests are ported to
  `test/<layer>/…test.ts` (bun:test) and keep their meaning. Anything not ported needs a stated
  reason in the report: it is a ruling request.
- **Behaviour parity with upstream at the PR's merge commit:**
  - the same routes, payloads, headers, SSE shapes and `board` CLI output;
  - the same hook and status-line output (the brief too), keys and texts.
- **Web parity:** markup-parity tests compare React with upstream's own file at the PR's merge commit
  (`test/web/support/old-app.ts` `oldSource(file, ref)`), never React with itself. Modal layers are
  direct `<body>` children via portal + `useModalFocus`.
- **Lane rules (parallel work):**
  - A task touches the files its brief lists (and the new tests it adds). Any other file it had to
    touch is named in its report: it is a seam Task 10 must know about.
  - Files that more than one lane touches (see Lanes) get small, local edits: no reformatting, no
    reordering, no moved blocks. New tests go into **new** test files, not appended to shared ones.
  - **Stylesheets:** only Task 2 touches `web/styles/*` and `test/web/styles.test.ts`. Every other
    task leaves the CSS alone, even where its PR changed `web/app.css` (Task 2 has it).
  - **Pins:** a task moves only the parity pins of the code its PR changed, to its PR's merge. A pin
    that would need another lane's work stays where it is (say so in the report); Task 10 moves every
    pin to `b2c5afa`. `test/web/style-attributes.test.ts` `UPSTREAM_REF` stays `513e441` until Task 10.
  - `test/core/catch-up-strings.test.ts` `MERGES`: append your merge; Task 10 takes the union.
- **Multi-profile and start command stay intact.** Everything the phase-2 work pinned keeps passing:
  - the one-profile page is byte-for-byte phase 1's, now at the new upstream;
  - the wrong-account guards;
  - the profile env rule;
  - start commands.

  Where an upstream change touches Claude's folders (`~/.claude`), it works per profile, as the
  hooks do: the shown profiles. With one profile it is exactly upstream's behaviour. **Anything that
  stops, starts, resumes or wakes a session goes through the board's existing profile guards**
  (`mayWake`, the pane records, `launchTarget`). If the board can't be sure of the profile, it
  refuses, with a reason in English and Russian («ты» register). Each task's profile rulings are in
  its brief.
- Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`),
  `.ts`/`.tsx` import extensions, no `any`, JSON narrowed, unknown fields kept, layers respected.
  Windows first-class, no shell when spawning. React and react-dom only, Biome.
- Toolchain (Git Bash): `export PATH="$HOME/.bun/bin:$PATH"`, then `bun test <file>`, `bun test`,
  `bun run check`. Each task ends with `bun test` green (only the 2 symlink tests may skip) and
  `bun run check` clean. The working copy is LF.
- **Sandboxes only.** Tests use temp folders and `test/support` fakes. Never run the owner's real
  herdr or claude, nor `bun src/entrypoints/*` against the machine (not even `--help`). Never read or
  write the real `~/.claude*`, `%APPDATA%\herdr` or `%LOCALAPPDATA%\herdr`, and never use port 12422.
- **Commits:** one per upstream PR, "Catch up: <upstream subject>" (#56 is split in three, with the
  suffixes the table gives). Task 2 and a follow-up a review asks for get their own plain sentence;
  Task 10's merges are plain sentences too. No prefix, no trailer, no `Co-Authored-By`, no AI
  mention. The author is the repo's git user. Stage by path.

## Lanes

Start A, B, C, D and E at once. C2 starts when Task 7 is in. Task 10 starts when every lane is done.

| Lane | Tasks, in order | Estimate (impl + review, one fix round where expected) |
|---|---|---|
| A | 1 (#52) → 2 (stylesheets) | 16 + 11 = **27 min** |
| B | 3 (#53) | 34 + 12 fix = **46 min** |
| C | 4 (#54, #55) → *merge Task 5's commit from lane D* → 7 (#56 web) → 9 (#58) | 18 + 54 + 12 fix + 19 = **103 min** (critical) |
| C2 | 8 (#57), from lane C after Task 7 | **19 min**, beside Task 9 |
| D | 5 (#56 model, texts) → 6 (#56 server, CLI, launch, #59's resume rule) | 13 + 71 + 12 fix = **96 min** |
| E | P (#59 without its resume part) | 10 + 4 = **14 min** |

**Lane A.**
- Task 1: `src/core/crash-policy.ts` (new), `src/entrypoints/run.ts`, `src/tui/app.ts`,
  `test/core/crash-policy.test.ts` (new), `README.md`.
- Task 2: `web/styles/app.css`, `test/web/styles.test.ts`. Nothing else.

**Lane B.** Task 3: `src/core/transcript.ts` (or a new `src/core/queue.ts`), `src/adapters/claude-home.ts`,
`src/server/routes/session.ts`, `web/src/api/client.ts`, `web/src/models/outbox.ts` (new),
`web/src/models/composer-session.ts`, `web/src/hooks/useComposer.ts`,
`web/src/components/sheet/Thread.tsx`, `web/src/components/sheet/Sheet.tsx`,
`web/src/components/icons.tsx`, `src/core/i18n/strings.ts`, `README.md`; tests
`test/core/queue.test.ts`, `test/web/outbox.test.ts`, `test/server/queue.test.ts`,
`test/web/thread-queue.test.tsx` (all new), `test/web/composer-session.test.ts`,
`test/core/catch-up-strings.test.ts`.

**Lane C** (the session panel's row and the archive's page, which share the composer row, the
menus and their models).
- Task 4: `web/src/models/menu-model.ts`, `web/src/components/menu/menu-engine.ts`,
  `web/src/models/board-menus.ts`, `web/src/hooks/useContextMenus.ts`,
  `web/src/components/sheet/Composer.tsx`, `web/src/components/icons.tsx`; tests
  `test/web/menu.test.ts`, `test/web/menu-actions.test.ts`, `test/web/sheet.test.tsx`,
  `test/web/support/old-sheet.ts`, `test/web/support/menu-sides.tsx`.
- Before Task 7: `git merge --no-ff <Task 5's commit>` (lane D's branch at Task 5; disjoint files,
  clean). If Task 5 gets a fix after that, merge again.
- Task 7: see its brief (archive panel, toolbar, toasts, menus, sheet button, launch card, cards'
  flight, keys) plus `README.md`.
- Task 9: `web/src/models/row-model.ts` (new), `web/src/hooks/useActionRow.ts` (new),
  `web/src/components/sheet/Composer.tsx`, `web/src/components/sheet/Sheet.tsx`,
  `web/src/models/board-menus.ts`, `web/src/hooks/useContextMenus.ts`, `src/core/i18n/strings.ts`,
  `README.md`; tests `test/web/row-model.test.ts` (new) and the pins it moves.

**Lane C2.** Task 8: `web/src/models/archive-drop.ts` (new), `web/src/hooks/useCardDrag.ts`,
`web/src/components/DropArchive.tsx` (new), `web/src/components/Board.tsx`,
`web/src/hooks/useArchive.ts`, `README.md`; `test/web/archive-drop.test.ts` (new). Disjoint from
Task 9 except `README.md` (other hunks).

**Lane D.**
- Task 5: `src/core/archive.ts` (new), `src/core/types.ts`, `src/core/payload.ts`,
  `src/core/i18n/archive-strings.ts` (new), `src/core/i18n/strings.ts`; tests
  `test/core/archive.test.ts` (new), `test/core/catch-up-strings.test.ts`.
- Task 6: see its brief (archive store and service, scheduler, collect, server routes, CLI, launch
  resume, spawn-agent `--resume`, the skill).

**Files more than one lane touches** (Task 10 resolves; all in different hunks):
- `README.md`: A (Development), B (web board: the queue), C (the archive section, #57's lines in it,
  #58's sheet line).
- `src/core/i18n/strings.ts`: B (`queue.*`), D/Task 5 (the `ARCHIVE_STRINGS` merge), C/Task 9
  (`mokupilot.call`). Lane C has Task 5 already.
- `test/core/catch-up-strings.test.ts`: B (`b5a96b8`), D/Task 5 (`2b9e6b7`, the archive file), C/Task 9
  (`b2c5afa`). Union, upstream order.
- `src/server/routes/session.ts`: B (`detail`: `queued`), D/Task 6 (the `archive` action, the
  origin and stale lists).
- `web/src/components/sheet/Sheet.tsx`, `web/src/components/icons.tsx`, `web/src/api/client.ts`: B
  (the thread's foot, the clock glyph if missing, `SessionDetail.queued`) and C (the archive button,
  the row, the archive's API).
- The CSS is Task 2's alone; B and C draw markup whose rules Task 2 brings.

**Overlap with #59 (Task P)**, whose upstream files are `src/claude.mjs history.mjs install.mjs
launch.mjs mokupilot.mjs paths.mjs setup.mjs spawn.mjs`:
- Lane B / Task 3: `src/adapters/claude-home.ts` (`claude.mjs`).
- Lane D / Task 6: `src/adapters/paths.ts`, `src/services/launch/{launches,run,launcher,request}.ts`,
  `src/services/launch/spawn-agent.ts`, `src/core/launch/spawn-args.ts`,
  `test/entrypoints/install.test.ts` (the skill's pin), `test/entrypoints/spawn-agent.test.ts`.
- #59 also edits #56's own code: Return and `spawn-agent --resume` resume "with the session's own
  CLAUDE_CONFIG_DIR". Task 6's profile ruling does this already, through `launchTarget` and the
  session's profile (stricter: it refuses when unsure). So **Task P runs after Task 10**, on the
  integrated branch, and treats that part of #59 as covered by Task 6 (or reconciles it there).
- **Ruling (controller):** #59's resume rule moves into Task 6 (its addendum), and the rest of #59
  is Task P in its own lane E from the start, so #59 is off the critical path. Lane E touches
  `src/adapters/profiles.ts`, the install entrypoint's status-line message, `src/entrypoints/cli.ts`
  (name and cwd lookups), `README.md`, the multi-profile spec line; Task 10 resolves its overlaps
  with B (`claude-home.ts`, if any) and D (`cli.ts`, `paths.ts`) by keeping both sides.

## Tasks

### Task 1: #52 — the board starts again after a crash

Port 1a9987b completely:
- `src/crash-policy.mjs` → `src/core/crash-policy.ts` (`CRASH_WAITS_MS`, `MAX_CRASHES`,
  `CRASH_WINDOW_MS`, `afterCrash`);
- `src/run.mjs` → `src/entrypoints/run.ts`: the crash log (`web.log` in the state folder via
  `stateDir()`), `uncaughtException` logged, never the pane's end; the start after a pause; a
  stamp that fails mid-write waits for the next event; `crashes` cleared on a code change; an
  exited child not signalled; `send` that throws kills; the watcher replaced after an error (5 s).
  Keep today's recursive watch of `.ts` files under `src/`;
- `src/tui.mjs` → `src/tui/app.ts`: the crash's stack appended to `web.log` (its `log` helper);
- README; `test/crash-policy.test.mjs` → `test/core/crash-policy.test.ts`.

No profile ruling: it restarts the board, never a session, and reads no Claude folder. Commit
"Catch up: Board pane survives crashes: run.mjs starts the board again and logs why".

### Task 2: the stylesheets, ahead of the lanes

`test/web/styles.test.ts` holds one pin for the whole of `app.css`, rule for rule, so the lanes
cannot each port their own part of it. This task brings `web/styles/app.css` to upstream's
`web/app.css` at `b2c5afa` (the queue #53, the row and More #54/#55/#58, the archive #56, its drop
place #57) and moves `STYLES_REF` to `b2c5afa` (its comment too). The setup rules stay in
`setup.css`, as today. Comments name the TS files the plan gives (`models/outbox.ts`,
`hooks/useActionRow.ts` with `models/row-model.ts`, `hooks/useArchive.ts`,
`components/DropArchive.tsx`, `components/archive/ArchivePanel.tsx`). No other file: the markup comes
with the lanes; `style-attributes.test.ts` stays at `513e441` until Task 10 (no new rule selects by
an attribute, so it passes meanwhile). No profile ruling. Commit "Bring the stylesheets to upstream's
b2c5afa, ahead of the lanes that draw their markup".

### Task 3: #53 — queued messages show in the session's thread

Port b5a96b8 completely:
- `queuedPrompts(text, { since, idleSince })` (pure, with its `SYSTEM_TAG` and `promptText`) →
  `src/core/transcript.ts` or a new `src/core/queue.ts`; `readThread` / `sessionThread(path, limit,
  queue)` → `src/adapters/claude-home.ts` (one read of the tail for both; `conversation()` keeps its
  result);
- the session detail (`src/server/routes/session.ts` `detail`): `queued` (only while `alive`), the
  keys in upstream's order (`item, conversation, queued, helpers, …`);
- `web/outbox.js` → `web/src/models/outbox.ts` (`messageKey`, `holds`, `sentKey`, `unsettled`,
  `newestAt`), exactly;
- the page: the message leaves the box at once for the thread's foot (`useComposer.ts`,
  `composer-session.ts`: the outbox per session, `deliver`, sent / failed with Retry and Edit, the
  draft kept until the session has it, the reload at 800 ms and the redraw at 31 s, toasts only when
  the thread is not on show); the waiting bubbles and their one-time rise (`Thread.tsx`, reduced
  motion); `SessionDetail.queued` (`web/src/api/client.ts`); the `queue.*` keys;
- README; `test/queue.test.mjs` → `test/core/queue.test.ts`, `test/web/outbox.test.ts`,
  `test/server/queue.test.ts` (its HTTP part).

Thread parity against upstream's `waitingHTML` / `renderSheetBody` at `b5a96b8` goes in the new
`test/web/thread-queue.test.tsx` with a pin of its own; do not edit `test/web/support/old-sheet.ts`
(lane C moves its pins). Existing composer tests that pinned "the box clears after the send" move to
#53's behaviour. No CSS (Task 2).

Profile rules (rulings):
- `idleSince` comes from the session's registry in **its own profile's** Claude home:
  `deps.homes.forDir(item.claudeRoot ?? deps.claude.root).liveSessions().get(item.session)` (as
  `session.ts` reads the registry elsewhere), never the board's own `~/.claude` only.
- Sending, and Retry of a failed message, go through the existing `message` action unchanged (the
  gate, the fresh snapshot, the wake guard for a sleeping session).
- With one profile, upstream's behaviour exactly.

Commit "Catch up: Queued messages show in the session's thread".

### Task 4: #54 and #55 — the session panel's row and its More menu

Port 3105958, then 8745585, one commit each:
- `placeMenu(point, size, viewport, { margin, up })` (`web/src/models/menu-model.ts`, every caller)
  and the engine's `up` (`menu-engine.ts`);
- More: the dots button at the row's end (title and aria-label `sheet.more`), "New here" before it,
  the More list in groups with separators (#54's `MORE`, then #55's: the call joins the tools),
  `HERDR_MORE` with `sheet-archive`, only the buttons the row hides, opened upward from
  `rect.top - 4` (`board-menus.ts`, `useContextMenus.ts`). "Hidden in the row" is upstream's own
  test: `getComputedStyle(el).display === 'none'` at the click;
- #55: the call before Terminal in the row (`Composer.tsx`);
- the tests (`menu.test` `up`), More parity in `menu-actions.test.ts` and the sheet's page in
  `old-sheet.ts` (`SHEET_MERGE`) moved to each merge.

UI only: Wake, Sleep, Restart and New here keep their guards. No CSS (Task 2). Commits "Catch up:
Session panel actions fit any width: four in the row, the rest under More" and "Catch up: Session
panel: the call joins the row, History goes under More".

### Task 5: #56, part 1 — the archive's model, shapes and texts

What both the server (Task 6) and the page (Task 7) build on; it lands first so lane C can merge it.
- `web/archive-model.js` → `src/core/archive.ts`: `TIDY_DAYS`, `archiveBlock`, `heldEntries`,
  `tidyList`, `searchArchive`, exactly;
- the shapes, as types in `src/core/archive.ts`: the record on disk (upstream's fields, plus the
  session's `profile`, `profileFolder`, `profileWanted` — see Task 6), the public record
  (`publicRecord`: no `claim`, `tries`, `moved`; `held` as a count; `returning`), a log entry, `GET`
  and `POST /api/archive` bodies and answers, the `archive` action's answer;
- `LaunchView.resume` and `Config.archiveUndoSec` (`src/core/types.ts`), `BoardPayload.archive`
  (`{ log }`, `src/core/payload.ts`);
- `web/i18n-archive.js` → `src/core/i18n/archive-strings.ts`, merged in `strings.ts` as upstream
  does;
- tests: "what may go to the archive" and "a tidy-up … searched by every word" →
  `test/core/archive.test.ts`; `catch-up-strings.test.ts` reads `web/i18n-archive.js` too (its
  `FILES`) and lists `2b9e6b7`.

No profile ruling here (Task 6 has them). Commit "Catch up: Archive: take sessions off the board,
and bring them back (model and texts)".

### Task 6: #56, part 2 — the server, the CLI and the resume

Port the rest of 2b9e6b7 that is not the page:
- `src/archive.mjs` → `src/adapters/archive-store.ts` (records under the cards' per-file lock,
  `updateJson`; the log, 60 kept) and `src/services/archive.ts` (`freeToClose`, `askArchive`,
  `holdEntries`, `closeDue`/`closeOne`, `retry`, `keep`, `putBack`, `restoreHeld`, `takeBack`,
  `markReturning`, `settleReturned`, `forgetArchived`, and the server's `bringBack`);
- `archiveDir()` (`src/adapters/paths.ts`); `restoreEntry` (`src/adapters/schedule-store.ts`);
- the scheduler (`src/services/scheduler.ts`): `closeDue` on each tick, the soonest close counted,
  the archive folder watched; `collect` (`src/services/board.ts`): archived items hidden,
  `settleReturned` for one back in another pane;
- the server: the `archive` action (`routes/session.ts`, also in the origin and stale lists),
  `GET`/`POST /api/archive` (new `routes/archive.ts`), `undoMs` from `archiveUndoSec`, the archive
  folder watched, `archive: { log }` first in the board payload (`board-state.ts`);
- the launch resume: `{resume}` in `PLACEHOLDERS` (`core/launch/launcher-command.ts`); `start(body,
  items, { resume })` with no message, no `/rename`, its own id as the card, the card kept on
  dismiss, `resume` in the view (`services/launch/{launches,run,launcher,request}.ts`); a
  `launch.command` without `{resume}` falls back to the board's spawn-agent; `launch.agent` whose
  args pick a session refuses (`archive.err.cannotResume`);
- spawn-agent `--resume <uuid>` (`core/launch/spawn-args.ts` `parseArgs`,
  `services/launch/spawn-agent.ts`, USAGE): not with `--session-id`, no `/rename`, refused when the
  command picks its own session;
- `board archive --session <id|name|pane>` (`src/entrypoints/cli.ts`, USAGE), never the session
  itself, closed at once (`grace: 0`);
- the skill's added line (`skills/herdr-agents/SKILL.md`; `install.test.ts` pin → `2b9e6b7`);
- the tests: `test/archive.test.mjs`'s server, CLI and `{resume}` tests →
  `test/server/archive.test.ts` and `test/core/launcher-command.test.ts`; `spawn.test`'s `--resume`
  → `test/entrypoints/spawn-agent.test.ts`; `fake-herdr`'s `{ until, then }` →
  `test/support/fake-herdr.ts`.

README: none here (Task 7 has #56's whole README hunk).

Profile rules (rulings, wrong account first):
- **Return resumes in the session's own profile, or not at all.** The record keeps the item's
  `profile`, `profileFolder` and `profileWanted` at archive time (else Return reads them from the
  session's card, `sessionProfile`). `bringBack` asks `launchTarget(undefined, <the record as the
  parent>, profiles)`: the session's own profile, hidden or not, never another. `checkRequest` gets
  that parent explicitly (the archived session is not among the board's items, which would make it
  "a parent the board does not know"). The start then runs through the board's launch path as any
  start in that profile does: `CLAUDE_CONFIG_DIR` from `configDir`, `--config-dir`/`--keep-env` to
  spawn-agent, the profile's start command and args, the pane recorded (`notePane`), so later wakes
  pass `mayWake`.
- **The transcript is looked up in that profile's home only** (`deps.homes.forDir(profile.dir)`
  `transcriptPath`, then `cwdOf`). Not there: with one profile, upstream's `archive.err.noTranscript`;
  with several, `archive.err.noTranscript` when no profile's home has it, `archive.err.profile`
  when another one's has it.
- **Refused up front, nothing started:** no known profile (`unknownParent`, a `profileWanted`
  mismatch, a profile no longer listed) → `markReturning(key, null)` and a new key (in
  `src/core/i18n/profile-strings.ts`):
  - `archive.err.profile` — en "“{name}” stays in the archive: the board cannot be sure which
    Claude profile it ran in ({profile}), and it never resumes a session in a guessed one. Resume
    it yourself in its profile: claude --resume {session}"; ru "«{name}» остаётся в архиве: доска
    не уверена, в каком профиле Claude она работала ({profile}), а угадывать профиль она не станет.
    Продолжи её сам в её профиле: claude --resume {session}".
- **Archiving** closes a pane and never starts anything, so it needs no wake guard. Its readiness
  (`readyToSleep`) reads the session's registry in its own profile's home, as today. A session
  whose profile the board cannot tell is not archived (it could not come back safely): `freeToClose`
  maps that refusal of `readyToSleep` to a new reason instead of `archive.why.herdr`:
  - `archive.why.profile` — en "Its Claude profile is not known ({why}): it could not come back from
    the archive in the right account"; ru "Её профиль Claude неизвестен ({why}): из архива её не
    вернуть в нужном аккаунте".
- Held schedule entries go back as upstream says; when they run, they wake through the existing
  guards. "Remove from archive" deletes the board's card and context files, never Claude's folders.
- `board archive` from an agent reads the target's registry in the target's profile, not the CLI
  process's own `CLAUDE_CONFIG_DIR`.
- Tests: a Return in a second profile starts with its `CLAUDE_CONFIG_DIR` and records the pane; a
  Return of a session whose profile is unknown is refused and starts nothing; the transcript is
  found in its profile's home and not in `~/.claude`; one profile is upstream's run exactly.

**Addendum from #59 (f0cef14, commit 479815e), moved here so #59 is off the critical path.**
Upstream #59 makes Return and `spawn-agent --resume` resume "with the session's own
CLAUDE_CONFIG_DIR". The rules above already do that for Return (stricter: refused when unsure).
Also, for `spawn-agent --resume <uuid>`:
- `--config-dir` / `--keep-env` stay the board's decision, as today.
- With `--profile p`: p's home must hold the transcript, else refused before herdr is called.
- With neither: the one listed profile (hidden included) whose home holds the transcript; none →
  `archive.err.noTranscript`; two or more → refused. Never a fallback to the inherited env or the
  agent's own folder.
- Each refusal has a reason in English and Russian («ты») and comes before any worktree, workspace,
  tab or Claude. `profileWant` is written to the card for `--resume` too.
- Tests (`test/entrypoints/spawn-agent.test.ts`): `--resume` of a work transcript → `--env` work;
  `--profile default` + a work transcript → refused before herdr; not found → refused. Return: a
  default session on a board whose env is default → no `--env` (upstream test 2's "~/.claude
  without the variable").
Planner's analysis of #59: `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.claude/worktrees/catchup-f0cef14/.superpowers/catch-up-f0cef14-p59.md` (rulings R1–R9).

Commit "Catch up: Archive: take sessions off the board, and bring them back".

### Task 7: #56, part 3 — the archive on the web board

Starts after lane C merged Task 5's commit. Port the rest of 2b9e6b7 (`web/app.js`, `index.html`,
`board-menus.js`, `menu-model.js`, `launch.js`) and #56's whole README hunk:
- `hooks/useArchive.ts` (new): `archiveSession`, `archiveMany`, `returnSessions`, `offerReturn`,
  `postArchive`, `tidyItems`, `noteArchive` (a `kept` said once), `lastArchived` and Ctrl+Z
  (`useBoardKeys`/`board-keys`); `archiving` and `flyBack` in the page's state; the cards out of the
  board at once (`board-view`), back on a refused archive;
- the flights: into the Archive button and out of it, its nod (springs, reduced motion);
- `components/archive/ArchivePanel.tsx` (new) in `SidePanels.tsx`: search, rows by day, Return,
  Remove in two clicks, the tidy offer, read on open and on each board change while open; the
  toolbar's `#archive-open` (`Toolbar.tsx`); `panel.test.tsx`'s top-level ids gain `archive-sheet`;
- toasts with an action and a duration, `hide()` (`state/board-ui.ts`, `Toast.tsx`);
- menus: Archive on a card (`archiveWhy`), `columnMenu` for "Idle", the tidy submenu in a lane's
  menu, `archiveOpen` on the board's (`menu-model.ts`, `board-menus.ts` `forColumn`,
  `useContextMenus.ts`); `data-col` on the column heads (`ColumnsHead.tsx`);
- the sheet's Archive button (`Composer.tsx`, `models/sheet.ts`: hidden, title, disabled by
  `archiveBlock`; `Sheet.tsx`);
- the launch card of a Return ("back", `archive.step`; Retry is Return again: `LaunchCard.tsx`,
  `models/launch.ts`, `useLaunch.ts`); the archive's API in `web/src/api/client.ts`; icons;
- the tests: `archive.test`'s menus test → `test/web/archive-menus.test.ts`; the panel's markup
  against upstream's `archiveRowHTML`/`renderArchive` at `2b9e6b7` → `test/web/archive.test.tsx`;
  pins moved to `2b9e6b7`: board (`old-board.ts` `LATER`), menus (`board-menu-sides.ts`,
  `menu.test.ts`, `terminal.test.tsx` `cardMenu`), the sheet's page and head (`old-sheet.ts`), the
  launch card.

Profile rules (rulings):
- With more than one profile shown, an archive row carries the session's profile tag
  (`ProfileTag`, from the record's profile facts), as its card did; with one profile, none: the
  page is upstream's byte for byte.
- Return's refusals come from the server (Task 6) and show as upstream's toasts do.

No CSS (Task 2). Commit "Catch up: Archive: take sessions off the board, and bring them back (web)".

### Task 8: #57 — archive by dragging a card

In lane C2 (from lane C after Task 7). Port 98e1f7a:
- `dropsOn` → `web/src/models/archive-drop.ts` (new; a geometry rule of the page only);
- the drop place: `components/DropArchive.tsx` (new, mounted by `Board.tsx`): comes up with a
  mouse drag (spring), lit while over, the reason when the session may not go;
- `useCardDrag.ts`: over the place (with slop) or flicked at it, no lane target meanwhile, no
  autoscroll; let go: `dropInArchive` (the ghost into the place) and `archiveSession(key, { fly:
  false })` (`useArchive.ts`); a refused one says why and the card goes back;
- README; the test → `test/web/archive-drop.test.ts`; drag parity pins, if any, to `98e1f7a`.

UI only: the same archive action and its rulings (Task 6). No CSS (Task 2). Commit "Catch up:
Archive by dragging a card onto a place that comes up with the drag".

### Task 9: #58 — the row shows as many actions as fit

In lane C, beside Task 8. Port b2c5afa:
- `web/row-model.js` → `web/src/models/row-model.ts` (`fitRow`), exactly;
- `hooks/useActionRow.ts` (new): `PRIORITY`, widths taken once per set of buttons, language and
  layout (`measuring`, words then icons in one task), `icons` and `over` classes, More `over` when
  nothing is left over, refit on resize, on a button shown or hidden, on a language change and on
  the narrow-sheet query; on a phone Terminal stays under More;
- `Composer.tsx`: the buttons in upstream's new order (Changes and History after Terminal);
- More lists the `.over` buttons (`board-menus.ts`, `useContextMenus.ts`);
- `mokupilot.call` → "MokuPilot" / "MokuPilot" (`strings.ts`); README;
- tests: `test/row-model.test.mjs` → `test/web/row-model.test.ts`; `menu.test`'s label; pins to
  `b2c5afa`: the sheet's page (`old-sheet.ts`), More (`menu-actions.test.ts`), `cardMenu`
  (`menu.test.ts`, `terminal.test.tsx`, `board-menu-sides.ts`); `catch-up-strings` lists `b2c5afa`.

UI only. No CSS (Task 2). Commit "Catch up: Session panel row shows as many actions as fit, the
rest under More".

### Task 10: Integration

In the catch-up worktree (`feature/catchup-main-f0cef14`), once every lane is reviewed:
1. `git merge --no-ff` lanes A, B, D, E, C, C2, in that order, each with a plain message ("Merge lane
   B: queued messages in the thread", …). Resolve the conflicts the Lanes section lists by keeping
   both sides; anything else is a seam: report it.
2. Pins: every parity pin a lane left on an intermediate merge (`b5a96b8`, `3105958`, `8745585`,
   `2b9e6b7`, `98e1f7a`) moves to `b2c5afa`, and `style-attributes.test.ts` `UPSTREAM_REF` too. A
   test that fails there is a seam between lanes: fix the code, never keep the old pin.
   `catch-up-strings` `MERGES` is the union, in upstream order.
3. `bun test` green, `bun run check` clean; commit the fixes as plain sentences.

### Task P: #59 — Respect CLAUDE_CONFIG_DIR and Claude profiles beside ~/.claude

Port f0cef14 (commit 479815e), **without its resume part**: that is Task 6's addendum (lane D).
Runs in lane E, in parallel with the other lanes, from the base. Most of it is already
on the branch (multi-profile phase 2, catch-up 513e441 Task 1). Port only what is missing, and
cite the rest in the report. Read the planner's table:
`C:/migo/development/projects/external/mokuhub/herdr-agent-board/.claude/worktrees/catchup-f0cef14/.superpowers/catch-up-f0cef14-p59.md`.

What to port:
- **Discovery** (`src/adapters/profiles.ts` `findProfileDirs`):
  - a `~/.claude-<name>` folder also counts when it holds `sessions/`;
  - a `<name>` with a dot in it is not found;
  - the default folder's rule is unchanged.
- **install**: `status line in <settings.json>: left as it was (not ours)`, as upstream prints it.
- **`board` CLI**: own name and a target's cwd (`src/entrypoints/cli.ts:107,129,144`) read every
  listed profile's registry and the inherited one, the inherited one first (as `:539`).
- **README**:
  - the "What it finds" paragraph: folders with `sessions/` too, no dotted names;
  - after Setup step 1's profiles paragraph: "A session brought back from the archive runs in
    its own profile again" (with R5's refusals in a sentence);
  - MokuPilot stays "refused outside the board's profile";
  - mirror the "found automatically" line in `docs/superpowers/specs/2026-10-18-multi-profile-design.md:96`.
- **Not ported, with reasons in the report:**
  - MokuPilot child env (R8);
  - install into every found folder (R3);
  - recent folders of hidden profiles (R4);
  - upstream's `profileEnv` / `configDirOf` (R6, R7);
  - the setup check's detail prefix (R9).

Profile rules: discovery only finds folders; it never decides a session's profile. Nothing here
starts, resumes or wakes a session. Keep R3 (install into shown profiles only), R4, R6–R9 as the
planner's file says. The README sentence about a session brought back from the archive describes
Task 6's rule (its own profile, refused when unsure).

Tests (bun:test, temp homes via `test/support/env.ts isolatedHome`, fake herdr):
- `test/adapters/profiles.test.ts`: upstream test 1's folder set. These are found: `.claude-work/sessions`,
  `.claude-moku/projects`. These are not: `.claude-empty`, the dir `.claude.json.bak-x`, the file
  `.claude-file`, `.claude-x.bak/projects`.
- `test/entrypoints/install.test.ts:91`: the new message.
- `test/entrypoints/cli.test.ts`: a target in another profile gets its cwd from that profile's registry.
- Upstream test 3 (doctor per profile) is covered by `test/core/setup.test.ts:409-455` and
  `test/adapters/setup-facts.test.ts:125-145`. Say so; no new test.

Commit "Catch up: Respect CLAUDE_CONFIG_DIR and Claude profiles beside ~/.claude".

### Task 11: Final seams review

A whole-branch review from `738b30f` to the head: every hunk of #52–#58 ported or
ruled, the lanes' seams (the composer row with the queue's foot, the archive with the row and its
More, the drop place with the drag), the profile rulings of Tasks 3, 6 and 7 against the
multi-profile spec, the one-profile page byte for byte, commit messages. Fixes are new subagents,
one commit each, plain sentences.

## Estimate

Calibration from the last catch-up (sequential): #50 208 lines → 15 min; #48+#46+#47 220 →
25; #49 419 → 19; #51 995 (web, server, CLI) → 40 + 8 review; a fix round ~6 + re-review ~6; final
review 14. Upstream lines are diff lines, tests and README included.

| Task | Lane | PR | Upstream lines | Implementer | Review | Expected fix round |
|---|---|---|---|---|---|---|
| 1 | A | #52 | 121 | 12 | 4 | — |
| 2 | A | CSS #53–#58 | 122 | 8 | 3 | — |
| 3 | B | #53 | 458 | 28 | 6 | 12 |
| 4 | C | #54 + #55 | 51 | 14 | 4 | — |
| 5 | D | #56 model, texts | ~250 | 10 | 3 | — |
| 6 | D | #56 server, CLI, launch | ~1,100 | 50 | 9 | 12 |
| 7 | C | #56 web | ~720 | 45 | 9 | 12 |
| 8 | C2 | #57 | 147 | 15 | 4 | — |
| 9 | C | #58 | 126 | 15 | 4 | — |
| 10 | — | integration | — | 15 | 5 | — |
| 11 | — | final seams review | — | — | 18 | 12 |

| Lane / step | Minutes |
|---|---|
| A | 27 |
| B | 46 |
| C (critical): 4 → 7 → 9 | 18 + 66 + 19 = 103 |
| C2 (beside Task 9) | 19 |
| D | 84 |
| Integration (Task 10) | 20 |
| Final seams review (Task 11) with one fix round | 30 |
| **Critical path** (lane C → 10 → 11), Task P not counted | **~153 min (~2 h 35)**; ~129 without fix rounds |
| The same tasks one after another, for comparison | ~330 min (~5 h 30) |

Task P (#59) sits between Tasks 10 and 11 and adds its own time to the critical path.
