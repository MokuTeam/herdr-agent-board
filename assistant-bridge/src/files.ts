// The bridge's files in its state directory (#384, design 3.2 and 7.1): config.json (the owner's),
// key.json (the hub identity, mode 0600), bridge.db (the store), status.json (for `status`).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateKey, isPeerId, type KeyPair } from '../../src/core/team.ts'
import { type ConfigResult, parseConfig } from './config.ts'

export const DEFAULT_DIR = join(homedir(), '.local', 'state', 'assistant-bridge')

export const paths = (dir: string) => ({
  config: join(dir, 'config.json'),
  key: join(dir, 'key.json'),
  db: join(dir, 'bridge.db'),
  status: join(dir, 'status.json'),
})

/** The state directory, made 0700 when it is not there. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
}

export function readConfig(dir: string): ConfigResult {
  const file = paths(dir).config
  if (!existsSync(file)) return { ok: false, errors: [`no config at ${file}`] }
  try {
    return parseConfig(JSON.parse(readFileSync(file, 'utf8')), dir)
  } catch (err) {
    return { ok: false, errors: [`config.json: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

export function readKey(dir: string): KeyPair | null {
  const file = paths(dir).key
  if (!existsSync(file)) return null
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { pkcs8?: unknown; pub?: unknown }
    return typeof v.pkcs8 === 'string' && isPeerId(v.pub) ? { pkcs8: v.pkcs8, pub: v.pub } : null
  } catch {
    return null
  }
}

/** Writes a file whole, mode 0600, through a temporary one so a crash leaves the old or the new. */
export function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** The key, made and saved the first time. */
export async function ensureKey(dir: string): Promise<{ key: KeyPair; fresh: boolean }> {
  const had = readKey(dir)
  if (had) return { key: had, fresh: false }
  const key = await generateKey()
  writePrivate(paths(dir).key, `${JSON.stringify(key)}\n`)
  return { key, fresh: true }
}
