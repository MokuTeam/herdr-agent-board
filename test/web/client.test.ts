import { afterEach, expect, spyOn, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { ApiError, api, errorText, isBoardPayload } from '../../web/src/api/client.ts'
import { payload } from './support/board.tsx'

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
