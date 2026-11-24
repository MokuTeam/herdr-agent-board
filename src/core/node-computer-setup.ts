// "Add a computer" (#513, docs/design/nodes 11.2, 20.2): pure view types, relay link helper,
// and validation for claiming a computer behind NAT by one command. No node: import, safe for web/.
import { DEVICE_ID, LOCAL } from './node-key.ts'
import type { MasterState } from './node-setup.ts'
import { NODE_PORT } from './nodes.ts'
import type { Text } from './server-plan.ts'

export type { MasterState }

/** The link the master keeps to a computer behind NAT: through the relay socket. */
export interface RelayLink {
  kind: 'relay'
  socket: string
}

export const relayLink = (socket: string): RelayLink => ({ kind: 'relay', socket })

/** The master's steps after Approve claims the computer. */
export const COMPUTER_MASTER_STEPS = ['claim', 'config', 'link', 'status', 'thresholds', 'bundle', 'login'] as const
export type ComputerMasterStepId = (typeof COMPUTER_MASTER_STEPS)[number]

export interface ComputerMasterStep {
  id: ComputerMasterStepId
  state: MasterState
  said: Text | null
}

export type ComputerSetupPhase = 'idle' | 'waiting' | 'found' | 'claiming' | 'finishing' | 'done' | 'expired' | 'failed'

export interface ComputerFound {
  id: string
  host: string
  platform: string
  version: string
  /** Lower-case SHA-256 hex fingerprint of the door's verified TLS certificate. */
  fingerprint: string
}

/** What GET /api/nodes/computer/setup returns. Never holds any master token or private relay/enrol key. */
export interface ComputerSetupView {
  phase: ComputerSetupPhase
  /** The pasted one-line sh command while phase is waiting or found; null otherwise. */
  command: string | null
  /** Readable script inside the pasted command while waiting or found; null otherwise. */
  script: string | null
  socket: string | null
  expiresAt: number | null
  found: ComputerFound | null
  device: { id: string } | null
  master: ComputerMasterStep[]
  bundle: { ok: boolean; applied: number; kept: number; sent: number; why: string | null } | null
  login: { device: string; profiles: { id: string; loggedIn: boolean | null }[] } | null
  error: string | null
  next: Text | null
}

export const COMPUTER_IDLE_VIEW: ComputerSetupView = {
  phase: 'idle',
  command: null,
  script: null,
  socket: null,
  expiresAt: null,
  found: null,
  device: null,
  master: [],
  bundle: null,
  login: null,
  error: null,
  next: null,
}

export const BOARD_PORTS: readonly number[] = [12421, 12422]

/** Validates an optional door port input (undefined -> default NODE_PORT; null -> invalid). */
export function computerPortOf(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return NODE_PORT
  return Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535 && !BOARD_PORTS.includes(v as number)
    ? (v as number)
    : null
}

/** Validates a device id when claiming a computer; returns a Text error or null when valid. */
export function computerIdProblem(id: string, o: { selfId: string; devices: Record<string, unknown> }): Text | null {
  if (!DEVICE_ID.test(id) || id === LOCAL) return { key: 'node.setup.refuse.id', params: { id } }
  if (id === o.selfId) return { key: 'node.setup.refuse.idSelf', params: { id } }
  if (Object.hasOwn(o.devices, id)) return { key: 'node.setup.refuse.idTaken', params: { id } }
  return null
}

export const computerSteps = (): ComputerMasterStep[] =>
  COMPUTER_MASTER_STEPS.map(id => ({ id, state: 'wait', said: null }))
