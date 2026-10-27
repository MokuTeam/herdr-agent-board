// What the Remote access panel shows of setting up the server (AccessView.server): the admin
// connection's fields, what sudo needs, where Look, Apply or Undo stands, what Look found, the
// case, the plan, a run's progress, why something stopped, the server's key the admin login met,
// and the setup on record. Never a password. Pure, with no node: import: the page imports it.
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
  // the admin's login by password (the simple-setup spec's "The admin login by password")
  | 'loginPassword'
  | 'wrongLogin'
  | 'rootLogin'
  | 'keyOnly'
  | 'otherPrompt'
  | 'sshOld'
  | 'sudoPassword'
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
  /**
   * The server's key as the admin's login met it ('SHA256:… (ED25519)'), and whether that login
   * pinned it (the first one does, call 2); null before a login went through.
   */
  hostKey: { fingerprint: string; pinnedNow: boolean } | null
  /**
   * What the last Look was for: the tunnel's web server, or the board installed on the server
   * itself (path B of the board on a server, core/server-install.ts); none: the tunnel's.
   */
  target?: 'tunnel' | 'install'
  /** Path B: the board's code it sends, the install's output, the setup link (in memory only), its exit. */
  install?: InstallView | null
}

export interface InstallView {
  from: { commit: string; changes: boolean }
  out: string[]
  /** The setup link the install printed, kept apart from its output until the panel closes. */
  link: string | null
  code: number | null
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
  'loginPassword',
  'wrongLogin',
  'rootLogin',
  'keyOnly',
  'otherPrompt',
  'sshOld',
  'sudoPassword',
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

const isHostKey = (v: unknown): boolean => isFields(v) && isText(v.fingerprint) && typeof v.pinnedNow === 'boolean'

const isInstall = (v: unknown): boolean =>
  isFields(v) &&
  isFields(v.from) &&
  isText(v.from.commit) &&
  Array.isArray(v.out) &&
  (v.link === null || isText(v.link)) &&
  (v.code === null || typeof v.code === 'number')

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
    (v.testAfter === null || Array.isArray(v.testAfter)) &&
    (v.hostKey === null || isHostKey(v.hostKey)) &&
    (v.target === undefined || v.target === 'tunnel' || v.target === 'install') &&
    (v.install === undefined || v.install === null || isInstall(v.install))
  )
}
