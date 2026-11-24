// "Relay on the server" (#511, design docs/design/nodes/README.md 20): the pure parts of the
// service (services/nodes/relay-setup.ts) around the relay's plan (core/relay-plan.ts).
// Keeps config.json's `nodes.relay` edits, the packed run wrapper, and the panel's view.
// Pure, with no node: import.

import { DEVICE_ID, deviceIdFromHost, LOCAL } from './nodes.ts'
import { RELAY_MASTER_USER } from './relay-texts.ts'
import type { Text } from './server-plan.ts'
import type { AdminHint, SudoMode } from './server-view.ts'

/**
 * A relay run (Apply or Undo) packed with gzip + base64 so it stays under command line limits.
 * Starts with `# agent-board: relay <kind>` for the admin log and fake ssh.
 */
export function packedRelayRun(kind: 'apply' | 'undo', script: string, pack: (text: string) => string): string {
  return [
    `# agent-board: relay ${kind}`,
    `s=$(echo ${pack(script)} | base64 -d | gzip -dc) || { echo 'The run could not be unpacked on the server: nothing was changed.'; echo '@@result unchanged'; exit 3; }`,
    'exec sh -c "$s"',
    '',
  ].join('\n')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Writes `nodes.relay` into config.json's `nodes` section (in place); returns whether anything
 * changed. A board without `nodes` (`had` false) gets a minimal section with its own id, order
 * `['local']`, `whenFull: 'local'`, empty `devices`, and `relay`. An existing `nodes` section keeps
 * all of its existing fields, devices, order, and lanes.
 */
export function putRelay(
  nodes: Record<string, unknown>,
  had: boolean,
  r: { host: string; sshPort: number; selfId: string },
): boolean {
  const relay = { host: r.host, sshPort: r.sshPort, user: RELAY_MASTER_USER }
  if (!had) {
    for (const key of Object.keys(nodes)) delete nodes[key]
    nodes.id = DEVICE_ID.test(r.selfId) && r.selfId !== LOCAL ? r.selfId : deviceIdFromHost(r.selfId)
    nodes.order = [LOCAL]
    nodes.whenFull = 'local'
    nodes.relay = relay
    nodes.devices = {}
    return true
  }
  if (JSON.stringify(nodes.relay) === JSON.stringify(relay)) return false
  nodes.relay = relay
  return true
}

/**
 * Removes `nodes.relay` from config.json's `nodes` section (in place) after Undo; returns whether
 * anything changed. Leaves all devices, order, and other settings untouched.
 */
export function dropRelay(nodes: Record<string, unknown>): boolean {
  if (!isObject(nodes) || !Object.hasOwn(nodes, 'relay')) return false
  delete nodes.relay
  return true
}

/** What the master does around the server's run, in order. */
export const RELAY_MASTER_BEFORE = ['keys'] as const
export const RELAY_MASTER_AFTER = ['config'] as const
export type RelayMasterStepId = (typeof RELAY_MASTER_BEFORE)[number] | (typeof RELAY_MASTER_AFTER)[number]
export type RelayMasterState = 'wait' | 'run' | 'ok' | 'skip' | 'fail'

export interface RelayMasterStep {
  id: RelayMasterStepId
  state: RelayMasterState
  said: Text | null
}

export const relayMasterSteps = (ids: readonly RelayMasterStepId[]): RelayMasterStep[] =>
  ids.map(id => ({ id, state: 'wait', said: null }))

export type RelaySetupPhase =
  | 'idle'
  | 'looking'
  | 'plan'
  | 'applying'
  | 'finishing'
  | 'done'
  | 'failed'
  | 'undoing'
  | 'undone'

/** The server target as the relay form named it. Never holds passwords. */
export interface RelaySetupServer {
  /** Public host or address written into `nodes.relay` (what NAT nodes dial). */
  host: string
  /** Address the admin connection uses (defaults to `host`; e.g. `127.0.0.1` on same-server). */
  adminHost: string
  sshPort: number
  /** Empty string when running locally on the same server without SSH. */
  user: string
  /** Admin private key path; '' for ssh default. */
  key: string
  /** True when the relay is set up locally on this same machine without SSH. */
  local: boolean
}

export interface RelaySetupView {
  phase: RelaySetupPhase
  kind: 'apply' | 'undo' | null
  server: RelaySetupServer | null
  hostKey: { fingerprint: string; pinnedNow: boolean } | null
  sudo: SudoMode | null
  found: {
    os: string
    ssh: string
    hostname: string
    include: boolean
    nodeUser: string
    masterUser: string
    socketsDir: string
    keysDir: string
    fence: string
    enrolled: number
    record: boolean
  } | null
  refusals: Text[]
  plan: {
    id: string
    words: Text[]
    warnings: Text[]
    steps: { id: string; title: Text; why: Text }[]
  } | null
  run: {
    steps: { id: string; state: 'wait' | 'start' | 'skip' | 'ok' | 'fail' }[]
    undone: { id: string; ok: boolean }[]
    result: string | null
    warnings: string[]
    said: string[]
  } | null
  master: RelayMasterStep[]
  hint: AdminHint | null
  error: string | null
  next: Text | null
}

export const RELAY_IDLE_VIEW: RelaySetupView = {
  phase: 'idle',
  kind: null,
  server: null,
  hostKey: null,
  sudo: null,
  found: null,
  refusals: [],
  plan: null,
  run: null,
  master: [],
  hint: null,
  error: null,
  next: null,
}
