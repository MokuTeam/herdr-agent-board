// A JSON file another program rewrites (Claude Code's ~/.claude.json, where tg-mcp's url and token
// are): read again only when it changed; caught in the middle of a rewrite (it does not parse), the
// last value that did, so wake's Telegram does not go off and on with each of Claude Code's writes.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { followedJson } from '../../src/adapters/followed-json.ts'

/** A folder of its own, with spaces, Cyrillic and %. */
const folder = (): string => mkdtempSync(join(tmpdir(), 'Иван Петров 100% '))

/** Writes the text with a modification time of its own (a second apart), so a change is seen whatever the clock's grain. */
let tick = 1_700_000_000
function write(file: string, text: string): void {
  writeFileSync(file, text)
  tick += 1
  utimesSync(file, tick, tick)
}

test('followed: read once per change; half written, the last value that parsed; gone, none', () => {
  const dir = folder()
  try {
    const file = join(dir, '.claude.json')
    const read = followedJson(file)
    expect(read()).toBeNull()

    write(file, '﻿{"mcpServers":{"telegram":{"url":"http://127.0.0.1:7777/mcp"}}}')
    const first = read()
    expect(first).toEqual({ mcpServers: { telegram: { url: 'http://127.0.0.1:7777/mcp' } } })
    // Not changed: the same value, not read again.
    expect(read()).toBe(first)

    // Caught in the middle of a rewrite: the last value that parsed, again on the next look.
    write(file, '{"mcpServers":{"tele')
    expect(read()).toEqual(first)
    write(file, '')
    expect(read()).toEqual(first)

    // Written whole: the new value.
    write(file, '{"mcpServers":{}}')
    expect(read()).toEqual({ mcpServers: {} })

    // Removed: none; a broken one after that is none too (no value parsed since).
    rmSync(file)
    expect(read()).toBeNull()
    write(file, '{"half')
    expect(read()).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
