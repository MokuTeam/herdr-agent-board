# Verifying a done: code

For lanes whose work is code: name this file in `threads.verify.brief` (`{ "<lane>":
"docs/agents/verify-checklist-code.md" }`). It is the general checklist (`verify-checklist.md`)
plus what experiment #308 found a code reviewer must check on the commit itself.

- **Each acceptance line has evidence you looked at yourself**, each claim in the done entry checked
  against the commit, the run or the pull request it names; what you could not check said plainly
  (an `unsure` verdict).
- **No duplicate.** Search the open pull requests and issues for the same change
  (`gh pr list --search`, `gh issue list --search`). Work that repeats an open pull request is a fail.
- **The whole issue.** Read the issue's scope and "done when"; each point is in the change or the
  verdict says which is missing.
- **The new test proves the fix.** It fails on the base and passes on the head: run that one test
  file against the base's sources and against the head.
- **The named code really changed.** The function or file the summary names is in the diff, changed
  the way the summary says.
- **Suite parity.** The pull request names what it ran and what already failed on the base; check the
  claim with single files where you can. Never run a whole suite on a shared machine.
- **One commit to revert.** The change reverts cleanly as one commit (or one squash), with nothing
  outside the task in it.

A pass needs a report (`--file`): one line per acceptance line and per point above, each with what
you looked at.
