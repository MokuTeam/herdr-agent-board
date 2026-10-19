import { afterEach, expect, spyOn, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { parseConversation } from '../../src/core/transcript.ts'
import { ApiError, api, errorText, isBoardPayload, isBoardProfile, isSessionDetail } from '../../web/src/api/client.ts'
import { notification } from '../support/task-notification.ts'
import { item, payload } from './support/board.tsx'

const t = translator('en')
type Call = { url: string; init: RequestInit | undefined }

let restore: (() => void) | undefined

function answer(status: number, body: string): Call[] {
  restore?.()
  const calls: Call[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(body, { status })
  }
  const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fake, { preconnect: fetch.preconnect }))
  restore = () => spy.mockRestore()
  return calls
}

afterEach(() => {
  restore?.()
  restore = undefined
})

test('a board payload has its lists, version and staleness', () => {
  expect(isBoardPayload(payload())).toBe(true)
  expect(isBoardPayload({ ...payload(), items: null })).toBe(false)
  expect(isBoardPayload({ ...payload(), stale: 'no' })).toBe(false)
  expect(isBoardPayload([])).toBe(false)
  // The terminal's fields: missing (a board before it), or as the server sends them.
  expect(isBoardPayload({ ...payload(), terminal: true, shells: ['s1'] })).toBe(true)
  expect(isBoardPayload({ ...payload(), terminal: 'yes' })).toBe(false)
  expect(isBoardPayload({ ...payload(), shells: [1] })).toBe(false)
  // Whether MokuPilot is here for calls: missing (a board before it), or a yes or no.
  expect(isBoardPayload({ ...payload(), mokupilot: false })).toBe(true)
  expect(isBoardPayload({ ...payload(), mokupilot: 'yes' })).toBe(false)
  expect(isBoardPayload(null)).toBe(false)
})

const PROFILE = {
  id: 'default',
  title: 'Private',
  color: '#5856D6',
  colorName: 'indigo',
  dir: 'C:\\Users\\me\\.claude',
  hidden: false,
  inherited: true,
  exists: true,
  hooks: true,
  sessions: 2,
  limits: null,
}

test('a board payload has its profiles, or none (a board before them)', () => {
  expect(isBoardPayload({ ...payload(), profiles: [PROFILE] })).toBe(true)
  expect(isBoardPayload({ ...payload(), profiles: [] })).toBe(true)
  expect(isBoardPayload({ ...payload(), profiles: undefined })).toBe(true)
  expect(isBoardPayload({ ...payload(), profiles: [{ ...PROFILE, hidden: 'no' }] })).toBe(false)
  expect(isBoardPayload({ ...payload(), profiles: [{ ...PROFILE, id: 1 }] })).toBe(false)
  expect(isBoardPayload({ ...payload(), profiles: [{ ...PROFILE, title: null }] })).toBe(false)
  expect(isBoardPayload({ ...payload(), profiles: [{ ...PROFILE, color: undefined }] })).toBe(false)
  expect(isBoardPayload({ ...payload(), profiles: [null] })).toBe(false)
  expect(isBoardPayload({ ...payload(), profiles: 'x' })).toBe(false)
  expect(isBoardProfile(PROFILE)).toBe(true)
  expect(isBoardProfile({ ...PROFILE, hidden: undefined })).toBe(false)
})

test('a profile has what the switch and the tags read: id, title, color, folder, shown or hidden', () => {
  expect(isBoardProfile(PROFILE)).toBe(true)
  // A hidden one: its hooks not read, no usage.
  expect(isBoardProfile({ ...PROFILE, hidden: true, hooks: null, limits: null })).toBe(true)
  // Fields the page does not read yet may come as they will.
  expect(isBoardProfile({ ...PROFILE, extra: 1 })).toBe(true)
  for (const bad of [
    { ...PROFILE, dir: undefined },
    { ...PROFILE, dir: 1 },
    { ...PROFILE, dir: null },
    { ...PROFILE, id: undefined },
    { ...PROFILE, title: 2 },
    { ...PROFILE, color: null },
    { ...PROFILE, hidden: 'false' },
    [PROFILE],
    'default',
    null,
  ])
    expect([bad, isBoardProfile(bad)]).toEqual([bad, false])
  expect(isBoardPayload({ ...payload(), profiles: [PROFILE, { ...PROFILE, dir: 3 }] })).toBe(false)
})

test('a profile has what the Profiles panel reads: its folder there or not, the board’s hooks there, its sessions now', () => {
  expect(isBoardProfile({ ...PROFILE, exists: false, hooks: false, sessions: 0 })).toBe(true)
  // A hidden one: its settings.json not read.
  expect(isBoardProfile({ ...PROFILE, hidden: true, hooks: null })).toBe(true)
  for (const bad of [
    { ...PROFILE, exists: undefined },
    { ...PROFILE, exists: 'yes' },
    { ...PROFILE, exists: null },
    { ...PROFILE, hooks: undefined },
    { ...PROFILE, hooks: 'true' },
    { ...PROFILE, hooks: 0 },
    { ...PROFILE, sessions: undefined },
    { ...PROFILE, sessions: '2' },
    { ...PROFILE, sessions: null },
  ])
    expect([bad, isBoardProfile(bad)]).toEqual([bad, false])
  expect(isBoardPayload({ ...payload(), profiles: [PROFILE, { ...PROFILE, sessions: '1' }] })).toBe(false)
})

test('a profile’s usage, which the usage pill reads: none (null), or a reading with its list of windows', () => {
  const reading = {
    source: 'statusline',
    observedAt: 1000,
    stale: false,
    windows: [{ minutes: 300, usedPercentage: 92, resetsAt: null, expired: false }],
  }
  expect(isBoardProfile({ ...PROFILE, limits: reading })).toBe(true)
  expect(isBoardProfile({ ...PROFILE, limits: { ...reading, windows: [] } })).toBe(true)
  // A window the pill cannot read is left out by it (models/limits.ts), as on the board's own usage.
  expect(isBoardProfile({ ...PROFILE, limits: { ...reading, windows: [{ minutes: 60 }, null] } })).toBe(true)
  for (const bad of [
    undefined,
    'none',
    0,
    false,
    [],
    [reading],
    {},
    { ...reading, windows: undefined },
    { ...reading, windows: null },
    { ...reading, windows: 'x' },
    { ...reading, windows: { 0: reading.windows[0] } },
  ])
    expect([bad, isBoardProfile({ ...PROFILE, limits: bad })]).toEqual([bad, false])
  const { limits: _, ...without } = PROFILE
  expect(isBoardProfile(without)).toBe(false)
  expect(isBoardPayload({ ...payload(), profiles: [PROFILE, { ...PROFILE, limits: reading }] })).toBe(true)
  expect(isBoardPayload({ ...payload(), profiles: [PROFILE, { ...PROFILE, limits: 'x' }] })).toBe(false)
})

test('POST sends JSON with the X-Board header and answers the reply', async () => {
  const calls = answer(200, '{"ok":true,"id":"x"}')
  expect(await api.post('/api/settings', { language: 'ru' })).toEqual({ ok: true, id: 'x' })
  const [call] = calls
  expect(call?.url).toBe('/api/settings')
  expect(call?.init?.method).toBe('POST')
  expect(call?.init?.headers).toEqual({ 'content-type': 'application/json', 'x-board': '1' })
  expect(call?.init?.body).toBe('{"language":"ru"}')
})

test('POST without a body sends {}; an empty answer is {}', async () => {
  const calls = answer(200, '')
  expect(await api.post('/api/launch/x/focus')).toEqual({})
  expect(calls[0]?.init?.body).toBe('{}')
})

test('a refusal or ok:false is an ApiError worded as the board words it; so is a network failure', async () => {
  answer(409, '{"error":"herdr is out of date"}')
  const refused = await api.post('/api/session/a/focus').catch((err: unknown) => err)
  expect(refused).toBeInstanceOf(ApiError)
  expect(errorText(refused, t)).toBe('herdr is out of date')

  answer(500, 'not json')
  expect(errorText(await api.post('/x').catch((err: unknown) => err), t)).toBe('Error 500')

  answer(200, '{"ok":false}')
  expect(errorText(await api.post('/x').catch((err: unknown) => err), t)).toBe('Error 200')

  expect(errorText(new TypeError('Failed to fetch'), t)).toBe('No connection to the board: Failed to fetch')
})

test('GET checks the answer with the guard; the board snapshot is uncached and comes as it is, for the connection to check', async () => {
  const calls = answer(200, JSON.stringify(payload()))
  expect((await api.board()).version).toBe('v1')
  expect(calls[0]?.init?.cache).toBe('no-store')
  answer(200, '{"items":[],"version":"v2"}')
  expect(await api.board()).toEqual({ items: [], version: 'v2' })
  answer(200, '[1,2]')
  expect(await api.board().catch((err: unknown) => err)).toBeInstanceOf(ApiError)
  const isList = (v: unknown): v is number[] => Array.isArray(v)
  expect(await api.get('/api/list', isList)).toEqual([1, 2])
})

const detail = {
  item: item({ key: 'a' }),
  conversation: [
    { role: 'user', text: 'hi', at: 1 },
    { role: 'tool', label: 'Read', detail: 'x', path: '', done: true, at: 2 },
  ],
  screen: '',
  dialog: null,
  checkout: true,
}

test('a session detail has its item, turns, screen, dialog and checkout', () => {
  expect(isSessionDetail(detail)).toBe(true)
  expect(isSessionDetail({ ...detail, dialog: { kind: 'review' } })).toBe(true)
  expect(isSessionDetail({ ...detail, conversation: [{ text: 'no role' }] })).toBe(false)
  expect(isSessionDetail({ ...detail, item: { name: 'no key' } })).toBe(false)
  expect(isSessionDetail({ ...detail, checkout: 'yes' })).toBe(false)
  expect(isSessionDetail({ ...detail, screen: undefined })).toBe(false)
})

test('a session detail holds its turns as the server reads them: task and reminder notices, updates kept as thinking', () => {
  const line = (o: unknown) => JSON.stringify(o)
  const conversation = parseConversation([
    line({ type: 'user', message: { content: 'watch the job' } }),
    line({
      type: 'assistant',
      thinkingDisplay: 'updates',
      message: { content: [{ type: 'thinking', thinking: 'Watching the job.' }] },
    }),
    line({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: notification('Background command "Wait for the job" completed (exit code 0)', { id: 'bq1' }),
        commandMode: 'task-notification',
      },
    }),
    line({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content: notification('Agent "Check the job" finished', { id: 'a2', tail: '<result>Done.</result>' }),
      },
    }),
    line({ type: 'user', message: { content: '[board reminder from Master] check the job again' } }),
  ])
  expect(conversation.map(c => [c.role, c.role === 'notice' ? c.kind : ''])).toEqual([
    ['user', ''],
    ['assistant', ''],
    ['notice', 'command'],
    ['notice', 'agent'],
    ['notice', 'reminder'],
  ])
  // As the page gets it: through JSON.
  expect(isSessionDetail(JSON.parse(JSON.stringify({ ...detail, conversation })))).toBe(true)
  expect(isSessionDetail({ ...detail, conversation: [...conversation, { role: 'system', text: 'x', at: 3 }] })).toBe(
    false,
  )
})

test('a session is read uncached by its key, with the signal; a 404 keeps its status', async () => {
  const calls = answer(200, JSON.stringify(detail))
  const signal = new AbortController().signal
  expect((await api.session('a/b c', signal)).checkout).toBe(true)
  expect(calls[0]?.url).toBe('/api/session/a%2Fb%20c')
  expect(calls[0]?.init?.cache).toBe('no-store')
  expect(calls[0]?.init?.signal).toBe(signal)
  answer(404, '{"error":"Session not found"}')
  const gone = await api.session('a', signal).catch((err: unknown) => err)
  expect(gone).toBeInstanceOf(ApiError)
  expect(gone instanceof ApiError && [gone.status, gone.message]).toEqual([404, 'Session not found'])
})

test('an upload posts the file itself with X-Board, its name and type; it answers where it went', async () => {
  const calls = answer(200, JSON.stringify({ ok: true, path: 'C:\\u\\2026-10-17\\a b.png' }))
  const file = new File(['png'], 'a b.png', { type: 'image/png' })
  expect(await api.upload('a b.png', file)).toBe('C:\\u\\2026-10-17\\a b.png')
  expect(calls[0]?.url).toBe('/api/upload')
  expect(calls[0]?.init?.method).toBe('POST')
  expect(calls[0]?.init?.headers).toEqual({ 'x-board': '1', 'x-filename': 'a%20b.png', 'content-type': 'image/png' })
  expect(calls[0]?.init?.body).toBe(file)
  const untyped = answer(200, '{"ok":true,"path":"/u/x"}')
  await api.upload('x', new Blob(['x']))
  expect(untyped[0]?.init?.headers).toMatchObject({ 'content-type': 'application/octet-stream' })
  answer(413, '{"error":"File larger than 30 MB"}')
  const big = await api.upload('x', new Blob(['x'])).catch((err: unknown) => err)
  expect(errorText(big, t)).toBe('File larger than 30 MB')
  answer(200, '{"ok":false}')
  expect(errorText(await api.upload('x', new Blob(['x'])).catch((err: unknown) => err), t)).toBe('Error 200')
})
