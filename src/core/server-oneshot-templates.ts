// What the one command ("Do it myself", the simple-setup spec's "'Do it myself': one command")
// carries of the board's own scripts: rendered by the board's own functions (lookScript2,
// buildPlan, undoPlan, runScript, launchScript, relyLine) for every shape a server can give them,
// each with stand-ins where the server's own values go, then made templates (core/server-template.ts).
// The command reads Look's output on the server, picks the template the board would have rendered
// and fills it in; core/server-oneshot.ts puts it all together.
//
// A shape is what changes a script's lines, not only its values: the case; Docker there or not;
// their sites fetched or not; the socket folder's group to change or not; their Caddyfile checked
// beside itself or in place; a first setup or an update. The guard's lines (who holds which port,
// their config's hash) are filled in from rely lines of their own; a record's earlier items ride in
// the record line of the run (`it=…`), which the board writes from the plan.
// Pure, with no node: import.
import { t } from './lang.ts'
import type { Container, Holder, RoundOne, ServerFacts } from './server-facts.ts'
import { type LookInput, lookScript2 } from './server-look.ts'
import {
  buildPlan,
  chooseCase,
  nginxAddress,
  type Plan,
  type PlanStep,
  type RecordItem,
  type Rely,
  relyLine,
  type SetupCase,
  type SetupRecord,
  type Text,
  undoPlan,
  type Wanted,
} from './server-plan.ts'
import { launchScript, runScript } from './server-script.ts'
import { type Inputs, type Place, templateOf, type Value } from './server-template.ts'
import {
  argsHash,
  BLOCK_BEGIN,
  BLOCK_END,
  CADDY_FILE,
  CADDY_IMAGE,
  CADDY_NAME,
  caddyRunArgs,
  IMPORT_LINE,
  NGINX_FILE,
  type OwnCaddy,
  SITE_FILE,
  SOCAT_IMAGE,
  SOCKET_NAME,
  socatRunArgs,
  VOLUMES,
} from './server-texts.ts'
import { sshdBlock } from './tunnel-snippets.ts'

/** The run's last line (core/server-script.ts LAST_LINE). */
const LAST_LINE = '# agent-board: end'
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
const HEX_B = '0123456789abcdef'.repeat(4)

/** Every value the command fills in, by the name its templates and its awk give it. */
export const INPUTS: Inputs = {
  plan_id: { sentinel: 'zqplanzq', alt: '20261023-100400-3f9a' },
  run_id: { sentinel: 'zqrunzq', alt: '20261023-100401-0b1c' },
  at: { sentinel: 'zqatzq', alt: '2026-10-23T10:04:00.000Z' },
  gid: { sentinel: '7654321', alt: '995' },
  distro: { sentinel: 'debian', alt: 'ubuntu' },
  relies: { sentinel: '#zqrelieszq', alt: 'echo one\necho two' },
  carried: { sentinel: 'zqcarriedzq', alt: "''" },
  // their Caddy
  file: { sentinel: '/zqfdir/zqfile', alt: '/etc/caddy/Caddyfile', probe: '/srv/my web/Caddy file' },
  config: { sentinel: '/zqcdir/zqconfig', alt: '/etc/caddy/Caddyfile', probe: '/etc/my caddy/Caddyfile' },
  sha: { sentinel: HEX_A, alt: HEX_B },
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
  rec_case: { sentinel: 'zqcase', alt: '3a' },
  rec_domain: { sentinel: 'zqrecdom.example.org', alt: 'board.example.com' },
  rec_address: { sentinel: 'https://zqrecaddr.example.org', alt: 'https://board.example.com:8443' },
  rec_port: { sentinel: '61234', alt: 'null' },
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
  // the launch
  run: { sentinel: `#zqrunlinezq\n${LAST_LINE}`, alt: `echo run\n${LAST_LINE}` },
}

const scalar = (name: string): Place => ({ name, from: [name], text: v => str(v[name]) })
const candidateOf = (name: string): Place => ({
  name: `${name === 'file' ? '' : `${name}_`}candidate`,
  from: [name],
  text: v => `${dirOf(str(v[name]))}/${CANDIDATE}`,
})

/** The places every template may have; those a rendering lacks are simply not there. */
function places(w: Wanted, c: SetupCase | null): Place[] {
  const own = c === '1' || c === '1b' || c === '4a' || c === '4b' ? c : null
  return [
    ...['plan_id', 'run_id', 'at', 'gid', 'carried', 'sha', 'cid', 'network', 'bin', 'user', 'group', 'oldgroup'].map(
      scalar,
    ),
    ...['old', 'rec_case', 'rec_domain', 'rec_address', 'rec_port', 'sha_caddyfile', 'sha_site', 'sha_nginx'].map(
      scalar,
    ),
    ...['setup_caddy', 'setup_socket', 'group_from', 'group_to', 'file', 'config', 'ufile', 'tfile'].map(scalar),
    ...['cr_bin', 'cr_cid', 'cr_cmd0', 'cr_cfg', 'cr_rel', 'cr_host', 'nx_bin', 'nx_conf'].map(scalar),
    candidateOf('file'),
    candidateOf('config'),
    candidateOf('ufile'),
    { name: 'rec_host', from: ['rec_address'], text: v => new URL(str(v.rec_address)).hostname },
    { name: 'docker_repo', from: ['distro'], text: v => `https://download.docker.com/linux/${str(v.distro)}` },
    { name: 'relies', from: ['relies'], text: v => str(v.relies), spelling: 'lines' },
    { name: 'run', from: ['run'], text: v => str(v.run), spelling: 'lines' },
    { name: 'addr_r', from: ['addr'], text: v => resolveAt(str(v.addr)) },
    { name: 'hosts', from: ['hosts'], text: v => list(v.hosts), spelling: 'sqwords' },
    { name: 'nhosts', from: ['nhosts'], text: v => list(v.nhosts), spelling: 'sqwords' },
    { name: 'listen', from: ['listen'], text: v => list(v.listen), spelling: 'listen' },
    {
      name: 'nginx_resolve',
      from: ['listen'],
      text: v => `${w.domain}:80:${resolveAt(nginxAddress(list(v.listen)))}`,
    },
    ...(own ? [{ name: 'caddy_hash', from: ['gid'], text: (v: Record<string, Value>) => caddyHash(own, w, v) }] : []),
    {
      name: 'socat_hash',
      from: ['gid', 'network'],
      text: v => argsHash(hashInput(socatArgs(c === '3b', w, v))),
    },
  ]
}

const caddyArgs = (c: OwnCaddy, w: Wanted, v: Record<string, Value>): string[] =>
  caddyRunArgs(c, w, str(v.gid), str(v.plan_id), w.acme)
const socatArgs = (host: boolean, w: Wanted, v: Record<string, Value>): string[] =>
  socatRunArgs(host ? { host: true } : { network: str(v.network) }, w, str(v.gid), str(v.plan_id))
const caddyHash = (c: OwnCaddy, w: Wanted, v: Record<string, Value>): string => argsHash(hashInput(caddyArgs(c, w, v)))

/**
 * What a container's settings hash is taken of (core/server-texts.ts `labelled`): its name, role,
 * settings, image and command, without the run's id. Read back from its `docker run` argv, and
 * checked against the hash in its label.
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

/** A shape of Apply's run: what changes its lines. Dimensions a case does not have are false (Docker: true for 2, 3a, 3b). */
export interface ApplyShape {
  c: SetupCase
  docker: boolean
  fetch: boolean
  group: boolean
  cand: boolean
  update: boolean
}

/** The shape's name, as the command's awk spells it too. */
export const applyKey = (s: ApplyShape): string =>
  `a.${s.c}.d${+s.docker}.f${+s.fetch}.g${+s.group}.c${+s.cand}.u${+s.update}`

/** Every shape the board's buildPlan has for the cases it does. */
export function applyShapes(): ApplyShape[] {
  const out: ApplyShape[] = []
  const add = (s: Partial<ApplyShape> & { c: SetupCase }): void => {
    out.push({ docker: true, fetch: false, group: false, cand: false, update: false, ...s })
  }
  for (const update of [false, true]) {
    for (const c of ['1', '1b', '4a'] as const) for (const docker of [true, false]) add({ c, docker, update })
    for (const docker of [true, false]) for (const fetch of [true, false]) add({ c: '4b', docker, fetch, update })
    for (const group of [true, false]) for (const fetch of [true, false]) add({ c: '2', fetch, group, update })
    for (const c of ['3a', '3b'] as const)
      for (const cand of [true, false]) for (const fetch of [true, false]) add({ c, cand, fetch, update })
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

/** What every shape starts from: Docker there, nothing on the web ports, the socket's folder and sshd's fence as step 1 makes them. */
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

/** A stand-in for what the plain texts name only (a holder, a container's name): never in a script. */
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
  return s.update ? { ...f, record: earlierRecord(s.c, w, v) } : f
}

// ---------------------------------------------------------------------------------------------
// Rendering

/**
 * The board's run of a plan, with the guard's lines as the command fills them in, and the record's
 * items the plan does not name (an Apply's earlier items; Undo's Docker, backups and images that
 * were there before) in the record line, `it=…`. Undo's own items stay the guard's, as the board has
 * them: its steps take each off the record as they go.
 */
function asTemplate(p: Plan, w: Wanted, v: Record<string, Value>): string {
  const relies = str(v.relies)
  const [guard, ...rest] = p.steps
  if (guard?.id !== 'guard') throw new Error('a plan starts with its guard')
  const record = p.kind === 'undo' ? guard.record : []
  const steps: PlanStep[] = [{ ...guard, commands: relies === '' ? [] : relies.split('\n'), record }, ...rest]
  const run = runScript({ ...p, steps }, w, { id: str(v.run_id), at: str(v.at) })
  const empty = "\n  it=''\n"
  if (run.split(empty).length !== 2) throw new Error('the run writes its record as it did')
  return run.replace(empty, `\n  it=${str(v.carried)}\n`)
}

/** A plan made from facts, refused unless it is a plan of the case wanted. */
function planOf(f: ServerFacts, w: Wanted, v: Record<string, Value>, c: SetupCase): Plan {
  const p = buildPlan(f, w, { id: str(v.plan_id), docker: true })
  if (!('steps' in p)) throw new Error(`no plan for case ${c}: ${p.why.join(', ')}`)
  if (p.case !== c) throw new Error(`case ${p.case} where ${c} was meant`)
  return p
}

/** One Apply template: its run, and what the panel's plan says of it (step titles, why), with places for what is shown. */
export interface ApplyTemplate {
  key: string
  shape: ApplyShape
  run: string
  steps: { id: string; title: string }[]
  why: string
  docker: boolean
}

/** A text of the plan in the board's language, its stand-ins as places (what the command shows, never runs). */
function shown(text: Text): string {
  let out = t(text.key, text.params)
  const marks: [string, string][] = [
    [SHOWN.holder, '@{d_holder}@'],
    [SHOWN.container, '@{d_container}@'],
  ]
  for (const [name, input] of Object.entries(INPUTS)) {
    if (typeof input.sentinel === 'string' && !input.sentinel.includes('\n'))
      marks.push([input.sentinel, `@{${name}}@`])
  }
  marks.sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of marks) out = out.replaceAll(from, to)
  return out
}

export function applyTemplate(s: ApplyShape, w: Wanted): ApplyTemplate {
  const render = (v: Record<string, Value>): string => asTemplate(planOf(applyFacts(s, w, v), w, v, s.c), w, v)
  const run = templateOf(render, INPUTS, places(w, s.c))
  const sentinels = Object.fromEntries(Object.entries(INPUTS).map(([k, i]) => [k, i.sentinel]))
  const f = applyFacts(s, w, sentinels)
  const p = planOf(f, w, sentinels, s.c)
  const choice = chooseCase(f, w)
  if (choice.case === null) throw new Error(`no case for ${applyKey(s)}`)
  return {
    key: applyKey(s),
    shape: s,
    run,
    steps: p.steps.map(x => ({ id: x.id, title: shown(x.title) })),
    why: shown(choice.why),
    docker: p.steps.some(x => x.id === 'docker-install'),
  }
}

// ---------------------------------------------------------------------------------------------
// The guard's lines

/** A rely line's shape: what it checks, at which port. */
export type RelyShape =
  | { kind: 'free'; port: 80 | 443 | 8443 | 8480 | 8481; docker: boolean }
  | { kind: 'program'; port: 80 | 443; program: 'caddy' | 'nginx' }
  | { kind: 'container'; port: 443 | null }
  | { kind: 'config' }

export const relyKey = (r: RelyShape): string =>
  r.kind === 'free'
    ? `r.free.${r.port}.d${+r.docker}`
    : r.kind === 'program'
      ? `r.program.${r.port}.${r.program}`
      : r.kind === 'container'
        ? `r.container.${r.port ?? 'none'}`
        : 'r.config'

export function relyShapes(): RelyShape[] {
  const out: RelyShape[] = []
  for (const port of [80, 443, 8443, 8480, 8481] as const)
    for (const docker of [true, false]) out.push({ kind: 'free', port, docker })
  out.push({ kind: 'program', port: 443, program: 'caddy' }, { kind: 'program', port: 80, program: 'nginx' })
  out.push({ kind: 'container', port: 443 }, { kind: 'container', port: null }, { kind: 'config' })
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
          : r
    return relyLine(rely).command
  }
  return templateOf(render, INPUTS, places(w, null))
}

// ---------------------------------------------------------------------------------------------
// Settings hashes, round two of Look, the launch

/** What the board's containers' settings hashes are taken of, as JSON, with places for the folder's gid and their network. */
export function hashTemplates(w: Wanted): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of ['1', '1b', '4a', '4b'] as const)
    out[`h.caddy.${c}`] = templateOf(v => JSON.stringify(hashInput(caddyArgs(c, w, v))), INPUTS, places(w, null))
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

/** The launch (core/server-script.ts launchScript), with places for the run's id and the whole run. */
export function launchTemplate(w: Wanted): string {
  return templateOf(v => launchScript(str(v.run_id), str(v.run)), INPUTS, places(w, null))
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

/** The record an Undo shape is rendered from: its items in order, its head the record's own values. */
function undoRecord(s: UndoShape, w: Wanted, v: Record<string, Value>): SetupRecord {
  const folder = w.socket.slice(0, w.socket.lastIndexOf('/')) || '/'
  const port = str(v.rec_port)
  return {
    v: 1,
    id: 'r0',
    at: '2026-10-21T10:04:00.000Z',
    state: 'applied',
    case: str(v.rec_case) as SetupCase,
    pair: { user: w.user, socket: w.socket },
    domain: str(v.rec_domain),
    publicPort: port === 'null' ? null : Number(port),
    address: str(v.rec_address),
    items: s.items.map(i => {
      const item = undoItem(i, v)
      return item.kind === 'group' ? { ...item, path: folder } : item
    }),
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

/** One Undo template: its run, and its steps' titles. */
export interface UndoTemplate {
  key: string
  shape: UndoShape
  run: string
  steps: { id: string; title: string }[]
}

export function undoTemplate(s: UndoShape, w: Wanted): UndoTemplate {
  const plan = (v: Record<string, Value>): Plan => {
    const r = undoRecord(s, w, v)
    return undoPlan(
      r,
      { ...undoFacts(s, w, v), record: r },
      { id: str(v.plan_id), removeDocker: false, removeEdited: false },
    )
  }
  // the record's case as its items make it: Undo names a missing line (2) or block (3a, 3b) by it
  const family =
    s.items.includes('L') || s.items.includes('F2') ? '2' : s.items.includes('B') || s.items.includes('K2') ? '3a' : '1'
  const inputs: Inputs = { ...INPUTS, rec_case: { sentinel: 'zqcase', alt: family } }
  const run = templateOf(v => asTemplate(plan(v), w, v), inputs, places(w, null))
  const sentinels = Object.fromEntries(Object.entries(INPUTS).map(([k, i]) => [k, i.sentinel]))
  return {
    key: undoKey(s),
    shape: s,
    run,
    steps: plan(sentinels).steps.map(x => ({ id: x.id, title: shown(x.title) })),
  }
}

/** An item of a record as Undo's shape names it; null for those the run's record line carries (Docker, backups). */
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
  const sentinels = Object.fromEntries(Object.entries(INPUTS).map(([k, i]) => [k, i.sentinel]))
  const seqs = new Map<string, UndoItem[]>()
  const add = (items: UndoItem[]): void => {
    seqs.set(items.join(''), items)
  }
  for (const s of applyShapes()) {
    if (s.update) continue
    const p = planOf(applyFacts(s, w, sentinels), w, sentinels, s.c)
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
