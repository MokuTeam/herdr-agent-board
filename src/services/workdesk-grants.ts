// WORKDESK-95 (#936): the workflow grant of a claimed Workdesk round. Workdesk keeps only the
// SHA-256 of a `wdplan_` bearer the board generates (`grant_task_workflow`, board credential); the
// bearer itself must reach the assigned native master session and no one else. The board has no
// such channel yet: its own caller identity (`/mcp` headers, the `board` command) is what the
// caller says, and the protected Codex recipient (#444) is not here. So nothing is granted until a
// recipient channel is given that attests the exact session: without one this module makes no
// call at all, and the watcher goes down the path it went before. The bearer lives in this process
// only, never in a thread, prompt, log, file, environment or argument.
import { createHash, randomBytes } from 'node:crypto'
import type { BoardDb } from '../adapters/db.ts'
import { getThread } from '../adapters/work-thread-store.ts'
import { WorkdeskToolError } from '../adapters/workdesk-mcp.ts'
import { workdeskHandoffReader } from '../adapters/workdesk-store.ts'
import type { Item } from '../core/types.ts'
import { object, type WorkdeskTask } from '../core/workdesk.ts'
import { stableWorkdeskSid, workdeskAgent } from '../core/workdesk-topology.ts'

/** The one round a bearer opens: the claimed card, its assignment and revision, and its master. */
export type GrantRound = {
  taskId: number
  assignmentId: string
  revision: number
  executor: string
  sessionKey: string
  sid: string
}

/**
 * A private way to the one native session of a round. `attest` says it can reach exactly that
 * session (its SID, on this computer) and nothing else; `deliver` hands it the bearer; `revoke`
 * tells it to drop the bearer of a round that is over. None exists on the board today.
 */
export type RecipientChannel = {
  attest(round: GrantRound): boolean | Promise<boolean>
  deliver(round: GrantRound, bearer: string): boolean | Promise<boolean>
  revoke(round: GrantRound): void | Promise<void>
}

export type GrantProblem = 'unverified' | 'unattested' | 'grant' | 'conflict' | 'closed' | 'delivery'

type Mcp = { call(name: string, args: Record<string, unknown>): Promise<unknown> }
type Held = { round: GrantRound; bearer: string; digest: string; granted: boolean; delivered: boolean }
type Binding = { assignment_id: string; executor: string; thread_id: string; sid: string; revision: number }

export const GRANT_TOOL = 'grant_task_workflow'

/** `wdplan_` and 32 random bytes as unpadded base64url (43 characters), as Workdesk reads it. */
export const workflowBearer = (): string => `wdplan_${randomBytes(32).toString('base64url')}`
export const bearerDigest = (bearer: string): string => createHash('sha256').update(bearer).digest('hex')

const sameRound = (a: GrantRound, b: GrantRound): boolean =>
  a.taskId === b.taskId &&
  a.assignmentId === b.assignmentId &&
  a.revision === b.revision &&
  a.executor === b.executor &&
  a.sessionKey === b.sessionKey &&
  a.sid === b.sid

const errorCode = (err: unknown): unknown => (err instanceof WorkdeskToolError ? err.body?.code : undefined)

/**
 * The round of a listed card, checked against what the board itself stored at the claim (the
 * handoff, the dialog binding, the thread's assignee) and the one local session that holds that
 * SID now. Null when any of them disagrees: a node's session, a pane key without a SID, a SID
 * another session took, a round the binding does not name.
 */
export function verifiedRound(db: BoardDb, task: WorkdeskTask, items: readonly Item[] | null): GrantRound | null {
  if (!task.assignment || !task.executor || task.status === 'queued') return null
  const handoff = workdeskHandoffReader(db)(task.id)
  if (!handoff?.thread_id || handoff.executor !== task.executor) return null
  const binding = db.db
    .query<Binding, [number]>(
      'SELECT assignment_id, executor, thread_id, sid, revision FROM workdesk_dialog_bindings WHERE task_id = ?',
    )
    .get(task.id)
  if (
    !binding ||
    binding.assignment_id !== task.assignment.id ||
    binding.revision !== task.assignment.revision ||
    binding.executor !== task.executor ||
    binding.thread_id !== handoff.thread_id ||
    !stableWorkdeskSid(binding.sid)
  )
    return null
  const thread = getThread(db, handoff.thread_id)
  if (
    thread?.assignee?.kind !== 'session' ||
    thread.assignee.key !== handoff.session_key ||
    thread.assignee.name !== task.executor
  )
    return null
  const matches = (items ?? []).filter(item => item.session === binding.sid || item.key === handoff.session_key)
  const item = matches[0]
  if (
    matches.length !== 1 ||
    !item ||
    item.device !== undefined ||
    item.session !== binding.sid ||
    item.key !== handoff.session_key ||
    item.name !== task.executor ||
    !workdeskAgent(item.agent)
  )
    return null
  return {
    taskId: task.id,
    assignmentId: task.assignment.id,
    revision: task.assignment.revision,
    executor: task.executor,
    sessionKey: handoff.session_key,
    sid: binding.sid,
  }
}

export function createWorkflowGrants(channel: RecipientChannel | null) {
  const held = new Map<number, Held>()

  async function drop(taskId: number): Promise<void> {
    const entry = held.get(taskId)
    if (!entry) return
    held.delete(taskId)
    entry.bearer = ''
    if (entry.delivered && channel) {
      try {
        await channel.revoke(entry.round)
      } catch {}
    }
  }

  return {
    /** Whether a grant can be issued at all: a recipient channel and a Workdesk that grants. */
    enabled: (tools: ReadonlyMap<string, unknown>): boolean => channel !== null && tools.has(GRANT_TOOL),

    /** The digest held for a card (tests and diagnostics); never the bearer. */
    digest: (taskId: number): string | null => held.get(taskId)?.digest ?? null,

    /**
     * Forget every round the complete list no longer names as current: a card gone from the list
     * (accepted, closed, cancelled), a new assignment or revision, another executor. Workdesk
     * expires its side itself on rework, cancellation and acceptance.
     */
    async reconcile(tasks: readonly WorkdeskTask[]): Promise<void> {
      const current = new Map(tasks.map(task => [task.id, task]))
      for (const [taskId, entry] of [...held]) {
        const task = current.get(taskId)
        if (
          !task?.assignment ||
          task.status === 'queued' ||
          task.executor !== entry.round.executor ||
          task.assignment.id !== entry.round.assignmentId ||
          task.assignment.revision !== entry.round.revision
        )
          await drop(taskId)
      }
    },

    /**
     * Grant and deliver the round of one card, once. A retry reuses the bearer and digest of the
     * same round; a different round first drops the old one. Nothing reaches Workdesk before the
     * channel attests the session.
     */
    async issue(mcp: Mcp, round: GrantRound | null): Promise<GrantProblem | null> {
      if (!channel) return null
      if (!round) return 'unverified'
      const prior = held.get(round.taskId)
      if (prior && !sameRound(prior.round, round)) await drop(round.taskId)
      const entry = held.get(round.taskId)
      if (entry?.delivered) return null
      let attested = false
      try {
        attested = (await channel.attest(round)) === true
      } catch {}
      if (!attested) return 'unattested'
      const next =
        entry ??
        (() => {
          const bearer = workflowBearer()
          const made: Held = { round, bearer, digest: bearerDigest(bearer), granted: false, delivered: false }
          held.set(round.taskId, made)
          return made
        })()
      if (!next.granted) {
        try {
          const result = object(
            await mcp.call(GRANT_TOOL, {
              task_id: round.taskId,
              assignment_id: round.assignmentId,
              revision: round.revision,
              executor: round.executor,
              token_hash: next.digest,
            }),
          )
          if (result?.granted !== true) return 'grant'
        } catch (err) {
          const code = errorCode(err)
          // A digest Workdesk does not know for this round (a restart lost the bearer) or a round
          // that is over: drop it; the next round gets a fresh bearer.
          if (code === 'workflow_grant_conflict' || code === 'workflow_closed' || code === 'assignment_mismatch') {
            await drop(round.taskId)
            return code === 'workflow_grant_conflict' ? 'conflict' : 'closed'
          }
          return 'grant'
        }
        next.granted = true
      }
      let delivered = false
      try {
        delivered = (await channel.deliver(round, next.bearer)) === true
      } catch {}
      if (!delivered) return 'delivery'
      next.delivered = true
      return null
    },

    /** Drop every bearer (the watcher stops or its configuration changes). */
    async clear(): Promise<void> {
      for (const taskId of [...held.keys()]) await drop(taskId)
    },
  }
}

export type WorkflowGrants = ReturnType<typeof createWorkflowGrants>
