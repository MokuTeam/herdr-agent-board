// "Add a server" (#509, docs/design/nodes/README.md 11.1, 12): the pure parts of the service
// (services/nodes/setup.ts) around the node's plan (core/node-plan.ts). The plugin's archive goes
// up as the admin, on ssh's stdin, into a folder of its own that only the admin and root can read;
// the run goes packed (gzip, then base64), as the whole plan is past a Windows command line
// otherwise; the device is written into config.json's `nodes`, which a board's first device
// creates; the device's id is found from what the master and the server already say; and the view
// the panel reads, with the master's own steps after the server's. Pure, with no node: import.

import { LINK_USER } from './node-texts.ts'
import { DEVICE_ID, deviceIdFromHost, LOCAL, type NodeStatus } from './nodes.ts'
import type { Text } from './server-plan.ts'
import type { AdminHint, SudoMode } from './server-view.ts'

/** The folder the archive goes into on the server: /var/tmp, its name made by mktemp. */
const UPLOAD_PATH = /^\/var\/tmp\/agent-board-node\.[A-Za-z0-9]{6,16}\/plugin\.tar$/
const HEX64 = /^[0-9a-f]{64}$/

/**
 * As the admin, without sudo: the archive on stdin into a new folder under /var/tmp, mode 700, so
 * no other user can read or swap it; its path and sha256. The run copies it into its own root-only
 * folder and checks it against the sha256 again before unpacking (core/node-plan.ts, the plugin step).
 */
export const UPLOAD_SCRIPT = [
  '# agent-board: node upload',
  'set -u',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'LC_ALL=C; export LC_ALL',
  'umask 077',
  'd=$(mktemp -d /var/tmp/agent-board-node.XXXXXXXX) || { echo "@@fail could not make a folder under /var/tmp"; exit 1; }',
  'cat > "$d/plugin.tar" || { rm -rf "$d"; echo "@@fail could not write the archive under /var/tmp"; exit 1; }',
  'echo "@@path $d/plugin.tar"',
  'echo "@@sha $(sha256sum < "$d/plugin.tar" | cut -c1-64)"',
  '',
].join('\n')

/** The upload's lines read: where the archive is and its sha256, or null when it did not say both. */
export function readUpload(lines: readonly string[]): { path: string; sha256: string } | null {
  const said = (key: string): string =>
    lines
      .find(l => l.startsWith(`@@${key} `))
      ?.slice(key.length + 3)
      .trim() ?? ''
  const path = said('path')
  const sha256 = said('sha')
  return UPLOAD_PATH.test(path) && HEX64.test(sha256) ? { path, sha256 } : null
}

/** The upload's own complaint (`@@fail …`), or null. */
export const uploadFailure = (lines: readonly string[]): string | null =>
  lines.find(l => l.startsWith('@@fail '))?.slice(7) ?? null

/** As the admin: the upload's folder removed once the run is over. Only a path the upload made. */
export function cleanScript(path: string): string {
  if (!UPLOAD_PATH.test(path)) throw new Error('not a path the upload made')
  return [
    '# agent-board: node clean',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    `rm -rf '${path.slice(0, path.lastIndexOf('/'))}'`,
    '',
  ].join('\n')
}

/**
 * A node run (Apply or Undo) packed: its first line names it for the admin's log and the tests'
 * fake, then the script unpacked and run by a new sh in its place, so nothing of this wrapper is
 * left to stop when the admin's connection goes. `pack` is gzip, then base64.
 */
export function packedRun(kind: 'apply' | 'undo', script: string, pack: (text: string) => string): string {
  return [
    `# agent-board: node ${kind}`,
    `s=$(echo ${pack(script)} | base64 -d | gzip -dc) || { echo 'The run could not be unpacked on the server: nothing was changed.'; echo '@@result unchanged'; exit 3; }`,
    'exec sh -c "$s"',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// The device in config.json

/** The link the master keeps to the node: ssh as the link user to the door. */
export interface SshLink {
  kind: 'ssh'
  host: string
  sshPort: number
  user: typeof LINK_USER
  port: number
}

export const sshLink = (host: string, sshPort: number, port: number): SshLink => ({
  kind: 'ssh',
  host,
  sshPort,
  user: LINK_USER,
  port,
})

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The device written into `nodes` (the raw section, changed in place); whether anything changed.
 * A board without the section (`had` false) gets one: its own id from this computer's name, the
 * new device first in the order and this computer after it, no lane that may leave, a start by hand
 * on this computer when all is full. A section already there keeps everything of its own: a new
 * device goes in before `local` in an order that lists it, a device already there gets this link
 * and loses a revocation (Apply made it a token and a key of its own), its other keys stay.
 */
export function putDevice(
  nodes: Record<string, unknown>,
  had: boolean,
  d: { id: string; link: SshLink; selfId: string },
): boolean {
  if (!had) {
    for (const key of Object.keys(nodes)) delete nodes[key]
    nodes.id = d.selfId
    nodes.order = [d.id, LOCAL]
    nodes.whenFull = 'local'
    nodes.devices = { [d.id]: { link: { ...d.link } } }
    return true
  }
  if (!isObject(nodes.devices)) nodes.devices = {}
  const devices = nodes.devices as Record<string, unknown>
  let changed = false
  const entry = devices[d.id]
  if (isObject(entry)) {
    if (JSON.stringify(entry.link) !== JSON.stringify(d.link)) {
      entry.link = { ...d.link }
      changed = true
    }
    if (Object.hasOwn(entry, 'revoked')) {
      delete entry.revoked
      changed = true
    }
  } else {
    devices[d.id] = { link: { ...d.link } }
    changed = true
  }
  if (Array.isArray(nodes.order) && !nodes.order.includes(d.id)) {
    const at = nodes.order.indexOf(LOCAL)
    if (at < 0) nodes.order.push(d.id)
    else nodes.order.splice(at, 0, d.id)
    changed = true
  }
  return changed
}

/** The device taken out of `nodes` (its entry and its place in the order) after Undo; whether it was there. */
export function dropDevice(nodes: Record<string, unknown>, id: string): boolean {
  let changed = false
  if (isObject(nodes.devices) && Object.hasOwn(nodes.devices, id)) {
    delete nodes.devices[id]
    changed = true
  }
  if (Array.isArray(nodes.order) && nodes.order.includes(id)) {
    nodes.order = nodes.order.filter(x => x !== id)
    changed = true
  }
  return changed
}

/**
 * The device's id for a server: the one the owner typed; else the device of this master whose link
 * already goes to this host; else what the server says of itself (config.json's `node` there,
 * then the record of a run, then its host name), made to fit. null: nothing to make one from yet.
 */
export function deviceIdFor(o: {
  asked?: string | undefined
  host: string
  sshPort: number
  devices: Record<string, { link?: unknown } | undefined>
  server?: { nodeId: string | null; recordId: string | null; hostname: string } | undefined
}): string | null {
  if (o.asked) return o.asked
  for (const [id, dev] of Object.entries(o.devices)) {
    const link = dev?.link
    if (
      id !== LOCAL &&
      isObject(link) &&
      link.kind === 'ssh' &&
      link.host === o.host &&
      (link.sshPort ?? 22) === o.sshPort
    )
      return id
  }
  const s = o.server
  if (!s) return null
  if (s.nodeId && DEVICE_ID.test(s.nodeId)) return s.nodeId
  if (s.recordId && DEVICE_ID.test(s.recordId)) return s.recordId
  const short = s.hostname.split('.')[0] ?? ''
  return short ? deviceIdFromHost(short) : deviceIdFromHost(o.host)
}

/**
 * Why the master does not take this id for this server, as a text: not an id, `local`, this
 * board's own, or a device of another server already. null: it may.
 */
export function deviceIdProblem(
  id: string,
  o: { host: string; sshPort: number; selfId: string; devices: Record<string, { link?: unknown } | undefined> },
): Text | null {
  if (!DEVICE_ID.test(id) || id === LOCAL) return { key: 'node.setup.refuse.id', params: { id } }
  if (id === o.selfId) return { key: 'node.setup.refuse.idSelf', params: { id } }
  const link = o.devices[id]?.link
  if (
    isObject(link) &&
    !(link.kind === 'ssh' && link.host === o.host && ((link.sshPort as number | undefined) ?? 22) === o.sshPort)
  )
    return { key: 'node.setup.refuse.idTaken', params: { id } }
  return null
}

// ---------------------------------------------------------------------------------------------
// The view

/** What the master does around the server's run, in order: before it (token, key, archive, upload), after it the rest. */
export const MASTER_BEFORE = ['token', 'key', 'archive', 'upload'] as const
export const MASTER_AFTER = ['config', 'link', 'status', 'thresholds', 'bundle', 'login'] as const
export type MasterStepId = (typeof MASTER_BEFORE)[number] | (typeof MASTER_AFTER)[number]
export type MasterState = 'wait' | 'run' | 'ok' | 'skip' | 'fail'
export interface MasterStep {
  id: MasterStepId
  state: MasterState
  /** What it found or why it failed, as a text: the device's id, a profile's report, the link's reason. */
  said: Text | null
}

export const masterSteps = (ids: readonly MasterStepId[]): MasterStep[] =>
  ids.map(id => ({ id, state: 'wait', said: null }))

export type NodeSetupPhase =
  | 'idle'
  | 'looking'
  | 'plan'
  | 'applying'
  | 'finishing'
  | 'done'
  | 'failed'
  | 'undoing'
  | 'undone'

/** The server as the form named it. The admin's password is never part of it. */
export interface SetupServer {
  host: string
  sshPort: number
  user: string
  /** The admin's key file; '' for ssh's own (the agent, ~/.ssh). */
  key: string
}

/** What the panel reads: GET /api/nodes/setup. No password, no token, no key is ever in it. */
export interface NodeSetupView {
  phase: NodeSetupPhase
  /** Apply's or Undo's: what the plan and the progress are of. */
  kind: 'apply' | 'undo' | null
  server: SetupServer | null
  /** The device's id and the door's port the plan is for. */
  device: { id: string; port: number } | null
  hostKey: { fingerprint: string; pinnedNow: boolean } | null
  sudo: SudoMode | null
  /** What Look found, in short, for the panel's summary. */
  found: {
    os: string
    arch: string
    cpus: number
    memTotalMb: number
    memAvailableMb: number
    homeFreeMb: number | null
    bun: string | null
    herdr: string | null
    claude: string | null
    /** A node is there already (set up by hand or by an earlier run): its id; the plan then does only what is missing. */
    node: string | null
    /** The record of an earlier run is there. */
    record: boolean
  } | null
  /** Why the board does not make this server a node; empty when it may. */
  refusals: Text[]
  plan: {
    id: string
    words: Text[]
    warnings: Text[]
    steps: { id: string; title: Text; why: Text }[]
    /** The ceiling as Look proposed it; Apply may carry the owner's own figures. */
    ceiling: {
      memoryMaxMb: number
      memoryHighMb: number
      swapMaxMb: number
      cpuWeight: number
      tasksMax: number
    } | null
    /** The packages tick is needed: a tool the steps use is missing. */
    packagesNeeded: boolean
    /** Undo: whether ~/work goes too is the owner's tick. */
    work?: boolean
  } | null
  /** The server's run: each step's last word, the undone steps, and how it ended. */
  run: {
    steps: { id: string; state: 'wait' | 'start' | 'skip' | 'ok' | 'fail' }[]
    undone: { id: string; ok: boolean }[]
    result: string | null
    warnings: string[]
    said: string[]
  } | null
  /** The master's steps around the run, in order. */
  master: MasterStep[]
  /** The first bundle's report, in short. */
  bundle: { ok: boolean; applied: number; kept: number; sent: number; why: string | null } | null
  /** The node's profiles and whether each is logged in to Claude: "Log in to Claude on <device>" until they are. */
  login: { device: string; profiles: { id: string; loggedIn: boolean | null }[] } | null
  hint: AdminHint | null
  error: string | null
  /** After a failure: what the owner does next, as a text. */
  next: Text | null
}

export const IDLE_VIEW: NodeSetupView = {
  phase: 'idle',
  kind: null,
  server: null,
  device: null,
  hostKey: null,
  sudo: null,
  found: null,
  refusals: [],
  plan: null,
  run: null,
  master: [],
  bundle: null,
  login: null,
  hint: null,
  error: null,
  next: null,
}

/** The profiles of a node's status as the view shows them. */
export const loginOf = (device: string, s: NodeStatus | null): NodeSetupView['login'] =>
  s ? { device, profiles: s.profiles.map(p => ({ id: p.id, loggedIn: p.loggedIn })) } : null
