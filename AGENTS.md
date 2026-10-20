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
- **The suite stays as it was.** `bun test` and `bun run check` before the pull request. A test
  that already fails on `main` on your machine is named in the pull request, not fixed in passing
  or hidden.
- **Say who it touches.** The pull request says which setups the change is for, which ones it
  leaves alone, and how you know.

## Running the tests

The whole suite takes a few minutes. While working, run the files that cover what you change
(`bun test test/server/routes.test.ts`, seconds); run the whole suite once, before the pull
request.
