// A test MCP client for the board's /mcp (#813, server/routes/mcp.ts) and config.json as the board's own.
import { expect } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sandbox } from './sandbox.ts'

/** config.json as the board's own: the command the board runs for a call reads it, as on a real computer. */
export function boardConfig(box: Sandbox, url: string, more: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', wakeUrl: null, port: Number(new URL(url).port), ...more }),
  )
}

let next = 1

/** One JSON-RPC request to `url`/mcp; its answer, which must be a 200. */
export async function rpc(url: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { result: Record<string, unknown> }
}

/** A tool's answer: its text and whether it is an error. */
export async function tool(url: string, name: string, args: unknown, headers: Record<string, string> = {}) {
  const { result } = await rpc(url, 'tools/call', { name, arguments: args }, headers)
  const r = result as { content: { text: string }[]; isError?: boolean }
  return { text: r.content.map(c => c.text).join('\n'), error: r.isError === true }
}
