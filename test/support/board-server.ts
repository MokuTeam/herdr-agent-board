// The web board's server in a child process (runner.ts 'server' mode) against the sandbox's fake herdr.
import { afterAll } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Child, type Sandbox, sandbox, until } from './sandbox.ts'

/**
 * For a describe block that shares one board: call it in the block, then the returned function
 * in its beforeAll. The sandbox goes after the block's last test (sandbox() alone would clean up
 * when the beforeAll hook ends).
 */
export function sharedSandbox(): () => Promise<Sandbox> {
  const cleanups: (() => void | Promise<void>)[] = []
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })
  return () => sandbox({ after: cleanup => cleanups.push(cleanup) })
}

export async function unusedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise(resolve => server.close(resolve))
  return port
}

export type BoardMessage = { ready?: boolean; refreshed?: boolean; log?: string }

/**
 * Starts the server with one 'other' lane and no polling (refreshSec 3600); resolves once it
 * listens. `extra`: environment of its own (the board in a herdr pane, say).
 */
export async function serveBoard(
  box: Sandbox,
  cfg: Record<string, unknown> = {},
  extra: Record<string, string> = {},
): Promise<{ url: string; proc: Child }> {
  const port = await unusedPort()
  const proc = box.run(
    'server',
    {
      port,
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      ...cfg,
    },
    extra,
  )
  await until(() => proc.messages.some(m => (m as BoardMessage).ready))
  return { url: `http://127.0.0.1:${port}`, proc }
}

export const logged = (proc: Child, text: string): boolean =>
  proc.messages.some(m => (m as BoardMessage).log?.includes(text))
