// What the Remote access panel shows of setting up the server (AccessView.server): the admin
// connection's fields, what sudo needs, where Look, Apply or Undo stands, what Look found, the
// case, the plan, a run's progress, why something stopped, and the setup on record. Never the sudo
// password. Pure, with no node: import: the page imports it.
import type { ServerFacts } from './server-facts.ts'
import type { Choice, Plan, SetupCase } from './server-plan.ts'
import type { Progress } from './server-script.ts'
import type { TestStep } from './tunnel.ts'

/** How the admin runs as root: is root, sudo without a password, with one, sudo refusing without a terminal, or no sudo. */
export type SudoMode = 'root' | 'nopasswd' | 'password' | 'requiretty' | 'none'
/** Why the admin connection or a run stopped, for the panel's hint. */
export type AdminHint =
  | 'publickey'
  | 'tooMany'
  | 'noHostKey'
  | 'hostKey'
  | 'needPassword'
  | 'wrongPassword'
  | 'requiretty'
  | 'notSudoer'
  | 'network'
  | 'noSsh'
  | 'aptLock'
  | 'pullLimit'
  | 'changed'
  | 'busy'
  | 'lost'
  | 'unreadable'
  | 'lookAgain'
export type ServerPhase = 'idle' | 'looking' | 'plan' | 'applying' | 'undoing' | 'done' | 'failed'

export interface ServerView {
  admin: { user: string; key: string }
  sudo: SudoMode | null
  phase: ServerPhase
  facts: ServerFacts | null
  choice: Choice | null
  plan: Plan | null
  progress: Progress | null
  hint: AdminHint | null
  error: string | null
  setup: { case: SetupCase; address: string; at: string } | null
  testAfter: TestStep[] | null
}

const SUDO: ReadonlySet<unknown> = new Set(['root', 'nopasswd', 'password', 'requiretty', 'none'])
const PHASES: ReadonlySet<unknown> = new Set(['idle', 'looking', 'plan', 'applying', 'undoing', 'done', 'failed'])
const HINTS: ReadonlySet<unknown> = new Set([
  'publickey',
  'tooMany',
  'noHostKey',
  'hostKey',
  'needPassword',
  'wrongPassword',
  'requiretty',
  'notSudoer',
  'network',
  'noSsh',
  'aptLock',
  'pullLimit',
  'changed',
  'busy',
  'lost',
  'unreadable',
  'lookAgain',
])
const CASES: ReadonlySet<unknown> = new Set(['1', '1b', '2', '3a', '3b', '4a', '4b'])

type Fields = Record<string, unknown>
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const fieldsOrNull = (v: unknown): boolean => v === null || isFields(v)

const isChoice = (v: unknown): boolean =>
  isFields(v) && (CASES.has(v.case) ? isFields(v.why) : v.case === null && Array.isArray(v.why))

const isPlan = (v: unknown): boolean =>
  isFields(v) && isText(v.id) && isText(v.kind) && isText(v.address) && Array.isArray(v.steps) && Array.isArray(v.ticks)

const isProgress = (v: unknown): boolean => isFields(v) && Array.isArray(v.steps) && Array.isArray(v.undo)

const isSetup = (v: unknown): boolean => isFields(v) && CASES.has(v.case) && isText(v.address) && isText(v.at)

/** The view's `server` as the board sends it, as far as the panel relies on it. */
export function isServerView(v: unknown): v is ServerView {
  return (
    isFields(v) &&
    isFields(v.admin) &&
    isText(v.admin.user) &&
    isText(v.admin.key) &&
    (v.sudo === null || SUDO.has(v.sudo)) &&
    PHASES.has(v.phase) &&
    fieldsOrNull(v.facts) &&
    (v.choice === null || isChoice(v.choice)) &&
    (v.plan === null || isPlan(v.plan)) &&
    (v.progress === null || isProgress(v.progress)) &&
    (v.hint === null || HINTS.has(v.hint)) &&
    (v.error === null || isText(v.error)) &&
    (v.setup === null || isSetup(v.setup)) &&
    (v.testAfter === null || Array.isArray(v.testAfter))
  )
}
