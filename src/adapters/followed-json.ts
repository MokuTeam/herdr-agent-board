// A JSON file another program rewrites while it is read (Claude Code's ~/.claude.json, where
// tg-mcp's url and token are, #119): read again only when its modification time or size changed;
// one caught in the middle of a rewrite (it does not parse, or cannot be read just then) gives the
// last value that parsed, and is read again on the next look. Gone, it is none.
import { readFileSync, statSync } from 'node:fs'

/** A reader of `file`'s JSON (a BOM taken off): its value, the last one that parsed, or null when there is none. */
export function followedJson(file: string): () => unknown {
  let seen: { mtimeMs: number; size: number } | null = null
  let last: unknown = null
  return () => {
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(file, { throwIfNoEntry: false })
    } catch {
      return last // not readable just now: as it was
    }
    if (!stat) {
      seen = null
      last = null
      return null
    }
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) return last
    try {
      last = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
      seen = { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {} // half written: the last value that parsed, read again next time
    return last
  }
}
