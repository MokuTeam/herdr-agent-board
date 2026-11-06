// Reminders through the board's server (#335, POST /api/calendar-reminders and the payload): off
// with the calendar (no reminders in the payload, the route refuses, no state file); on, an event
// of the board's own a few minutes ahead fires its reminder at once, on the desktop (the sandbox's
// stand-ins: a PowerShell that is not there, herdr's fake) and in the payload, and Snooze from the
// page takes it out. A fake wake; events are invented.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logged, serveBoard } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { sandbox } from '../support/sandbox.ts'

async function until(fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>
const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Board': '1' },
    body: JSON.stringify(body),
  })

type Line = { reminders?: { snoozeMin: number; items: { id: string; title: string; join?: string }[] } }

test('calendar off: no reminders in the payload, the route refuses, no state file', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const { url } = await serveBoard(box, { language: 'en', wakeUrl: wake.url, calendar: { on: false } })
    const board = await json(await fetch(`${url}/api/board`))
    assert.equal('calendar' in board, false)
    const res = await post(`${url}/api/calendar-reminders`, { id: 'AAAAAAAAAAAAAAAA', act: 'snooze' })
    assert.equal(res.status, 409)
    const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board')
    assert.equal(existsSync(join(state, 'calendar-reminders.json')), false)
  } finally {
    wake.down()
  }
})

test('calendar on: an event minutes ahead fires its reminder on the desktop and in the payload; Snooze takes it out', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const { url, proc } = await serveBoard(box, {
      language: 'en',
      wakeUrl: wake.url,
      calendar: { on: true, reminders: { beforeMin: 10, snoozeMin: 5 } },
    })
    // nothing on show yet: the line is as it was before reminders
    const before = (await json(await fetch(`${url}/api/board`))).calendar as Line
    assert.ok(before)
    assert.equal('reminders' in before, false)

    const now = Date.now()
    const added = await json(
      await post(`${url}/api/calendar`, {
        op: 'add',
        title: 'Design review',
        start: now + 5 * 60_000,
        end: now + 35 * 60_000,
        join: 'https://meet.example.com/xyz',
      }),
    )
    assert.equal(added.ok, true)
    let line: Line = {}
    await until(async () => {
      line = (await json(await fetch(`${url}/api/board`))).calendar as Line
      return !!line.reminders
    })
    const item = line.reminders?.items[0]
    assert.ok(item)
    assert.equal(item.title, 'Design review')
    assert.equal(item.join, 'https://meet.example.com/xyz')
    assert.equal(line.reminders?.snoozeMin, 5)
    const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'calendar-reminders.json')
    assert.ok(existsSync(state))
    // the desktop was asked: Windows through PowerShell (not there in the sandbox), elsewhere herdr
    if (process.platform === 'win32') await until(() => logged(proc, 'reminder notification'))
    else await until(() => box.calls().some(c => c[0] === 'notification' && c.includes('Design review')))

    assert.equal((await post(`${url}/api/calendar-reminders`, { id: 'not-an-id', act: 'snooze' })).status, 400)
    assert.equal((await post(`${url}/api/calendar-reminders`, { id: item.id, act: 'later' })).status, 400)
    assert.equal((await post(`${url}/api/calendar-reminders`, { id: 'AAAAAAAAAAAAAAAA', act: 'dismiss' })).status, 404)
    const snoozed = await json(await post(`${url}/api/calendar-reminders`, { id: item.id, act: 'snooze' }))
    assert.equal(snoozed.ok, true)
    await until(async () => !((await json(await fetch(`${url}/api/board`))).calendar as Line).reminders)
    const kept = JSON.parse(readFileSync(state, 'utf8')) as { items: Record<string, { snooze?: number }> }
    assert.ok(Object.values(kept.items)[0]?.snooze)
  } finally {
    wake.down()
  }
})
