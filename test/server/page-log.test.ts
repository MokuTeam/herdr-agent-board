// A line from the page for the board's log (POST /api/log, server/routes/page-log.ts): what a
// phone's browser could not do there (#102), which only the page can see.
import { beforeAll, describe, expect, test } from 'bun:test'
import { pageLogLine } from '../../src/server/routes/page-log.ts'
import { logged, serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Child } from '../support/sandbox.ts'

test('one line, cut to 500 characters; anything else is no line', () => {
  expect(pageLogLine('  paste: empty;\n the clipboard held  nothing ')).toBe('paste: empty; the clipboard held nothing')
  expect(pageLogLine('x'.repeat(600))).toHaveLength(500)
  expect(pageLogLine(42)).toBe('')
  expect(pageLogLine('   ')).toBe('')
})

describe('POST /api/log', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let proc: Child

  beforeAll(async () => {
    ;({ url, proc } = await serveBoard(await sandbox(), { language: 'en' }))
  }, 30_000)

  const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  test("goes into the board's log, marked as the page's; only from the board's own page", async () => {
    expect((await post({ text: 'paste: empty; the clipboard held text/plain' })).status).toBe(200)
    const deadline = Date.now() + 3000
    while (!logged(proc, 'page: paste: empty; the clipboard held text/plain') && Date.now() < deadline)
      await Bun.sleep(20)
    expect(logged(proc, 'page: paste: empty; the clipboard held text/plain')).toBe(true)
    expect((await post({ text: '' })).status).toBe(400)
    expect((await post({ text: 'x' }, {})).status).toBe(403)
    expect((await post({ text: 'x' }, { 'x-board': '1', origin: 'https://evil.example' })).status).toBe(403)
  })
})
