// Local Antigravity (Gemini) usage reading (#647), strictly gated on agy being installed.
// Reads only the status-line cache file (`agy-limits-latest.json`) — never reads auth tokens,
// never makes model calls, and never runs on boards where agy is not installed.
import { lstatSync, readFileSync } from 'node:fs'
import { type AgyLimits, type BoardAgyLimits, boardAgyLimitsFrom, parseAgyLimits } from '../core/agy-limits.ts'
import { agyConfigured } from '../core/launch/agents.ts'
import type { LaunchSpec } from '../core/types.ts'
import { agyUsageFile } from './paths.ts'
import { findCommand } from './setup-facts.ts'

let cachedPathKey: string | null = null
let cachedAgyFound = false

/** Cached PATH check for `agy`, invalidated automatically if PATH or PATHEXT changes (e.g. in tests). */
export function agyOnPathCached(env: Record<string, string | undefined> = process.env): boolean {
  const pathKey = `${env.PATH ?? env.Path ?? ''}\0${env.PATHEXT ?? ''}`
  if (cachedPathKey === pathKey) return cachedAgyFound
  cachedPathKey = pathKey
  const found = findCommand('agy', { env })
  cachedAgyFound = !!(found.ps ?? found.sh)
  return cachedAgyFound
}

/** Whether Antigravity CLI is installed or configured on this machine. */
export function agyInstalled(launch?: LaunchSpec, env?: Record<string, string | undefined>): boolean {
  return agyConfigured(launch) || agyOnPathCached(env)
}

/**
 * Read an Antigravity usage cache file (written by `entrypoints/agy-statusline.ts`).
 * Rejects symlinks and files over 64 KB, matching `readUsageFile` in `adapters/claude-home.ts`.
 */
export function readAgyUsageFile(file: string, now = Date.now()): AgyLimits {
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) return parseAgyLimits(null, now)
    return parseAgyLimits(JSON.parse(readFileSync(file, 'utf8')), now)
  } catch {
    return parseAgyLimits(null, now)
  }
}

/**
 * Local Antigravity usage for the board payload and node status:
 * - `undefined` when `agy` is not installed/configured here (zero file reads, field omitted).
 * - `BoardAgyLimits` when a readable, non-expired status-line cache exists.
 * - `null` when `agy` is installed but no readable/non-expired reading exists yet (shown as unknown).
 */
export function localAgyLimits(
  launch?: LaunchSpec,
  now = Date.now(),
  opts?: { installed?: boolean; file?: string },
): BoardAgyLimits | null | undefined {
  const present = opts?.installed ?? agyInstalled(launch)
  if (!present) return undefined
  return boardAgyLimitsFrom(readAgyUsageFile(opts?.file ?? agyUsageFile(), now), now)
}
