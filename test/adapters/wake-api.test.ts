// Whether a wake answers on its port: GET /alive for the supervisor's health check (never waits on
// herdr), /alive then /status for the one-wake-per-machine probe, and the separate plugin's old router
// told apart by its /status, which has no Telegram state (and no /alive).
import { afterEach, expect, test } from 'bun:test'
import { oldRouterAt, wakeAlive, wakeAnswers } from '../../src/adapters/wake-api.ts'

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true)
})

/** A server on an unused port of 127.0.0.1 answering `answer` per path; the paths asked, in order. */
function serve(answer: (path: string) => Response | Promise<Response>): { port: number; asked: string[] } {
  const asked: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: req => {
      const path = new URL(req.url).pathname
      asked.push(path)
      return answer(path)
    },
  })
  servers.push(server)
  return { port: server.port as number, asked }
}

/** The new wake: /alive at once, /status only once herdr answers, which it never does here. */
const newWakeWithHerdrHanging = (path: string): Response | Promise<Response> =>
  path === '/alive' ? Response.json({ pid: 4242 }) : new Promise<Response>(() => {})
/** The old router: /status only, a 404 with an empty body for anything else. */
const oldRouter = (path: string): Response =>
  path === '/status' ? Response.json({ pid: 4242, sessions: {} }) : new Response(null, { status: 404 })
/** Another program on the port. */
const foreign = (): Response => new Response('<html>not wake</html>')

test('wakeAlive asks GET /alive only: a pid there is alive, whatever herdr does', async () => {
  const wake = serve(newWakeWithHerdrHanging)
  expect(await wakeAlive(wake.port, 1000)).toBe(true)
  expect(wake.asked).toEqual(['/alive'])
})

test('wakeAlive: no /alive (the old router), another program, or no answer in time is not alive', async () => {
  expect(await wakeAlive(serve(oldRouter).port, 1000)).toBe(false)
  expect(await wakeAlive(serve(foreign).port, 1000)).toBe(false)
  const hung = serve(() => new Promise<Response>(() => {}))
  const started = Date.now()
  expect(await wakeAlive(hung.port, 300)).toBe(false)
  expect(Date.now() - started).toBeLessThan(2000)
})

test('wakeAnswers: the new wake by its /alive, never waiting on /status', async () => {
  const wake = serve(newWakeWithHerdrHanging)
  expect(await wakeAnswers(wake.port, 1000)).toBe(true)
  expect(wake.asked).toEqual(['/alive'])
})

test('wakeAnswers: the separate plugin’s old router is no wake of the board’s (its /status has no Telegram state)', async () => {
  const router = serve(oldRouter)
  expect(await wakeAnswers(router.port, 1000)).toBe(false)
  expect(router.asked).toEqual(['/alive', '/status'])
  // The board's wake by its /status too, when /alive is not there (a 404 from a proxy, say).
  const status = serve(path =>
    path === '/status'
      ? Response.json({ pid: 4242, sessions: {}, telegram: { state: 'off' } })
      : new Response(null, { status: 404 }),
  )
  expect(await wakeAnswers(status.port, 1000)).toBe(true)
})

test('oldRouterAt: the separate plugin’s router by its /status (its pid); the board’s wake, another program or none is not', async () => {
  expect(await oldRouterAt(serve(oldRouter).port, 1000)).toBe(4242)
  expect(await oldRouterAt(serve(newWakeWithHerdrHanging).port, 300)).toBeNull()
  expect(await oldRouterAt(serve(foreign).port, 1000)).toBeNull()
  const wake = serve(path =>
    path === '/alive' ? Response.json({ pid: 7 }) : Response.json({ pid: 7, sessions: {}, telegram: { state: 'off' } }),
  )
  expect(await oldRouterAt(wake.port, 1000)).toBeNull()
  const hung = serve(() => new Promise<Response>(() => {}))
  const started = Date.now()
  expect(await oldRouterAt(hung.port, 300)).toBeNull()
  expect(Date.now() - started).toBeLessThan(2000)
})

test('wakeAnswers: another program, or nothing answering within the time in all, is no wake', async () => {
  expect(await wakeAnswers(serve(foreign).port, 1000)).toBe(false)
  const hung = serve(() => new Promise<Response>(() => {}))
  const started = Date.now()
  expect(await wakeAnswers(hung.port, 300)).toBe(false)
  expect(Date.now() - started).toBeLessThan(2000)
})
