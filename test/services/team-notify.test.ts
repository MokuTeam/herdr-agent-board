// The owner hears of the team's messages (#355): the team service's inbound hook says which thread
// a kept message is in (once, not on a redelivery), and services/team-notify.ts raises the desktop
// notification with the sender this board knows and the start of the text, counts what is unread
// and forgets it once the thread is read. A muted thread raises and counts nothing: #216's mute of
// one thread, or of the whole team chat.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { peekReads, teamReadsFile } from '../../src/adapters/team-reads.ts'
import { addInbox, changeAgents, changeThreads, type ThreadRecord } from '../../src/adapters/team-store.ts'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import { TOAST_CHARS } from '../../src/core/team-unread.ts'
import type { TeamToast } from '../../src/integrations/team-toast.ts'
import type { InboundEvent } from '../../src/services/team-hub.ts'
import { BURST_MS, createTeamNotify, TOASTS_PER_HOUR } from '../../src/services/team-notify.ts'
import { msgOf, question } from '../hub/harness.ts'
import { isolatedHome } from '../support/env.ts'
import { handshake, setup, stopAll, until } from '../support/team-service.ts'

afterEach(stopAll)

const PEER = 'A'.repeat(43)
const OTHER = 'B'.repeat(43)

function notifier(at: { now: number }, muted?: (thread: string) => boolean) {
  isolatedHome()
  const shown: TeamToast[] = []
  const due: { fn: () => void; ms: number }[] = []
  const n = createTeamNotify({
    desktop: { show: t => void shown.push(t) },
    nameOf: peer => (peer === PEER ? 'Anna' : 'Bob'),
    ...(muted && { mutes: () => muted }),
    now: () => at.now,
    later: (fn, ms) => void due.push({ fn, ms }),
  })
  return { n, shown, due }
}

const topic = (i: number) => `team/00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

/** Kept in the inbox as the service keeps it; `thread` absent: as before threads (that pair's general). */
const keep = (
  from: string,
  id: string,
  text: string,
  receivedAt: number,
  held = false,
  thread?: string,
): InboundEvent => {
  addInbox({
    id,
    from,
    ts: new Date(receivedAt).toISOString(),
    text,
    receivedAt,
    held,
    ackedAt: null,
    ...(thread && { thread }),
  })
  return { id, from, thread: thread ?? `${from}/general`, held, fresh: false }
}

const TOPIC = '0123abcd-4567-49ab-8def-0123456789ab'
const record = (scope: string, id: string, over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  scope,
  id,
  title: null,
  link: null,
  handler: null,
  muted: false,
  by: scope,
  createdAt: 1,
  lastAt: 1,
  ...over,
})

describe('the inbound hook', () => {
  test('a kept message says its thread once; a redelivery says nothing more', async () => {
    const s = setup()
    s.svc.start()
    const anna = (await generateKey()) as KeyPair
    const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
    const env = await question(anna, me, 'is the build green?')
    ws.recv({ t: 'deliver', env })
    await until(() => ws.of('ack').length === 1, 'an ack')
    expect(s.inbound).toEqual([
      { id: msgOf(env).id, from: anna.pub, thread: `${anna.pub}/general`, held: false, fresh: true },
    ])
    ws.recv({ t: 'deliver', env })
    await until(() => ws.of('ack').length === 2, 'a second ack')
    expect(s.inbound).toHaveLength(1)
  })
})

describe('createTeamNotify', () => {
  test('a message raises one notification: the name this board knows, the start of the text, a click to its thread', () => {
    const at = { now: 1_000 }
    const { n, shown } = notifier(at)
    expect(n.unread()).toBe(0)
    at.now = 2_000
    n.inbound(keep(PEER, 'm1', `  hello\n\nthere ‮${'x'.repeat(200)}`, 2_000))
    expect(shown).toHaveLength(1)
    const toast = shown[0] as TeamToast
    expect(toast).toMatchObject({ id: 'm1', thread: `${PEER}/general`, title: 'Anna', label: 'Team' })
    expect(toast.body.startsWith('hello there \\u{202e}xxx')).toBe(true)
    expect(toast.body.endsWith('…')).toBe(true)
    expect(toast.body.length).toBe(TOAST_CHARS + 1)
  })

  test('a held message (a changed key) shows no text, only that it is held', () => {
    const { n, shown } = notifier({ now: 1_000 })
    n.inbound(keep(PEER, 'm1', 'secret words', 2_000, true))
    expect(shown[0]?.body).toBe('A message is held: their key changed. Trust it on the board to read it.')
    expect(JSON.stringify(shown)).not.toContain('secret words')
  })

  test('unread: what came after the marks began, by thread; reading one clears it and only it', () => {
    const at = { now: 1_000 }
    const { n } = notifier(at)
    keep(PEER, 'old', 'before the board counted', 500)
    expect(n.unread()).toBe(0) // the file is made now, at 1000: what came before is not news
    expect(peekReads()?.since).toBe(1_000)
    n.inbound(keep(PEER, 'a1', 'one', 1_500))
    n.inbound(keep(PEER, 'a2', 'two', 1_600))
    n.inbound(keep(OTHER, 'b1', 'three', 1_700))
    expect(n.unread()).toBe(3)
    expect(n.unreadByThread()).toEqual({ [`${PEER}/general`]: 2, [`${OTHER}/general`]: 1 })
    at.now = 2_000
    n.read(`${PEER}/general`)
    expect(n.unread()).toBe(1)
    expect(n.unreadByThread()).toEqual({ [`${OTHER}/general`]: 1 })
    n.inbound(keep(PEER, 'a3', 'four', 2_500))
    expect(n.unreadByThread()).toEqual({ [`${PEER}/general`]: 1, [`${OTHER}/general`]: 1 })
  })

  test('a muted thread raises nothing and counts nothing; the others still do', () => {
    const { n, shown } = notifier({ now: 1_000 }, thread => thread === `${PEER}/general`)
    n.inbound(keep(PEER, 'a1', 'quiet', 1_500))
    n.inbound(keep(OTHER, 'b1', 'loud', 1_600))
    expect(shown.map(s => s.title)).toEqual(['Bob'])
    expect(n.unread()).toBe(1)
  })

  test('the board’s own mutes (#216): a muted thread, and every team thread while the team chat is muted', () => {
    const { n, shown } = notifier({ now: 1_000 })
    changeThreads(all => {
      all[`${PEER}/${TOPIC}`] = record(PEER, TOPIC, { title: 'release', muted: true })
    })
    n.inbound(keep(PEER, 'a1', 'in a muted topic', 1_500, false, `${PEER}/${TOPIC}`))
    n.inbound(keep(PEER, 'a2', 'in the team chat', 1_600, false, 'team/general'))
    n.inbound(keep(OTHER, 'b1', 'in a pair', 1_700))
    expect(shown.map(s => s.id)).toEqual(['a2', 'b1'])
    expect(n.unreadByThread()).toEqual({ 'team/general': 1, [`${OTHER}/general`]: 1 })
    changeAgents(s => {
      s.peers.team = { on: false, lanes: [], muted: true }
    })
    n.changed()
    n.inbound(keep(OTHER, 'b2', 'in a team topic', 1_800, false, `team/${TOPIC}`))
    expect(shown.map(s => s.id)).toEqual(['a2', 'b1'])
    expect(n.unreadByThread()).toEqual({ [`${OTHER}/general`]: 1 })
  })

  test('the small line names where: a topic by its title (cut, printable), the team chat, a pair', () => {
    const { n, shown } = notifier({ now: 1_000 })
    changeThreads(all => {
      all[`team/${TOPIC}`] = record('team', TOPIC, { title: `Release${String.fromCharCode(7)} ${'notes '.repeat(20)}` })
    })
    n.inbound(keep(PEER, 'a1', 'one', 1_500, false, `team/${TOPIC}`))
    n.inbound(keep(PEER, 'a2', 'two', 1_600, false, 'team/general'))
    n.inbound(keep(PEER, 'a3', 'three', 1_700))
    const [topic, chat, pair] = shown.map(s => s.label)
    expect(topic?.startsWith(String.raw`Release\u{7} notes`)).toBe(true)
    expect(topic?.endsWith('…')).toBe(true)
    expect(topic?.length).toBeLessThanOrEqual(61)
    expect([chat, pair]).toEqual(['Team chat', 'Team'])
  })

  test('a burst in a thread is one notification, then how many more once the window is up', () => {
    const at = { now: 500 }
    const { n, shown, due } = notifier(at)
    n.unread() // the marks begin at 500
    at.now = 1_000
    n.inbound(keep(PEER, 'a1', 'one', 1_000))
    at.now = 2_000
    n.inbound(keep(PEER, 'a2', 'two', 2_000))
    at.now = 3_000
    n.inbound(keep(PEER, 'a3', 'three', 3_000))
    n.inbound(keep(OTHER, 'b1', 'another thread', 3_000))
    expect(shown.map(s => s.id)).toEqual(['a1', 'b1'])
    expect(due.map(d => d.ms)).toEqual([BURST_MS - 1_000])
    at.now = 1_000 + BURST_MS
    due[0]?.fn()
    expect(shown.at(-1)).toEqual({
      id: 'a3',
      thread: `${PEER}/general`,
      title: 'Anna',
      body: '2 more messages',
      label: 'Team',
    })
    expect(JSON.stringify(shown.at(-1))).not.toContain('three')
    expect(n.unread()).toBe(4)
    // A window after the summary, a message is told on its own again.
    at.now = 1_000 + 2 * BURST_MS
    n.inbound(keep(PEER, 'a4', 'four', at.now))
    expect(shown.at(-1)?.id).toBe('a4')
  })

  test('a burst summary in a thread muted meanwhile says nothing', () => {
    const at = { now: 1_000 }
    const muted = { now: false }
    const { n, shown, due } = notifier(at, () => muted.now)
    n.inbound(keep(PEER, 'a1', 'one', 1_000))
    n.inbound(keep(PEER, 'a2', 'two', 1_000))
    muted.now = true
    due[0]?.fn()
    expect(shown.map(s => s.id)).toEqual(['a1'])
  })

  test('at most TOASTS_PER_HOUR notifications an hour, whatever comes in; the count still moves', () => {
    const at = { now: 500 }
    const { n, shown } = notifier(at)
    n.unread() // the marks begin at 500
    at.now = 1_000
    for (let i = 0; i < TOASTS_PER_HOUR + 5; i++) n.inbound(keep(PEER, `m${i}`, 'x', 1_000, false, topic(i)))
    expect(shown).toHaveLength(TOASTS_PER_HOUR)
    expect(n.unread()).toBe(TOASTS_PER_HOUR + 5)
    at.now = 1_000 + 3_600_000
    n.inbound(keep(PEER, 'late', 'x', at.now, false, topic(99)))
    expect(shown).toHaveLength(TOASTS_PER_HOUR + 1)
  })

  test('read up to a time: what came after it stays unread; a time past now is now', () => {
    const at = { now: 1_000 }
    const { n } = notifier(at)
    n.unread() // the marks begin at 1000
    n.inbound(keep(PEER, 'a1', 'one', 1_500))
    n.inbound(keep(PEER, 'a2', 'two', 2_500))
    at.now = 3_000
    n.read(`${PEER}/general`, 2_000)
    expect(n.unreadByThread()).toEqual({ [`${PEER}/general`]: 1 })
    n.read(`${PEER}/general`, 9_999_999)
    expect(peekReads()?.threads[`${PEER}/general`]).toBe(3_000)
    expect(n.unread()).toBe(0)
  })

  test('nothing is written until the board asks: no read marks file before the first count', () => {
    notifier({ now: 1_000 })
    expect(existsSync(teamReadsFile())).toBe(false)
  })
})
