# Working on agent-board

For people and agents changing this repository. What the board does and how to run it is in
[README.md](README.md); how the code is laid out is under [Development](README.md#development).

## An issue first

Several people and their agents work on the board at once. So that two of them do not build the
same thing, every change starts from an issue:

- **Look first.** Before you start, search the open issues and pull requests
  (`gh issue list --search "<words>"`, `gh pr list --search "<words>"`), closed ones too when the
  subject may have been settled. Someone already on it: work with them, on their issue, instead of
  starting your own.
- **No issue yet: open one** before you write code: what is wrong or missing, and what the change
  will do. Say in it who works on it.
- **Work by it.** The branch and the pull request refer to the issue (`Closes #<n>` in the pull
  request), and what comes up on the way goes into the issue, so the next person finds it there.
  A finding outside your task gets an issue of its own instead of a change in passing.

## Everyone's setup, not yours

The board runs on many machines, each set up its own way: Windows, macOS and Linux; Claude Code
alone, or other agents in herdr beside it (pi, and Claude Code through pi's bridge); one Claude
profile or several; with or without herdr-wake, MokuPilot, notifications. A change that fixes
your setup must leave every other one as it was.

- **Gate what is for one setup.** A change for one agent, bridge, OS or tool runs only where that
  setup is recognised (an environment variable, what herdr says the pane runs, the platform). Every
  other setup goes down exactly the code it went down before, with no new calls on its way: a hook
  that runs on every prompt of every session does not ask herdr for anything a plain Claude
  session does not need.
- **Show it is the same for the others.** Where the change touches something every setup goes
  through (routing, hooks, cards, the `board` command, the herdr adapter), compare old and new on
  what the other setups send: Claude session ids, `pane-<id>` keys, Windows paths, names with
  spaces, other alphabets and `%`. Say in the pull request what you compared and what came out.
- **Tests that prove the fix.** A new test fails on `main` and passes with the change (run it
  against `main`'s files: `git show origin/main:<file> > <file>`, then put yours back). Cover the
  setups the change must not touch too, not only the one it is for.
- **The suite stays as it was.** `bun run test` and `bun run check` before the pull request. A test
  that already fails on `main` on your machine is named in the pull request, not fixed in passing
  or hidden.
- **Say who it touches.** The pull request says which setups the change is for, which ones it
  leaves alone, and how you know.

## Running the tests

While working, run the files that cover what you change (`bun test test/server/routes.test.ts`,
seconds). Before the pull request, run the whole suite once with `bun run test`: four Bun workers
(`--parallel=4`), about 6 minutes and about 3 GB at its peak on an 8-core Windows laptop. One heavy
run at a time on a machine others share.

- `bun run test:fast`: all but the end-to-end files, `*.e2e.test.ts`, which run the real sh, awk
  and PowerShell. `bun run test:e2e`: only those.
- A bare `bun test` still runs everything, one file after another in one process: several times
  slower, and its memory grows with the run.
- `test/timings.json` holds each file's time, so the workers start the slowest first. After adding
  a slow file, refresh it: `bun run test --update-timings`.
- Bun 1.4 does not read `bunfig.toml`'s `timeout`: in a bare `bun test` a test without a timeout
  of its own has 5 s, in the scripts 30 s (`--timeout=30000`).

Waits meant for a real Claude cost a test against the fake herdr seconds for nothing. Such a
test sets `BOARD_TEST_PACE` (`src/core/pace.ts`): the board's polls and pauses run at that
fraction (`0.02` in the tests), its deadlines as written. What a test waits out on purpose (a lock
that stays held, a wake that stays slow) has a knob of its own: `BOARD_LOCK_TIMEOUT_MS`,
`BOARD_WAKE_ANSWER_MS`, `BOARD_NAMED_WAIT_MS`, `BOARD_TEAM_JOIN_MS`,
`BOARD_WAKE_START_DEADLINE_MS`, `BOARD_WAKE_ROUND_MS`. Unset in production; set them only in tests.
