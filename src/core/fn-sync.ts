// The MokuTab functions registry synced between the owner's machines through the master (#864),
// agreed with MokuTab's maintainer: the functions folder stays MokuTab's git repository, read by
// its bridge on every run; commits travel as they are (their authors too, a vault function's
// hand-made commit and every chrome_fn_save); a machine only fast-forwards, and only with its
// tracked files clean. A machine whose branch went another way than the registry's (diverged), or
// with changes not committed, gets nothing written: the sync stops there and says so, and the
// diverged commit is kept in the master's hub so nothing is lost. No I/O here: adapters/fn-git.ts
// runs git, services/nodes/fn-sync.ts the rounds, services/node/fn-sync.ts a machine's side.
import type { SetupCheck } from './setup.ts'
import { fileScanText, secretHit } from './team-agents.ts'
import type { Translator } from './types.ts'

/** A file of the registry larger than this is refused, and with it the commits that bring it. */
export const FN_MAX_FILE_BYTES = 256 * 1024
/** The registry's tree, at most this many bytes and files. */
export const FN_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const FN_MAX_FILES = 2000

/** What a machine says of its functions folder. */
export type FnLook =
  | { state: 'none' }
  | { state: 'empty' }
  | { state: 'not-repo' }
  | { state: 'repo'; branch: string; head: string; dirty: string[] }

/** What the hub knows of the machine's commit. */
export interface FnRelation {
  /** The hub has the machine's commit. */
  known: boolean
  /** The machine's commit is in the registry's history (it is behind, or current). */
  behind: boolean
  /** The registry's commit is in the machine's history (it is ahead). */
  ahead: boolean
}

/**
 * What a round does with one machine:
 * - `skip`: no folder there; `current`; `fetch`: its new commits come up first (then decided again);
 * - `seed`: the hub has nothing yet, the machine's branch becomes the registry;
 * - `take`: the registry fast-forwards to the machine's commit;
 * - `give`: the machine fast-forwards to the registry's; `clone`: an empty folder gets it;
 * - `stop` with why: `not-repo`, `branch` (another branch checked out), `dirty`, `diverged`.
 */
export type FnAction =
  | { do: 'skip' | 'current' | 'fetch' | 'seed' | 'take' | 'give' | 'clone' }
  | { do: 'stop'; why: 'not-repo' | 'branch' | 'dirty' | 'diverged' }

export function decide(o: {
  look: FnLook
  hub: { branch: string; head: string } | null
  relation: FnRelation | null
}): FnAction {
  const { look, hub, relation } = o
  if (look.state === 'none') return { do: 'skip' }
  if (look.state === 'not-repo') return { do: 'stop', why: 'not-repo' }
  if (look.state === 'empty') return hub ? { do: 'clone' } : { do: 'skip' }
  if (!hub) return { do: 'seed' }
  if (look.branch !== hub.branch) return { do: 'stop', why: 'branch' }
  if (look.head === hub.head) return { do: 'current' }
  if (!relation?.known) return { do: 'fetch' }
  if (relation.ahead) return { do: 'take' }
  if (relation.behind) return look.dirty.length ? { do: 'stop', why: 'dirty' } : { do: 'give' }
  return { do: 'stop', why: 'diverged' }
}

/** What the board will not carry, by path: too large, a secret by its check, or the tree too big. */
export interface FnRefused {
  path: string
  why: string
}

/** The stop reasons with words of their own (`fnSync.stop.*`); any other (a node's HTTP status) is shown as it is. */
const STOP_SAID = new Set(['not-repo', 'branch', 'dirty', 'diverged', 'refused', 'git', 'not-ff', 'too-big'])

/**
 * `board doctor` on a master, from its sync's record (`<state>/fn-sync/state.json`): the machines
 * the sync stopped at and why, the files it refused; null while there is nothing to say (no registry
 * yet, no machine stopped: a master with nodes but no MokuTab folder anywhere). Never a file's
 * contents: the record holds none.
 */
export function fnSyncCheck(raw: unknown, t: Translator): SetupCheck | null {
  if (typeof raw !== 'object' || raw === null) return null
  const machines = (raw as { machines?: unknown }).machines
  if (typeof machines !== 'object' || machines === null) return null
  const stopped: string[] = []
  const refused: string[] = []
  for (const [id, m] of Object.entries(machines as Record<string, unknown>)) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as { stop?: unknown; refused?: unknown }
    if (typeof r.stop === 'string')
      stopped.push(`${id} (${STOP_SAID.has(r.stop) ? t(`fnSync.stop.${r.stop}`) : r.stop.slice(0, 40)})`)
    if (Array.isArray(r.refused))
      for (const x of r.refused)
        if (typeof x === 'object' && x !== null)
          refused.push(`${String((x as FnRefused).path)} on ${id} (${String((x as FnRefused).why)})`)
  }
  const said = [
    stopped.length ? t('fnSync.doctor.stopped', { list: stopped.join(', ') }) : '',
    refused.length ? t('fnSync.doctor.refused', { list: refused.join(', ') }) : '',
  ].filter(Boolean)
  const head = (raw as { head?: unknown }).head
  if (!said.length && typeof head !== 'string') return null
  return {
    id: 'fn-sync',
    level: said.length ? 'warn' : 'ok',
    title: t('fnSync.doctor'),
    detail: said.length
      ? said.join('; ')
      : t('fnSync.doctor.ok', { head: typeof head === 'string' ? head.slice(0, 8) : '-' }),
    fix: said.length ? t('fnSync.doctor.fix') : '',
    code: '',
  }
}

/** Why the board will not carry a file's bytes, or null: too large, or a secret by the board's check. */
export function refusalOf(bytes: Uint8Array): string | null {
  if (bytes.length > FN_MAX_FILE_BYTES) return 'too-large'
  const text = fileScanText(bytes)
  const hit = text === null ? null : secretHit(text)
  return hit ? `secret: ${hit}` : null
}
