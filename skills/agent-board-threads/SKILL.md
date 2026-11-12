---
name: agent-board-threads
description: "How a Claude session works with the board's threads (board thread): hand work to other sessions as threads and hear one line when each one moves, instead of reading their full reports; report your own work in the thread you were given (status, summary, a report as a file); ask the owner a question in a thread; read a long thread through a fork or a subagent; watch threads, a lane or your own; catch up after a compaction or a sleep. Load it when you hand work out, when your brief names a thread key like atlas-12, or when a [board reminder from threads] line arrives."
---

<!-- agent-board: installed by the agent-board plugin's install action; it replaces this file on updates. -->

# Working by threads

A thread is a task with a memory, kept by the board: a key (`atlas-12`), a title, a one-line summary of where it stands, a status, an assignee, and a feed of entries. Workers write their progress and results into the thread; whoever handed the work out hears one line per change, and reads more only when it asks. That keeps reports out of a long-lived session's context, where every later turn would read them again.

`board thread list` says whether threads are on: "threads are off" means nothing here applies, and you report the way your brief says.

## Keys and statuses

- A key is the lane and a number: `atlas-12`. It never changes, also when the thread moves to another lane. Name threads by their key when you talk about them. Commands also take a bare number in your own lane (`12`) and the first 8 characters of a thread's id.
- Statuses: `next` (not started), `doing`, `waiting` (on something outside: a client, CI, a date; `--waiting` says what), `owner` (waits on the owner: an answer, a decision, a step that is theirs), `done`, `dropped` (will not be done).
- A thread may have sub-threads, one level only, 20 at most. When the last open one closes, the parent's feed says so and its watchers hear it.
- Every write prints one line (`ok · atlas-13 · done · 1 file`) and every command takes `--json`.

## When you were given a thread

Your brief names a key ("work in thread atlas-13"). Report there, not to whoever gave it to you:

- `board thread post atlas-13 --status doing --summary "<where it stands, one line>"` when you start or reach a step worth knowing.
- `board thread post atlas-13 --status done --summary "217 rows mapped, 3 flagged in the report" --file out/report.md` when you finish. The summary is the one line the others hear: make it say the result. A report longer than a few lines goes as `--file` (five files at most, 5 MB each); the board keeps a copy, so a worktree removed later does not take it along. `board thread done atlas-13 "<summary>" --file out/report.md` is the short form.
- `--status waiting --waiting "<on what>"` when you are blocked on something outside the board.
- `board thread ask atlas-13 "<question for the owner>"` when you need the owner's answer or decision. The thread waits on the owner and your card moves to "needs the user", as `board ask` does. When the owner answers in your terminal, record the answer with `board thread post`.
- Text without flags is a note in the feed: `board thread post atlas-13 "the 2019 sheet has two header rows"`; text that starts with `--` goes after a lone `--`. Links: `--link <url>` (http, https, a thread key or a local path). A flag a command does not take is refused: read the error and fix the flag.
- Do not send the full report to your master as a message as well. It hears your summary in one line and reads the rest only if it needs to.
- `done` on a thread that waits on the owner is only proposed: the owner confirms it on the board.

## When you hand work out

- `board thread new "<title>"` makes a thread in your lane (`--lane <id>` for another); `--to <session>` gives it to a session by its name and marks it `doing`; `--parent <key>` makes it a sub-thread of a larger piece of work.
- Put the key in the worker's brief and say how to report: "Work in thread atlas-13: post your status and result there with board thread post (a report as --file), send me nothing else."
- You watch every thread you create: each status change arrives as one line, `[board reminder from threads] atlas-13 done: 217 rows mapped, 3 flagged in the report. More: board thread changes`. Several changes arrive as one line, three threads spelled out and "and N more"; you never hear of your own changes.
- `board thread changes` prints what changed since you last asked, one line per thread; `--peek` leaves your place where it was. Past 20 threads it shows the newest and marks nothing read: `board thread changes --all` lists them all.
- `board thread list` shows the open threads of your lane, `--mine` the ones you created, were given or watch, `--lane <id>`, `--all` every lane, `--done` the closed ones too. `board thread show <key>` prints the head and the last five entries, cut short; `--since <n>` the entries after number n, `--last <n>`.
- `board thread set <key> --assignee <session|none> | --title "<t>" | --lane <id> | --parent <key|none>` changes the head.

## Reading a long thread

`board thread show <key> --full` prints every entry whole. Do not run it in a long-lived session: send a fork or a subagent to run it (and to read the files it lists by path) and bring back the few lines you need. A file is listed as its name, size and path, never its content.

## Watching

- `board thread watch <key> | --lane <id> | --mine` adds a watch; `board thread unwatch` with the same target removes it.
- `--what status` (the default: status changes and the owner's answers), `asks` (also questions raised for the owner), `all` (every entry).
- `--idle`: the line waits until your turn is over instead of arriving in it. `--wake`: a line wakes you when you sleep; without it the line waits until you are awake, which is the default, since waking a session costs more than a status line is worth.
- The board leaves a gap of a minute between two lines to one session; what changes meanwhile joins the next line.

## After a compaction or a sleep

`board thread list --mine` gives back what you were working on, and `board thread changes` what moved while you were away.

## What the board does on its own

- Who wrote an entry is set from where the write came from: a `board` command run in your session writes as you, never as the owner or another session.
- An entry is never changed or removed: a correction is a new entry.
- `board thread link <key>` prints the thread's address on the board, to put in a message to the owner as a markdown link; `board thread open <key>` raises the board's window.
