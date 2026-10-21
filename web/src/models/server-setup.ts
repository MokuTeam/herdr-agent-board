// The Remote access panel's "On the server", step 3 (components/access/ServerSetup.tsx), in words:
// what Look found (the server, who holds 443 and 80, the tunnel's fence and folder, their Caddy's
// config), the case or why the board leaves it to the owner, the plan's steps with what each
// touches and what Undo takes back, a run's progress, why it stopped and what was rolled back, the
// setup on record, and "Do it myself": the plan Look made, as commands, or without one the plan for
// the case the owner picks (Call 28), its unknowns as `<placeholders>` with the commands that find
// them. What the part keeps while the panel is open (SetupState, the sudo password among it) is
// never stored: it goes to the board with Look, Apply and Undo only, and with the panel as it closes.
// The board's side of it (ServerView, the `server-*` ops) is services/server-setup.ts's.
import type { Holder, ServerFacts } from '../../../src/core/server-facts.ts'
import { fenceDiff } from '../../../src/core/server-look.ts'
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

/** The distributions "Do it myself" without Look writes Docker's install for. */
export type Distro = 'debian' | 'ubuntu'

/** What the part keeps while the panel is open: drawn anew (and so gone) as the panel closes. */
export interface SetupState {
  /** The sudo password as typed: sent with each Look, Apply or Undo, kept nowhere else. */
  password: string
  /** An answer said sudo needs a password (`need: 'password'`); `again` is what Continue sends. */
  asked: boolean
  again: 'server-look' | 'server-undo-look'
  /** The plan's ticks. */
  docker: boolean
  removeDocker: boolean
  removeEdited: boolean
  /** Undo clicked once: the next click asks the board for the Undo plan. */
  undoArmed: boolean
  /** "Do it myself" open; without a plan, the case picked and the distribution (null: Look's, else Debian). */
  manual: boolean
  pick: SetupCase
  distro: Distro | null
}

export const SETUP_START: SetupState = {
  password: '',
  asked: false,
  again: 'server-look',
  docker: false,
  removeDocker: false,
  removeEdited: false,
  undoArmed: false,
  manual: false,
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
}

/** The distribution "Do it myself" writes for: the one picked, else Look's when it is one of the two, else Debian. */
export function distroOf(s: ServerView, state: SetupState): Distro {
  if (state.distro) return state.distro
  const id = s.facts?.distro.id
  return id === 'ubuntu' ? 'ubuntu' : 'debian'
}

/**
 * What "Do it myself" shows: the plan Look made; for another board's setup on the server, that
 * setup's Undo (what the spec offers then); else the plan for the case the owner picked.
 */
export function manualOf(s: ServerView, settings: TunnelConfig, state: SetupState): Manual {
  if (s.plan) return { blocks: doItMyself(s.plan), finders: [], picker: false }
  const record =
    s.facts && s.choice?.case === null && s.choice.why.includes('otherSetup') ? setupRecord(s.facts.record) : null
  if (s.facts && record) {
    const undo = undoPlan(record, s.facts, { id: 'manual', removeDocker: false, removeEdited: false })
    return { blocks: doItMyself(undo), finders: [], picker: false }
  }
  const plan = manualPlan(state.pick, wantedOf(settings), distroOf(s, state))
  return { blocks: doItMyself(plan), finders: placeholderFinders(state.pick), picker: true }
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

/** The sudo password goes with a request only once typed. */
export const withPassword = (state: SetupState): { password?: string } =>
  state.password === '' ? {} : { password: state.password }

/** The password field shows once sudo is known to want one, or an answer or hint said so. */
export const asksPassword = (s: ServerView, state: SetupState): boolean =>
  s.sudo === 'password' || state.asked || s.hint === 'needPassword' || s.hint === 'wrongPassword'

/** A field of the admin connection as its edit goes to the board: trimmed; null when unchanged. */
export function adminEdit(now: string, typed: string): string | null {
  const text = typed.trim()
  return text === now ? null : text
}
