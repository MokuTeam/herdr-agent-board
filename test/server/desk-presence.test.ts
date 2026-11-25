// The owner's desk on running boards (#788, epic #763 T5): a master on a headless server and its
// nodes (test/support/node-pair.ts), each computer's idle time a file the test writes
// (TEST_PRESENCE_OBS), the master's computer without a desktop (TEST_PRESENCE_DESKTOP=0). On main the
// master read only its own computer: a headless one said "at the computer" whenever its session
// said unlocked, and its reminders went to its own desktop, which no one sits at. Now:
// - presence follows the node the owner works at, read over the node's real door;
// - the master's own reading never puts the owner "here" while it has no desktop;
// - a calendar reminder shows on the most recently active node alone, once;
// - a board without nodes reads its own computer exactly as before, desktop or not.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logged, serveBoard } from '../support/board-server.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(40_000)

const dir = mkdtempSync(join(tmpdir(), 'desk-obs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function until<T>(what: string, f: () => Promise<T | null | false> | T | null | false, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got !== null && got !== false) return got
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await Bun.sleep(50)
  }
}

/** A computer's idle time as the test says it: a file its board reads at each ask. */
function computer(name: string, idleSec: number | null, locked: boolean | null) {
  const file = join(dir, `${name}-${Math.random().toString(36).slice(2)}.json`)
  const say = (i: number | null, l: boolean | null): void =>
    writeFileSync(file, JSON.stringify({ idleSec: i, locked: l }))
  say(idleSec, locked)
  return { file, say }
}

const state = async (url: string): Promise<string | undefined> =>
  ((await (await fetch(`${url}/api/presence`)).json()) as { presence: { state: string } | null }).presence?.state

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

/** Whether this board showed a notification with `title` on its desktop (herdr's fake; PowerShell's log on Windows). */
const notified = (n: { box: Sandbox; proc: Parameters<typeof logged>[0] }, title: string): boolean =>
  process.platform === 'win32'
    ? logged(n.proc, 'reminder notification')
    : n.box.calls().some(c => c[0] === 'notification' && c.includes(title))

const presenceFile = (box: Sandbox): string =>
  join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/presence.json')

test('presence follows the node the owner works at; a headless master never says "here" by itself', async () => {
  // The master's own session says unlocked and busy: on main that alone was "at the computer".
  const head = computer('master', 0, false)
  const desk = computer('laptop', 600, false)
  const pair = await nodePair({
    count: 1,
    masterCfg: { presence: { mode: 'auto', idleMinutes: 1 } },
    masterEnv: { TEST_PRESENCE_DESKTOP: '0', TEST_PRESENCE_OBS: head.file, TEST_PRESENCE_MS: '50' },
    nodeEnv: () => ({ TEST_PRESENCE_OBS: desk.file }),
  })
  const node = pair.nodes[0] as PairNode
  const master = pair.master.url
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)

  // The node's computer idle for 10 minutes: away, whatever the master's own session says.
  await until('away from the idle desk', async () => (await state(master)) === 'away')
  // The owner sits down at the node: here.
  desk.say(3, false)
  await until('here at the desk', async () => (await state(master)) === 'here')
  // The node's screen locked: away again.
  desk.say(1, true)
  await until('away at the locked desk', async () => (await state(master)) === 'away')

  // The node goes: only the headless master is left, busy as ever, and the owner stays away.
  await node.proxy.cut('drop')
  await until('the node offline', async () =>
    (await pair.devices()).find(d => d.id === node.id)?.link?.state !== 'online' ? true : null,
  )
  await Bun.sleep(1000)
  expect(await state(master)).toBe('away')
})

test('a calendar reminder shows on the most recently active node alone, once', async () => {
  const head = computer('master', 0, false)
  const idle = computer('server-1', 900, false)
  const busy = computer('server-2', 4, false)
  const pair = await nodePair({
    count: 2,
    masterCfg: {
      presence: { mode: 'auto' },
      calendar: { on: true, reminders: { beforeMin: 10, snoozeMin: 5 } },
    },
    masterEnv: { TEST_PRESENCE_DESKTOP: '0', TEST_PRESENCE_OBS: head.file },
    nodeEnv: id => ({ TEST_PRESENCE_OBS: id === 'server-1' ? idle.file : busy.file }),
  })
  const [one, two] = pair.nodes as [PairNode, PairNode]
  for (const n of pair.nodes) await pair.waitDevice(n.id, d => d.link?.state === 'online', 10_000)

  const now = Date.now()
  const added = await post(`${pair.master.url}/api/calendar`, {
    op: 'add',
    title: 'Design review',
    start: now + 5 * 60_000,
    end: now + 35 * 60_000,
  })
  expect(added.status).toBe(200)
  await until('the busy node shows the reminder', () => notified(two, 'Design review'))
  await Bun.sleep(500)
  expect(notified(one, 'Design review')).toBe(false)
  if (process.platform !== 'win32') {
    expect(pair.master.box.calls().some(c => c[0] === 'notification')).toBe(false)
    expect(two.box.calls().filter(c => c[0] === 'notification' && c.includes('Design review')).length).toBe(1)
  }
})

test('a board without nodes reads its own computer as before, desktop or not', async () => {
  for (const desktop of ['0', '1']) {
    const box = await sandbox()
    const own = computer('standalone', 0, false)
    // Away by the board's own detection, then the computer says busy: back, as on main.
    mkdirSync(join(presenceFile(box), '..'), { recursive: true })
    writeFileSync(presenceFile(box), JSON.stringify({ state: 'away', since: 1, by: 'auto' }))
    const { url } = await serveBoard(
      box,
      { language: 'en', presence: { mode: 'auto', idleMinutes: 1 } },
      { TEST_PRESENCE_DESKTOP: desktop, TEST_PRESENCE_OBS: own.file, TEST_PRESENCE_MS: '50' },
    )
    await until(`here (desktop ${desktop})`, async () => (await state(url)) === 'here')
  }
})
