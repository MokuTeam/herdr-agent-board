# Verifying a done

The board's default checklist for a verifier (#492). It is general: most threads are not pull
requests. A lane whose work is code names `verify-checklist-code.md` in `threads.verify.brief`.

- **Each acceptance line has evidence you looked at yourself.** Open the file, the record, the run,
  the page, the pull request. The worker's word, its summary or its report is never the evidence.
- **Each claim in the done entry is checked against the thing it names.** "Updated the record" means
  you read the record now; "the test passes" means you ran it or read its run; "sent" means you see
  it sent.
- **The whole task is there.** Read what the thread asked, all of it, and say for each part whether
  it is done. Half of a task is a fail, whatever the summary says.
- **Nothing changed outside the task.** Look at what changed (a diff, the record's history, the
  folder) for things the task did not ask for.
- **Say plainly what you could not check, and why.** No access, no tool, a system that does not
  answer: that is an `unsure` verdict with the reason, never a pass on trust and never a fail for
  something you could not see.

Tests: run single test files, never a whole suite on a shared machine, unless your checklist says
otherwise.

A pass needs a report (`--file`): one line per acceptance line and per point above, each with what
you looked at.
