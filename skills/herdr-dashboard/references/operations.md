# Find the existing feature documentation

The repository already has a detailed README. Read the matching section in the **running
checkout**; the online links below point to current `main`, which can be newer than that
installation. This index is not a second feature manual.

| Task | Canonical README section |
| --- | --- |
| Cards, Usage, Setup and presentation | [Web board](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#web-board), [Setup](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#setup) |
| Account folders, hidden profiles and start commands | [Claude profiles](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#claude-profiles) |
| Categories and configuration | [Web board](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#web-board), [Settings](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#settings) |
| Start sessions or helpers | [New sessions](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#new-sessions), [spawn-agent](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#spawn-agent), [Helpers](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#helpers-and-linked-sessions) |
| Questions, permissions and messages | [Answering from the board](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#answering-from-the-board) |
| Reminders or restart | [Schedule](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#schedule), [Restart](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#restart); use the [agent checklist](schedule.md) |
| Archive, return or terminal input | [Archive](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#archive), [Terminal](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#terminal) |
| Card commands and call reports | [Agents](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#agents), [Retry-safe call exports](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md#retry-safe-call-exports-opt-in) |

For command syntax use this instance's `board --help`; for raw Herdr workspace/pane controls
use `herdr --skill`. A category, a Claude profile and a Herdr workspace are different targets;
resolve which one the user means before selecting a write operation.

When diagnosing a value, inspect its origin instead of inferring a cause from a label:

- Card age: `web/src/models/card.ts` and `web/src/models/attention.ts` select the timestamp;
  `src/core/types.ts` describes the card fields. Compare the actual card with those rules.
- Usage: `web/src/models/limits.ts` interprets the reading; check its source, timestamp and
  stale flag. Missing data does not establish zero usage or an account-login failure.
- Setup: `src/services/setup-check.ts` collects the facts and `src/core/setup.ts` evaluates
  them. A preview can intentionally differ from the installed commands/hooks. Diagnose that
  mismatch before running an installer.

Use [discovery](discovery.md) to establish the instance and [the route index](http-api.md)
when an authorized operation needs HTTP. Keep behavior, defaults and limits in README;
update this file only when the navigation or diagnostic decision changes.
