import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LostAccess } from '../../src/core/lost-access.ts'
import type { Card, Item } from '../../src/core/types.ts'
import { createLostAccessMonitor } from '../../src/services/lost-access.ts'

const NOW = Date.UTC(2026, 10, 23, 14, 0, 0)
const LIMIT: LostAccess = { kind: 'limit', resetsAt: Date.UTC(2026, 10, 23, 18, 0, 0), at: NOW }

const makeItem = (over: Partial<Item> = {}): Item => ({
  key: 'child-1',
  session: 'child-1',
  pane: 'w1:p2',
  workspace: 'Board',
  cwd: '/w',
  status: 'idle',
  name: 'ben',
  autoName: 'ben',
  category: 'other',
  categorySet: false,
  column: 'idle',
  attention: '',
  ...over,
})

function setupTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'lost-access-svc-'))
  const file = join(dir, 'lost-access.json')
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('createLostAccessMonitor', () => {
  test('notifies once on had-access -> lost-access to desktop, day session, and parent; never repeats; clears on recovery', async () => {
    const tmp = setupTemp()
    try {
      const desktop: { title: string; body: string }[] = []
      const delivered: { to: string; text: string; noWake?: boolean }[] = []
      const cards = new Map<string, Card>([['child-1', { key: 'child-1', parent: 'parent-1' }]])

      const monitor = createLostAccessMonitor({
        file: tmp.file,
        log: () => {},
        cards: () => cards,
        sendNotice: async (title, body) => {
          desktop.push({ title, body })
        },
        deliverToSession: (target, text, _now, _from, opts) => {
          delivered.push({ to: target.key, text, ...(opts?.noWake !== undefined && { noWake: opts.noWake }) })
        },
      })

      const parent = makeItem({ key: 'parent-1', session: 'parent-1', pane: 'w1:p1', name: 'anna' })
      const day = makeItem({ key: 'day-1', session: 'day-1', pane: null, name: 'cleo', day: true })
      const childOk = makeItem()

      // Normal sessions do nothing and create no state file.
      await monitor.observe([parent, day, childOk], NOW)
      expect(desktop).toEqual([])
      expect(delivered).toEqual([])
      expect(existsSync(tmp.file)).toBe(false)

      // Transition to lost access: fires once to desktop, day, and parent.
      const childLost = makeItem({
        column: 'me',
        attention: 'access',
        question: 'limit until 18:00',
        lostAccess: LIMIT,
      })
      await monitor.observe([parent, day, childLost], NOW)
      expect(desktop).toEqual([{ title: 'Lost access: ben', body: 'limit until 18:00' }])
      expect(delivered).toEqual([
        { to: 'day-1', text: 'ben lost access: limit until 18:00' },
        { to: 'parent-1', text: 'ben lost access: limit until 18:00', noWake: true },
      ])
      expect(existsSync(tmp.file)).toBe(true)

      // Subsequent refresh with same state (even newer error timestamp) does NOT repeat.
      const childRetried = makeItem({
        column: 'me',
        attention: 'access',
        question: 'limit until 18:00',
        lostAccess: { ...LIMIT, at: NOW + 30_000 },
      })
      await monitor.observe([parent, day, childRetried], NOW + 30_000)
      expect(desktop).toHaveLength(1)
      expect(delivered).toHaveLength(2)

      // Restarting the monitor while still in lost-access does NOT repeat either.
      const restarted = createLostAccessMonitor({
        file: tmp.file,
        log: () => {},
        cards: () => cards,
        sendNotice: async (title, body) => {
          desktop.push({ title, body })
        },
        deliverToSession: (target, text) => {
          delivered.push({ to: target.key, text })
        },
      })
      await restarted.observe([parent, day, childRetried], NOW + 60_000)
      expect(desktop).toHaveLength(1)
      expect(delivered).toHaveLength(2)

      // Recovery clears persisted state.
      await restarted.observe([parent, day, childOk], NOW + 120_000)
      expect(existsSync(tmp.file)).toBe(false)

      // New incident after recovery notifies once again.
      await restarted.observe([parent, day, childLost], NOW + 180_000)
      expect(desktop).toHaveLength(2)
      expect(delivered).toHaveLength(4)
    } finally {
      tmp.cleanup()
    }
  })

  test('resolves parent via pane-<id> card ref and links.from, dedupes when day is parent', async () => {
    const tmp = setupTemp()
    try {
      const delivered: string[] = []
      const cards = new Map<string, Card>([['c-pane', { key: 'c-pane', parent: 'pane-w1:p1' }]])
      const monitor = createLostAccessMonitor({
        file: tmp.file,
        log: () => {},
        cards: () => cards,
        sendNotice: async () => {},
        deliverToSession: (target, text) => {
          delivered.push(`${target.key}:${text}`)
        },
      })

      const parentDay = makeItem({ key: 'p-day', session: 'p-day', pane: 'w1:p1', name: 'anna', day: true })
      const childPane = makeItem({
        key: 'c-pane',
        session: 'c-pane',
        name: 'atlas',
        column: 'me',
        attention: 'access',
        question: 'logged out',
        lostAccess: { kind: 'logged_out', resetsAt: null, at: NOW },
      })
      const childLink = makeItem({
        key: 'c-link',
        session: 'c-link',
        name: 'cleo',
        column: 'me',
        attention: 'access',
        question: 'expired login',
        lostAccess: { kind: 'expired', resetsAt: null, at: NOW },
        links: { from: { key: 'p-day', name: 'anna', at: NOW - 10_000 }, started: [], talks: [] },
      })

      await monitor.observe([parentDay, childPane, childLink], NOW)
      // day === parent: only one message per child, not two.
      expect(delivered).toEqual(['p-day:atlas lost access: logged out', 'p-day:cleo lost access: expired login'])
    } finally {
      tmp.cleanup()
    }
  })

  test('fast path handles corrupt persisted file safely without crashing', async () => {
    const tmp = setupTemp()
    try {
      writeFileSync(tmp.file, '{not-json')
      const monitor = createLostAccessMonitor({
        file: tmp.file,
        log: () => {},
        sendNotice: async () => {},
        deliverToSession: () => {},
      })
      await monitor.observe([makeItem()], NOW)
    } finally {
      tmp.cleanup()
    }
  })
})
