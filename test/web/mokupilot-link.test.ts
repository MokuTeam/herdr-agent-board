// "MokuPilot" in link mode (web/src/hooks/useSessionActions.ts callMokuPilot): the server starts
// nothing and gives a mokupilot:// link, which the page opens here for the MokuPilot on this
// computer, and says so; a link that is not one, or a browser that throws, is a toast, never a
// page gone. A launch the server started is said as before.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { type ActResult, callMokuPilot } from '../../web/src/hooks/useSessionActions.ts'

const ID = '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f'
const LINK = `mokupilot://call?claude-session=${ID}&cwd=%2Fsrv%2Facme`
const session = { key: ID, name: 'Acme', agent: 'claude', session: ID } as Item

function run(reply: ActResult, open: (url: string) => void, lang = 'en') {
  const t = translator(lang)
  const said: [string, boolean][] = []
  const asked: string[] = []
  return {
    said,
    asked,
    go: () =>
      callMokuPilot(ID, {
        t,
        itemOf: k => (k === ID ? session : undefined),
        act: async (_k, action) => {
          asked.push(action)
          return reply
        },
        toast: (text, error = false) => void said.push([text, error]),
        open,
      }),
  }
}

test('link mode: the link opens in this browser, and the toast says where the call starts', async () => {
  const opened: string[] = []
  const r = run({ ok: true, state: 'link', url: LINK }, url => void opened.push(url))
  await r.go()
  expect(r.asked).toEqual(['mokupilot'])
  expect(opened).toEqual([LINK])
  expect(r.said).toEqual([[translator('en')('mokupilot.opened', { name: 'Acme' }), false]])
  expect(r.said[0]?.[0]).toMatch(/phone/)
  const ru = run({ ok: true, state: 'link', url: LINK }, () => {}, 'ru')
  await ru.go()
  expect(ru.said[0]?.[0]).toMatch(/телефоне/)
})

test('a browser that cannot open it, or a link that is not one: a toast, the board stays', async () => {
  const thrown = run({ ok: true, state: 'link', url: LINK }, () => {
    throw new Error('scheme has no handler')
  })
  await thrown.go()
  expect(thrown.said).toEqual([['The browser did not open the MokuPilot link: scheme has no handler', true]])
  for (const url of ['https://evil.example/', 'javascript:alert(1)', '', undefined]) {
    const opened: string[] = []
    const r = run({ ok: true, state: 'link', url }, u => void opened.push(u))
    await r.go()
    expect(opened).toEqual([])
    expect(r.said[0]?.[1]).toBe(true)
  }
})

test('a launch the server started, or a refusal, is said as before, and nothing opens', async () => {
  const t = translator('en')
  for (const [reply, said] of [
    [{ ok: true, state: 'launched', file: '/usr/bin/meet' }, [t('mokupilot.started', { name: 'Acme' }), false]],
    [{ ok: false, error: 'MokuPilot not found (meet)' }, ['MokuPilot not found (meet)', true]],
  ] as [ActResult, [string, boolean]][]) {
    const opened: string[] = []
    const r = run(reply, u => void opened.push(u))
    await r.go()
    expect(opened).toEqual([])
    expect(r.said).toEqual([said])
  }
})

test('under auto the server says where the call went: a link is opened, anything not mokupilot:// is still refused', async () => {
  const opened: string[] = []
  const auto = run(
    { ok: true, state: 'link', url: LINK, resolved: 'link', why: 'forwarded-other', viewer: '100.64.0.7' },
    url => void opened.push(url),
  )
  await auto.go()
  expect(opened).toEqual([LINK])
  expect(auto.said[0]?.[1]).toBe(false)
  for (const url of [
    'MOKUPILOT://call',
    ' mokupilot://call',
    'mokupilot:call',
    'file:///etc/passwd',
    'data:text/html,x',
  ]) {
    const seen: string[] = []
    const r = run({ ok: true, state: 'link', url, resolved: 'link', why: 'mode-link' }, u => void seen.push(u))
    await r.go()
    expect([url, seen]).toEqual([url, []])
    expect(r.said[0]?.[1]).toBe(true)
  }
  // A launch on the board's computer under auto: said as before, nothing opens here.
  const seen: string[] = []
  const local = run(
    { ok: true, state: 'launched', file: '/usr/bin/meet', resolved: 'local', why: 'loopback-direct' },
    u => void seen.push(u),
  )
  await local.go()
  expect(seen).toEqual([])
  expect(local.said).toEqual([[translator('en')('mokupilot.started', { name: 'Acme' }), false]])
})
