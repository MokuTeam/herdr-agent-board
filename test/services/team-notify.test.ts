// The owner hears of the team's messages (#355): the team service's inbound hook says which thread
// a kept message is in (once, not on a redelivery), and services/team-notify.ts raises the desktop
// notification with the sender this board knows and the start of the text, counts what is unread
// and forgets it once the thread is read. A muted thread raises and counts nothing.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { peekReads, teamReadsFile } from '../../src/adapters/team-reads.ts'
import { addInbox } from '../../src/adapters/team-store.ts'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import { TOAST_CHARS } from '../../src/core/team-unread.ts'
import type { TeamToast } from '../../src/integrations/team-toast.ts'
import type { InboundEvent } from '../../src/services/team-hub.ts'
import { createTeamNotify } from '../../src/services/team-notify.ts'
import { msgOf, question } from '../hub/harness.ts'
import { isolatedHome } from '../support/env.ts'
import { handshake, setup, stopAll, until } from '../support/team-service.ts'

afterEach(stopAll)

const PEER = 'A'.repeat(43)
const OTHER = 'B'.repeat(43)

function notifier(at: { now: number }, muted: (thread: string) => boolean = () => false) {
  isolatedHome()
  const shown: TeamToast[] = []
  const n = createTeamNotify({
    desktop: { show: t => void shown.push(t) },
    nameOf: peer => (peer === PEER ? 'Anna' : 'Bob'),
    muted,
    now: () => at.now,
  })
  return { n, shown }
}

const keep = (from: string, id: string, text: string, receivedAt: number, held = false): InboundEvent => {
  addInbox({ id, from, ts: new Date(receivedAt).toISOString(), text, receivedAt, held, ackedAt: null })
  return { id, from, thread: `${from}/general`, held }
}

describe('the inbound hook', () => {
  test('a kept message says its thread once; a redelivery says nothing more', async () => {
    const s = setup()
    s.svc.start()
    const anna = (await generateKey()) as KeyPair
    const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
    const env = await question(anna, me, 'is the build green?')
    ws.recv({ t: 'deliver', env })
    await until(() => ws.of('ack').length === 1, 'an ack')
    expect(s.inbound).toEqual([{ id: msgOf(env).id, from: anna.pub, thread: `${anna.pub}/general`, held: false }])
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

  test('nothing is written until the board asks: no read marks file before the first count', () => {
    notifier({ now: 1_000 })
    expect(existsSync(teamReadsFile())).toBe(false)
  })
})
