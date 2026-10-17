import { afterEach, expect, spyOn, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { ApiError, api, errorText, isBoardPayload, isSessionDetail } from '../../web/src/api/client.ts'
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
  expect(isBoardPayload(null)).toBe(false)
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

test('GET checks the answer with the guard; the board snapshot is uncached', async () => {
  const calls = answer(200, JSON.stringify(payload()))
  expect((await api.board()).version).toBe('v1')
  expect(calls[0]?.init?.cache).toBe('no-store')
  answer(200, '{"items":[]}')
  expect(await api.board().catch((err: unknown) => err)).toBeInstanceOf(ApiError)
  answer(200, '[1,2]')
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
