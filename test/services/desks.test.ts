// The master's desks (#788, services/nodes/desks.ts) against fake node links: presence reads the
// most recently active desk of the owner's online devices and of this computer only where it has a
// desktop; a notification goes to that one desk, once; a headless master with no desk shows none,
// and one with a desktop is the fallback.
import { expect, test } from 'bun:test'
import type { NoticeDesktop, NoticeToast } from '../../src/integrations/notice-toast.ts'
import type { ReminderDesktop, ReminderToast } from '../../src/integrations/reminder-toast.ts'
import type { TeamDesktop, TeamToast } from '../../src/integrations/team-toast.ts'
import { createDesks, type DesksOptions } from '../../src/services/nodes/desks.ts'
import type { Link } from '../../src/services/nodes/link.ts'

interface FakeNode {
  state: 'online' | 'offline'
  desk: Record<string, unknown> | null
  posts: unknown[]
  refuse?: boolean
  asks?: number
  /** The ask is answered after this long. */
  slow?: number
}

function fakeLinks(nodes: Record<string, FakeNode>) {
  const link = (id: string): Link | null => {
    const n = nodes[id]
    if (!n) return null
    return {
      id,
      state: () => ({ state: n.state }),
      async fetch(path: string, init?: RequestInit) {
        if (path === '/api/node/desk') {
          n.asks = (n.asks ?? 0) + 1
          if (n.slow) await Bun.sleep(n.slow)
          return n.desk ? Response.json(n.desk) : new Response('', { status: 404 })
        }
        if (path === '/api/node/desk-toast') {
          n.posts.push(JSON.parse(String(init?.body)))
          return n.refuse ? new Response('', { status: 400 }) : Response.json({ ok: true })
        }
        return new Response('', { status: 404 })
      },
    } as unknown as Link
  }
  return { link }
}

function setup(o: {
  nodes: Record<string, FakeNode>
  desktop?: boolean
  here?: { idleSec: number | null; locked: boolean | null }
  owner?: (id: string) => boolean
  now?: () => number
}) {
  const shown: { reminder: ReminderToast[]; cleared: string[]; team: TeamToast[]; notice: NoticeToast[] } = {
    reminder: [],
    cleared: [],
    team: [],
    notice: [],
  }
  const reminder: ReminderDesktop = { show: t => shown.reminder.push(t), clear: id => shown.cleared.push(id) }
  const team: TeamDesktop = { show: t => shown.team.push(t) }
  const notice: NoticeDesktop = { show: t => shown.notice.push(t) }
  const logs: string[] = []
  const opts: DesksOptions = {
    on: () => true,
    links: () => fakeLinks(o.nodes),
    deviceIds: () => Object.keys(o.nodes),
    ownerAllowed: id => o.owner?.(id) ?? true,
    desktopHere: () => o.desktop ?? false,
    observeHere: async () => o.here ?? { idleSec: null, locked: null },
    local: { reminder: () => reminder, team: () => team, notice: () => notice },
    log: t => logs.push(t),
    ...(o.now && { now: o.now }),
  }
  return { desks: createDesks(opts), shown, logs }
}

const node = (idleSec: number | null, locked: boolean | null = false, desktop = true): FakeNode => ({
  state: 'online',
  desk: { ok: true, desktop, idleSec, locked },
  posts: [],
})

const REMINDER: ReminderToast = {
  id: 'AbCdEfGhIjKlMnOp',
  title: 'Design review',
  body: 'in 5 min · 14:30 - 15:00',
  whose: 'Board',
  expires: Date.now() + 3_600_000,
  labels: { join: 'Join', open: 'Open', snooze: 'Snooze 5 min' },
}
const TEAM: TeamToast = { id: 'm-1', thread: 'team/general', title: 'anna', body: 'hello', label: 'Team chat' }

const settle = () => Bun.sleep(20)

test('presence: the most recently active of the online owner desks; a headless master adds nothing', async () => {
  const nodes = { 'server-1': node(900), 'server-2': node(4), 'server-3': node(0) }
  nodes['server-3'].state = 'offline'
  const { desks } = setup({ nodes, desktop: false, here: { idleSec: 0, locked: false } })
  expect(await desks.observe()).toEqual({ idleSec: 4, locked: false })
})

test('a device turned off for the owner, or without a desktop, is no desk', async () => {
  const nodes = { 'server-1': node(900), 'server-2': node(4), 'server-3': node(1, false, false) }
  const { desks } = setup({ nodes, owner: id => id !== 'server-2' })
  expect(await desks.observe()).toEqual({ idleSec: 900, locked: false })
})

test('a headless master with no desk heard from: no word, and no notification anywhere', async () => {
  const { desks, shown, logs } = setup({ nodes: {}, desktop: false, here: { idleSec: 0, locked: false } })
  expect(await desks.observe()).toEqual({ idleSec: null, locked: null })
  desks.reminder.show(REMINDER)
  desks.team.show(TEAM)
  await settle()
  expect(shown.reminder).toEqual([])
  expect(shown.team).toEqual([])
  expect(logs.some(l => l.includes('no desk'))).toBe(true)
})

test('a master with a desktop counts as a desk: the active one of it and the nodes wins', async () => {
  const nodes = { 'server-1': node(300) }
  const { desks, shown } = setup({ nodes, desktop: true, here: { idleSec: 2, locked: false } })
  expect(await desks.observe()).toEqual({ idleSec: 2, locked: false })
  desks.reminder.show(REMINDER)
  await settle()
  expect(shown.reminder.map(t => t.id)).toEqual([REMINDER.id])
  expect(nodes['server-1'].posts).toEqual([])
})

test('a reminder and a Team message go to the active node alone, once; the clear follows the reminder', async () => {
  const nodes = { 'server-1': node(600), 'server-2': node(5) }
  const { desks, shown } = setup({ nodes, desktop: true, here: { idleSec: 900, locked: false } })
  desks.reminder.show(REMINDER)
  desks.team.show(TEAM)
  await settle()
  expect(nodes['server-2'].posts).toEqual([
    { kind: 'reminder', toast: REMINDER },
    { kind: 'team', toast: TEAM },
  ])
  expect(nodes['server-1'].posts).toEqual([])
  expect(shown.reminder).toEqual([])
  expect(shown.team).toEqual([])
  desks.reminder.clear(REMINDER.id)
  await settle()
  expect(nodes['server-2'].posts.at(-1)).toEqual({ kind: 'reminder-clear', id: REMINDER.id })
  expect(shown.cleared).toEqual([])
})

test('the active desk moves: the next notification follows it', async () => {
  const nodes = { 'server-1': node(600), 'server-2': node(5) }
  const { desks } = setup({ nodes })
  desks.team.show(TEAM)
  await settle()
  nodes['server-1'].desk = { ok: true, desktop: true, idleSec: 0, locked: false }
  nodes['server-2'].desk = { ok: true, desktop: true, idleSec: 0, locked: true }
  await desks.observe()
  desks.team.show({ ...TEAM, id: 'm-2' })
  await settle()
  expect(nodes['server-2'].posts.map(p => (p as { toast: TeamToast }).toast.id)).toEqual(['m-1'])
  expect(nodes['server-1'].posts.map(p => (p as { toast: TeamToast }).toast.id)).toEqual(['m-2'])
})

test('the node does not take it: this computer shows it where it has a desktop, nowhere where it has none', async () => {
  const withDesktop = { 'server-1': { ...node(5), refuse: true } }
  const a = setup({ nodes: withDesktop, desktop: true })
  a.desks.team.show(TEAM)
  await settle()
  expect(withDesktop['server-1'].posts.length).toBe(1)
  expect(a.shown.team.map(t => t.id)).toEqual(['m-1'])

  const headless = { 'server-1': { ...node(5), refuse: true } }
  const b = setup({ nodes: headless, desktop: false })
  b.desks.team.show(TEAM)
  await settle()
  expect(b.shown.team).toEqual([])
})

test('the only desk goes quiet after "here": it counts as idle since the owner last touched it there', async () => {
  let clock = 1_700_000_000_000
  const nodes = { 'server-1': node(3) }
  const { desks } = setup({ nodes, desktop: false, now: () => clock })
  expect(await desks.observe()).toEqual({ idleSec: 3, locked: false })
  // The lid closes: the link goes. Twenty minutes on, the owner is idle there for twenty minutes.
  nodes['server-1'].state = 'offline'
  clock += 20 * 60_000
  const obs = await desks.observe()
  expect(obs.idleSec).toBeCloseTo(20 * 60 + 3, 0)
  expect(obs.locked).toBeNull()
})

test('a burst of notifications shares one round of asks', async () => {
  const nodes = { 'server-1': { ...node(600), slow: 30 }, 'server-2': { ...node(5), slow: 30 } }
  const { desks } = setup({ nodes })
  for (let i = 0; i < 10; i++) desks.team.show({ ...TEAM, id: `m-${i}` })
  await Bun.sleep(150)
  expect(nodes['server-1'].asks).toBe(1)
  expect(nodes['server-2'].asks).toBe(1)
  expect(nodes['server-2'].posts.length).toBe(10)
})

test('the active node does not take it: the next desk has it, still once', async () => {
  const nodes = { 'server-1': node(600), 'server-2': { ...node(5), refuse: true } }
  const { desks, shown } = setup({ nodes, desktop: false })
  desks.reminder.show(REMINDER)
  await settle()
  expect(nodes['server-2'].posts.length).toBe(1)
  expect(nodes['server-1'].posts).toEqual([{ kind: 'reminder', toast: REMINDER }])
  expect(shown.reminder).toEqual([])
})

test('a clear right after its show follows it to the same desk', async () => {
  const nodes = { 'server-1': { ...node(5), slow: 30 } }
  const { desks } = setup({ nodes })
  desks.reminder.show(REMINDER)
  desks.reminder.clear(REMINDER.id)
  await Bun.sleep(150)
  expect(nodes['server-1'].posts).toEqual([
    { kind: 'reminder', toast: REMINDER },
    { kind: 'reminder-clear', id: REMINDER.id },
  ])
})

test('plain board notices route to the active desk node and fall back locally (#897)', async () => {
  const notice: NoticeToast = { id: 'ns-1234567-0a1b2c3d', title: 'NetSuite · 1234567', body: '1234567 ends at 20:05' }
  const nodes = { 'server-1': node(5) }
  const remote = setup({ nodes, desktop: true, here: { idleSec: 60, locked: false } })
  remote.desks.notice.show(notice)
  await settle()
  expect(nodes['server-1'].posts).toEqual([{ kind: 'notice', toast: notice }])
  expect(remote.shown.notice).toEqual([])

  const local = setup({ nodes: { 'server-1': node(600) }, desktop: true, here: { idleSec: 2, locked: false } })
  local.desks.notice.show(notice)
  await settle()
  expect(local.shown.notice).toEqual([notice])
})
