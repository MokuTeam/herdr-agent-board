// Setting up the server's web server, as a plan: which case Look's facts make (the server-setup
// spec's "Choosing the case"), the steps that set it up with what each touches, checks and undoes,
// the record the run leaves on the server and whose it is (the tunnel's user and socket, call 30),
// the Undo of a record, and the facts for "Do it myself" without Look. Every command is written as
// the owner would paste it, `sudo` in front of what needs root and their values one shell word
// each; the board's run (core/server-script.ts) runs the same lines as root.
// Pure, with no node: import: the page renders "Do it myself" from it.
import { t } from './lang.ts'
import type { Container, Holder, Port, ServerFacts } from './server-facts.ts'
import { isContainerId, isPlainPath, shQuote } from './server-shell.ts'
import {
  type Acme,
  ARGS_LABEL,
  BACKUPS_DIR,
  BLOCK_BEGIN,
  BLOCK_END,
  boardCaddyfile,
  CADDY_DIR,
  CADDY_FILE,
  CADDY_IMAGE,
  CADDY_NAME,
  CHECK_PATH,
  caddyRunArgs,
  DOCKER_FILES,
  DOCKER_PACKAGES,
  dockerInstall,
  IMPORT_LINE,
  markedBlock,
  NGINX_FILE,
  nginxFile,
  type OwnCaddy,
  PORT_3A,
  PORT_3B,
  PORT_4,
  PORT_4B_CHECK,
  RECORD_FILE,
  ROLE_LABEL,
  SITE_DIR,
  SITE_FILE,
  SOCAT_IMAGE,
  SOCKET_NAME,
  siteFile,
  socatRunArgs,
  VOLUMES,
} from './server-texts.ts'
import { fieldProblem, type TunnelField } from './tunnel.ts'
import { keysFile, SSHD_RELOAD, socketFolder } from './tunnel-snippets.ts'

export type SetupCase = '1' | '1b' | '2' | '3a' | '3b' | '4a' | '4b'
/**
 * Why the board does not set up the server by itself ("Do it myself"). Beyond the spec's list:
 * `portTaken` (8443, 8480 or 8481, which the case needs, held by another program) and `folder`
 * (the socket's folder not found: step 1 not done).
 */
export type Manual =
  | 'os'
  | 'selinux'
  | 'podman'
  | 'rootless'
  | 'userns'
  | 'requiretty'
  | 'noSystemd'
  | 'dockerConflicts'
  | 'caddyJson'
  | 'caddyResume'
  | 'adminOff'
  | 'autoHttpsOff'
  | 'caddyBaked'
  | 'caddy1'
  | 'twoConfigs'
  | 'bridge'
  | 'macvlan'
  | 'domainServed'
  | 'split'
  | 'other80'
  | 'otherSetup'
  | 'interrupted'
  | 'portTaken'
  | 'folder'

/** A setup is one tunnel's: its user and its socket. */
export interface Pair {
  user: string
  socket: string
}
/** What the panel wants: the pair, the domain, the public port (null: 443) and, in tests only, a CA. */
export interface Wanted extends Pair {
  domain: string
  publicPort: number | null
  acme?: Acme
}
/** A text of the panel: its key in the dictionaries and its values. */
export interface Text {
  key: string
  params?: Record<string, string>
}
export type Choice = { case: SetupCase; why: Text } | { case: null; why: Manual[] }
/** What a step adds, changes or removes, as the plan lists it. */
export interface Touch {
  kind:
    | 'file'
    | 'line'
    | 'block'
    | 'backup'
    | 'container'
    | 'volume'
    | 'image'
    | 'package'
    | 'group'
    | 'reload'
    | 'network'
  what: string
}
/** One thing of the board's on the server, with what Undo needs to remove it. */
export type RecordItem =
  | { kind: 'file'; path: string; sha256: string }
  | { kind: 'line'; file: string; line: string }
  | { kind: 'block'; file: string; begin: string; end: string }
  | { kind: 'backup'; of: string; path: string }
  | { kind: 'group'; path: string; from: string; to: string }
  | { kind: 'container'; name: string; setup: string }
  | { kind: 'volume'; name: string }
  | { kind: 'image'; ref: string; before: boolean }
  | { kind: 'docker'; packages: string[]; files: string[] }
/** /etc/agent-board/setup.json: the board's setup on the server, written by its runs. */
export interface SetupRecord {
  v: 1
  id: string
  at: string
  state: 'running' | 'applied' | 'rolled-back' | 'rollback-failed'
  case: SetupCase
  pair: Pair
  domain: string
  publicPort: number | null
  address: string
  items: RecordItem[]
}
/**
 * One step. `skipIf`: commands that all succeed when what the step does is in place already (the
 * run skips it then). `check`: commands run after `commands`, as "Do it myself" shows them.
 * `record`: for Apply, what the step adds to the record (a file's hash, an image's "there before"
 * and a container's run are filled in by the run on the server); the first step's are the record's
 * items already there, carried over. For Undo, what the step takes off the record.
 */
export interface PlanStep {
  id: string
  title: Text
  why: Text
  skipIf: string[]
  commands: string[]
  check: string[]
  undo: string[]
  touches: Touch[]
  record: RecordItem[]
  timeoutS: number
}
export interface Plan {
  id: string
  kind: 'apply' | 'update' | 'undo' | 'nothing'
  case: SetupCase
  address: string
  publicPort: number | null
  relies: string[]
  steps: PlanStep[]
  undoTouches: Touch[]
  warnings: Text[]
  ticks: ('docker' | 'removeDocker' | 'removeEdited')[]
}

const CASES: readonly SetupCase[] = ['1', '1b', '2', '3a', '3b', '4a', '4b']
const STATES: ReadonlySet<unknown> = new Set(['running', 'applied', 'rolled-back', 'rollback-failed'])
/** Run and plan ids: they name files and labels on the server. */
const PLAIN_ID = /^[A-Za-z0-9._-]{1,64}$/
/** What Look could not know without the owner's server, in "Do it myself" without Look: `<your Caddyfile>`. */
const PLACEHOLDER = /^<[^<>\n]+>$/
/** The step that only lists commands for the owner: the run always skips it. */
const BY_HAND = ['true']
const BY_HAND_ID = 'by-hand'

/** Undo's last step, what the owner made by hand in step 1: theirs to run, never the run's (core/server-script.ts says it skipped). */
export const byHand = (s: PlanStep): boolean => s.id === BY_HAND_ID
/**
 * How many of their hosts are fetched before and after a reload, and how many characters of their
 * names at most: the names travel in the run, and the whole ssh line (the run in base64 among it)
 * must fit Windows' command line, 32,767 characters, for the biggest plan too (core/server-script.ts).
 */
const FETCH_MOST = 20
const FETCH_CHARS = 1500

// ---------------------------------------------------------------------------------------------
// The record and whose it is

type Fields = Record<string, unknown>
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A string that can reach a script: no newline or NUL. */
const isLine = (v: unknown): v is string => typeof v === 'string' && !/[\n\r\0]/.test(v)
const isGroupName = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}\$?$/.test(v)
const isImageRef = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9._/:@-]{0,254}$/.test(v)
const isPackage = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9.+-]{0,99}$/.test(v)
const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535
const strings = (v: unknown, ok: (x: unknown) => x is string): string[] | null =>
  Array.isArray(v) && v.every(ok) ? [...v] : null

/** One item of a record, when it names only what the board itself adds (its own names and paths). */
function recordItem(v: unknown, folder: string): RecordItem | null {
  if (!isFields(v)) return null
  switch (v.kind) {
    case 'file':
      return [CADDY_FILE, SITE_FILE, NGINX_FILE].includes(v.path as string) &&
        typeof v.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(v.sha256)
        ? { kind: 'file', path: v.path as string, sha256: v.sha256 }
        : null
    case 'line':
      return isLine(v.file) && isPlainPath(v.file) && v.line === IMPORT_LINE
        ? { kind: 'line', file: v.file, line: IMPORT_LINE }
        : null
    case 'block':
      return isLine(v.file) && isPlainPath(v.file) && v.begin === BLOCK_BEGIN && v.end === BLOCK_END
        ? { kind: 'block', file: v.file, begin: BLOCK_BEGIN, end: BLOCK_END }
        : null
    case 'backup':
      return isLine(v.of) &&
        isPlainPath(v.of) &&
        isLine(v.path) &&
        isPlainPath(v.path) &&
        v.path.startsWith(`${BACKUPS_DIR}/`)
        ? { kind: 'backup', of: v.of, path: v.path }
        : null
    case 'group':
      return v.path === folder && isGroupName(v.from) && isGroupName(v.to)
        ? { kind: 'group', path: folder, from: v.from, to: v.to }
        : null
    case 'container':
      return (v.name === CADDY_NAME || v.name === SOCKET_NAME) && isLine(v.setup)
        ? { kind: 'container', name: v.name, setup: v.setup }
        : null
    case 'volume':
      return VOLUMES.includes(v.name as (typeof VOLUMES)[number]) ? { kind: 'volume', name: v.name as string } : null
    case 'image':
      return isImageRef(v.ref) && typeof v.before === 'boolean' ? { kind: 'image', ref: v.ref, before: v.before } : null
    case 'docker': {
      const packages = strings(v.packages, isPackage)
      const files = strings(v.files, (x): x is string => DOCKER_FILES.includes(x as string))
      return packages && files ? { kind: 'docker', packages, files } : null
    }
    default:
      return null
  }
}

/** The record read back from the server: null for anything but the board's own (call 23). */
export function setupRecord(json: unknown): SetupRecord | null {
  if (!isFields(json) || json.v !== 1) return null
  const { id, at, state, pair, domain, publicPort, address, items } = json
  const c = json.case
  if (typeof id !== 'string' || !PLAIN_ID.test(id) || !isLine(at) || !STATES.has(state)) return null
  if (!CASES.includes(c as SetupCase)) return null
  if (!isFields(pair) || !isLine(pair.user) || pair.user === '' || !isLine(pair.socket) || !isPlainPath(pair.socket))
    return null
  if (!isLine(domain) || domain === '' || !isLine(address)) return null
  if (publicPort !== null && !isPort(publicPort)) return null
  // a pair or domain the panel would refuse was not written by a board
  if (wantedProblem({ user: pair.user, socket: pair.socket, domain, publicPort })) return null
  if (!Array.isArray(items)) return null
  const folder = socketFolder(pair.socket)
  const read = items.map(i => recordItem(i, folder))
  if (read.some(i => i === null)) return null
  return {
    v: 1,
    id,
    at,
    state: state as SetupRecord['state'],
    case: c as SetupCase,
    pair: { user: pair.user, socket: pair.socket },
    domain,
    publicPort,
    address,
    items: read as RecordItem[],
  }
}

/**
 * What is wrong with what the panel wants, as the tunnel's settings are checked (core/tunnel.ts);
 * null when nothing is. Its values reach root's shell quoted, but also text their Caddy or nginx
 * loads as config (a site's address, `server_name`, the socket's path), where no quoting helps: a
 * `;`, a brace or a newline there is a directive of the board's in their proxy.
 */
export function wantedProblem(w: Wanted): string | null {
  const fields: [TunnelField, unknown][] = [
    ['user', w.user],
    ['socket', w.socket],
    ['domain', w.domain],
    ['publicPort', w.publicPort],
  ]
  for (const [field, value] of fields) {
    if (value === '') return t('tunnel.err.required', { field: t(`tunnel.field.${field}`) })
    const problem = fieldProblem(field, value)
    if (problem) return problem
  }
  // a test CA only (BOARD_SETUP_ACME_CA…): a URL and a file, one word each in the board's Caddyfile
  if (w.acme && !(/^https?:\/\/[^\s{}]+$/.test(w.acme.ca) && /^\/[\w./-]+$/.test(w.acme.root)))
    return 'The test CA is a URL and an absolute path'
  return null
}

/** Refuses what the panel wants unless it checks out: nothing is planned or run from it then. */
function checkWanted(w: Wanted): void {
  const problem = wantedProblem(w)
  if (problem) throw new Error(problem)
}

/** 'same': pair, domain and public port the panel's; 'update': the pair the same; 'other': another pair (Call 30). */
export function whose(r: SetupRecord, w: Wanted): 'same' | 'update' | 'other' {
  if (r.pair.user !== w.user || r.pair.socket !== w.socket) return 'other'
  return r.domain === w.domain && (r.publicPort ?? 443) === (w.publicPort ?? 443) ? 'same' : 'update'
}

/**
 * A record of a setup: any but a rolled-back run's, or one that left something of a setup. A
 * rolled-back run can leave only Docker it installed (kept, call 20) or an image that was there
 * before: not a setup, so the case comes from what holds the ports again (and the record's Docker
 * is carried on).
 */
const holdsSetup = (r: SetupRecord): boolean =>
  r.state !== 'rolled-back' || r.items.some(i => i.kind !== 'docker' && !(i.kind === 'image' && i.before))

/** What identifies an item: a newer one with the same key replaces an older one. */
function itemKey(i: RecordItem): string {
  switch (i.kind) {
    case 'file':
      return `file ${i.path}`
    case 'line':
      return `line ${i.file}`
    case 'block':
      return `block ${i.file}`
    case 'backup':
      return `backup ${i.path}`
    case 'group':
      return `group ${i.path}`
    case 'container':
      return `container ${i.name}`
    case 'volume':
      return `volume ${i.name}`
    case 'image':
      return `image ${i.ref}`
    case 'docker':
      return 'docker'
  }
}

/** A record's items, each once: the newest of each, an image "there before" only if every run found it so. */
function dedupe(items: readonly RecordItem[]): RecordItem[] {
  const out = new Map<string, RecordItem>()
  for (const i of items) {
    const key = itemKey(i)
    const was = out.get(key)
    if (was) out.delete(key)
    if (i.kind === 'image' && was?.kind === 'image') out.set(key, { ...i, before: i.before && was.before })
    else if (i.kind === 'docker' && was) out.set(key, was)
    else out.set(key, i)
  }
  return [...out.values()]
}

// ---------------------------------------------------------------------------------------------
// Choosing the case

const manual = (why: Manual[]): { case: null; why: Manual[] } => ({ case: null, why })
const bare = (name: string): string => name.replace(/^\//, '')

function containerOf(f: ServerFacts, id: string): Container | undefined {
  return f.docker?.containers.find(c => c.id === id)
}
/** The board's own container by name and label, when Look listed it. */
function ownContainer(f: ServerFacts, name: string, role: string): Container | undefined {
  return f.docker?.containers.find(c => bare(c.name) === name && c.labels[ROLE_LABEL] === role)
}
const isOurs = (f: ServerFacts, h: Holder): boolean =>
  h.kind === 'container' && containerOf(f, h.id)?.labels[ROLE_LABEL] !== undefined
const isFree = (h: Holder): boolean => h.kind === 'free'

function isCaddy(f: ServerFacts, h: Holder): boolean {
  if (h.kind === 'unit' || h.kind === 'process') return h.program === 'caddy'
  if (h.kind !== 'container') return false
  if (h.program === 'caddy' || (f.caddy?.where === 'container' && f.caddy.container === h.id)) return true
  return /(^|\/)caddy([:@]|$)/.test(containerOf(f, h.id)?.image ?? '')
}

/** What every run needs on the server, by the names Look's `@@missing` lines give (runuser: case 2's alone). */
const RUN_TOOLS = ['flock', 'setsid', 'timeout', 'sha256sum', 'ss']

/** The limits of call 25 and step 1 not done: none of the cases is done by the board then. */
function hostLimits(f: ServerFacts): Manual[] {
  const why: Manual[] = []
  if (!f.distro.supported || RUN_TOOLS.some(t => f.host.missing.includes(t))) why.push('os')
  if (f.host.selinux === 'enforcing') why.push('selinux')
  if (f.docker?.podman) why.push('podman')
  if (f.docker?.rootless) why.push('rootless')
  if (f.docker?.userns) why.push('userns')
  if (!f.folder) why.push('folder')
  return why
}

const holderName = (f: ServerFacts, h: Holder): string => {
  if (h.kind === 'unit') return h.unit
  if (h.kind === 'container') return bare(containerOf(f, h.id)?.name ?? h.id.slice(0, 12))
  if (h.kind === 'process') return h.program
  if (h.kind === 'split') return h.programs.join(', ')
  return ''
}

/** The board's Caddy on the ports a case needs: they must be free (or its own). */
function portsFree(f: ServerFacts, ports: Port[]): boolean {
  return ports.every(p => isFree(f.ports[p]) || isOurs(f, f.ports[p]))
}

function ownCase(f: ServerFacts, c: OwnCaddy, why: Text): Choice {
  if (!f.docker && f.host.conflicts.length) return manual(['dockerConflicts'])
  const extra: Port[] = c === '4a' ? [PORT_4] : c === '4b' ? [PORT_4, PORT_4B_CHECK] : []
  if (!portsFree(f, extra)) return manual(['portTaken'])
  return { case: c, why }
}

/** 443 is someone else's: the board's Caddy on 8443, with 80 for the certificate (call 16). */
function caseFour(f: ServerFacts, w: Wanted, held: string): Choice {
  const h80 = f.ports[80]
  if (isFree(h80)) return ownCase(f, '4a', { key: 'server.case.4a', params: { holder: held } })
  const nginx = h80.kind === 'unit' && h80.program === 'nginx' && f.nginx?.confD
  if (!nginx) return manual(['other80'])
  if (f.nginx?.serverNames.includes(w.domain)) return manual(['domainServed'])
  if (!f.systemd) return manual(['noSystemd'])
  return ownCase(f, '4b', { key: 'server.case.4b', params: { holder: held } })
}

/** What keeps the board from adding to their Caddy (falls back to case 4 when 80 allows, call 15). */
function caddyProblems(f: ServerFacts, h: Holder): Manual[] {
  const c = f.caddy
  const why: Manual[] = []
  if (h.kind === 'process') why.push('noSystemd')
  if (h.kind === 'unit' && !f.systemd) why.push('noSystemd')
  const mine = c && (h.kind === 'container' ? c.where === 'container' && c.container === h.id : c.where === 'unit')
  if (!c || !mine || c.config === '') return [...why, 'twoConfigs']
  if (c.adapter !== 'caddyfile') why.push('caddyJson')
  if (c.resume) why.push('caddyResume')
  if (c.adminOff) why.push('adminOff')
  if (c.autoHttpsOff) why.push('autoHttpsOff')
  if (/^v?1\./.test(c.version)) why.push('caddy1')
  if (h.kind === 'container' && (c.mount === null || c.hostPath === null)) why.push('caddyBaked')
  return why
}

/** The user-defined network the helper joins (call 33): the first by name that is not macvlan or ipvlan. */
function helperNetwork(c: Container): string | null {
  const ok = c.networks
    .filter(n => n.userDefined && n.driver !== 'macvlan' && n.driver !== 'ipvlan')
    .map(n => n.name)
    .sort()
  return ok[0] ?? null
}

function byHolders(f: ServerFacts, w: Wanted): Choice {
  const h443 = f.ports[443]
  const h80 = f.ports[80]
  if (h443.kind === 'split' || h80.kind === 'split') return manual(['split'])
  // the board's own container with no record of it: not something to plan over
  if (isOurs(f, h443) || isOurs(f, h80)) return manual(['otherSetup'])
  if (isFree(h443))
    return isFree(h80)
      ? ownCase(f, '1', { key: 'server.case.1' })
      : ownCase(f, '1b', { key: 'server.case.1b', params: { holder: holderName(f, h80) } })
  if (!isCaddy(f, h443)) return caseFour(f, w, holderName(f, h443))
  if (f.caddy?.hosts.includes(w.domain)) return manual(['domainServed'])
  const problems = caddyProblems(f, h443)
  if (problems.length) {
    const four = caseFour(f, w, 'Caddy')
    return four.case !== null ? four : manual(problems)
  }
  if (h443.kind === 'unit') {
    if (f.host.missing.includes('runuser')) return manual(['os'])
    return { case: '2', why: { key: 'server.case.2', params: { unit: h443.unit } } }
  }
  const container = h443.kind === 'container' ? containerOf(f, h443.id) : undefined
  if (!container) return manual(['twoConfigs'])
  const name = bare(container.name)
  if (container.hostNetwork) {
    if (!portsFree(f, [PORT_3B])) return manual(['portTaken'])
    return { case: '3b', why: { key: 'server.case.3b', params: { container: name } } }
  }
  const network = helperNetwork(container)
  if (network) return { case: '3a', why: { key: 'server.case.3a', params: { container: name, network } } }
  return manual([container.networks.some(n => n.driver === 'macvlan' || n.driver === 'ipvlan') ? 'macvlan' : 'bridge'])
}

/** The case for the facts Look found (the spec's table, then its "anything else" list). */
export function chooseCase(f: ServerFacts, w: Wanted): Choice {
  checkWanted(w)
  const limits = hostLimits(f)
  if (limits.length) return manual(limits)
  if (f.record !== null && f.record !== undefined) {
    const r = setupRecord(f.record)
    if (!r) return manual(['otherSetup'])
    if (holdsSetup(r)) {
      const who = whose(r, w)
      if (who === 'other') return manual(['otherSetup'])
      if (r.state === 'running' && !f.lockHeld) return manual(['interrupted'])
      return { case: r.case, why: { key: `server.case.${who}`, params: { case: r.case, domain: r.domain } } }
    }
  }
  return byHolders(f, w)
}

// ---------------------------------------------------------------------------------------------
// Shell words and lines

/** One shell word: as it is when it needs no quoting, else shQuote'd. */
const q = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : shQuote(s))
const lines = (text: string): string => text.split('\n').map(q).join(' ')
/** A file written with sudo, its lines as printf's arguments. */
const writeTo = (path: string, text: string): string => `printf '%s\\n' ${lines(text)} | sudo tee ${q(path)} >/dev/null`
const appendTo = (path: string, text: string): string =>
  `printf '%s\\n' ${lines(text)} | sudo tee -a ${q(path)} >/dev/null`
/** The file holds exactly this text already. */
const sameText = (path: string, text: string): string =>
  `[ "$(printf '%s\\n' ${lines(text)} | sha256sum)" = "$(sudo cat ${q(path)} 2>/dev/null | sha256sum)" ]`
const hashOf = (path: string): string => `$(sudo cat ${q(path)} | sha256sum | cut -c1-64)`
/**
 * Written in place (the same file, so a file bind mount sees it, call 14), and only from a file
 * that is there and not empty: `>` empties the file before cat reads a thing.
 */
const inPlace = (from: string, to: string): string =>
  `sudo sh -c ${shQuote(`test -s ${q(from)} && cat ${q(from)} > ${q(to)}`)}`
/** A file of the board's written beside itself and moved in: one that is cut short is never the file. */
const copyWhole = (from: string, to: string): string =>
  `sudo cp -p ${q(from)} ${q(`${to}.part`)}; sudo mv -f ${q(`${to}.part`)} ${q(to)}`
/** A line that imports the board's site file: the board's own, or one written by hand. */
const IMPORTS_SITE = `^[[:space:]]*import[[:space:]]+${SITE_FILE.replaceAll('.', '\\.')}([[:space:]]|$)`
const importsSite = (files: string[]): string => `sudo grep -Eqs ${shQuote(IMPORTS_SITE)} ${files.map(q).join(' ')}`
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'
const label = (name: string, key: string): string =>
  `$(sudo docker inspect -f '{{index .Config.Labels "${key}"}}' ${q(name)} 2>/dev/null)`
const isOursCmd = (name: string, role: string): string => `[ "${label(name, ROLE_LABEL)}" = ${role} ]`
const running = (name: string): string => `$(sudo docker inspect -f '{{.State.Running}}' ${q(name)} 2>/dev/null)`
const volumeOurs = (v: string): string =>
  `[ "$(sudo docker volume inspect -f '{{index .Labels "${ROLE_LABEL}"}}' ${q(v)} 2>/dev/null)" = caddy ]`
/** Removes the line (case 2) or the block (case 3) of the board's from a file's text on stdin. */
const STRIP_LINE = `L=${shQuote(IMPORT_LINE)} awk '$0 != ENVIRON["L"]'`
const STRIP_BLOCK = `B0=${shQuote(BLOCK_BEGIN)} E0=${shQuote(BLOCK_END)} awk 'index($0, ENVIRON["B0"]) == 1 { s = 1 } !s { print } s && $0 == ENVIRON["E0"] { s = 0 }'`
/** The block of the board's is whole: as many ends as beginnings, at most one. */
const wholeBlock = (file: string): string =>
  `n=$(sudo grep -c '^${BLOCK_BEGIN}' ${q(file)} || true); m=$(sudo grep -cx '${BLOCK_END}' ${q(file)} || true); if [ "$n" != "$m" ] || [ "$n" -gt 1 ]; then echo ${shQuote(`The board's block in ${file} is not whole: put it right by hand.`)}; false; fi`
const blockText = (file: string): string =>
  `sudo cat ${q(file)} | B0=${shQuote(BLOCK_BEGIN)} E0=${shQuote(BLOCK_END)} awk 'index($0, ENVIRON["B0"]) == 1 { s = 1 } s { print } s && $0 == ENVIRON["E0"] { s = 0 }'`

const gidWord = (f: ServerFacts): string => {
  const gid = f.folder?.gid
  return gid !== undefined && Number.isInteger(gid) && gid >= 0 ? String(gid) : '<gid>'
}

// ---------------------------------------------------------------------------------------------
// Steps

/** A step with whether the facts say it is in place already (for "nothing to change"). */
interface Built {
  step: PlanStep
  done: boolean
}

function mk(id: string, o: Partial<PlanStep> & { commands: string[] }, params?: Record<string, string>): PlanStep {
  return {
    id,
    title: params ? { key: `server.step.${id}.title`, params } : { key: `server.step.${id}.title` },
    why: params ? { key: `server.step.${id}.why`, params } : { key: `server.step.${id}.why` },
    skipIf: [],
    check: [],
    undo: [],
    touches: [],
    record: [],
    timeoutS: 60,
    ...o,
  }
}

/** What a plan relies on (call 11): who holds a port, their config's hash, their container. */
export type Rely =
  | { kind: 'free'; port: Port; docker: boolean }
  | { kind: 'program'; port: Port; program: string }
  | { kind: 'container'; port: Port | null; id: string }
  | { kind: 'config'; path: string; sha: string }

export function relyLine(r: Rely): { said: string; command: string } {
  const changed = (what: string): string => `then echo '@@changed ${what}'; false; fi`
  switch (r.kind) {
    case 'free': {
      const docker = r.docker ? ` sudo docker ps --format '{{.Ports}}' 2>/dev/null | grep -F ':${r.port}->';` : ''
      return {
        said: `port ${r.port}: free`,
        command: `if { sudo ss -H -ltn 'sport = :${r.port}';${docker} } | grep -q .; ${changed(`holder${r.port}`)}`,
      }
    }
    case 'program':
      return {
        said: `port ${r.port}: ${r.program}`,
        command: `if ! sudo ss -H -ltnp 'sport = :${r.port}' | grep -qF ${q(`(("${r.program}",`)}; ${changed(`holder${r.port}`)}`,
      }
    case 'container':
      return {
        said: r.port === null ? `container ${r.id.slice(0, 12)}` : `port ${r.port}: container ${r.id.slice(0, 12)}`,
        command: `if [ "${running(r.id)}" != true ]; ${changed(r.port === null ? 'container' : `holder${r.port}`)}`,
      }
    case 'config':
      return {
        said: `${r.path}: sha256 ${r.sha.slice(0, 12)}`,
        command: `if [ "${hashOf(r.path)}" != ${r.sha} ]; ${changed('config')}`,
      }
  }
}

/** A port's holder as the plan relies on it; nothing for the board's own. */
function relyOn(f: ServerFacts, port: Port): Rely[] {
  const h = f.ports[port]
  if (isOurs(f, h)) return []
  if (h.kind === 'free') return [{ kind: 'free', port, docker: f.docker !== null }]
  if (h.kind === 'container') return [{ kind: 'container', port, id: h.id }]
  if (h.kind === 'unit' || h.kind === 'process') return [{ kind: 'program', port, program: h.program }]
  return []
}

function guard(relies: Rely[], carried: RecordItem[]): PlanStep {
  return mk('guard', { commands: relies.map(r => relyLine(r).command), record: carried, timeoutS: 60 })
}

function dockerStep(f: ServerFacts): PlanStep {
  return mk('docker-install', {
    commands: dockerInstall(f.distro.id === 'ubuntu' ? 'ubuntu' : 'debian'),
    skipIf: ['command -v docker >/dev/null 2>&1'],
    check: ['sudo docker version >/dev/null'],
    undo: [`if ! dpkg -s docker-ce >/dev/null 2>&1; then sudo rm -f ${DOCKER_FILES.join(' ')}; fi`],
    touches: [
      { kind: 'package', what: 'docker-ce docker-ce-cli containerd.io' },
      ...DOCKER_FILES.map(what => ({ kind: 'file' as const, what })),
    ],
    record: [{ kind: 'docker', packages: [...DOCKER_PACKAGES], files: [...DOCKER_FILES] }],
    timeoutS: 900,
  })
}

function pullStep(id: string, image: string): PlanStep {
  const has = `sudo docker image inspect ${image} >/dev/null`
  return mk(
    id,
    {
      commands: [`sudo docker pull ${image}`],
      skipIf: [`${has} 2>&1`],
      check: [has],
      undo: [`if ${has} 2>&1; then sudo docker image rm ${image} >/dev/null 2>&1 || true; fi`],
      touches: [{ kind: 'image', what: image }],
      record: [{ kind: 'image', ref: image, before: false }],
      timeoutS: 600,
    },
    { image },
  )
}

/**
 * One of the board's own files: the earlier one kept whole for the rollback (else a mark that this
 * run made it), the new text written beside it and moved in (their Caddy may import it), its mode
 * set. The rollback puts the earlier one back, or removes the file only when this run made it.
 */
function ownFile(
  id: string,
  path: string,
  text: string,
  b: string,
  more: { commands?: string[]; undo?: string[] } = {},
) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const saved = `${b}/${name}.board`
  const made = `${b}/${name}.new`
  const part = `${path}.part`
  return mk(
    id,
    {
      commands: [
        // made only when missing: `install -d -m` sets the mode of a folder that is there (their conf.d)
        `sudo test -d ${q(dirOf(path))} || sudo install -d -m 755 ${q(dirOf(path))}`,
        `sudo install -d -m 700 ${q(b)}`,
        `if sudo test -f ${q(path)}; then ${copyWhole(path, saved)}; else sudo touch ${q(made)}; fi`,
        writeTo(part, text),
        `sudo chmod 644 ${q(part)}`,
        `sudo mv -f ${q(part)} ${q(path)}`,
        ...(more.commands ?? []),
      ],
      skipIf: [sameText(path, text)],
      check: [`sudo test -s ${q(path)}`],
      undo: [
        `sudo rm -f ${q(part)}`,
        `if sudo test -f ${q(saved)}; then ${copyWhole(saved, path)}; elif sudo test -f ${q(made)}; then sudo rm -f ${q(path)}; fi`,
        ...(more.undo ?? []),
      ],
      touches: [{ kind: 'file', what: path }],
      record: [{ kind: 'file', path, sha256: '' }],
    },
    { file: path },
  )
}

/** A container of the board's: recreated only when its settings' hash changed, else left running. */
function runStep(id: string, name: string, role: string, args: string[], setup: string): PlanStep {
  const hash = args.find(a => a.startsWith(`${ARGS_LABEL}=`))?.slice(ARGS_LABEL.length + 1) ?? ''
  const ours = isOursCmd(name, role)
  return mk(
    id,
    {
      commands: [
        `if ${ours}; then sudo docker rm -f ${name} >/dev/null; fi`,
        // the argv after `docker` (caddyRunArgs, socatRunArgs): `run` is its first word
        `sudo docker ${args.map(q).join(' ')}`,
      ],
      skipIf: [
        `[ "$(sudo docker inspect -f '{{index .Config.Labels "${ARGS_LABEL}"}} {{.State.Running}}' ${name} 2>/dev/null)" = '${hash} true' ]`,
      ],
      check: [`[ "${running(name)}" = true ]`],
      undo: [`if ${ours}; then sudo docker rm -f ${name} >/dev/null; fi`],
      touches: [{ kind: 'container', what: name }],
      record: [{ kind: 'container', name, setup }],
      timeoutS: 120,
    },
    { container: name },
  )
}

const reloadOwn = `if [ "$(sudo docker inspect -f '{{index .Config.Labels "${ROLE_LABEL}"}} {{.State.Running}}' ${CADDY_NAME} 2>/dev/null)" = 'caddy true' ]; then sudo docker exec ${CADDY_NAME} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; fi`

const HOST_NAME = /^(?=.*[a-z])[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** Their exact host names (no wildcard, no address), not the board's domain, each once. */
const exactHosts = (names: readonly string[], domain: string): string[] =>
  [...new Set(names)].filter(h => HOST_NAME.test(h) && h !== domain)

/** Their hosts to fetch: the first exact names, at most 20 and 1,500 characters of them. */
function fetchHosts(names: readonly string[], domain: string): string[] {
  const out: string[] = []
  let chars = 0
  for (const h of exactHosts(names, domain)) {
    if (out.length === FETCH_MOST || chars + h.length > FETCH_CHARS) break
    out.push(h)
    chars += h.length
  }
  return out
}

/** A note for the plan when some of their exact host names are left out of the fetches. */
function someHosts(names: readonly string[], domain: string): Text[] {
  const all = exactHosts(names, domain).length
  const n = fetchHosts(names, domain).length
  return n < all ? [{ key: 'server.warn.someHosts', params: { n: String(n), all: String(all) } }] : []
}

const resolveAt = (address: string): string => (address.includes(':') ? `[${address}]` : address)

/** A host's HTTP status at their proxy's address, with SNI (`curl --resolve`; 000 when it does not answer). */
const statusFn = (address: string): string =>
  `st() { curl -sk -o /dev/null -w '%{http_code}' -m 10 --resolve "$1:\${2:-443}:${resolveAt(address)}" "\${3:-https}://$1/" || true; }`

/** Each host's status now, into a file of the run's. */
function fetchInto(hosts: string[], file: string, address: string, both = false): string[] {
  const each = both ? `'%s %s %s\\n' "$h" "$(st "$h" 80 http)" "$(st "$h")"` : `'%s %s\\n' "$h" "$(st "$h")"`
  return [
    statusFn(address),
    `for h in ${hosts.map(shQuote).join(' ')}; do printf ${each}; done | sudo tee ${q(file)} >/dev/null`,
  ]
}

/** The same statuses as in the file (one retry after 2 s; a host that did not answer before left out, call 21). */
function compareWith(file: string, address: string, both = false): string[] {
  const test = both
    ? `{ [ "$a" != 000 ] && [ "$(st "$h" 80 http)" != "$a" ]; } || { [ "$s" != 000 ] && [ "$(st "$h")" != "$s" ]; }`
    : `[ "$s" != 000 ] && [ "$(st "$h")" != "$s" ]`
  const read = both ? 'h a s' : 'h s'
  return [
    statusFn(address),
    `bad=$(sudo cat ${q(file)} | while read -r ${read}; do if ${test}; then sleep 2; if ${test}; then echo "$h answers otherwise than before the reload"; fi; fi; done)`,
    'if [ -n "$bad" ]; then echo "$bad"; false; fi',
  ]
}

/** Their Caddy, as the chain of steps that edit its Caddyfile needs it. */
interface TheirCaddy {
  /** False for a file no Caddy Look found uses: edited, nothing checked or reloaded. */
  live: boolean
  file: string
  sha: string
  /** Where the candidate is checked: beside their file, or none (a file mount: written in place first). */
  candidate: string | null
  /** The candidate's and their config's paths as their Caddy sees them. */
  candidateCfg: string
  cfg: string
  /** How their Caddy runs a command: on the host as its user, or in its container. */
  validate: (cfg: string) => string
  adapt: string
  reload: string[]
  isUp: string
  address: string
  fetch: boolean
}

function theirCaddy(f: ServerFacts): TheirCaddy | null {
  const c = f.caddy
  if (!c || c.hostPath === null) return null
  const file = c.hostPath
  if (!isLine(file) || !(isPlainPath(file) || PLACEHOLDER.test(file))) return null
  // their proxy's address (an IP) and their config's hash reach the scripts as they are: checked
  // here. ss prints an IPv6 address in brackets, and one bound to an interface with `%<name>`.
  const ip = c.address.replace(/^\[(.*)\]$/, '$1').replace(/%[^%]*$/, '')
  const address = /^[0-9A-Fa-f.:]+$/.test(ip) ? ip : '127.0.0.1'
  const sha = /^[0-9a-f]{64}$/.test(c.sha256) ? c.sha256 : PLACEHOLDER.test(file) ? '' : null
  if (sha === null) return null
  const fetch = f.host.fetch === 'curl'
  if (c.where === 'unit') {
    const unit = f.units.caddy
    const holder = f.ports[443]
    const name = holder.kind === 'unit' ? holder.unit : 'caddy.service'
    const bin = unit?.execStart[0] && isPlainPath(unit.execStart[0]) ? unit.execStart[0] : 'caddy'
    const user = unit?.user && unit.user !== '' ? unit.user : 'root'
    const candidate = `${dirOf(file)}/.Caddyfile.agent-board`
    // STEPPATH=/: Caddy 2.6 makes $HOME/.step on any run (/root/.step as root), which no record
    // names; pointed at a folder that is there, it makes nothing (the spike). `env`, since a
    // `sudo VAR=x …` line would not run in the board's script, where sudo is a function.
    const caddy = `env STEPPATH=/ ${q(bin)}`
    return {
      live: true,
      file,
      sha,
      candidate,
      candidateCfg: candidate,
      cfg: file,
      validate: cfg => `sudo runuser -u ${q(user)} -- ${caddy} validate --config ${q(cfg)} --adapter caddyfile`,
      adapt: `sudo ${caddy} adapt`,
      reload: [`sudo systemctl reload ${q(name)}`],
      isUp: `systemctl is-active --quiet ${q(name)}`,
      address,
      fetch,
    }
  }
  const id = c.container
  if (id === null || !(isContainerId(id) || PLACEHOLDER.test(id)) || !isLine(c.config)) return null
  // as Look runs it: an older Caddy in their image would make $HOME/.step in their container
  const exec = `sudo docker exec -e STEPPATH=/ ${q(id)} caddy`
  const inFolder = c.mount === 'folder' || c.mount === 'volume'
  return {
    live: true,
    file,
    sha,
    candidate: inFolder ? `${dirOf(file)}/.Caddyfile.agent-board` : null,
    candidateCfg: `${dirOf(c.config)}/.Caddyfile.agent-board`,
    cfg: c.config,
    validate: cfg => `${exec} validate --config ${q(cfg)} --adapter caddyfile`,
    adapt: `${exec} adapt`,
    reload: [`${exec} reload --config ${q(c.config)} --adapter caddyfile`],
    isUp: `[ "${running(id)}" = true ]`,
    address,
    fetch,
  }
}

const hostsFn = (t: TheirCaddy): string =>
  `hosts() { ${t.adapt} --config "$1" --adapter caddyfile 2>/dev/null | grep -o '"host":.[^]]*]' | grep -o '"[^"]*"' | grep -vx '"host"' | sort -u; }`

/**
 * The steps that change their Caddyfile and reload their Caddy (cases 2 and 3, their Undo): a
 * backup and their host names first; the new text beside their file and checked there, then
 * written in place (or, for a file mount, written in place and checked at once); their sites
 * fetched before and after the reload. `edit` makes the new text from the old on stdin; `add` is
 * appended; `out` and `into` say how the host names change. A chain whose backup step finds nothing
 * to do (the line or block as wanted already) is skipped whole: the later steps skip when there is
 * no backup of this run.
 */
function chain(
  t: TheirCaddy,
  b: string,
  o: {
    edit: string
    add: string | null
    present: string | null
    out: string | null
    into: string | null
    extraCheck: string[]
    record: RecordItem[]
    touch: Touch
    hosts: string[]
    restoreSite: boolean
    undo: boolean
  },
): PlanStep[] {
  const backup = `${b}/Caddyfile`
  const noBackup = [`! sudo test -f ${q(backup)}`]
  const params = { file: t.file }
  const before = `sudo cat ${q(`${b}/hosts-before`)}`
  const kept = o.out ? `${before} | grep -vxF ${q(`"${o.out}"`)}` : before
  const wantLine = o.into ? `want=$( { ${kept}; echo ${q(`"${o.into}"`)}; } | sort -u)` : `want=$(${kept} | sort -u)`
  const compareHosts = (cfg: string): string[] => [
    hostsFn(t),
    `new=$(hosts ${q(cfg)})`,
    wantLine,
    `if [ "$new" != "$want" ]; then echo 'The host names your Caddy serves would change. Wanted:'; echo "$want"; echo 'Found:'; echo "$new"; false; fi`,
  ]
  const shaCheck =
    t.sha !== '' ? [`if [ "${hashOf(t.file)}" != ${t.sha} ]; then echo '@@changed config'; false; fi`] : []
  const newText = (into: string): string[] => [
    ...o.extraCheck,
    `sudo cat ${q(t.file)} | ${o.edit} | sudo tee ${q(into)} >/dev/null`,
    ...(o.add ? [appendTo(into, o.add)] : []),
  ]
  const steps: PlanStep[] = [
    mk(
      'backup',
      {
        commands: [
          `sudo install -d -m 700 ${q(b)}`,
          `sudo cp -p ${q(t.file)} ${q(backup)}`,
          `sudo chmod 600 ${q(backup)}`,
          ...(t.live ? [hostsFn(t), `hosts ${q(t.cfg)} | sudo tee ${q(`${b}/hosts-before`)} >/dev/null`] : []),
        ],
        skipIf: o.present ? [o.present] : [],
        check: [`sudo test -f ${q(backup)}`],
        touches: [{ kind: 'backup', what: t.file }],
        record: o.undo ? [] : [{ kind: 'backup', of: t.file, path: backup }],
      },
      params,
    ),
  ]
  // their file back as it was: never one that imports the board's site while that site is not there
  const restore = `if ${importsSite([backup])} && ! sudo test -s ${SITE_FILE}; then echo ${q(`${t.file} is left as it is: its backup imports ${SITE_FILE}, which is not there.`)}; false; else ${inPlace(backup, t.file)}; fi`
  const reloaded = `${b}/reloaded`
  const validate = mk(
    'validate',
    {
      commands: [
        t.validate(t.candidate ? t.candidateCfg : t.cfg),
        ...compareHosts(t.candidate ? t.candidateCfg : t.cfg),
      ],
      skipIf: noBackup,
    },
    params,
  )
  const write = mk(
    'write',
    {
      commands: [
        ...shaCheck,
        ...(t.candidate ? [] : newText(`${b}/Caddyfile.new`)),
        inPlace(t.candidate ?? `${b}/Caddyfile.new`, t.file),
        ...(t.candidate ? [`sudo rm -f ${q(t.candidate)}`] : []),
      ],
      skipIf: noBackup,
      check: [],
      undo: [restore, ...(t.candidate ? [`sudo rm -f ${q(t.candidate)}`] : [])],
      touches: [o.touch],
      record: o.record,
    },
    params,
  )
  if (t.candidate) {
    const cand = t.candidate
    steps.push(
      mk(
        o.undo ? 'unedit' : 'candidate',
        {
          commands: [`sudo cp -p ${q(t.file)} ${q(cand)}`, ...newText(cand)],
          skipIf: noBackup,
          check: [`sudo test -f ${q(cand)}`],
          undo: [`sudo rm -f ${q(cand)}`],
        },
        params,
      ),
      ...(t.live ? [validate] : []),
      write,
    )
  } else steps.push(write, ...(t.live ? [validate] : []))
  if (!t.live) return steps
  const fetch = t.fetch && o.hosts.length > 0
  if (fetch)
    steps.push(mk('fetch-before', { commands: fetchInto(o.hosts, `${b}/before`, t.address), skipIf: noBackup }))
  steps.push(
    mk(
      'reload',
      {
        // the mark tells a rollback that the reload took: a reload that fails leaves their Caddy on
        // its running config, which the file put back matches, so there is nothing to reload then
        commands: [...t.reload, `sudo touch ${q(reloaded)}`],
        skipIf: noBackup,
        check: [t.isUp],
        // newest first, so this runs before the write's own undo: everything back, then one reload
        undo: [
          restore,
          ...(o.restoreSite
            ? [
                `if sudo test -f ${q(`${b}/board.caddy.board`)}; then ${copyWhole(`${b}/board.caddy.board`, SITE_FILE)}; fi`,
              ]
            : []),
          `if sudo test -f ${q(reloaded)}; then ${t.reload.join('; ')}; fi`,
          ...(fetch ? compareWith(`${b}/before`, t.address) : []),
        ],
        touches: [{ kind: 'reload', what: t.file }],
      },
      params,
    ),
  )
  if (fetch) steps.push(mk('fetch-after', { commands: compareWith(`${b}/before`, t.address), skipIf: noBackup }))
  return steps
}

// ---------------------------------------------------------------------------------------------
// The plan

interface Ctx {
  f: ServerFacts
  w: Wanted
  id: string
  b: string
  gid: string
  old: SetupRecord | null
  update: boolean
  same: boolean
}

const ADDRESS = (w: Wanted, c: SetupCase): string =>
  c === '4a' || c === '4b' ? `https://${w.domain}:${PORT_4}` : `https://${w.domain}`

function ownSteps(x: Ctx, c: OwnCaddy): { built: Built[]; relies: Rely[] } {
  const { f, w } = x
  const args = caddyRunArgs(c, w, x.gid, x.id, w.acme)
  const hash = args.find(a => a.startsWith(`${ARGS_LABEL}=`))?.slice(ARGS_LABEL.length + 1)
  const mine = ownContainer(f, CADDY_NAME, 'caddy')
  const up = mine !== undefined && mine.labels[ARGS_LABEL] === hash
  const kept = x.same && up
  const built: Built[] = []
  if (!f.docker) built.push({ step: dockerStep(f), done: false })
  built.push(
    { step: pullStep('pull-caddy', CADDY_IMAGE), done: mine?.image === CADDY_IMAGE },
    {
      step: ownFile('caddyfile', CADDY_FILE, boardCaddyfile(c, w, w.acme), x.b, {
        commands: [reloadOwn],
        undo: [`sudo rmdir ${CADDY_DIR} 2>/dev/null || true`, reloadOwn],
      }),
      done: kept,
    },
    {
      step: mk('volumes', {
        commands: VOLUMES.map(v => `sudo docker volume create --label ${ROLE_LABEL}=caddy ${v} >/dev/null`),
        skipIf: VOLUMES.map(volumeOurs),
        check: [`sudo docker volume inspect ${VOLUMES.join(' ')} >/dev/null`],
        undo: VOLUMES.map(v => `if ${volumeOurs(v)}; then sudo docker volume rm ${v} >/dev/null; fi`),
        touches: VOLUMES.map(what => ({ kind: 'volume' as const, what })),
        record: VOLUMES.map(name => ({ kind: 'volume' as const, name })),
      }),
      done: kept,
    },
    { step: runStep('run-caddy', CADDY_NAME, 'caddy', args, x.id), done: up },
    {
      step: mk('caddy-up', {
        commands: [
          `i=0; until [ "${running(CADDY_NAME)}" = true ] && sudo docker exec ${CADDY_NAME} wget -q -O /dev/null http://127.0.0.1:2019/config/ || [ "$i" -ge 30 ]; do i=$((i + 1)); sleep 1; done`,
          `if [ "$i" -ge 30 ]; then sudo docker logs --tail 30 ${CADDY_NAME}; fi`,
        ],
        check: [`sudo docker exec ${CADDY_NAME} wget -q -O /dev/null http://127.0.0.1:2019/config/`],
        timeoutS: 90,
      }),
      done: up,
    },
  )
  const relies: Rely[] = [
    ...(c === '1' || c === '4a' ? relyOn(f, 80) : []),
    ...(c === '1' || c === '1b' ? relyOn(f, 443) : []),
    ...(c === '4a' || c === '4b' ? relyOn(f, PORT_4) : []),
  ]
  if (c === '4b') {
    const nginx = f.nginx
    const served = nginx?.serverNames.includes(w.domain) === true
    const hosts = f.host.fetch === 'curl' ? fetchHosts(nginx?.serverNames ?? [], w.domain) : []
    const listen = nginx?.listen80 ?? []
    const at = nginxAddress(listen)
    const nginxDone = x.same && served
    built.push(
      {
        step: ownFile('nginx-file', NGINX_FILE, nginxFile(w, listen), x.b, {
          undo: ['if sudo nginx -t 2>/dev/null; then sudo systemctl reload nginx; fi'],
        }),
        done: nginxDone,
      },
      { step: mk('nginx-check', { commands: ['sudo nginx -t'] }), done: nginxDone },
      {
        step: mk('nginx-reload', {
          commands: [
            ...(hosts.length
              ? [`sudo install -d -m 700 ${q(x.b)}`, ...fetchInto(hosts, `${x.b}/nginx-before`, '127.0.0.1', true)]
              : []),
            'sudo systemctl reload nginx',
            ...(hosts.length ? ['sleep 1', ...compareWith(`${x.b}/nginx-before`, '127.0.0.1', true).slice(1)] : []),
          ],
          check: ['systemctl is-active --quiet nginx'],
          touches: [{ kind: 'reload', what: 'nginx' }],
          timeoutS: 300,
        }),
        done: nginxDone,
      },
      {
        step: mk('acme-path', {
          commands: [
            `for i in 1 2 3 4 5 6 7 8 9 10; do a=$(curl -s -m 5 --resolve ${q(`${w.domain}:80:${resolveAt(at)}`)} ${q(`http://${w.domain}${CHECK_PATH}`)} || true); if [ "$a" = agent-board ]; then break; fi; sleep 2; done`,
            `if [ "$a" != agent-board ]; then echo ${shQuote(`nginx does not hand ${CHECK_PATH} for ${w.domain} to the board's Caddy. It answered:`)} "$a"; false; fi`,
          ],
          timeoutS: 60,
        }),
        done: nginxDone,
      },
    )
    relies.push(...relyOn(f, 80), ...relyOn(f, PORT_4B_CHECK))
  }
  return { built, relies }
}

/** Where 4b fetches through nginx on 80: the loopback when nginx listens on all addresses, else its own. */
export function nginxAddress(listen80: string[]): string {
  const addresses = listen80.map(l => l.trim().split(/\s+/)[0] ?? '')
  if (addresses.length === 0 || addresses.some(a => /^(\d+|\*:\d+|0\.0\.0\.0:\d+)$/.test(a))) return '127.0.0.1'
  if (addresses.some(a => a.startsWith('[::]'))) return '::1'
  const ip = addresses[0]?.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') ?? ''
  return /^[0-9a-f.:]+$/i.test(ip) ? ip : '127.0.0.1'
}

/** What's done of a case-2 or case-3 setup on the facts: their Caddy serves the domain already. */
const servedByThem = (x: Ctx): boolean => x.same && x.f.caddy?.hosts.includes(x.w.domain) === true

function caseTwo(x: Ctx, t: TheirCaddy): { built: Built[]; relies: Rely[] } | Manual[] {
  const { f, w } = x
  if (f.ports[443].kind !== 'unit') return ['twoConfigs']
  const unit = f.units.caddy
  const folder = socketFolder(w.socket)
  const group = unit ? unit.group || unit.user : ''
  const asRoot = !unit || unit.user === '' || unit.user === 'root'
  const done = servedByThem(x)
  const built: Built[] = [
    {
      step: ownFile('site-file', SITE_FILE, siteFile(w), x.b, { undo: [`sudo rmdir ${SITE_DIR} 2>/dev/null || true`] }),
      done,
    },
  ]
  if (!asRoot && f.folder && group !== '' && f.folder.group !== group) {
    const socket = (g: string): string => `if sudo test -S ${q(w.socket)}; then sudo chgrp ${q(g)} ${q(w.socket)}; fi`
    built.push({
      step: mk(
        'folder-group',
        {
          commands: [`sudo chgrp ${q(group)} ${q(folder)}`, socket(group), `sudo chmod 2750 ${q(folder)}`],
          skipIf: [`[ "$(stat -c %G ${q(folder)})" = ${q(group)} ]`],
          check: [`[ "$(stat -c %G ${q(folder)})" = ${q(group)} ]`],
          undo: [
            `sudo chgrp ${q(f.folder.group)} ${q(folder)}`,
            socket(f.folder.group),
            `sudo chmod 2750 ${q(folder)}`,
          ],
          touches: [{ kind: 'group', what: folder }],
          record: [{ kind: 'group', path: folder, from: f.folder.group, to: group }],
        },
        { folder, group },
      ),
      done: false,
    })
  }
  const steps = chain(t, x.b, {
    edit: STRIP_LINE,
    add: IMPORT_LINE,
    present: x.update ? null : `sudo grep -qxF ${shQuote(IMPORT_LINE)} ${q(t.file)}`,
    out: x.update && x.old ? x.old.domain : null,
    into: w.domain,
    extraCheck: [],
    record: [{ kind: 'line', file: t.file, line: IMPORT_LINE }],
    touch: { kind: 'line', what: t.file },
    hosts: fetchHosts(f.caddy?.hosts ?? [], w.domain),
    restoreSite: true,
    undo: false,
  })
  built.push(...steps.map(step => ({ step, done })))
  const relies: Rely[] = [
    ...relyOn(f, 443),
    ...(t.sha !== '' ? [{ kind: 'config' as const, path: t.file, sha: t.sha }] : []),
  ]
  return { built, relies }
}

function caseThree(x: Ctx, t: TheirCaddy, host: boolean): { built: Built[]; relies: Rely[] } | Manual[] {
  const { f, w } = x
  const id = f.caddy?.container ?? ''
  const container = containerOf(f, id)
  const network = host ? null : container ? helperNetwork(container) : null
  if (!host && network === null) return ['bridge']
  const args = socatRunArgs(network === null ? { host: true } : { network }, w, x.gid, x.id)
  const hash = args.find(a => a.startsWith(`${ARGS_LABEL}=`))?.slice(ARGS_LABEL.length + 1)
  const mine = ownContainer(f, SOCKET_NAME, 'socket')
  const up = mine !== undefined && mine.labels[ARGS_LABEL] === hash
  const url = host ? `http://127.0.0.1:${PORT_3B}/` : `http://${SOCKET_NAME}:${PORT_3A}/`
  const failed = 'bad address|refused|timed out|unable to resolve'
  const probe = `command -v wget >/dev/null || exit 0; wget -q -T 3 -O /dev/null ${url} 2>&1`
  const run = runStep('run-socat', SOCKET_NAME, 'socket', args, x.id)
  if (network) run.touches.push({ kind: 'network', what: network })
  const upstream = host ? `127.0.0.1:${PORT_3B}` : `${SOCKET_NAME}:${PORT_3A}`
  const done = servedByThem(x)
  const built: Built[] = [
    { step: pullStep('pull-socat', SOCAT_IMAGE), done: mine?.image === SOCAT_IMAGE },
    { step: run, done: up },
    {
      step: mk('reach-helper', {
        commands: [
          `if ! sudo docker exec ${q(id)} sh -c 'command -v wget' >/dev/null 2>&1; then echo "Your Caddy's image has no wget: this check is skipped."; fi`,
          `for i in 1 2 3 4 5; do out=$(sudo docker exec ${q(id)} sh -c ${shQuote(probe)} || true); if ! printf '%s\\n' "$out" | grep -Eqi ${q(failed)}; then break; fi; sleep 1; done`,
          `if printf '%s\\n' "$out" | grep -Eqi ${q(failed)}; then echo "$out"; false; fi`,
        ],
      }),
      done: up,
    },
  ]
  const steps = chain(t, x.b, {
    edit: STRIP_BLOCK,
    add: markedBlock(w, upstream),
    present: x.update
      ? null
      : `[ "$(${blockText(t.file)} | sha256sum)" = "$(printf '%s\\n' ${lines(markedBlock(w, upstream))} | sha256sum)" ]`,
    out: x.update && x.old ? x.old.domain : null,
    into: w.domain,
    extraCheck: [wholeBlock(t.file)],
    record: [{ kind: 'block', file: t.file, begin: BLOCK_BEGIN, end: BLOCK_END }],
    touch: { kind: 'block', what: t.file },
    hosts: fetchHosts(f.caddy?.hosts ?? [], w.domain),
    restoreSite: false,
    undo: false,
  })
  built.push(...steps.map(step => ({ step, done })))
  const relies: Rely[] = [
    ...relyOn(f, 443),
    { kind: 'container', port: null, id },
    ...(t.sha !== '' ? [{ kind: 'config' as const, path: t.file, sha: t.sha }] : []),
    ...(host ? relyOn(f, PORT_3B) : []),
  ]
  return { built, relies }
}

function warningsFor(x: Ctx, c: SetupCase, steps: PlanStep[]): Text[] {
  const { f, w } = x
  const out: Text[] = []
  if (f.dns.domain.length === 0) out.push({ key: 'server.warn.noDns', params: { domain: w.domain } })
  else if (!f.dns.domain.some(a => f.dns.local.includes(a)))
    out.push({ key: 'server.warn.dns', params: { domain: w.domain, addresses: f.dns.domain.join(', ') } })
  if (steps.some(s => s.id === 'docker-install') && (f.host.forwarding || f.host.forwarders.length > 0))
    out.push({ key: 'server.warn.forwarding', params: { forwarders: f.host.forwarders.join(', ') || 'ip_forward' } })
  const ports = { '1': '80, 443', '1b': '443', '4a': `80, ${PORT_4}`, '4b': `${PORT_4}` } as Record<string, string>
  const open = ports[c]
  if (open) out.push({ key: 'server.warn.ports', params: { ports: open } })
  if (c === '3a' || c === '3b') out.push({ key: 'server.warn.tcpHop' })
  if (c === '3a') {
    const net = steps.find(s => s.id === 'run-socat')?.touches.find(t => t.kind === 'network')?.what ?? ''
    out.push({ key: 'server.warn.composeDown', params: { network: net } })
  }
  if ((c === '2' || c === '3a' || c === '3b' || c === '4b') && f.host.fetch !== 'curl')
    out.push({ key: 'server.warn.noFetch' })
  if (steps.some(s => s.id === 'fetch-before')) out.push(...someHosts(f.caddy?.hosts ?? [], w.domain))
  if (c === '4b' && f.host.fetch === 'curl') out.push(...someHosts(f.nginx?.serverNames ?? [], w.domain))
  if (f.folder && f.folder.members.length > 0)
    out.push({
      key: 'server.warn.groupMembers',
      params: { group: f.folder.group, members: f.folder.members.join(', ') },
    })
  const unit = f.units.caddy
  if (c === '2' && (!unit || unit.user === '' || unit.user === 'root')) out.push({ key: 'server.warn.caddyRoot' })
  return out
}

const touchOf = (i: RecordItem): Touch => {
  switch (i.kind) {
    case 'file':
      return { kind: 'file', what: i.path }
    case 'line':
      return { kind: 'line', what: i.file }
    case 'block':
      return { kind: 'block', what: i.file }
    case 'backup':
      return { kind: 'backup', what: i.of }
    case 'group':
      return { kind: 'group', what: i.path }
    case 'container':
      return { kind: 'container', what: i.name }
    case 'volume':
      return { kind: 'volume', what: i.name }
    case 'image':
      return { kind: 'image', what: i.ref }
    case 'docker':
      return { kind: 'package', what: i.packages.join(' ') }
  }
}

function checkId(id: string): void {
  if (!PLAIN_ID.test(id)) throw new Error(`not a plain id: ${JSON.stringify(id)}`)
}

/** The plan for the facts Look found; a choice the board does not make itself gives its reasons. */
export function buildPlan(
  f: ServerFacts,
  w: Wanted,
  o: { id: string; docker: boolean },
): Plan | { case: null; why: Manual[] } {
  checkWanted(w)
  checkId(o.id)
  const choice = chooseCase(f, w)
  const raw = f.record !== null && f.record !== undefined ? setupRecord(f.record) : null
  if (choice.case === null) {
    // a run that did not finish: its Undo first; Look again after it
    if (choice.why.length === 1 && choice.why[0] === 'interrupted' && raw) {
      const p = undoPlan(raw, f, { id: o.id, removeDocker: false, removeEdited: false })
      return { ...p, warnings: [{ key: 'server.warn.interrupted' }, ...p.warnings] }
    }
    return choice
  }
  const c = choice.case
  const mine = raw && whose(raw, w) !== 'other' ? raw : null
  const old = mine && holdsSetup(mine) ? mine : null
  const who = old ? whose(old, w) : null
  const x: Ctx = {
    f,
    w,
    id: o.id,
    b: `${BACKUPS_DIR}/${o.id}`,
    gid: gidWord(f),
    old,
    update: who === 'update',
    same: who === 'same',
  }
  let made: { built: Built[]; relies: Rely[] } | Manual[]
  if (c === '2' || c === '3a' || c === '3b') {
    const t = theirCaddy(f)
    if (!t) return manual(['twoConfigs'])
    made = c === '2' ? caseTwo(x, t) : caseThree(x, t, c === '3b')
  } else {
    if (c === '4b' && !f.nginx) return manual(['other80'])
    made = ownSteps(x, c)
  }
  if (Array.isArray(made)) return manual(made)
  const carried = mine ? dedupe(mine.items) : []
  const steps = [guard(made.relies, carried), ...made.built.map(b => b.step)]
  const nothing = x.same && made.built.every(b => b.done)
  const four = c === '4a' || c === '4b'
  const ticks: Plan['ticks'] = steps.some(s => s.id === 'docker-install') && !o.docker ? ['docker'] : []
  return {
    id: o.id,
    kind: nothing ? 'nothing' : x.update ? 'update' : 'apply',
    case: c,
    address: ADDRESS(w, c),
    publicPort: four ? PORT_4 : null,
    relies: made.relies.map(r => relyLine(r).said),
    steps,
    undoTouches: dedupeTouches([
      ...steps.slice(1).flatMap(s => s.record.map(touchOf)),
      ...(c === '2' || c === '3a' || c === '3b' ? [{ kind: 'reload' as const, what: f.caddy?.hostPath ?? '' }] : []),
      ...(c === '4b' ? [{ kind: 'reload' as const, what: 'nginx' }] : []),
    ]),
    warnings: warningsFor(x, c, steps),
    ticks,
  }
}

function dedupeTouches(touches: Touch[]): Touch[] {
  const seen = new Set<string>()
  return touches.filter(t => {
    const key = `${t.kind} ${t.what}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// Undo

/** A file of the board's goes when it is as the board wrote it, or when the owner said so. */
function dropFile(path: string, sha: string, removeEdited: boolean): string {
  if (removeEdited) return `sudo rm -f ${q(path)}`
  return `if [ "${hashOf(path)}" = ${sha} ]; then sudo rm -f ${q(path)}; else echo ${q(`${path} was changed since the board wrote it: kept.`)}; fi`
}

/**
 * Undo from the record (call 22): newest first; the board's line or block out of their file as it
 * is now (never the backup written back), checked, their Caddy reloaded; containers and volumes by
 * name and label; images the board pulled and nothing uses; the folder's group back; Docker only
 * when ticked; /etc/agent-board last. The last step lists what the owner made by hand, not run.
 */
export function undoPlan(
  r: SetupRecord,
  f: ServerFacts,
  o: { id: string; removeDocker: boolean; removeEdited: boolean },
): Plan {
  checkWanted({ user: r.pair.user, socket: r.pair.socket, domain: r.domain, publicPort: r.publicPort })
  checkId(o.id)
  const items = withEdit(r, f, dedupe(r.items))
  const b = `${BACKUPS_DIR}/${o.id}`
  const relies: Rely[] = []
  const warnings: Text[] = []
  /** A warning once, however many steps give it. */
  const warn = (more: Text[]): void => {
    for (const w of more) if (!warnings.some(x => x.key === w.key)) warnings.push(w)
  }
  const steps: PlanStep[] = []
  const done = new Set<string>()
  const dockerItem = items.find(i => i.kind === 'docker')
  const onlyOurs = (f.docker?.containers ?? []).every(c => c.labels[ROLE_LABEL] !== undefined)
  const offerDocker = dockerItem !== undefined && onlyOurs
  const files = items.filter(i => i.kind === 'file')
  const theirFile = theirCaddy(f)?.file
  for (const item of [...items].reverse()) {
    switch (item.kind) {
      case 'line':
      case 'block': {
        const t = theirCaddy(f)
        const theirs = t !== null && t.file === item.file
        if (!theirs) warnings.push({ key: 'server.warn.notTheirConfig', params: { file: item.file } })
        const plain: TheirCaddy = t && theirs ? t : bareFile(item.file)
        const line = item.kind === 'line'
        steps.push(
          ...chain(plain, b, {
            edit: line ? STRIP_LINE : STRIP_BLOCK,
            add: null,
            present: line
              ? `! sudo grep -qxF ${shQuote(IMPORT_LINE)} ${q(item.file)}`
              : `! sudo grep -qx ${shQuote(BLOCK_END)} ${q(item.file)}`,
            out: r.domain,
            into: null,
            extraCheck: line ? [] : [wholeBlock(item.file)],
            record: [item],
            touch: { kind: item.kind, what: item.file },
            hosts: theirs ? fetchHosts(f.caddy?.hosts ?? [], r.domain) : [],
            restoreSite: false,
            undo: true,
          }),
        )
        if (theirs && t) {
          if (t.sha !== '') relies.push({ kind: 'config', path: t.file, sha: t.sha })
          relies.push(...relyOn(f, 443))
          if (t.live && t.fetch) warn(someHosts(f.caddy?.hosts ?? [], r.domain))
        }
        break
      }
      case 'file': {
        const id =
          item.path === NGINX_FILE ? 'drop-nginx-file' : item.path === SITE_FILE ? 'drop-site-file' : 'drop-caddyfile'
        const dir = item.path === SITE_FILE ? SITE_DIR : item.path === CADDY_FILE ? CADDY_DIR : null
        const nginx = item.path === NGINX_FILE
        // a copy first, which the rollback puts back (only where the file is gone)
        const saved = `${b}/${item.path.slice(item.path.lastIndexOf('/') + 1)}.dropped`
        const hosts = nginx && f.host.fetch === 'curl' ? fetchHosts(f.nginx?.serverNames ?? [], r.domain) : []
        if (nginx && f.host.fetch === 'curl') warn(someHosts(f.nginx?.serverNames ?? [], r.domain))
        // board.caddy stays while a Caddyfile imports it: their Caddy would not start without it
        const importers = [
          ...new Set([
            ...items.flatMap(i => (i.kind === 'line' ? [i.file] : [])),
            ...(theirFile && isPlainPath(theirFile) ? [theirFile] : []),
          ]),
        ]
        steps.push(
          mk(
            id,
            {
              commands: [
                ...(item.path === SITE_FILE && importers.length
                  ? [
                      `if ${importsSite(importers)}; then echo ${q(`${SITE_FILE} stays: a Caddyfile still imports it.`)}; false; fi`,
                    ]
                  : []),
                `sudo install -d -m 700 ${q(b)}`,
                `if sudo test -f ${q(item.path)}; then sudo cp -p ${q(item.path)} ${q(saved)}; fi`,
                ...(hosts.length ? fetchInto(hosts, `${b}/nginx-before`, '127.0.0.1', true) : []),
                `if sudo test -e ${q(item.path)}; then ${dropFile(item.path, item.sha256, o.removeEdited)}; fi`,
                `sudo rm -f ${q(`${item.path}.part`)}`,
                ...(dir ? [`sudo rmdir ${q(dir)} 2>/dev/null || true`] : []),
                ...(nginx
                  ? [
                      'sudo nginx -t',
                      'sudo systemctl reload nginx',
                      ...(hosts.length
                        ? ['sleep 1', ...compareWith(`${b}/nginx-before`, '127.0.0.1', true).slice(1)]
                        : []),
                    ]
                  : []),
              ],
              skipIf: nginx ? [] : [`! sudo test -e ${q(item.path)}`],
              undo: [
                `if sudo test -f ${q(saved)} && ! sudo test -e ${q(item.path)}; then ${dir ? `sudo install -d -m 755 ${q(dir)}; ` : ''}${copyWhole(saved, item.path)}; fi`,
                ...(nginx ? ['if sudo nginx -t 2>/dev/null; then sudo systemctl reload nginx; fi'] : []),
              ],
              touches: [
                { kind: 'file', what: item.path },
                ...(nginx ? [{ kind: 'reload' as const, what: 'nginx' }] : []),
              ],
              record: [item],
              timeoutS: nginx ? 300 : 60,
            },
            { file: item.path },
          ),
        )
        break
      }
      case 'container': {
        const role = item.name === CADDY_NAME ? 'caddy' : 'socket'
        const id = role === 'caddy' ? 'drop-caddy' : 'drop-socket'
        steps.push(
          mk(
            id,
            {
              commands: [
                `if ${isOursCmd(item.name, role)}; then sudo docker rm -f ${item.name} >/dev/null; elif sudo docker inspect ${item.name} >/dev/null 2>&1; then echo ${q(`${item.name} has not the board's label: kept.`)}; fi`,
              ],
              touches: [{ kind: 'container', what: item.name }],
              record: [item],
              timeoutS: 120,
            },
            { container: item.name },
          ),
        )
        break
      }
      case 'volume': {
        if (done.has('volume')) break
        done.add('volume')
        const volumes = items.filter(i => i.kind === 'volume')
        steps.push(
          mk('drop-volumes', {
            commands: volumes.map(v => `if ${volumeOurs(v.name)}; then sudo docker volume rm ${v.name} >/dev/null; fi`),
            touches: volumes.map(v => touchOf(v)),
            record: volumes,
          }),
        )
        break
      }
      case 'image': {
        if (done.has('image')) break
        done.add('image')
        const pulled = items.filter((i): i is Extract<RecordItem, { kind: 'image' }> => i.kind === 'image' && !i.before)
        if (!pulled.length) break
        steps.push(
          mk('drop-images', {
            commands: pulled.map(
              i =>
                `if sudo docker image inspect ${q(i.ref)} >/dev/null 2>&1; then sudo docker image rm ${q(i.ref)} >/dev/null 2>&1 || echo ${q(`${i.ref} is in use: kept.`)}; fi`,
            ),
            touches: pulled.map(touchOf),
            record: items.filter(i => i.kind === 'image'),
            timeoutS: 120,
          }),
        )
        break
      }
      case 'group': {
        const socket = `if sudo test -S ${q(r.pair.socket)}; then sudo chgrp ${q(item.from)} ${q(r.pair.socket)}; fi`
        steps.push(
          mk(
            'group-back',
            {
              commands: [
                `if [ "$(stat -c %G ${q(item.path)})" = ${q(item.to)} ]; then sudo chgrp ${q(item.from)} ${q(item.path)}; fi`,
                socket,
                `sudo chmod 2750 ${q(item.path)}`,
              ],
              touches: [{ kind: 'group', what: item.path }],
              record: [item],
            },
            { folder: item.path, group: item.from },
          ),
        )
        break
      }
      case 'docker': {
        if (!o.removeDocker || !offerDocker) break
        steps.push(
          mk('drop-docker', {
            commands: [
              `if [ -n "$(sudo docker ps -aq)$(sudo docker volume ls -q)$(sudo docker images -q)" ]; then echo "Docker holds containers, volumes or images that are not the board's: Docker stays."; else sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 purge -y ${item.packages.join(' ')} && sudo rm -f ${item.files.join(' ')} && sudo rm -rf /var/lib/docker /var/lib/containerd; fi`,
            ],
            touches: [touchOf(item), ...item.files.map(what => ({ kind: 'file' as const, what }))],
            record: [item],
            timeoutS: 900,
          }),
        )
        break
      }
      case 'backup':
        break
    }
  }
  const folder = socketFolder(r.pair.socket)
  steps.push(
    mk('forget', {
      commands: [
        `sudo rm -rf ${RECORD_FILE} ${BACKUPS_DIR} ${CADDY_DIR}`,
        "# the runs' scripts and logs go with the folder: sudo rm -rf /etc/agent-board",
      ],
      touches: [{ kind: 'file', what: RECORD_FILE }],
      record: items,
    }),
    mk(BY_HAND_ID, {
      commands: [
        '# what you made by hand in step 1, if you want it gone too:',
        `sudo rm -f ${q(keysFile(r.pair.user))}`,
        `sudo rm -rf ${q(folder)}`,
        `sudo userdel ${q(r.pair.user)}`,
        `# and the "Match User ${r.pair.user}" block at the end of /etc/ssh/sshd_config, by hand; then:`,
        `sudo sshd -t && ${SSHD_RELOAD}`,
      ],
      skipIf: BY_HAND,
    }),
  )
  const ticks: Plan['ticks'] = [
    ...(offerDocker ? ['removeDocker' as const] : []),
    ...(files.length ? ['removeEdited' as const] : []),
  ]
  return {
    id: o.id,
    kind: 'undo',
    case: r.case,
    address: r.address,
    publicPort: r.publicPort,
    relies: relies.map(x => relyLine(x).said),
    steps: [guard(relies, items), ...steps],
    undoTouches: [],
    warnings,
    ticks,
  }
}

/**
 * A record of case 2 or 3 with the line or block in their file named, even when its run was cut
 * short before it recorded it (a run of an earlier board, or one stopped between its backup and its
 * write): the file its backup is of, else the Caddyfile Look found. Undo takes it out only where it
 * is there (its backup step skips when it is not), so naming it once too often changes nothing.
 */
function withEdit(r: SetupRecord, f: ServerFacts, items: RecordItem[]): RecordItem[] {
  const kind = r.case === '2' ? 'line' : r.case === '3a' || r.case === '3b' ? 'block' : null
  if (kind === null || items.some(i => i.kind === kind)) return items
  const backup = items.find((i): i is Extract<RecordItem, { kind: 'backup' }> => i.kind === 'backup')
  const file = backup?.of ?? theirCaddy(f)?.file
  if (file === undefined || !isPlainPath(file)) return items
  return [
    ...items,
    kind === 'line'
      ? { kind: 'line', file, line: IMPORT_LINE }
      : { kind: 'block', file, begin: BLOCK_BEGIN, end: BLOCK_END },
  ]
}

/** Their file when Look found no Caddy using it: the line or block comes out, nothing is reloaded. */
function bareFile(file: string): TheirCaddy {
  return {
    live: false,
    file,
    sha: '',
    candidate: null,
    candidateCfg: file,
    cfg: file,
    validate: () => '',
    adapt: '',
    reload: [],
    isUp: '',
    address: '127.0.0.1',
    fetch: false,
  }
}

// ---------------------------------------------------------------------------------------------
// Do it myself without Look (call 28)

const P_FILE = '<your Caddyfile>'
const P_INSIDE = '<its Caddyfile inside the container>'
const P_CONTAINER = '<your Caddy container>'
const P_NETWORK = '<your network>'
const P_GROUP = '<the folder group>'
const P_PROGRAM = '<the program>'

/** For "Do it myself" without Look: facts whose unknowns are `<placeholders>`. */
export function manualFacts(c: SetupCase, distro: 'debian' | 'ubuntu'): ServerFacts {
  const free: Holder = { kind: 'free' }
  const other: Holder = { kind: 'process', program: P_PROGRAM }
  const facts: ServerFacts = {
    distro: { id: distro, version: '<version>', codename: '<codename>', arch: '', supported: true },
    ports: { 80: free, 443: free, 8443: free, 8480: free, 8481: free },
    docker: null,
    systemd: true,
    units: { caddy: null, nginx: null },
    fence: {},
    folder: { mode: '2750', owner: '<user>', group: P_GROUP, gid: Number.NaN, members: [] },
    socket: null,
    record: null,
    lockHeld: false,
    host: {
      selinux: null,
      forwarding: false,
      forwarders: [],
      fetch: null,
      missing: [],
      sudo: 'sudo',
      coreutils: 'gnu',
      conflicts: [],
    },
    dns: { domain: [], local: [] },
    caddy: null,
    nginx: null,
  }
  const caddyFacts = {
    adapter: 'caddyfile',
    resume: false,
    version: 'v2',
    hosts: [],
    adminOff: false,
    autoHttpsOff: false,
    sha256: '',
    endsWithNewline: true,
    address: '127.0.0.1',
  }
  switch (c) {
    case '1':
      return facts
    case '1b':
      return { ...facts, ports: { ...facts.ports, 80: other } }
    case '2': {
      const holder: Holder = { kind: 'unit', unit: 'caddy.service', program: 'caddy' }
      return {
        ...facts,
        ports: { ...facts.ports, 80: holder, 443: holder },
        units: {
          caddy: {
            execStart: ['/usr/bin/caddy', 'run', '--environ', '--config', P_FILE],
            execReload: [],
            user: 'caddy',
            group: 'caddy',
            active: 'active',
            workingDirectory: '',
          },
          nginx: null,
        },
        caddy: { ...caddyFacts, where: 'unit', container: null, config: P_FILE, hostPath: P_FILE, mount: null },
      }
    }
    case '3a':
    case '3b': {
      const host = c === '3b'
      const holder: Holder = { kind: 'container', id: P_CONTAINER, program: 'caddy' }
      return {
        ...facts,
        ports: { ...facts.ports, 80: holder, 443: holder },
        docker: {
          version: '',
          podman: false,
          rootless: false,
          userns: false,
          containers: [
            {
              id: P_CONTAINER,
              name: P_CONTAINER,
              image: 'caddy',
              cmd: [],
              hostNetwork: host,
              networks: host ? [] : [{ name: P_NETWORK, driver: 'bridge', userDefined: true }],
              mounts: [],
              ports: [],
              labels: {},
            },
          ],
        },
        caddy: {
          ...caddyFacts,
          where: 'container',
          container: P_CONTAINER,
          config: P_INSIDE,
          hostPath: P_FILE,
          mount: 'file',
        },
      }
    }
    case '4a':
      return { ...facts, ports: { ...facts.ports, 443: other } }
    case '4b': {
      const nginx: Holder = { kind: 'unit', unit: 'nginx.service', program: 'nginx' }
      return {
        ...facts,
        ports: { ...facts.ports, 443: other, 80: nginx },
        nginx: { confD: true, listen80: ['80'], serverNames: [] },
      }
    }
  }
}

/** Each placeholder of `manualFacts(c, …)`'s plan with the command that finds its value (the folder's, of the tunnel's socket). */
export function placeholderFinders(c: SetupCase, socket: string): { placeholder: string; command: string }[] {
  const folder = q(socketFolder(socket))
  const gid = { placeholder: '<gid>', command: `stat -c %g ${folder}` }
  const inspect = (what: string): string => `docker inspect -f '${what}' '${P_CONTAINER}'`
  switch (c) {
    case '2':
      return [
        { placeholder: P_FILE, command: 'systemctl show caddy -p ExecStart' },
        { placeholder: P_GROUP, command: `stat -c %G ${folder}` },
      ]
    case '3a':
    case '3b':
      return [
        { placeholder: P_CONTAINER, command: 'docker ps --format "{{.ID}} {{.Names}} {{.Image}} {{.Ports}}"' },
        { placeholder: P_FILE, command: inspect('{{json .Mounts}}') },
        { placeholder: P_INSIDE, command: inspect('{{json .Config.Cmd}}') },
        ...(c === '3a' ? [{ placeholder: P_NETWORK, command: inspect('{{json .NetworkSettings.Networks}}') }] : []),
        gid,
      ]
    default:
      return [gid]
  }
}
