// The Remote access panel's "On the server" (components/access/ServerSetup.tsx), in words: the
// one flow (the board's address, the server, the login and its password, Set up the server), the
// plan in plain words (core/server-plain.ts) with the full plan as its details (what Look found,
// the case, the steps with what each touches and what Undo takes back), a run's progress, why it
// stopped and what was rolled back, the setup on record; and for a server the board does not do,
// the steps by hand: the plan Look made as commands, or the plan for the case the owner picks
// (Call 28), its unknowns as `<placeholders>` with the commands that find them. What the part keeps
// while the panel is open (SetupState, the passwords among it) is never stored: they go to the
// board with Look, Apply and Undo only, and with the panel as it closes. The board's side of it
// (ServerView, the `server-*` ops) is services/server-setup.ts's.

import { needFor } from '../../../src/core/server-admin.ts'
import type { Holder, ServerFacts } from '../../../src/core/server-facts.ts'
import { BOARD_USER, installWill, serverWanted } from '../../../src/core/server-install.ts'
import { fenceDiff } from '../../../src/core/server-look.ts'
import { type PlainPlan, plainPlan } from '../../../src/core/server-plain.ts'
import {
  buildPlan,
  type Choice,
  manualFacts,
  type Plan,
  placeholderFinders,
  type SetupCase,
  setupRecord,
  type Text,
  type Touch,
  undoPlan,
  type Wanted,
} from '../../../src/core/server-plan.ts'
import { doItMyself, type ManualBlock, type Progress } from '../../../src/core/server-script.ts'
import type { AdminHint, ServerView } from '../../../src/core/server-view.ts'
import type { TunnelConfig } from '../../../src/core/tunnel.ts'
import type { Translator } from '../../../src/core/types.ts'
import { timeOf } from '../../../src/core/when-format.ts'
import { serverSnippets } from './access.ts'
import { ONESHOT_IDLE, type OneshotGot } from './server-oneshot.ts'

/** Which password field a hint of the board's asks for (core/server-admin.ts), for the page. */
export { needFor }

/** The distributions "Do it myself" without Look writes Docker's install for. */
export type Distro = 'debian' | 'ubuntu'

/** A password field an answer asks for: the login's, or sudo's own. */
export type Need = 'password' | 'sudoPassword'

/** What the part keeps while the panel is open: drawn anew (and so gone) as the panel closes. */
export interface SetupState {
  /**
   * The login's password as typed (sudo's too, call 3): sent with each Look, Apply or Undo, kept
   * nowhere else, and forgotten once the board took it for a run (Undo asks for it again, call 9).
   */
  password: string
  /** sudo's own password, once an answer asked for it: sent as the login's is. */
  sudoPassword: string
  /** The field an answer asked for (`need`); null when none is asked. */
  need: Need | null
  /** sudo's own field shown: an answer asked for it once. */
  sudoAsked: boolean
  /** How many times a field was asked for: each time the field is emptied and focused. */
  asks: number
  /**
   * What Continue (and Enter in a password field) sends: Look, Undo's Look while Undo's ask stands,
   * or the Look of "Install the board on this server" while its ask stands.
   */
  again: 'server-look' | 'server-undo-look' | 'server-install-look'
  /** Set up the server was clicked without the board's address: said so until the address is there. */
  missing: boolean
  /** Install the board on this server was clicked without its own address: said so until it is there. */
  installAsked: boolean
  /** The board's refusal of the address of the board on the server as typed ('' when none): shown under its field. */
  installRefused: string
  /** The plan's ticks. */
  docker: boolean
  removeDocker: boolean
  removeEdited: boolean
  /** Undo clicked once: the next click asks the board for the Undo plan. */
  undoArmed: boolean
  /** "Do it myself (one command)" open, and the command as the board made it. */
  oneshot: boolean
  got: OneshotGot
  /** The public port Test connection found the board on after the command (443 or 8443); null before it did. */
  byHand: number | null
  /** The steps by hand, for a server the board does not do: the case picked and the distribution (null: Look's, else Debian). */
  pick: SetupCase
  distro: Distro | null
}

export const SETUP_START: SetupState = {
  password: '',
  sudoPassword: '',
  need: null,
  sudoAsked: false,
  asks: 0,
  again: 'server-look',
  missing: false,
  installAsked: false,
  installRefused: '',
  docker: false,
  removeDocker: false,
  removeEdited: false,
  undoArmed: false,
  oneshot: false,
  got: ONESHOT_IDLE,
  byHand: null,
  pick: '1',
  distro: null,
}

/** The step 3 of a board that has said nothing of the server yet: nothing looked at, no admin. */
export const SERVER_IDLE: ServerView = {
  admin: { user: '', key: '' },
  sudo: null,
  phase: 'idle',
  facts: null,
  choice: null,
  plan: null,
  progress: null,
  hint: null,
  error: null,
  setup: null,
  testAfter: null,
  hostKey: null,
}

/** A text of the core's (its key and values) in the panel's language. */
export const textLine = (x: Text, t: Translator): string => t(x.key, x.params ?? {})

const capitalize = (s: string): string => (s ? (s[0] as string).toUpperCase() + s.slice(1) : s)

/** Who holds a port, in a few words: free, `caddy (caddy.service)`, `"web-caddy-1" in Docker (caddy:2, compose "web")`. */
function holderText(f: ServerFacts, h: Holder, t: Translator): string {
  switch (h.kind) {
    case 'free':
      return t('server.panel.holder.free')
    case 'unit':
      return `${h.program} (${h.unit})`
    case 'process':
      return h.program
    case 'split':
      return h.programs.join(' + ')
    case 'container': {
      const c = f.docker?.containers.find(x => x.id === h.id)
      const name = c ? c.name.replace(/^\//, '') : h.id.slice(0, 12)
      const image = c?.image ?? h.program
      const project = c?.labels['com.docker.compose.project']
      return project
        ? t('server.panel.holder.compose', { name, image, project })
        : t('server.panel.holder.container', { name, image })
    }
  }
}

const sameHolder = (a: Holder, b: Holder): boolean => JSON.stringify(a) === JSON.stringify(b)

/** sshd's keys that differ, a few named (a fence not read at all would name all seventeen). */
function fenceKeys(diff: string[]): string {
  return diff.length > 4 ? `${diff.slice(0, 4).join(', ')}, …` : diff.join(', ')
}

/**
 * What Look found, a line each: the distribution · Docker · who holds 443 and 80; the tunnel's
 * fence in sshd against the panel's Match block (for `user`); the socket's folder; their Caddy's
 * config, when Look found one.
 */
export function foundLines(f: ServerFacts, t: Translator, user: string): string[] {
  const distro = [
    `${capitalize(f.distro.id)} ${f.distro.version}`.trim(),
    ...(f.distro.supported ? [] : [t('server.panel.unsupported')]),
  ]
  const docker = f.docker ? t('server.panel.docker', { version: f.docker.version }) : t('server.panel.noDocker')
  const [h443, h80] = [f.ports[443], f.ports[80]]
  const ports = sameHolder(h443, h80)
    ? t('server.panel.ports.both', { holder: holderText(f, h443, t) })
    : t('server.panel.ports.each', { h443: holderText(f, h443, t), h80: holderText(f, h80, t) })
  const lines = [[distro.join(' '), docker, ports].join(' · ')]
  const diff = fenceDiff(f.fence, user)
  lines.push(diff.length ? t('server.panel.fence.differs', { keys: fenceKeys(diff) }) : t('server.panel.fence.ok'))
  const folder = f.folder
  if (!folder) lines.push(t('server.panel.folder.none'))
  else {
    const ok = folder.mode === '2750' && folder.owner === user
    const params = { mode: folder.mode, owner: folder.owner, group: folder.group }
    lines.push(t(ok ? 'server.panel.folder.ok' : 'server.panel.folder.off', params))
  }
  const c = f.caddy
  if (c) {
    const how = c.where === 'unit' ? 'unit' : (c.mount ?? 'none')
    lines.push(
      t('server.panel.config', {
        path: c.hostPath ?? c.config,
        how: t(`server.panel.mount.${how}`),
        version: c.version,
      }),
    )
  }
  return lines
}

/** The case Look's facts make, in one line ('' when the board leaves it to the owner). */
export const caseLine = (c: Choice, t: Translator): string => (c.case === null ? '' : textLine(c.why, t))

/** Why the board leaves it to the owner, a line each. */
export const manualReasons = (c: Choice, t: Translator): string[] =>
  c.case === null ? c.why.map(m => t(`server.manual.${m}`)) : []

/** A step of a run: 'waiting', 'running 12 s', '✓', '✗', or in place already (skipped). */
export function stepState(p: Progress, n: number, now: number, t: Translator): string {
  const s = p.steps.find(x => x.n === n)
  switch (s?.state) {
    case undefined:
    case 'waiting':
      return t('server.panel.state.waiting')
    case 'running':
      return t('server.panel.state.running', { s: Math.max(0, Math.round((now - (s.since ?? now)) / 1000)) })
    case 'ok':
      return '✓'
    case 'fail':
      return '✗'
    case 'skipped':
      return t('server.panel.state.skipped')
  }
}

/** What a step touches: `file /etc/…` · `container agent-board-caddy` · … ('' for none). */
export const touchLine = (touches: readonly Touch[], t: Translator): string =>
  touches.map(x => t(`server.panel.touch.${x.kind}`, { what: x.what })).join(' · ')

/** What Undo takes back after this plan: what it removes or puts back, then what it reloads ('' for none). */
export function undoLine(p: Plan, t: Translator): string {
  const reloads = p.undoTouches.filter(x => x.kind === 'reload')
  const rest = p.undoTouches.filter(x => x.kind !== 'reload')
  if (!rest.length) return ''
  const line = t('server.panel.undoRemoves', { what: touchLine(rest, t) })
  return reloads.length
    ? `${line} ${t('server.panel.undoReloads', { what: reloads.map(x => x.what).join(', ') })}`
    : line
}

/** Why the admin connection or a run stopped, and what to do: the hints table's line (`server.hint.<hint>`); '' for none. */
export const hintLine = (h: AdminHint | null, t: Translator, admin: string): string =>
  h ? t(`server.hint.${h}`, { admin }) : ''

/** The steps whose failure says something of its own: their Caddy refused the config, kept it, or a site changed. */
const FAIL_HINTS: ReadonlySet<string> = new Set(['validate', 'reload', 'fetch-after'])

/** What a failed step of Apply means ('' when its output says it all). */
export const failHint = (id: string, t: Translator): string => (FAIL_HINTS.has(id) ? t(`server.panel.fail.${id}`) : '')

/** A step's title from the plan, by its number; its id when the plan is not there. */
export function stepTitle(plan: Plan | null, p: Progress | null, n: number, t: Translator): string {
  const step = plan?.steps[n - 1]
  if (step) return textLine(step.title, t)
  return p?.steps.find(s => s.n === n)?.id ?? String(n)
}

/** What a rollback undid, newest first, by the step's number: `✓ <step>` or `✗ <step>`. */
export const rollbackLines = (p: Progress, plan: Plan | null, t: Translator): { n: number; line: string }[] =>
  p.undo.map(u => ({ n: u.n, line: `${u.ok ? '✓' : '✗'} ${stepTitle(plan, p, u.n, t)}` }))

/** The setup on record: "Set up on Oct 21, 10:04 AM: Caddy in Docker". */
export function setupLine(s: NonNullable<ServerView['setup']>, t: Translator): string {
  const ms = Date.parse(s.at)
  const when = Number.isNaN(ms)
    ? s.at
    : `${new Date(ms).toLocaleDateString(t.lang, { day: 'numeric', month: 'short' })}, ${timeOf(ms, t)}`
  return t('server.panel.setUp', { when, case: t(`server.panel.caseName.${s.case}`) })
}

/** What the panel wants on the server: the tunnel's settings that pass their checks (else their defaults, as step 1's snippets). */
export function wantedOf(settings: TunnelConfig): Wanted {
  const { user, socket, domain } = serverSnippets(settings, null)
  return { user, socket, domain, publicPort: settings.publicPort }
}

/** "Do it myself" without Look (Call 28): the plan for a case on facts whose unknowns are `<placeholders>`. */
export function manualPlan(c: SetupCase, w: Wanted, distro: Distro): Plan {
  const built = buildPlan(manualFacts(c, distro), w, { id: 'manual', docker: true })
  if (!('steps' in built)) throw new Error(`no plan for case ${c} without Look: ${built.why.join(', ')}`)
  return built
}

/** The owner's choices of case without Look, as the spec names them; a group of more than one case shows them as variants. */
export const PICKS: readonly { id: 'none' | 'service' | 'docker' | 'other'; cases: readonly SetupCase[] }[] = [
  { id: 'none', cases: ['1'] },
  { id: 'service', cases: ['2'] },
  { id: 'docker', cases: ['3a', '3b'] },
  { id: 'other', cases: ['4b', '4a', '1b'] },
]

export interface Manual {
  /** The blocks to copy, one per step of the plan. */
  blocks: ManualBlock[]
  /** Each `<placeholder>` in them with the command that finds it on the server. */
  finders: { placeholder: string; command: string }[]
  /** No plan from Look: the case comes from the owner's pick. */
  picker: boolean
  /** Why there is no plan to show: the words of the check that refused it (a field's); null with one. */
  error: string | null
}

/** The distribution "Do it myself" writes for: the one picked, else Look's when it is one of the two, else Debian. */
export function distroOf(s: ServerView, state: SetupState): Distro {
  if (state.distro) return state.distro
  const id = s.facts?.distro.id
  return id === 'ubuntu' ? 'ubuntu' : 'debian'
}

/**
 * What "Do it myself" shows: the plan Look made; for another board's setup on the server, that
 * setup's Undo (what the spec offers then); else the plan for the case the owner picked. A plan the
 * core's checks refuse (they throw) gives their words instead of blocks, never a page that fails to draw.
 */
export function manualOf(s: ServerView, settings: TunnelConfig, state: SetupState): Manual {
  const plan = s.plan
  if (plan) return made(false, () => ({ blocks: doItMyself(plan), finders: [] }))
  const facts = s.facts
  const record =
    facts && s.choice?.case === null && s.choice.why.includes('otherSetup') ? setupRecord(facts.record) : null
  if (facts && record)
    return made(false, () => ({
      blocks: doItMyself(undoPlan(record, facts, { id: 'manual', removeDocker: false, removeEdited: false })),
      finders: [],
    }))
  const wanted = wantedOf(settings)
  return made(true, () => ({
    blocks: doItMyself(manualPlan(state.pick, wanted, distroOf(s, state))),
    finders: placeholderFinders(state.pick, wanted.socket),
  }))
}

/** The blocks `make` gives, or the words it was refused in. */
function made(picker: boolean, make: () => Pick<Manual, 'blocks' | 'finders'>): Manual {
  try {
    return { ...make(), picker, error: null }
  } catch (err) {
    return { blocks: [], finders: [], picker, error: err instanceof Error ? err.message : String(err) }
  }
}

/** A plan's tick as the part keeps it. */
export type Tick = Plan['ticks'][number]

/** The tick flipped. */
export function tickPatch(tick: Tick, state: SetupState): Partial<SetupState> {
  switch (tick) {
    case 'docker':
      return { docker: !state.docker }
    case 'removeDocker':
      return { removeDocker: !state.removeDocker }
    case 'removeEdited':
      return { removeEdited: !state.removeEdited }
  }
}

/** What a run's result says on a failure ('' for none, or for a run that applied). */
export function resultLine(p: Progress, t: Translator): string {
  const r = p.result
  return r === 'rolled-back' || r === 'rollback-failed' || r === 'busy' || r === 'changed'
    ? t(`server.panel.result.${r}`)
    : ''
}

/** The passwords go with Look, Apply and Undo, each only once typed: the login's, and sudo's own. */
export const withPassword = (state: SetupState): { password?: string; sudoPassword?: string } => ({
  ...(state.password !== '' && { password: state.password }),
  ...(state.sudoPassword !== '' && { sudoPassword: state.sudoPassword }),
})

/** sudo's own field shows once an answer asked for it, or the board's hint says sudo wants its own (needFor). */
export const sudoField = (s: ServerView, state: SetupState): boolean =>
  state.sudoAsked || needFor(s.hint) === 'sudoPassword'

/** The field the panel points at: the one an answer asked for, else the one the board's hint wants. */
export const neededField = (s: ServerView, state: SetupState): Need | null => state.need ?? needFor(s.hint)

/**
 * What an answer to Look, Apply or Undo changes in the part: a field it asks for (`need`) emptied
 * (the password typed was refused, or none was) and pointed at, with `op` for Continue; any other
 * answer asks for nothing, and Continue is Look again.
 */
export function answerPatch(
  reply: Record<string, unknown> | null,
  op: SetupState['again'] | null,
  state: SetupState,
): Partial<SetupState> {
  const again = op ? { again: op } : {}
  if (reply?.need === 'password') return { need: 'password', password: '', asks: state.asks + 1, ...again }
  if (reply?.need === 'sudoPassword')
    return { need: 'sudoPassword', sudoAsked: true, sudoPassword: '', asks: state.asks + 1, ...again }
  return { need: null, again: 'server-look' }
}

/** The login's fields fold away once a setup is on record, unless a password is asked for. */
export const loginFolded = (s: ServerView, state: SetupState): boolean =>
  s.setup !== null && neededField(s, state) === null && !sudoField(s, state)

/**
 * A field of the admin connection as its edit goes to the board: trimmed; null when unchanged, or
 * when it is what the field shows for none saved (root, for the login): tabbed through, it writes nothing.
 */
export function adminEdit(now: string, typed: string, shown = now): string | null {
  const text = typed.trim()
  return text === now || text === shown ? null : text
}

/** The login the flow uses when none is saved (the one a rented server gives). */
export const DEFAULT_LOGIN = 'root'
/** The tunnel's user on the server when none is set (the board's own login there). */
export const DEFAULT_TUNNEL_USER = 'boardtunnel'

/**
 * What Set up the server fills in before Look, so that only the address, the login and the
 * password are typed: the server from the address, the board's own login on the server; null
 * when nothing is missing (or there is no address to fill from).
 */
export function flowFill(c: TunnelConfig): { host?: string; user?: string } | null {
  if (c.domain === '') return null
  const fill = {
    ...(c.host === '' && { host: c.domain }),
    ...(c.user === '' && { user: DEFAULT_TUNNEL_USER }),
  }
  return Object.keys(fill).length > 0 ? fill : null
}

/**
 * What the board took of the panel's saves since it opened: the tunnel's settings, the admin's
 * fields, and the address of the board on the server (path B) once one was saved.
 */
export interface Took {
  tunnel: Partial<Record<keyof TunnelConfig, unknown>>
  admin: { user?: string; key?: string }
  install?: { domain?: string }
}

/**
 * The saves on their way (a field left just before Set up the server was clicked): Set up waits
 * for them, and goes on from what the board took, not from a view that has not come back yet.
 */
export interface Saves {
  track(sending: Promise<Record<string, unknown> | null>, sent: Partial<Took>): Promise<Record<string, unknown> | null>
  settle(): Promise<Took>
}

export function savesTracker(): Saves {
  const going = new Set<Promise<unknown>>()
  const took: Took = { tunnel: {}, admin: {} }
  return {
    track(sending, sent) {
      const kept = sending.then(reply => {
        if (reply?.ok === true) {
          Object.assign(took.tunnel, sent.tunnel)
          Object.assign(took.admin, sent.admin)
          if (sent.install) took.install = { ...took.install, ...sent.install }
        }
        return reply
      })
      going.add(kept)
      const done = () => void going.delete(kept)
      kept.then(done, done)
      return kept
    },
    async settle() {
      while (going.size > 0) await Promise.allSettled([...going])
      return {
        tunnel: { ...took.tunnel },
        admin: { ...took.admin },
        ...(took.install && { install: { ...took.install } }),
      }
    },
  }
}

/** The plan in plain words for what Look found (core/server-plain.ts); null before Look made one. */
export function plainOf(s: ServerView, settings: TunnelConfig, t: Translator): PlainPlan | null {
  const { facts, plan, choice } = s
  if (!facts) return null
  const made = plan ?? (choice?.case === null ? choice : null)
  if (!made) return null
  if (s.target !== 'install' || !s.install) return plainPlan(facts, made, wantedOf(settings), t)
  // the board installed on the server (path B): its own steps first, then the web server's for its
  // socket at its own domain (the tunnel's, from a board that had none of its own)
  const plain = plainPlan(facts, made, serverWanted(s.installDomain || settings.domain, BOARD_USER), t)
  if (plain.stop) return plain
  const own = installWill(
    {
      user: BOARD_USER,
      // Look reads whether the user is there, not whose it is: the install stops on someone else's
      userThere: facts.stepOne?.user !== null && facts.stepOne?.user !== undefined,
      sudoThere: false,
      sudo: false,
      source: { kind: 'archive', ...s.install.from },
      keysFrom: null,
    },
    t,
  )
  return { ...plain, will: [...own, ...plain.will] }
}

/** The server's key the admin's login met, with whether that login remembered it ('' before one did). */
export const hostKeyLine = (s: ServerView, t: Translator): string =>
  s.hostKey
    ? t(s.hostKey.pinnedNow ? 'server.panel.hostKeyPinned' : 'server.panel.hostKeySeen', {
        fingerprint: s.hostKey.fingerprint,
      })
    : ''

/** The plan's warnings the owner reads before Apply (the domain's DNS, the ports, an unfinished run); the rest are the details'. */
const PLAIN_WARNINGS: ReadonlySet<string> = new Set([
  'server.warn.noDns',
  'server.warn.dns',
  'server.warn.ports',
  'server.warn.interrupted',
])

export const isPlainWarning = (w: Text): boolean => PLAIN_WARNINGS.has(w.key)
