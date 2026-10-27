// The board on its own server in tests (core/on-server.ts): config.json with `serverMode` for
// DOMAIN and a socket in the sandbox, the board started with it (serveBoard), requests shaped as
// Caddy forwards them from the domain to the socket, and `board <args>` run as an agent runs it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logged, serveBoard } from './board-server.ts'
import { type Child, type ChildResult, type Sandbox, until } from './sandbox.ts'
import { CALLER, DOMAIN, ORIGIN } from './tunnel-board.ts'

/**
 * A socket's path in `dir`, as server mode takes it (an absolute path of plain characters): on
 * Windows the same folder spelled from the drive's root (/Users/…), which Windows reads on the
 * current drive. Its folder is made, as the installer makes it.
 */
export function socketIn(dir: string): string {
  const path = join(dir, 'run', 'board.sock')
  mkdirSync(dirname(path), { recursive: true })
  return process.platform === 'win32' ? path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/') : path
}

export const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

/** config.json as written by hand: English, no herdr-wake, wake off, the web port 9 (no board) unless given. */
export function writeConfig(box: Sandbox, value: Record<string, unknown>): void {
  const path = configPath(box)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ language: 'en', wakeUrl: '', wake: false, port: 9, ...value }, null, 2))
}

/** `board <args>` with the sandbox's env. */
export const board = (box: Sandbox, args: string[]): Promise<ChildResult> => box.run('cli', { args, env: {} }).exited

/**
 * The board in server mode for DOMAIN on a socket in the sandbox, config.json saying the same (for
 * the board command), once it says it listens there.
 */
export async function startOwnServer(
  box: Sandbox,
  cfg: Record<string, unknown> = {},
  extra: Record<string, string> = {},
): Promise<{ url: string; socket: string; proc: Child }> {
  const socket = socketIn(box.dir)
  const serverMode = { domain: DOMAIN, socket }
  const { url, proc } = await serveBoard(box, { language: 'en', serverMode, ...cfg }, extra)
  writeConfig(box, { serverMode, ...cfg, port: Number(new URL(url).port) })
  await until(() => logged(proc, `server mode: listening on ${socket} for ${ORIGIN}/`))
  return { url, socket, proc }
}

/**
 * Requests through the socket as Caddy forwards them: Host DOMAIN, X-Forwarded-Proto https,
 * X-Forwarded-For CALLER; POSTs with X-Board and ORIGIN. `headers` go over these; one given as ''
 * is left out.
 */
export function viaSocket(
  socket: string,
  cookie?: string,
): {
  get(path: string, headers?: Record<string, string>): Promise<Response>
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>
} {
  const headersOf = (more: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries({
        host: DOMAIN,
        'x-forwarded-proto': 'https',
        'x-forwarded-for': CALLER,
        ...(cookie ? { cookie } : {}),
        ...more,
      }).filter(([, value]) => value !== ''),
    )
  const at = (path: string): string => `http://${DOMAIN}${path}`
  return {
    get: (path, headers = {}) => fetch(at(path), { unix: socket, headers: headersOf(headers) }),
    post: (path, body, headers = {}) =>
      fetch(at(path), {
        unix: socket,
        method: 'POST',
        headers: headersOf({ 'content-type': 'application/json', 'x-board': '1', origin: ORIGIN, ...headers }),
        body: JSON.stringify(body),
      }),
  }
}
