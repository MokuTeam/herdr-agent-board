// A server for the relay setup (core/relay-plan.ts) on the fake root: Look, Apply and Undo
// run as the board would run them. Nothing here reaches a real server, herdr or the network.
import { readFileSync } from 'node:fs'
import {
  type RelayFacts,
  type RelayRecord,
  type RelayRun,
  type RelayWanted,
  readRelayLook,
  readRelayRun,
  relayLookScript,
  relayPlan,
  relayRecord,
  relayRunScript,
  relayUndoPlan,
} from '../../src/core/relay-plan.ts'
import { RELAY_RECORD } from '../../src/core/relay-texts.ts'
import { type FakeRoot, fakeRoot } from './fake-root.ts'

export const MASTER_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayMasterTestKeyOnly000000000000000000000 agent-board relay master'
export const ENROL_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayEnrolTestKeyOnly0000000000000000000000 agent-board relay enrol'
export const NODE_KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayNodeATestKeyOnly0000000000000000000000 node-a'
export const NODE_KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRelayNodeBTestKeyOnly0000000000000000000000 node-b'

export interface RelayServer {
  root: FakeRoot
  wanted(over?: Partial<RelayWanted>): RelayWanted
  look(withKeys?: boolean): RelayFacts
  apply(o?: {
    only?: string[]
    env?: Record<string, string>
    over?: Partial<RelayWanted>
    withKeys?: boolean
  }): RelayRun
  record(): RelayRecord | null
  undo(): RelayRun
}

export function relayServer(mode: 'include' | 'plain' = 'include'): RelayServer {
  let runs = 0
  const root = fakeRoot(mode, { relay: true })
  const wanted = (over: Partial<RelayWanted> = {}): RelayWanted => ({
    masterKey: MASTER_KEY,
    enrolKey: ENROL_KEY,
    ...over,
  })
  const look = (withKeys = true): RelayFacts => {
    const out = root.run(relayLookScript(withKeys ? { masterKey: MASTER_KEY, enrolKey: ENROL_KEY } : {}))
    const f = readRelayLook(out.lines)
    if (!f) throw new Error(`Relay Look did not end: ${out.err}`)
    return f
  }
  const record = (): RelayRecord | null => {
    try {
      return relayRecord(JSON.parse(readFileSync(root.path(RELAY_RECORD), 'utf8')))
    } catch {
      return null
    }
  }
  return {
    root,
    wanted,
    look,
    apply(a = {}) {
      const p = relayPlan(look(a.withKeys ?? true), wanted(a.over))
      if (!p.ok) throw new Error(`refused: ${JSON.stringify(p.why)}`)
      const plan = a.only
        ? { ...p.plan, steps: p.plan.steps.filter(s => s.id === 'check' || a.only?.includes(s.id)) }
        : p.plan
      const out = root.run(relayRunScript(plan, { id: `relay-${++runs}`, at: '2026-11-24T10:00:00Z' }), a.env)
      return readRelayRun(out.lines)
    },
    record,
    undo() {
      const r = record()
      if (!r) throw new Error('no record to undo')
      const f = look()
      const out = root.run(
        relayRunScript(relayUndoPlan(r, { enrolled: f.enrolled }), {
          id: `relay-undo-${++runs}`,
          at: '2026-11-24T11:00:00Z',
        }),
      )
      return readRelayRun(out.lines)
    },
  }
}

export const stepsOf = (r: RelayRun): string[] => r.steps.map(s => `${s.id} ${s.state}`)
