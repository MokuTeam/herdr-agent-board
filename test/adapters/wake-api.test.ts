// Whether a wake answers on its port: GET /alive for the supervisor's health check (never waits on
// herdr), and /alive then /status for the one-wake-per-machine probe (the old router has only /status).
import { afterEach, expect, test } from 'bun:test'
import { wakeAlive, wakeAnswers } from '../../src/adapters/wake-api.ts'

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

test('wakeAnswers: the old router by its /status after the 404 on /alive', async () => {
  const router = serve(oldRouter)
  expect(await wakeAnswers(router.port, 1000)).toBe(true)
  expect(router.asked).toEqual(['/alive', '/status'])
})

test('wakeAnswers: another program, or nothing answering within the time in all, is no wake', async () => {
  expect(await wakeAnswers(serve(foreign).port, 1000)).toBe(false)
  const hung = serve(() => new Promise<Response>(() => {}))
  const started = Date.now()
  expect(await wakeAnswers(hung.port, 300)).toBe(false)
  expect(Date.now() - started).toBeLessThan(2000)
})
