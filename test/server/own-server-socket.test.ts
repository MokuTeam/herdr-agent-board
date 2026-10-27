// The login listener's socket in server mode (server/tunnel.ts, core/on-server.ts), in this
// process: a stale socket a board before left is removed, anything else at its path stays, the
// socket goes when the listener stops, when the server mode leaves config.json, and when the
// process exits without stopping it; settings that do not check out listen nowhere.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../../src/core/types.ts'
import { createTunnelListener, type TunnelListener } from '../../src/server/tunnel.ts'
import { createAccess } from '../../src/services/access.ts'
import { createFirstLogin } from '../../src/services/first-login.ts'
import { createProbes } from '../../src/services/tunnel.ts'
import { isolatedHome } from '../support/env.ts'
import { socketIn } from '../support/own-server.ts'
import { root, until } from '../support/sandbox.ts'
import { DOMAIN } from '../support/tunnel-board.ts'

/** The listener on `cfg`, its log lines in `logs`. */
function listenerFor(cfg: Record<string, unknown>, logs: string[]): TunnelListener {
  const access = createAccess({ onChange: () => {} })
  return createTunnelListener({
    cfg: cfg as unknown as Config,
    webPort: 1,
    routes: [],
    guards: { port: 1, token: 't', stale: () => false },
    page: { method: 'GET', path: /^/, handle: () => new Response('page') },
    access,
    probes: createProbes(),
    ownFiles: () => false,
    log: text => logs.push(text),
    onChange: () => {},
    firstLogin: createFirstLogin({ access, domain: () => DOMAIN }),
  })
}

const hello = (socket: string): Promise<[number, unknown]> =>
  fetch(`http://${DOMAIN}/api/hello`, { unix: socket, headers: { host: DOMAIN, 'x-forwarded-proto': 'https' } }).then(
    async res => [res.status, await res.json()],
  )

/** Runs `code` (a module) in a Bun of its own with `args`, in the isolated home's env; its exit code. */
async function runScript(dir: string, code: string, args: string[]): Promise<number> {
  const file = join(dir, `script-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(file, code)
  const proc = Bun.spawn([process.execPath, file, ...args], {
    cwd: root,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return await proc.exited
}

test('a socket a board before left is removed and listened on; stopping removes it', async () => {
  const dir = isolatedHome()
  const socket = socketIn(dir)
  // a board that ended without stopping its listener
  await runScript(
    dir,
    "Bun.serve({ unix: process.argv[2], fetch: () => new Response('old') })\nprocess.kill(process.pid, 'SIGKILL')\n",
    [socket],
  )
  expect(existsSync(socket)).toBe(true)
  const logs: string[] = []
  const listener = listenerFor({ serverMode: { domain: DOMAIN, socket } }, logs)
  await listener.sync()
  expect(listener.socket()).toBe(socket)
  expect(listener.listening()).toBeNull()
  expect(logs).toEqual([`server mode: listening on ${socket} for https://${DOMAIN}/`])
  expect(await hello(socket)).toEqual([401, { error: 'setup' }])
  await listener.close()
  expect(existsSync(socket)).toBe(false)
})

test('anything else at the socket’s path stays as it is, and nothing listens', async () => {
  const dir = isolatedHome()
  const socket = socketIn(dir)
  writeFileSync(socket, 'mine')
  const logs: string[] = []
  const listener = listenerFor({ serverMode: { domain: DOMAIN, socket } }, logs)
  await listener.sync()
  await listener.sync()
  expect(listener.socket()).toBeNull()
  expect(logs).toEqual([
    `server mode: Cannot listen on ${socket}: ${socket} is there and is no socket: it is left as it is`,
  ])
  expect(readFileSync(socket, 'utf8')).toBe('mine')
  await listener.close()
  expect(readFileSync(socket, 'utf8')).toBe('mine')
})

test('settings that do not check out: nothing listens, the reason logged once', async () => {
  isolatedHome()
  const logs: string[] = []
  const listener = listenerFor({ serverMode: { domain: 'Board.example.com', socket: '/tmp/board.sock' } }, logs)
  await listener.sync()
  await listener.sync()
  expect(listener.socket()).toBeNull()
  expect(logs).toEqual([
    'server mode: serverMode.domain: The domain is a lowercase host name such as board.example.com, without https://, a path or a port',
  ])
  await listener.close()
})

test('the server mode taken out of config.json: the socket goes, as on a board on a PC', async () => {
  const dir = isolatedHome()
  const socket = socketIn(dir)
  const cfg: Record<string, unknown> = { serverMode: { domain: DOMAIN, socket } }
  const listener = listenerFor(cfg, [])
  await listener.sync()
  expect(existsSync(socket)).toBe(true)
  delete cfg.serverMode
  listener.configChanged()
  await until(() => listener.socket() === null && !existsSync(socket))
  await listener.close()
})

test('the process exits without stopping the listener (a restart): the socket goes with it', async () => {
  const dir = isolatedHome()
  const socket = socketIn(dir)
  const src = (path: string): string => JSON.stringify(join(root, 'src', path).replaceAll('\\', '/'))
  const code = `
import { createTunnelListener } from ${src('server/tunnel.ts')}
import { createAccess } from ${src('services/access.ts')}
import { createProbes } from ${src('services/tunnel.ts')}
import { existsSync } from 'node:fs'
const [socket, domain] = process.argv.slice(2)
const access = createAccess({ onChange: () => {} })
const listener = createTunnelListener({
  cfg: { serverMode: { domain, socket } },
  webPort: 1, routes: [], guards: { port: 1, token: 't', stale: () => false },
  page: { method: 'GET', path: /^/, handle: () => new Response('page') },
  access, probes: createProbes(), ownFiles: () => false, log: () => {}, onChange: () => {},
})
await listener.sync()
process.exit(existsSync(socket) ? 75 : 1)
`
  expect(await runScript(dir, code, [socket, DOMAIN])).toBe(75)
  expect(existsSync(socket)).toBe(false)
})
