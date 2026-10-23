// The board's answers to the page's fetches in a test, as test/web/profiles-panel.test.tsx has
// them: the replies given in turn, every call kept, and what each POST sent read back. A test file
// that uses them puts fetch back after each test: `afterEach(restoreFetch)`.
import { spyOn } from 'bun:test'

export type Call = { url: string; init: RequestInit | undefined }

/** One answer: its status, its JSON body and its headers, if any; an Error: no connection (fetch rejects with it). */
export type Answer = [status: number, body: unknown, headers?: Record<string, string>] | Error

let restore: (() => void) | undefined

/** The page's own fetch again. */
export function restoreFetch(): void {
  restore?.()
  restore = undefined
}

/** The server's answers to the page's fetches, in turn (then 200 `{ ok: true }`); the calls kept. */
export function answers(...replies: Answer[]): Call[] {
  restoreFetch()
  const calls: Call[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const reply = replies.shift() ?? [200, { ok: true }]
    if (reply instanceof Error) throw reply
    const [status, body, headers] = reply
    return new Response(JSON.stringify(body), { status, ...(headers && { headers }) })
  }
  const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fake, { preconnect: fetch.preconnect }))
  restore = () => spy.mockRestore()
  return calls
}

/** What went to the board: the path, the method, the X-Board header and the body (none for a GET). */
export const sent = (calls: Call[]) =>
  calls.map(c => [
    c.url,
    c.init?.method,
    (c.init?.headers as Record<string, string> | undefined)?.['x-board'],
    c.init?.body === undefined ? undefined : JSON.parse(String(c.init.body)),
  ])
