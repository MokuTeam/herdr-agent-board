# Schedule: agent checklist

Use the running checkout's README **Schedule**, **Restart** and **Agents** sections for
syntax, supported operations, limits, time zones and delivery behavior. The online
[Schedule reference](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#schedule)
tracks `main`, not necessarily the running build. `board --help` is the installed syntax.
This page adds a verification workflow, not another copy of the scheduler's constants.

1. Resolve the intended instance and live recipient using [discovery](discovery.md). Confirm
   that the requested text, destination, time/zone and delivery mode are within the user's
   existing authorization. A schedule grants no additional permissions.
2. Inspect existing entries with `board schedule` (caller) or `board schedule --all` before
   creating a possible duplicate. Use the CLI to create; the UI/API's supported changes are
   documented in README. Do not invent edit, pause or run-now operations.
3. Create once. Record the returned ID, saved text, target, mode and next timestamp in UTC and
   the intended local zone. Check the saved definition; do not assume the full input survived
   normalization or that a scheduler-running warning means creation failed.
4. Verify delivery in `scheduleLog` and then inspect the recipient's result. Saved, delivered
   and completed are separate outcomes. A bounded recent log is not a permanent audit trail.
5. For a text/time replacement, retain the previous definition, check whether delivery is in
   flight, cancel by ID and verify absence before creating the replacement. Cancellation
   cannot retract a prompt already sent. An uncertain cancellation needs inspection first.
6. Do not replay an uncertain send or restore old schedule JSON over a live scheduler. Review
   the README's at-least-once behavior and inspect resulting side effects before any retry.

A restart and a MokuPilot call report have their own workflows. Follow the installed
`herdr-agents` skill and README **Restart** / **Retry-safe call exports**; their bookkeeping
must not be edited as an ordinary reminder.

If behavior changes, verify against `src/entrypoints/cli.ts`, `src/core/when.ts`,
`src/core/schedule-rules.ts`, `src/adapters/schedule-store.ts`, `src/services/scheduler.ts`
and `src/server/routes/schedule.ts`. Update the canonical README first, then this checklist
only if the required decisions or verification steps changed.
