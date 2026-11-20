# Workdesk dialogue cutover

Use this procedure for one pinned Codex handoff. The first cutover is a read-only
check. Keep any owner test event for a separate coordinated step.

## Before the window

1. Record the existing Herdr pane, terminal ID, native SID, working directory and
   Codex profile. Confirm the Workdesk assignment and the original local thread UUID.
   Keep the SID as the explicit `workdeskDialog.legacyBindings[].sessionId` for that task.
2. Prepare and review a reversible server-only patch on a copy of the existing live
   tree. Keep the Board client version and all unrelated local changes. Leave the W1
   configuration, interval and topology intact.
3. Prepare `workdeskDialog.receiver = "launcher"`, its existing `onlyTaskId` and the
   full pin. Leave `workdeskDialog.deliver` absent or false. The read-only mode still
   polls event metadata and exposes a recipient status. It neither reads bodies nor
   acknowledges owner messages.
4. Record the Herdr session and workspace hosting the existing Agent board plugin
   pane. Verify that `pane process-info` shows `run.ts` as the pane process and
   its `tui.ts` child owns the configured Board port. Record the placement and
   the linked plugin's path. The normal coordinator MCP stays configured on Board.

## Attach in the same pane

1. At the agreed window the assigned session's operator uses `/quit` in Codex,
   leaving the pane and shell in place. The Board operator closes only the Agent
   board plugin pane with
   `herdr --session "$HERDR_NAME" plugin pane close "$BOARD_PANE"`. This stops the
   `run.ts` supervisor and its `tui.ts` child. Verify the port is free and the
   old Codex process is gone. Capture the quiescent Board backup and apply the
   reviewed patch and settings. The Herdr server stays running.
2. The assigned session's operator runs the absolute Board entrypoint in the same
   shell, cwd and Codex profile. In zsh, the operator's shell supplies FD 3 from
   an anonymous process substitution. The generator's standard output goes into
   that descriptor and the launcher closes it after reading. For this read-only
   launch the key can be ephemeral. Read-only is fixed for the life of the launcher,
   including a Board child restart, even if someone changes `deliver` in the file.

   ```sh
   bun /absolute/path/to/herdr-agent-board/src/entrypoints/workdesk-dialog-run.ts "$PINNED_NATIVE_SID" \
     3< <(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url") + "\n")')
   ```

   The launcher starts the authenticated App Server and the web Board child. It
   resumes the native SID, installs the MCP on that native thread, and attaches
   Board over child IPC. The stock Codex TUI connects from the same terminal. During
   this window use the web Board and leave the regular Agent board plugin closed.
   A session still present in Herdr, occupied port, mismatching pin or failed
   native resume stops startup.
3. Verify the same pane, terminal ID and SID with Herdr. Inspect the prior history
   in that TUI. Use a read-only `GET /api/board` and the coordinator's metadata
   index. Expect healthy W1, the unchanged web version,
   `workdeskDialog.delivery = "recipient_attached"` and
   `workdeskDialog.deliverEnabled = false`. The App Server's read-only catalog
   must show the dialogue tool for the resumed SID. Stop at any discrepancy.
4. Before the separate event, optionally restart only the supervised Board child by
   sending `SIGUSR1` to the known launcher PID. The launcher retains its sealing
   key, restarts Board, and attaches it again. The Codex App Server and TUI stay
   running. Confirm the same pane and SID and repeat the read-only checks.

## Revert to #443 before any protected delivery

1. Use the agreed window. Exit the protected TUI normally and wait for its launcher
   and both children to stop. Confirm there are no SQLite users or new writes.
   Keep a private SQLite backup.
2. Use `sqlite3 .backup` to make a consistent private v8 copy. Make a second working
   copy for v6 and run the guard and downgrade on that copy:

   ```sh
   sqlite3 -bail "$BOARD_V6_COPY" < docs/workdesk-dialog-rollback.sql
   ```

   Expect `ok` and no foreign-key output. The script preserves ordinary records and the
   metadata cursor. It refuses any sealed message, receipt, protected wake or advanced
   ACK. A refusal leaves the original database and the v8 backup in place.
3. Only with the old children stopped, move the old DB and any WAL/SHM files to the
   private rollback directory and atomically put the verified v6 copy in its place.
   Reverse just the reviewed protected server patch. Remove only `receiver` and
   `deliver` from the dialogue setting. Retain the #443 metadata configuration.
4. The Board operator opens the linked plugin again. For a workspace placement use
   its existing workspace and the original Board checkout.

   ```sh
   herdr --session "$HERDR_NAME" plugin pane open \
     --plugin agent-board --entrypoint board --placement tab --workspace "$BOARD_WORKSPACE" \
     --cwd /absolute/path/to/herdr-agent-board --env AGENT_BOARD_PLACEMENT=workspace --no-focus
   ```

   The assigned operator resumes Codex in the original Codex pane with the same
   SID, cwd, profile and approval settings. Verify the same Codex pane and SID,
   the restored plugin's supervisor and child, and healthy Board with
   `awaiting_recipient`.

A separate content-delivery cutover needs an authorized retained key, supplied as
one unpadded base64url line on FD 3. Both local transport capabilities are generated
anew at startup. Once a real answer has been stored or acknowledged, retain the
protected v8 state and its key. The pre-event schema rollback then refuses the DB.
