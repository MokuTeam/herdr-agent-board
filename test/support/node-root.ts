// A server for the node's install (core/node-plan.ts) on the fake root: the plugin's archive where
// the master would have put it, the door's hello, and Look, Apply and Undo run as the board would
// run them. Nothing here reaches a real server, herdr or the network.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NODE_API } from '../../src/core/node-door.ts'
import {
  ceilingFor,
  type NodeFacts,
  type NodeRecord,
  type NodeRun,
  type NodeWanted,
  nodeLookScript,
  nodePlan,
  nodeRecord,
  nodeRunScript,
  nodeUndoPlan,
  readNodeLook,
  readNodeRun,
} from '../../src/core/node-plan.ts'
import { type FakeRoot, fakeRoot } from './fake-root.ts'

export const LINK_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINodeLinkTestKeyOnly00000000000000000000 agent-board link'
export const ARCHIVE = '/var/tmp/agent-board-plugin.tar'
/** The master's token: only its hash goes to the server. */
export const TOKEN = 'node-test-token-not-a-secret'
/** The master's commit the archive was made at, as the plan stamps it on the node. */
export const COMMIT = 'c0ffee'.padEnd(40, '0')
export const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')
/** As the door answers (server/node-listener.ts). */
const HELLO = JSON.stringify({ api: 1, version: '0.0.0', node: { api: NODE_API, id: 'server-1', claimed: true } })

export interface NodeServer {
  root: FakeRoot
  wanted(over?: Partial<NodeWanted>): NodeWanted
  look(): NodeFacts
  /** Apply as planned from a Look now; `only`: the plan's steps by id (the guard always), for a test about some of them. */
  apply(o?: { only?: string[]; waitS?: number; env?: Record<string, string>; over?: Partial<NodeWanted> }): NodeRun
  /** The record on the server, read. */
  record(): NodeRecord | null
  undo(work: boolean): NodeRun
}

let runs = 0

/** A fresh Ubuntu 24.04 of 8 GB on the fake root (sshd including drop-ins), with the plugin's archive and the door's hello. */
export function nodeServer(o: { hello?: boolean } = {}): NodeServer {
  const root = fakeRoot('include', { node: true })
  const src = mkdtempSync(join(tmpdir(), 'board-node-plugin-'))
  try {
    writeFileSync(join(src, 'package.json'), '{"name":"agent-board"}\n')
    const r = spawnSync('tar', ['-cf', 'plugin.tar', 'package.json'], { cwd: src, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
    writeFileSync(root.path(ARCHIVE), readFileSync(join(src, 'plugin.tar')))
  } finally {
    rmSync(src, { recursive: true, force: true })
  }
  const sha = createHash('sha256')
    .update(readFileSync(root.path(ARCHIVE)))
    .digest('hex')
  if (o.hello !== false) writeFileSync(root.path('/state/hello'), HELLO)
  const look = (): NodeFacts => {
    const out = root.run(nodeLookScript({ port: 12430, linkKey: LINK_KEY }))
    const f = readNodeLook(out.lines)
    if (!f) throw new Error(`Look did not end: ${out.err}`)
    return f
  }
  const wanted = (over: Partial<NodeWanted> = {}): NodeWanted => ({
    id: 'server-1',
    port: 12430,
    linkKey: LINK_KEY,
    master: { id: 'laptop', name: "Ноутбук 'дом' 100%", tokenHash: TOKEN_HASH },
    plugin: { path: ARCHIVE, sha256: sha, commit: COMMIT },
    ceiling: ceilingFor({ memTotalMb: 7957, memAvailableMb: 7128 }) as NonNullable<ReturnType<typeof ceilingFor>>,
    packages: false,
    ...over,
  })
  const record = (): NodeRecord | null => {
    try {
      return nodeRecord(JSON.parse(readFileSync(root.path('/etc/agent-board-node/setup.json'), 'utf8')))
    } catch {
      return null
    }
  }
  return {
    root,
    wanted,
    look,
    apply(a = {}) {
      const p = nodePlan(look(), wanted(a.over), { waitS: a.waitS ?? 4 })
      if (!p.ok) throw new Error(`refused: ${JSON.stringify(p.why)}`)
      const plan = a.only
        ? { ...p.plan, steps: p.plan.steps.filter(s => s.id === 'check' || a.only?.includes(s.id)) }
        : p.plan
      const out = root.run(nodeRunScript(plan, { id: `run-${++runs}`, at: '2026-11-21T10:00:00Z' }), a.env)
      return readNodeRun(out.lines)
    },
    record,
    undo(work) {
      const r = record()
      if (!r) throw new Error('no record to undo')
      const out = root.run(
        nodeRunScript(nodeUndoPlan(r, { work }), { id: `undo-${++runs}`, at: '2026-11-21T11:00:00Z' }),
      )
      return readNodeRun(out.lines)
    },
  }
}

/** What the run did, step by step: `id state`. */
export const stepsOf = (r: NodeRun): string[] => r.steps.map(s => `${s.id} ${s.state}`)
