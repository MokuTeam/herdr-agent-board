import { afterEach, describe, expect, test } from 'bun:test'
import type { BoardDevice } from '../../src/core/payload.ts'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { MasterHandover } from '../../web/src/components/devices/MasterHandover.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { findAll, type Node } from './support/markup.ts'

const NOW = Date.now()
const VP = { w: 1600, h: 900 }
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

const DEVICES: BoardDevice[] = [
  {
    id: 'local',
    title: 'This computer',
    kind: null,
    link: null,
    status: null,
    sameCommit: null,
    payloadAt: null,
    paused: false,
    drain: false,
    maxSessions: null,
    minFreeMemMb: null,
    maxLoad: null,
  },
  {
    id: 'server-1',
    title: 'Atlas',
    kind: 'ssh',
    link: { state: 'online', since: NOW, heardAt: NOW },
    status: null,
    sameCommit: true,
    payloadAt: NOW,
    paused: false,
    drain: false,
    maxSessions: null,
    minFreeMemMb: null,
    maxLoad: null,
  },
]

const PLAN = {
  ok: true,
  from: 'laptop',
  to: 'server-1',
  targetTitle: 'Atlas',
  commit: 'abc12345',
  checks: [
    { id: 'online', ok: true, detail: 'server-1 is online', blocking: true },
    { id: 'backup', ok: true, detail: 'folder /bak', blocking: true },
  ],
  items: [{ category: 'db', files: 1, bytes: 4096 }],
  totalFiles: 1,
  totalBytes: 4096,
  requiredFreeMb: 64,
  targetFreeMb: 2048,
  errors: [],
  warnings: [],
}

describe('web/MasterHandover (#697)', () => {
  afterEach(restoreFetch)

  test('closed by default inside DevicesPanel, makes zero handover fetches on mount, and hidden without nodes', () => {
    const calls = answers()
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <DevicesPanel open={true} onClose={() => {}} />
      </PanelProvider>,
      board({ data: payload({ devices: DEVICES }), canEdit: true, now: NOW }),
    )
    expect(calls).toEqual([])
    const openBtn = findAll(nodes, el => el.tag === 'button' && text([el]) === 'Move master role…')
    expect(openBtn).toHaveLength(1)

    const plainP = payload({})
    delete (plainP as unknown as Record<string, unknown>).devices
    const plainNodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <DevicesPanel open={true} onClose={() => {}} />
      </PanelProvider>,
      board({ data: plainP, canEdit: true, now: NOW }),
    )
    expect(findAll(plainNodes, el => el.tag === 'button' && text([el]) === 'Move master role…')).toHaveLength(0)
  })

  test('renders preflight check results, verify status, and rollback button from initial view', () => {
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <MasterHandover
          open={true}
          devices={DEVICES}
          initial={{
            phase: 'checked',
            step: null,
            id: 'ho-1',
            target: 'server-1',
            plan: PLAN,
            verify: { ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node(s) online' }] },
            error: null,
            rolledBack: false,
            canRollback: true,
          }}
        />
      </PanelProvider>,
      board({ data: payload({ devices: DEVICES }), canEdit: true, now: NOW }),
    )
    const allText = text(nodes)
    expect(allText).toContain('Preflight checks')
    expect(allText).toContain('server-1 is online')
    expect(allText).toContain('Verification')
    expect(allText).toContain('1 node(s) online')
    expect(findAll(nodes, el => el.tag === 'button' && text([el]) === 'Rollback handover')).toHaveLength(1)
  })
})
