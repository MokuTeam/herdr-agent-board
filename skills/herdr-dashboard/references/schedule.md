# Schedule lifecycle

A schedule delivers a prompt to a Claude session. It is not a shell cron runner or a separate
agent, and it grants no additional permissions. The board's scheduler must run: normally in
the web server, or in the TUI with `web:false`. Entries survive a recipient restart. Read the
[README's Schedule and Restart sections](https://github.com/MokuTeam/herdr-agent-board/blob/feature/ts-rework/README.md#schedule)
for the full delivery rules; this page is the operation checklist.

## Supported operations

| Operation | Interface | Important limit |
| --- | --- | --- |
| Inspect | `board schedule`, `board schedule --all`, Schedule UI, GET `/api/board` | No separate schedule-list HTTP endpoint. |
| Create one-off | `board remind <when> "<text>" [--idle] [--session <target>]` | Creates a future delivery; not a dry run. |
| Create recurrence | `board every "<five-field cron>" "<text>" [--idle] [--session <target>]` | Minimum interval 5 minutes; at most 30 entries per session. |
| Change delivery mode | UI On time / When free; POST `/api/schedule` `{op:"mode",id,idle:true/false}` | When free is not pause. Restart entries always wait; mode changes are refused. |
| Cancel | `board unschedule <id>`; UI confirmation; POST `{op:"cancel",id}` | Cannot retract a prompt already delivered. |
| Cancel caller's entries | `board unschedule all` (optionally a verified `--session`) | `all` is per session, not a global purge. |
| Edit text/time | Cancel and recreate with a new ID | No dedicated edit endpoint or form; inspect due/in-flight state first. |
| Pause/resume, run now, end date/count | Not implemented as schedule operations | Do not invent flags, API ops or UI buttons. A direct message is a separate delivery. |

The UI currently views, cancels and changes the delivery mode. Creation is through the CLI.
Other entry kinds exist: `board restart` and MokuPilot call reports; do not treat them as
ordinary reminder entries or change their internal bookkeeping by hand.

## Create deliberately and verify

1. Confirm the task text, destination, time/zone and delivery mode are authorized. Use the
   [correct instance](discovery.md), then resolve its live session identity and profile.
   Without `--session`, the CLI needs the caller's session/pane context. A UUID, exact name or
   pane can be selected; prefer the verified session identity over a display-name guess.
2. Write a bounded instruction that tolerates redelivery. Do not include credentials. Ordinary
   text is capped at 2000 characters (longer text is truncated); keep it shorter and inspect
   the saved text rather than assuming the entire input survived.
3. Create once. These examples mutate the caller's schedule; run only the selected one:

   ```sh
   board remind in 30m "Review the agreed build result and report here" --idle
   board every "0 9 * * 1-5" "Summarize the agreed local checks in this session" --idle
   ```

4. Record returned ID, exact target/text/mode and next time. Re-read `board schedule` or
   `/api/board` and verify `next` in UTC and the intended local zone. A scheduler-not-running
   warning means the entry was saved but will wait until a scheduler runs.
5. Check `scheduleLog` or the state directory's `schedule/log.jsonl`, then inspect the target
   session's actual result. A stored entry, a successful HTTP request or a `sent` log is not
   proof that the requested work completed.

## Time zones and delivery

- Relative and unzoned absolute CLI times use the creating process's local time zone. Cron's
  later occurrences use the running scheduler's local time zone. The browser displays local
  dates too. Verify these environments agree; there is no per-entry IANA zone field.
  Setting `TZ` only for the CLI does not retarget an already-running scheduler's cron clock.
- An ISO one-off timestamp with an explicit offset is an absolute moment. A date alone means
  09:00; a bare clock time means its next occurrence. Cron accepts five fields and the aliases
  listed in README, not a seconds field. No `COUNT`/`UNTIL` command options exist.
- Default tick: 15 seconds. Default On time can queue into a running turn; `--idle` waits until
  free. A recognized dialog or a user draft holds delivery in either mode.
- Default `scheduleWaitMin`: 240 minutes of trying. At that limit a missed one-off is removed;
  a cron run is logged missed and advances. Time the board was off does not consume the budget.
- After downtime, a late one-off can deliver once and missed cron periods coalesce into one
  prompt. Three consecutive gone-target cron runs drop the entry.
- Sleeping sessions need herdr-wake. At most two wake concurrently. A cross-profile target is
  held/refused when the board cannot establish that waking in its pane preserves its profile;
  bypassing that check can resume the wrong account.
- After `/clear`, an entry can follow the successor session in the same pane and folder. Check
  `movedFrom` and the current target; the original UUID is not an unconditional lifetime binding.
- Delivery is **at least once**. A crash after typing but before recording may redeliver after
  the five-minute claim expires. Investigate uncertain side effects before retrying a send.
- The recent log is bounded (the API reads the newest records; disk compaction retains recent
  history), not a permanent audit trail. Export necessary receipts under the user's data policy.

## Change or recover

For a text/time edit, save the previous definition, check whether a delivery is in flight,
cancel its ID, verify absence, then create the replacement and record its new ID. Cancellation
cannot undo an action already taken. Do not restore old JSON entries to simulate pause or undo:
that can replay work. If cancellation's outcome is uncertain, inspect state before recreating.

A restart waits for a free session and ends process-local jobs; it requires working herdr-wake
and the same profile guards. Use installed `herdr-agents` and README “Restart” for that workflow.
`board call-report --session <id> --file <report.md> [--report-id <stable-id>]` is the separate
receipt-aware MokuPilot report path; its deduplication is not an exactly-once guarantee for
ordinary reminders. See README “Retry-safe call exports”.

Source map: `src/entrypoints/cli.ts`, `src/core/when.ts`, `src/core/schedule-rules.ts`,
`src/adapters/schedule-store.ts`, `src/services/scheduler.ts`, `src/server/routes/schedule.ts`.
