// Read only the dedicated, existing usagebar statusLine cache. Never reads auth,
// settings, ~/.claude.json, keychains or provider APIs, and never writes a cache.
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLimits } from './core/limits.ts'
import { claudeDir } from './adapters/paths.ts'
export function localUsage(directory = join(claudeDir(), 'herdr-usagebar'), now = Date.now()) {
  const context = { available: false, observedAt: null, source: null }
  try {
    const path = join(directory, 'claude-limits-latest.json')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return { context, limits: parseLimits(null, now) }
    return { context, limits: parseLimits(JSON.parse(readFileSync(path, 'utf8')), now) }
  } catch {
    return { context, limits: parseLimits(null, now) }
  }
}
