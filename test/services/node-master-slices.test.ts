// A node's copy of its master's payload parts (#780, services/node/master-slices.ts): asked over the
// relay only while the master's stream is up and one of the four features is on there; a change
// refreshes the payload; the master away keeps the last parts; none on at the master shows none.
import { expect, test } from 'bun:test'
import type { MasterFlags } from '../../src/core/master-flags.ts'
import { createNodeMasterSlices } from '../../src/services/node/master-slices.ts'

const flagsOn = (on: string[]): MasterFlags => ({ master: 'laptop', on: on as MasterFlags['on'], at: 1 })

function harness(o: { online?: boolean; on?: string[] } = {}) {
  let online = o.online ?? true
  let flags: MasterFlags | null = flagsOn(o.on ?? ['time', 'calendar'])
  let answer: Response | (() => Response) = new Response(
    JSON.stringify({ ok: true, slices: { time: { seq: 1, date: '2026-11-25', today: { atlas: 60 } } } }),
  )
  const asked: string[] = []
  let changed = 0
  const slices = createNodeMasterSlices({
    relay: {
      online: () => online,
      relay: async (_req, caller) => {
        asked.push(caller.rawPath)
        return typeof answer === 'function' ? answer() : answer.clone()
      },
    },
    flags: () => flags,
    changed: () => changed++,
    log: () => {},
    everyMs: 60_000,
  })
  return {
    slices,
    asked,
    changed: () => changed,
    setOnline: (v: boolean) => {
      online = v
    },
    setFlags: (f: MasterFlags | null) => {
      flags = f
    },
    setAnswer: (a: Response | (() => Response)) => {
      answer = a
    },
  }
}

const settle = () => Bun.sleep(10)

test('asked when poked while the stream is up; the parts and one refresh', async () => {
  const h = harness()
  h.slices.poke()
  await settle()
  expect(h.asked).toEqual(['/api/board-slices'])
  expect(h.slices.current()).toEqual({ time: { seq: 1, date: '2026-11-25', today: { atlas: 60 } } })
  expect(h.changed()).toBe(1)
  // The same parts again: no refresh.
  h.slices.poke()
  await settle()
  expect(h.changed()).toBe(1)
  h.slices.close()
})

test('nothing asked while the master holds no stream, nor while none of the four is on there', async () => {
  const off = harness({ online: false })
  off.slices.poke()
  await settle()
  expect(off.asked).toEqual([])
  expect(off.slices.current()).toBeNull()
  off.slices.close()

  const none = harness({ on: ['threads', 'watches'] })
  none.slices.poke()
  await settle()
  expect(none.asked).toEqual([])
  expect(none.slices.current()).toBeNull()
  none.slices.close()
})

test('a poke while a question is out asks again once it is answered', async () => {
  const h = harness()
  let n = 0
  h.setAnswer(() => {
    n++
    return new Response(JSON.stringify({ ok: true, slices: { time: { seq: n, date: '2026-11-25', today: {} } } }))
  })
  // The second poke comes while the first question is out.
  h.slices.poke()
  h.slices.poke()
  await Bun.sleep(30)
  expect(h.asked).toHaveLength(2)
  expect(h.slices.current()?.time?.seq).toBe(2)
  h.slices.close()
})

test("the master's owner turned this computer off: none of its parts on show", async () => {
  const h = harness()
  h.slices.poke()
  await settle()
  h.setAnswer(() => new Response(JSON.stringify({ ok: false, error: 'master-relay-owner' }), { status: 403 }))
  h.slices.poke()
  await settle()
  expect(h.slices.current()).toBeNull()
  h.slices.close()
})

test('the master away or an older master: the last parts stay; all four off at the master: none', async () => {
  const h = harness()
  h.slices.poke()
  await settle()
  h.setAnswer(() => new Response(JSON.stringify({ ok: false, error: 'node-master-offline' }), { status: 503 }))
  h.slices.poke()
  await settle()
  expect(h.slices.current()?.time?.seq).toBe(1)
  h.setAnswer(() => new Response('{"error":"not found"}', { status: 404 }))
  h.slices.poke()
  await settle()
  expect(h.slices.current()?.time?.seq).toBe(1)
  h.setFlags(flagsOn(['threads']))
  h.slices.poke()
  await settle()
  expect(h.slices.current()).toBeNull()
  expect(h.changed()).toBe(2)
  h.slices.close()
})
