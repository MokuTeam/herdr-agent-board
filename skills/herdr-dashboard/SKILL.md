---
name: herdr-dashboard
description: "Inspect and operate the agent-board dashboard for Herdr: explain cards, usage and setup checks; configure categories, Claude profiles and UI; manage board reminders and recurring schedules; choose the supported CLI or local HTTP operation. Use when the user asks about agent-board or the Herdr dashboard."
---

# Herdr dashboard

Use this as a router, not as a replacement for Herdr's own instructions.

1. Identify the requested operation and the actual dashboard instance. A preview, the
   registered plugin, `board` on PATH and the session's hooks can point to different code or
   state. Read [discovery](references/discovery.md) before making that assumption.
2. Choose the narrow reference:

   | Task | Read |
   | --- | --- |
   | Explain a card, Usage or Setup; change lanes, profiles or presentation | [Dashboard operations](references/operations.md) |
   | Create, inspect, change or cancel a reminder/cron entry | [Schedule lifecycle](references/schedule.md) |
   | Integrate with the local web server | [HTTP API](references/http-api.md) |
   | Find the running copy; verify or undo an authorized change | [Discovery and verification](references/discovery.md) |

3. For raw Herdr pane/agent/workspace control, run `herdr --skill` and follow its caller-context
   rules. For a Claude session's spawn, messaging, restart and MCP-recovery workflow, read the
   existing `herdr-agents` skill installed by this plugin. Do not invent another version of
   those interfaces or assume optional messaging tools are present.
4. Match the user's authorized scope. Inspection does not imply permission to create jobs,
   message another session, answer its permission dialog, install hooks or grant folder trust.
   Reuse authorization already given; do not add a confirmation roundtrip for an already
   authorized, unambiguous action. If scope is missing, prepare the exact target and change
   before asking.
5. Resolve live session keys and profile context; use the intended instance's CLI/env or HTTP
   origin. Never substitute the focused pane, another profile or another machine after an error.
6. Verify the persisted state and the actual outcome. A saved schedule is not a delivered
   prompt; a delivered prompt is not completed work. An uncertain send is not permission to
   send it again. Report the operation, target, evidence and any remaining limitation.

Keep tokens, credentials, environment dumps and unrelated conversations out of reports.
Category/profile visibility is not access control. Do not start a second scheduler against
live state just to test the UI; use fixtures for inspection and tests.

This optional skill is a complete folder: retain `references/` beside `SKILL.md` when copying
it to an agent's skill directory. The plugin installer installs `herdr-agents`, not this folder.
No script, MCP server, account access or schedule is installed by this documentation.
