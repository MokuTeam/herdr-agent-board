// What the one command ("Do it myself", the simple-setup spec's "'Do it myself': one command")
// carries of the board's own scripts: rendered by the board's own functions (lookScript2,
// buildPlan, undoPlan, relyLine, launchScript, and runScript's words for the record's items) for
// every shape a server can give them, each with stand-ins where the server's own values go, then
// made templates (core/server-template.ts). The command reads Look's output on the server, picks
// the steps the board would have planned, fills them in and puts the run together around them as
// core/server-script.ts runScript does (core/server-oneshot-awk.ts); core/server-oneshot.ts puts
// it all together.
//
// A plan's steps come in parts, each a list of step templates: step 1's parts the server lacks
// (one template each, the same in every plan); the case's own steps, by the case's shape (what
// changes their lines, not only their values: the case; Docker there or not; their sites fetched
// or not; the socket folder's group to change or not; their Caddyfile checked beside itself or in
// place; a first setup or an update; the folder's gid read by the run, when the run makes the
// folder); and for Undo, after the case's, step 1's parts the record names and the record's end.
// The guard's lines (who holds which port, their config's hash, step 1's parts still missing) are
// filled in from rely lines of their own. Pure, with no node: import.
import { t } from './lang.ts'
import type { Container, Holder, RoundOne, ServerFacts, StepOneFacts } from './server-facts.ts'
import { type LookInput, lookScript2 } from './server-look.ts'
import {
  buildPlan,
  byHand,
  nginxAddress,
  type Plan,
  type PlanStep,
  type RecordItem,
  type Rely,
  relyLine,
  type SetupCase,
  type SetupRecord,
  undoPlan,
  type Wanted,
} from './server-plan.ts'
import { aheadWord, itemWord, keyOf, LAST_LINE, launchScript } from './server-script.ts'
import { type Inputs, type Place, templateOf, type Value } from './server-template.ts'
import {
  argsHash,
  BLOCK_BEGIN,
  BLOCK_END,
  CADDY_FILE,
  CADDY_IMAGE,
  CADDY_NAME,
  FENCE_FILE,
  IMPORT_LINE,
  NGINX_FILE,
  SITE_FILE,
  SOCAT_IMAGE,
  SOCKET_NAME,
  SSHD_CONFIG,
  socatRunArgs,
  VOLUMES,
} from './server-texts.ts'
import { keysFile, socketFolder, sshdBlock } from './tunnel-snippets.ts'

/** Their Caddyfile's candidate beside it (core/server-plan.ts theirCaddy). */
const CANDIDATE = '.Caddyfile.agent-board'
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'
const resolveAt = (address: string): string => (address.includes(':') ? `[${address}]` : address)
const str = (v: Value | undefined): string => {
  if (typeof v !== 'string') throw new Error('one value expected')
  return v
}
const list = (v: Value | undefined): string[] => {
  if (!Array.isArray(v)) throw new Error('a list expected')
  return v
}

// ---------------------------------------------------------------------------------------------
// The server's values: a stand-in each, another plain value, and a probe where it may need quoting

const HEX_A = 'abcdef0123456789'.repeat(4)

/** Every value the command fills in, by the name its templates and its awk give it. */
export const INPUTS: Inputs = {
  plan_id: { sentinel: 'zqplanzq', alt: '20261023-100400-3f9a' },
  run_id: { sentinel: 'zqrunzq', alt: '20261023-100401-0b1c' },
  gid: { sentinel: '7654321', alt: '995' },
  distro: { sentinel: 'debian', alt: 'ubuntu' },
  // their Caddy
  file: { sentinel: '/zqfdir/zqfile', alt: '/etc/caddy/Caddyfile', probe: '/srv/my web/Caddy file' },
  config: { sentinel: '/zqcdir/zqconfig', alt: '/etc/caddy/Caddyfile', probe: '/etc/my caddy/Caddyfile' },
  sha: { sentinel: HEX_A, alt: '0123456789abcdef'.repeat(4) },
  addr: { sentinel: '10.123.45.67', alt: '127.0.0.1', probe: 'fd00::1' },
  hosts: { sentinel: ['zqhost.example.org'], alt: ['shop.example.org'], probe: ['a.example.com', 'b.example.org'] },
  cid: { sentinel: 'c0ffee00'.repeat(8), alt: `7f3c${'0a'.repeat(30)}` },
  network: { sentinel: 'zqnet', alt: 'web_default' },
  bin: { sentinel: '/zqbin/caddy', alt: '/usr/bin/caddy', probe: '/opt/my caddy/caddy' },
  user: { sentinel: 'zquser', alt: 'caddy' },
  group: { sentinel: 'zqgroup', alt: 'caddy' },
  oldgroup: { sentinel: 'zqoldgrp', alt: 'boardtunnel' },
  // their nginx (4b)
  listen: { sentinel: ['10.98.76.54:80'], alt: ['80'], probe: ['[::]:80', '127.0.0.1:80'] },
  nhosts: { sentinel: ['zqnhost.example.org'], alt: ['shop.example.org'], probe: ['a.example.com', 'b.example.org'] },
  // an update: the domain set up before
  old: { sentinel: 'zqold.example.org', alt: 'old.example.com' },
  // Undo: the record's own values
  rec_domain: { sentinel: 'zqrecdom.example.org', alt: 'board.example.com' },
  sha_caddyfile: { sentinel: 'fedcba9876543210'.repeat(4), alt: 'ab'.repeat(32) },
  sha_site: { sentinel: '13579bdf02468ace'.repeat(4), alt: 'cd'.repeat(32) },
  sha_nginx: { sentinel: '02468ace13579bdf'.repeat(4), alt: 'ef'.repeat(32) },
  setup_caddy: { sentinel: 'zqsetupc', alt: 'r0' },
  setup_socket: { sentinel: 'zqsetups', alt: 'r1' },
  group_from: { sentinel: 'zqgfrom', alt: 'boardtunnel' },
  group_to: { sentinel: 'zqgto', alt: 'caddy' },
  ufile: { sentinel: '/zqudir/zqufile', alt: '/etc/caddy/Caddyfile', probe: '/srv/my web/Caddy file' },
  tfile: { sentinel: '/zqtdir/zqtfile', alt: '/srv/caddy/Caddyfile', probe: '/srv/our web/Caddyfile' },
  // round two of Look
  cr_bin: { sentinel: '/zqcrbin/caddy', alt: '/usr/bin/caddy', probe: '/opt/my caddy/caddy' },
  cr_cid: { sentinel: 'deadbeef'.repeat(8), alt: `7f3c${'0a'.repeat(30)}` },
  cr_cmd0: { sentinel: 'zqcmd0', alt: 'caddy', probe: '/usr/local/bin/my caddy' },
  cr_cfg: { sentinel: '/zqcrdir/zqcrcfg', alt: '/etc/caddy/Caddyfile', probe: '/etc/my caddy/Caddyfile' },
  cr_rel: { sentinel: 'zqcrrel/Caddyfile', alt: 'Caddyfile', probe: 'my caddy/Caddyfile' },
  cr_host: { sentinel: '/zqcrhost/zqcrhfile', alt: '/srv/web/Caddyfile', probe: '/srv/my web/Caddyfile' },
  nx_bin: { sentinel: '/zqnxbin/nginx', alt: '/usr/sbin/nginx', probe: '/opt/my nginx/nginx' },
  nx_conf: { sentinel: '/zqnxconf/nginx.conf', alt: '/etc/nginx/nginx.conf', probe: '/etc/my nginx/nginx.conf' },
  // the launch: the run packed (gzip, then base64), as the board's service packs it
  packed: { sentinel: 'zqpackedzq', alt: 'H4sIAAAAAAAAAwMAAAAAAAAAAAA=' },
}

const scalar = (name: string): Place => ({ name, from: [name], text: v => str(v[name]) })
const candidateOf = (name: string): Place => ({
  name: `${name === 'file' ? '' : `${name}_`}candidate`,
  from: [name],
  text: v => `${dirOf(str(v[name]))}/${CANDIDATE}`,
})

/** The places every template may have; those a rendering lacks are simply not there. */
function places(w: Wanted, c: SetupCase | null): Place[] {
  return [
    ...['plan_id', 'run_id', 'gid', 'sha', 'cid', 'network', 'bin', 'user', 'group', 'oldgroup', 'old'].map(scalar),
    ...['rec_domain', 'sha_caddyfile', 'sha_site', 'sha_nginx', 'setup_caddy', 'setup_socket'].map(scalar),
    ...['group_from', 'group_to', 'file', 'config', 'ufile', 'tfile', 'packed'].map(scalar),
    ...['cr_bin', 'cr_cid', 'cr_cmd0', 'cr_cfg', 'cr_rel', 'cr_host', 'nx_bin', 'nx_conf'].map(scalar),
    candidateOf('file'),
    candidateOf('config'),
    candidateOf('ufile'),
    { name: 'docker_repo', from: ['distro'], text: v => `https://download.docker.com/linux/${str(v.distro)}` },
    { name: 'addr_r', from: ['addr'], text: v => resolveAt(str(v.addr)) },
    { name: 'hosts', from: ['hosts'], text: v => list(v.hosts), spelling: 'sqwords' },
    { name: 'nhosts', from: ['nhosts'], text: v => list(v.nhosts), spelling: 'sqwords' },
    { name: 'listen', from: ['listen'], text: v => list(v.listen), spelling: 'listen' },
    {
      name: 'nginx_resolve',
      from: ['listen'],
      text: v => `${w.domain}:80:${resolveAt(nginxAddress(list(v.listen)))}`,
    },
    {
      name: 'socat_hash',
      from: ['network'],
      text: v => argsHash(hashInput(socatArgs(c === '3b', w, v))),
    },
  ]
}

const socatArgs = (host: boolean, w: Wanted, v: Record<string, Value>): string[] =>
  socatRunArgs(host ? { host: true } : { network: str(v.network) }, w, str(v.gid), str(v.plan_id))

/**
 * What a container's settings hash is taken of (core/server-texts.ts `labelled`): its name, role,
 * settings with `<gid>` for the folder's gid (which has a label of its own), image and command,
 * without the run's id. Read back from its `docker run` argv, and checked against the hash in its
 * label.
 */
export function hashInput(args: readonly string[]): string[] {
  const image = args.findIndex(a => a === CADDY_IMAGE || a === SOCAT_IMAGE)
  const role = (args[7] ?? '').replace(/^agent-board\.role=/, '')
  // the folder's gid has a label of its own; the settings are hashed with `<gid>` in its place
  const gid = (args[13] ?? '').replace(/^agent-board\.gid=/, '')
  const anyGid = (a: string): string => (a === gid ? '<gid>' : a === `65534:${gid}` ? '65534:<gid>' : a)
  const input = [args[3] ?? '', role, ...args.slice(14, image).map(anyGid), ...args.slice(image)]
  const label = (args[11] ?? '').replace(/^agent-board\.args=/, '')
  if (image < 0 || argsHash(input) !== label) throw new Error('the settings hash is not of these args')
  return input
}

// ---------------------------------------------------------------------------------------------
// The facts each shape is rendered from

/**
 * A shape of the case's steps in Apply: what changes their lines. Dimensions a case does not have
 * are false (Docker: true for 2, 3a, 3b). `rgid`: the run makes the socket's folder and reads its
 * gid there (the cases with a container of the board's).
 */
export interface ApplyShape {
  c: SetupCase
  docker: boolean
  fetch: boolean
  group: boolean
  cand: boolean
  update: boolean
  rgid: boolean
}

/** The shape's name, as the command's awk spells it too. */
export const applyKey = (s: ApplyShape): string =>
  `a.${s.c}.d${+s.docker}.f${+s.fetch}.g${+s.group}.c${+s.cand}.u${+s.update}.r${+s.rgid}`

/** Every shape the board's buildPlan has for the cases it does. */
export function applyShapes(): ApplyShape[] {
  const out: ApplyShape[] = []
  const add = (s: Partial<ApplyShape> & { c: SetupCase }): void => {
    out.push({ docker: true, fetch: false, group: false, cand: false, update: false, rgid: false, ...s })
  }
  for (const update of [false, true]) {
    for (const rgid of [false, true]) {
      for (const c of ['1', '1b', '4a'] as const) for (const docker of [true, false]) add({ c, docker, update, rgid })
      for (const docker of [true, false])
        for (const fetch of [true, false]) add({ c: '4b', docker, fetch, update, rgid })
      for (const c of ['3a', '3b'] as const)
        for (const cand of [true, false]) for (const fetch of [true, false]) add({ c, cand, fetch, update, rgid })
    }
    // case 2 has no container of the board's: the folder's gid is never in its lines
    for (const group of [true, false]) for (const fetch of [true, false]) add({ c: '2', fetch, group, update })
  }
  return out
}

const FREE: Holder = { kind: 'free' }

/** The tunnel's `Match` block as `sshd -T` prints it back: its keys lowercased, its values as written. */
function fenceOf(user: string): Record<string, string> {
  const fence: Record<string, string> = {}
  for (const line of sshdBlock(user).split('\n').slice(1)) {
    const [key = '', ...value] = line.trim().split(/\s+/)
    fence[key.toLowerCase()] = value.join(' ')
  }
  return fence
}

/** What every shape starts from: Docker there, nothing on the web ports, step 1 done (the folder, sshd's fence). */
function baseFacts(w: Wanted, v: Record<string, Value>): ServerFacts {
  return {
    distro: { id: str(v.distro), version: '13', codename: 'trixie', arch: 'x86_64', supported: true },
    ports: { 80: FREE, 443: FREE, 8443: FREE, 8480: FREE, 8481: FREE },
    docker: { version: '29.0.0', podman: false, rootless: false, userns: false, containers: [] },
    systemd: true,
    units: { caddy: null, nginx: null },
    // sshd's fence as step 1 makes it (core/server-look.ts reads it back so)
    fence: fenceOf(w.user),
    folder: { mode: '2750', owner: w.user, group: w.user, gid: Number(str(v.gid)), members: [] },
    socket: null,
    record: null,
    lockHeld: false,
    host: {
      selinux: null,
      forwarding: false,
      forwarders: [],
      fetch: 'curl',
      missing: [],
      sudo: 'sudo',
      coreutils: 'gnu',
      conflicts: [],
    },
    dns: { domain: [], local: [] },
    caddy: null,
    nginx: null,
  }
}

/** A stand-in for what the plain texts name only (a holder, a container's name): never in a step. */
const SHOWN = { holder: 'zqshownholder', container: 'zqshowncontainer' }

function theirCaddyUnit(f: ServerFacts, v: Record<string, Value>, fetch: boolean): ServerFacts {
  const holder: Holder = { kind: 'unit', unit: 'caddy.service', program: 'caddy' }
  return {
    ...f,
    ports: { ...f.ports, 80: holder, 443: holder },
    units: {
      caddy: {
        execStart: [str(v.bin), 'run', '--environ', '--config', str(v.file)],
        execReload: [],
        user: str(v.user),
        group: str(v.group),
        active: 'active',
        workingDirectory: '',
      },
      nginx: f.units.nginx,
    },
    caddy: {
      where: 'unit',
      container: null,
      config: str(v.file),
      hostPath: str(v.file),
      mount: null,
      adapter: 'caddyfile',
      resume: false,
      version: 'v2.6.2',
      hosts: fetch ? list(v.hosts) : [],
      adminOff: false,
      autoHttpsOff: false,
      sha256: str(v.sha),
      endsWithNewline: true,
      address: str(v.addr),
    },
  }
}

function theirCaddyContainer(
  f: ServerFacts,
  v: Record<string, Value>,
  o: { host: boolean; cand: boolean; fetch: boolean; file?: string },
): ServerFacts {
  const id = str(v.cid)
  const container: Container = {
    id,
    name: `/${SHOWN.container}`,
    image: 'caddy:2',
    cmd: ['caddy', 'run', '--config', str(v.config), '--adapter', 'caddyfile'],
    hostNetwork: o.host,
    networks: o.host
      ? [{ name: 'host', driver: 'host', userDefined: false }]
      : [{ name: str(v.network), driver: 'bridge', userDefined: true }],
    mounts: [],
    ports: [],
    labels: {},
  }
  const holder: Holder = { kind: 'container', id, program: 'caddy' }
  return {
    ...f,
    ports: { ...f.ports, 80: holder, 443: holder },
    docker: {
      ...(f.docker ?? { version: '29.0.0', podman: false, rootless: false, userns: false }),
      containers: [container],
    },
    caddy: {
      where: 'container',
      container: id,
      config: str(v.config),
      hostPath: o.file ?? str(v.file),
      mount: o.cand ? 'folder' : 'file',
      adapter: 'caddyfile',
      resume: false,
      version: 'v2.11.7',
      hosts: o.fetch ? list(v.hosts) : [],
      adminOff: false,
      autoHttpsOff: false,
      sha256: str(v.sha),
      endsWithNewline: true,
      address: str(v.addr),
    },
  }
}

/** A record of an earlier setup of this pair for another domain: what makes buildPlan plan an update. */
function earlierRecord(c: SetupCase, w: Wanted, v: Record<string, Value>): SetupRecord {
  return {
    v: 1,
    id: 'r0',
    at: '2026-10-21T10:04:00.000Z',
    state: 'applied',
    case: c,
    pair: { user: w.user, socket: w.socket },
    domain: str(v.old),
    publicPort: null,
    address: `https://${str(v.old)}`,
    items: [{ kind: 'volume', name: VOLUMES[0] }],
  }
}

/** Step 1 as Look reads it when all of it is there but the socket's folder (the run makes it). */
const FOLDER_ONLY: StepOneFacts = {
  user: { uid: 990, group: 'zqusergroup' },
  keys: 'same',
  keysDir: true,
  include: true,
}

/** The facts that make buildPlan give this shape. */
export function applyFacts(s: ApplyShape, w: Wanted, v: Record<string, Value>): ServerFacts {
  let f = baseFacts(w, v)
  if (!s.docker) f = { ...f, docker: null }
  const other: Holder = { kind: 'process', program: SHOWN.holder }
  const nginx: Holder = { kind: 'unit', unit: 'nginx.service', program: 'nginx' }
  switch (s.c) {
    case '1':
      break
    case '1b':
      f = { ...f, ports: { ...f.ports, 80: other } }
      break
    case '4a':
      f = { ...f, ports: { ...f.ports, 443: other } }
      break
    case '4b':
      f = {
        ...f,
        ports: { ...f.ports, 443: other, 80: nginx },
        nginx: { confD: true, listen80: list(v.listen), serverNames: s.fetch ? list(v.nhosts) : [] },
      }
      break
    case '2':
      f = theirCaddyUnit(f, v, s.fetch)
      if (f.folder) f = { ...f, folder: { ...f.folder, group: s.group ? str(v.oldgroup) : str(v.group) } }
      break
    case '3a':
    case '3b':
      f = theirCaddyContainer(f, v, { host: s.c === '3b', cand: s.cand, fetch: s.fetch })
      break
  }
  if (s.rgid) f = { ...f, folder: null, stepOne: FOLDER_ONLY }
  return s.update ? { ...f, record: earlierRecord(s.c, w, v) } : f
}

// ---------------------------------------------------------------------------------------------
// Steps as the command's awk takes them

/** Step 1's steps in Apply (core/server-plan.ts stepOneSteps). */
const STEP_ONE_IDS: ReadonlySet<string> = new Set(['tunnel-user', 'socket-folder', 'keys-file', 'sshd-fence'])

/** A record item's class, as runScript treats it: Docker's (d), a group or a backup (g: recorded only when its step ran), step 1's (m), an image (i), any other (o). */
function itemClass(i: RecordItem): string {
  if (i.kind === 'docker') return 'd'
  if (i.kind === 'group' || i.kind === 'backup') return 'g'
  if (i.kind === 'user' || i.kind === 'folder' || i.kind === 'keys' || i.kind === 'fence') return 'm'
  return i.kind === 'image' ? 'i' : 'o'
}

/**
 * Undo's steps that take off the record more than items of their own: the record's end (all of it),
 * and the images and volumes (each of that kind the record has; core/server-plan.ts undoPlan).
 */
const TAKES: Record<string, string> = { forget: 'all', 'drop-images': 'image', 'drop-volumes': 'volume' }

/**
 * One step as the command's awk puts it into a run (core/server-script.ts runScript): a header
 * (id, timeout, the owner's by hand or not, fetching through nginx or not), its title (T), its
 * commands and check (S), skip checks (K), undo (U), and its record items (R: class and key; for
 * Apply each item's words: W0 as carried, W1 after the step ran, WA before it runs). Undo's items
 * are only named by key: its run's items are the record's, which the awk reads on the server.
 */
function stepLines(s: PlanStep, undo: boolean): string[] {
  const nginx = s.commands.some(c => c.includes('nginx-before'))
  const head = [
    `@@step ${s.id} ${s.timeoutS} ${byHand(s) ? 1 : 0} ${nginx ? 1 : 0}`,
    `T ${t(s.title.key, s.title.params)}`,
  ]
  // the owner's by-hand step is not in the run at all, only said skipped
  if (byHand(s)) return head
  const takes = undo ? TAKES[s.id] : undefined
  return [
    ...head,
    ...[...s.commands, ...s.check].map(l => `S ${l}`),
    ...s.skipIf.map(l => `K ${l}`),
    ...s.undo.map(l => `U ${l}`),
    ...(takes
      ? [`R * ${takes}`]
      : s.record.flatMap(i => [
          `R ${itemClass(i)} ${keyOf(i)}`,
          ...(undo ? [] : [`W0 ${itemWord(i, false)}`, `W1 ${itemWord(i, true)}`, `WA ${aheadWord(i)}`]),
        ])),
  ]
}

/** The template of some steps, cut into one per step. */
function stepTemplates(
  render: (v: Record<string, Value>) => PlanStep[],
  undo: boolean,
  w: Wanted,
  c: SetupCase | null,
): string[] {
  const text = templateOf(
    v =>
      render(v)
        .flatMap(s => stepLines(s, undo))
        .join('\n'),
    INPUTS,
    places(w, c),
  )
  const out: string[] = []
  if (text === '') return out
  for (const line of text.split('\n')) {
    if (line.startsWith('@@step ')) out.push(line)
    else if (out.length) out[out.length - 1] += `\n${line}`
    else throw new Error('a step template starts with its header')
  }
  return out
}

const SENTINELS: Record<string, Value> = Object.fromEntries(Object.entries(INPUTS).map(([k, i]) => [k, i.sentinel]))

/** A plan made from facts, refused unless it is a plan of the case wanted. */
function planOf(f: ServerFacts, w: Wanted, v: Record<string, Value>, c: SetupCase): Plan {
  const p = buildPlan(f, w, { id: str(v.plan_id), docker: true })
  if (!('steps' in p)) throw new Error(`no plan for case ${c}: ${p.why.join(', ')}`)
  if (p.case !== c) throw new Error(`case ${p.case} where ${c} was meant`)
  return p
}

/** One shape's steps: the case's own, after the guard and step 1's. */
export interface ShapeTemplate {
  key: string
  steps: string[]
}

export function applyTemplate(s: ApplyShape, w: Wanted): ShapeTemplate {
  const steps = (v: Record<string, Value>): PlanStep[] =>
    planOf(applyFacts(s, w, v), w, v, s.c).steps.filter((x, k) => k > 0 && !STEP_ONE_IDS.has(x.id))
  return { key: applyKey(s), steps: stepTemplates(steps, false, w, s.c) }
}

/** Step 1's steps, by the name the command's awk gives each (`x.…`): one template each. */
export function stepOneTemplates(w: Wanted): Record<string, string> {
  const out: Record<string, string> = {}
  const variants: { s: StepOneFacts; names: Record<string, string> }[] = [
    {
      s: { user: null, keys: 'none', keysDir: true, include: true },
      names: {
        'tunnel-user': 'x.user',
        'socket-folder': 'x.folder',
        'keys-file': 'x.keys.make',
        'sshd-fence': 'x.fence.file',
      },
    },
    {
      s: { user: null, keys: 'none', keysDir: false, include: false },
      names: { 'keys-file': 'x.keys.makedir', 'sshd-fence': 'x.fence.block' },
    },
    { s: { user: null, keys: 'other', keysDir: true, include: true }, names: { 'keys-file': 'x.keys.write' } },
  ]
  for (const { s, names } of variants) {
    const steps = (v: Record<string, Value>): PlanStep[] => {
      const f: ServerFacts = { ...baseFacts(w, v), folder: null, fence: {}, stepOne: s }
      return planOf(f, w, v, '1').steps.filter(x => x.id in names)
    }
    const ids = steps(SENTINELS).map(x => x.id)
    stepTemplates(steps, false, w, null).forEach((text, k) => {
      out[names[ids[k] ?? ''] ?? ''] = text
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The guard's lines

/** A rely line's shape: what it checks, at which port. */
export type RelyShape =
  | { kind: 'free'; port: 80 | 443 | 8443 | 8480 | 8481; docker: boolean }
  | { kind: 'program'; port: 80 | 443; program: 'caddy' | 'nginx' }
  | { kind: 'container'; port: 443 | null }
  | { kind: 'config' }
  | { kind: 'none'; what: 'user' | 'folder' | 'keys' }

export const relyKey = (r: RelyShape): string =>
  r.kind === 'free'
    ? `r.free.${r.port}.d${+r.docker}`
    : r.kind === 'program'
      ? `r.program.${r.port}.${r.program}`
      : r.kind === 'container'
        ? `r.container.${r.port ?? 'none'}`
        : r.kind === 'none'
          ? `r.none.${r.what}`
          : 'r.config'

export function relyShapes(): RelyShape[] {
  const out: RelyShape[] = []
  for (const port of [80, 443, 8443, 8480, 8481] as const)
    for (const docker of [true, false]) out.push({ kind: 'free', port, docker })
  out.push({ kind: 'program', port: 443, program: 'caddy' }, { kind: 'program', port: 80, program: 'nginx' })
  out.push({ kind: 'container', port: 443 }, { kind: 'container', port: null }, { kind: 'config' })
  for (const what of ['user', 'folder', 'keys'] as const) out.push({ kind: 'none', what })
  return out
}

/** One guard line's template (the board's relyLine), with its places: their container, their Caddyfile and its hash. */
export function relyTemplate(r: RelyShape, w: Wanted): string {
  const render = (v: Record<string, Value>): string => {
    const rely: Rely =
      r.kind === 'container'
        ? { kind: 'container', port: r.port, id: str(v.cid) }
        : r.kind === 'config'
          ? { kind: 'config', path: str(v.file), sha: str(v.sha) }
          : r.kind === 'none'
            ? {
                kind: 'none',
                what: r.what,
                name: r.what === 'user' ? w.user : r.what === 'folder' ? socketFolder(w.socket) : keysFile(w.user),
              }
            : r
    return relyLine(rely).command
  }
  return templateOf(render, INPUTS, places(w, null))
}

// ---------------------------------------------------------------------------------------------
// Settings hashes, round two of Look, the launch

/** What the helper's settings hash is taken of, as JSON, with a place for their network (3a). */
export function hashTemplates(w: Wanted): Record<string, string> {
  const out: Record<string, string> = {}
  for (const host of [false, true])
    out[`h.socat.${host ? 'host' : 'net'}`] = templateOf(
      v => JSON.stringify(hashInput(socatArgs(host, w, v))),
      INPUTS,
      places(w, null),
    )
  return out
}

/** A shape of round two: their Caddy (none, a unit or a container; adapted or not; its file on the host known or not) and their nginx. */
export interface LookShape {
  caddy: 'none' | 'unit' | 'container'
  adapt: boolean
  host: boolean
  nginx: 'none' | 'plain' | 'conf'
}
export const lookKey = (s: LookShape): string => `l.${s.caddy}.a${+s.adapt}.h${+s.host}.n${s.nginx}`

export function lookShapes(): LookShape[] {
  const out: LookShape[] = []
  for (const nginx of ['none', 'plain', 'conf'] as const) {
    if (nginx !== 'none') out.push({ caddy: 'none', adapt: false, host: false, nginx })
    for (const caddy of ['unit', 'container'] as const)
      for (const adapt of [true, false]) for (const host of [true, false]) out.push({ caddy, adapt, host, nginx })
  }
  return out
}

/** Round one's facts that make lookScript2 read this shape. */
function lookFacts(s: LookShape, v: Record<string, Value>): RoundOne {
  const base = baseFacts(
    { user: 'boardtunnel', socket: '/var/lib/boardtunnel/board.sock', domain: 'x.example.com', publicPort: null },
    v,
  )
  const r: RoundOne = { ...base }
  const adapter = s.adapt ? 'caddyfile' : 'json'
  if (s.caddy === 'unit') {
    const holder: Holder = { kind: 'unit', unit: 'caddy.service', program: 'caddy' }
    // a relative config with no working folder: no path on the host
    const config = s.host ? str(v.cr_cfg) : str(v.cr_rel)
    r.ports = { ...r.ports, 443: holder }
    r.units = {
      caddy: {
        execStart: [str(v.cr_bin), 'run', '--config', config, '--adapter', adapter],
        execReload: [],
        user: 'caddy',
        group: 'caddy',
        active: 'active',
        workingDirectory: '',
      },
      nginx: null,
    }
  } else if (s.caddy === 'container') {
    const id = str(v.cr_cid)
    r.ports = { ...r.ports, 443: { kind: 'container', id, program: 'caddy' } }
    r.docker = {
      version: '29.0.0',
      podman: false,
      rootless: false,
      userns: false,
      containers: [
        {
          id,
          name: '/web-caddy-1',
          image: 'caddy:2',
          cmd: [str(v.cr_cmd0), 'run', '--config', str(v.cr_cfg), '--adapter', adapter],
          hostNetwork: false,
          networks: [],
          mounts: s.host ? [{ type: 'bind', source: str(v.cr_host), destination: str(v.cr_cfg) }] : [],
          ports: [],
          labels: {},
        },
      ],
    }
  }
  if (s.nginx !== 'none') {
    r.ports = { ...r.ports, 80: { kind: 'unit', unit: 'nginx.service', program: 'nginx' } }
    r.units = {
      ...r.units,
      nginx: {
        execStart: [str(v.nx_bin), ...(s.nginx === 'conf' ? ['-c', str(v.nx_conf)] : []), '-g', 'daemon on;'],
        execReload: [],
        user: '',
        group: '',
        active: 'active',
        workingDirectory: '',
      },
    }
  }
  return r
}

export function lookTemplate(s: LookShape, input: LookInput): string {
  const render = (v: Record<string, Value>): string => {
    const script = lookScript2(lookFacts(s, v), input)
    if (script === null) throw new Error(`no round two for ${lookKey(s)}`)
    return script
  }
  return templateOf(render, INPUTS, places({ ...input, publicPort: null }, null))
}

/** The launch (core/server-script.ts launchScript) of a packed run, with places for the run's id and the packed run. */
export function launchTemplate(w: Wanted): string {
  return templateOf(
    v => launchScript(str(v.run_id), `# run\n${LAST_LINE}`, () => str(v.packed)),
    INPUTS,
    places(w, null),
  )
}

// ---------------------------------------------------------------------------------------------
// Undo

/** One item of a record as Undo's shape names it (no value): what kind, of which of the board's things. */
export type UndoItem = 'I1' | 'I2' | 'F1' | 'F2' | 'F3' | 'V1' | 'V2' | 'K1' | 'K2' | 'G' | 'L' | 'B'

/** What Undo finds of their Caddy now: none; another config than the record's; or theirs, as a unit or a container. */
export interface UndoShape {
  items: UndoItem[]
  theirs: 'none' | 'other' | 'unit' | 'container'
  cand: boolean
  fetch: boolean
  nfetch: boolean
}
export const undoKey = (s: UndoShape): string =>
  `u.${s.items.join('') || '0'}.t${s.theirs}.c${+s.cand}.f${+s.fetch}.n${+s.nfetch}`

/** The items of a record, by kind, as the run writes them (their values stand-ins). */
function undoItem(i: UndoItem, v: Record<string, Value>): RecordItem {
  switch (i) {
    case 'I1':
      return { kind: 'image', ref: CADDY_IMAGE, before: false }
    case 'I2':
      return { kind: 'image', ref: SOCAT_IMAGE, before: false }
    case 'F1':
      return { kind: 'file', path: CADDY_FILE, sha256: str(v.sha_caddyfile) }
    case 'F2':
      return { kind: 'file', path: SITE_FILE, sha256: str(v.sha_site) }
    case 'F3':
      return { kind: 'file', path: NGINX_FILE, sha256: str(v.sha_nginx) }
    case 'V1':
      return { kind: 'volume', name: VOLUMES[0] }
    case 'V2':
      return { kind: 'volume', name: VOLUMES[1] }
    case 'K1':
      return { kind: 'container', name: CADDY_NAME, setup: str(v.setup_caddy) }
    case 'K2':
      return { kind: 'container', name: SOCKET_NAME, setup: str(v.setup_socket) }
    case 'G':
      return { kind: 'group', path: '', from: str(v.group_from), to: str(v.group_to) }
    case 'L':
      return { kind: 'line', file: str(v.ufile), line: IMPORT_LINE }
    case 'B':
      return { kind: 'block', file: str(v.ufile), begin: BLOCK_BEGIN, end: BLOCK_END }
  }
}

/** A record of these items: its head the record's own values (its case as the items make it). */
function undoRecord(items: RecordItem[], w: Wanted, v: Record<string, Value>): SetupRecord {
  // the record's case as its items make it: Undo names a missing line (2) or block (3a, 3b) by it
  const c = items.some(i => i.kind === 'line' || (i.kind === 'file' && i.path === SITE_FILE))
    ? '2'
    : items.some(i => i.kind === 'block' || (i.kind === 'container' && i.name === SOCKET_NAME))
      ? '3a'
      : '1'
  return {
    v: 1,
    id: 'r0',
    at: '2026-10-21T10:04:00.000Z',
    state: 'applied',
    case: c,
    pair: { user: w.user, socket: w.socket },
    domain: str(v.rec_domain),
    publicPort: null,
    address: `https://${str(v.rec_domain)}`,
    items,
  }
}

/** What Look finds now, for an Undo shape: their Caddy (with the record's file, or another), their nginx for its fetch. */
function undoFacts(s: UndoShape, w: Wanted, v: Record<string, Value>): ServerFacts {
  let f = baseFacts(w, v)
  if (s.theirs === 'unit') f = theirCaddyUnit({ ...f }, { ...v, file: str(v.ufile) }, s.fetch)
  else if (s.theirs === 'container')
    f = theirCaddyContainer(f, v, { host: false, cand: s.cand, fetch: s.fetch, file: str(v.ufile) })
  else if (s.theirs === 'other') f = theirCaddyUnit({ ...f }, { ...v, file: str(v.tfile) }, false)
  if (s.items.includes('F3')) {
    const nginx: Holder = { kind: 'unit', unit: 'nginx.service', program: 'nginx' }
    f = {
      ...f,
      ports: { ...f.ports, 80: nginx },
      nginx: { confD: true, listen80: ['80'], serverNames: s.nfetch ? list(v.nhosts) : [] },
    }
  }
  return f
}

const UNDO_OPTIONS = (v: Record<string, Value>) => ({ id: str(v.plan_id), removeDocker: false, removeEdited: false })

/** The steps of an Undo plan before the record's end (`forget`): the case's own. */
function untilForget(p: Plan): PlanStep[] {
  const end = p.steps.findIndex(x => x.id === 'forget')
  if (end < 0) throw new Error('an Undo plan ends with forget')
  return p.steps.slice(1, end)
}

/** One Undo shape's steps: the case's own, before step 1's and the record's end. */
export function undoTemplate(s: UndoShape, w: Wanted): ShapeTemplate {
  const folder = socketFolder(w.socket)
  const steps = (v: Record<string, Value>): PlanStep[] => {
    const items = s.items.map(i => {
      const item = undoItem(i, v)
      return item.kind === 'group' ? { ...item, path: folder } : item
    })
    const r = undoRecord(items, w, v)
    return untilForget(undoPlan(r, { ...undoFacts(s, w, v), record: r }, UNDO_OPTIONS(v)))
  }
  return { key: undoKey(s), steps: stepTemplates(steps, true, w, null) }
}

/** Undo's steps for step 1's parts the record names, the record's end, and the by-hand step (`y.…`). */
export function stepOneUndoTemplates(w: Wanted): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = keysFile(w.user)
  const variants: { items: RecordItem[]; names: Record<string, string> }[] = [
    {
      items: [
        { kind: 'user', name: w.user },
        { kind: 'folder', path: socketFolder(w.socket) },
        { kind: 'keys', path: keys, dir: true },
        { kind: 'fence', path: FENCE_FILE },
      ],
      names: {
        'drop-fence': 'y.fence.file',
        'drop-keys': 'y.keys.dir',
        'drop-folder': 'y.folder',
        'drop-user': 'y.user',
        forget: 'y.forget',
      },
    },
    {
      items: [
        { kind: 'keys', path: keys, dir: false },
        { kind: 'fence', path: SSHD_CONFIG },
      ],
      names: { 'drop-fence': 'y.fence.block', 'drop-keys': 'y.keys', 'by-hand': 'y.byhand' },
    },
  ]
  for (const { items, names } of variants) {
    const steps = (v: Record<string, Value>): PlanStep[] => {
      const r = undoRecord(items, w, v)
      return undoPlan(r, { ...baseFacts(w, v), record: r }, UNDO_OPTIONS(v)).steps.filter(x => x.id in names)
    }
    const ids = steps(SENTINELS).map(x => x.id)
    stepTemplates(steps, true, w, null).forEach((text, k) => {
      out[names[ids[k] ?? ''] ?? ''] = text
    })
  }
  return out
}

/** An item of a record as Undo's shape names it; null for those its shape leaves to the run's record (Docker, backups, step 1's). */
export function undoCode(i: RecordItem): UndoItem | null {
  switch (i.kind) {
    case 'image':
      return i.before ? null : i.ref === CADDY_IMAGE ? 'I1' : 'I2'
    case 'file':
      return i.path === CADDY_FILE ? 'F1' : i.path === SITE_FILE ? 'F2' : 'F3'
    case 'volume':
      return i.name === VOLUMES[0] ? 'V1' : 'V2'
    case 'container':
      return i.name === CADDY_NAME ? 'K1' : 'K2'
    case 'group':
      return 'G'
    case 'line':
      return 'L'
    case 'block':
      return 'B'
    default:
      return null
  }
}

/** A record's items each once, the newest of each (core/server-plan.ts dedupe, for Undo's shapes). */
function dedupeCodes(codes: readonly UndoItem[]): UndoItem[] {
  const out: UndoItem[] = []
  for (const c of codes) {
    const at = out.indexOf(c)
    if (at >= 0) out.splice(at, 1)
    out.push(c)
  }
  return out
}

/**
 * Every record Undo may meet from the board's runs, by its items: a whole setup of each Apply
 * shape (with the image the board pulled, or one that was there before), a run cut short after
 * any of its steps, and the record an update leaves; with the line or block their Caddyfile has
 * named at its end (Undo names it when the record does not), and what Look finds of their Caddy now.
 */
export function undoShapes(w: Wanted): UndoShape[] {
  const seqs = new Map<string, UndoItem[]>()
  const add = (items: UndoItem[]): void => {
    seqs.set(items.join(''), items)
  }
  for (const s of applyShapes()) {
    if (s.update || s.rgid) continue
    const p = planOf(applyFacts(s, w, SENTINELS), w, SENTINELS, s.c)
    const steps = p.steps.slice(1).map(x => x.record.map(undoCode).filter((c): c is UndoItem => c !== null))
    for (const image of [true, false]) {
      const per = steps.map(codes => codes.filter(c => image || (c !== 'I1' && c !== 'I2')))
      const full = per.flat()
      const edit: UndoItem | null = s.c === '2' ? 'L' : s.c === '3a' || s.c === '3b' ? 'B' : null
      for (let k = 0; k <= per.length; k++) {
        const prefix = per.slice(0, k).flat()
        add(prefix)
        if (edit && !prefix.includes(edit)) add([...prefix, edit])
      }
      // an update re-records each item but the folder's group, whose step finds it done
      add(dedupeCodes([...full, ...full.filter(c => c !== 'G')]))
    }
  }
  const out: UndoShape[] = []
  for (const items of seqs.values()) {
    const edits = items.includes('L') || items.includes('B')
    const theirs: UndoShape['theirs'][] = edits ? ['none', 'other', 'unit', 'container'] : ['none']
    for (const th of theirs)
      for (const cand of th === 'container' ? [true, false] : [false])
        for (const fetch of th === 'unit' || th === 'container' ? [true, false] : [false])
          for (const nfetch of items.includes('F3') ? [true, false] : [false])
            out.push({ items, theirs: th, cand, fetch, nfetch })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The dictionary the command carries

/**
 * Every step template the command may need, each once (`@@t <name>`, then its lines), and every
 * shape's list of them (`@@shape <key> <name>…`): what the awk reads before Look's output.
 */
export function dictionary(w: Wanted): string {
  const named = new Map<string, string>()
  const out: string[] = []
  const add = (text: string): string => {
    let name = named.get(text)
    if (!name) {
      name = `s${named.size + 1}`
      named.set(text, name)
      out.push(`@@t ${name}`, text)
    }
    return name
  }
  // without the board's key the board makes no step 1 (core/server-plan.ts stepOneNeeds), nor does
  // the command; Undo removes what a record names of it all the same
  const key = w.publicKey !== undefined
  const made = [...(key ? Object.entries(stepOneTemplates(w)) : []), ...Object.entries(stepOneUndoTemplates(w))]
  for (const [name, text] of made) out.push(`@@t ${name}`, text)
  const shapes: string[] = []
  for (const s of applyShapes()) {
    if (s.rgid && !key) continue
    const x = applyTemplate(s, w)
    shapes.push(`@@shape ${[x.key, ...x.steps.map(add)].join(' ')}`)
  }
  for (const s of undoShapes(w)) {
    const x = undoTemplate(s, w)
    shapes.push(`@@shape ${[x.key, ...x.steps.map(add)].join(' ')}`)
  }
  return [...out, ...shapes].join('\n')
}
