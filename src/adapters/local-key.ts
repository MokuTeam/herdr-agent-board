// The board on its own server (core/on-server.ts): the key every program of the board's user sends
// to the board's ports on 127.0.0.1, the web board's and wake's. On a server other accounts reach
// 127.0.0.1 too (the web server's www-data, a container on the host's network) and can forge a
// Host, an Origin and X-Board; they cannot read this key: random, in the board's state folder,
// 0600. The board and wake make it when it is not there; the board command, wake's hooks and
// herdr's actions read it and send it as X-Board-Key. On a PC nothing makes, reads or sends it:
// the ports take any program on the computer, as before.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverModeOf } from '../core/on-server.ts'
import { stateDir } from './paths.ts'

export const LOCAL_KEY_HEADER = 'x-board-key'
export const localKeyFile = (): string => join(stateDir(), 'local-key')
/** 32 random bytes, base64url. */
const KEY = /^[\w-]{43}$/

const errorCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code

/** The key on file, or null when there is none (or not one the board made). */
export function readLocalKey(): string | null {
  try {
    const key = readFileSync(localKeyFile(), 'utf8').trim()
    return KEY.test(key) ? key : null
  } catch {
    return null
  }
}

/**
 * The key, made when there is none: written whole beside its place (0600), then linked in, so a
 * board and a wake starting together never read half a key and both keep the first one made. A
 * file there that holds no key is replaced.
 */
export function ensureLocalKey(): string {
  const have = readLocalKey()
  if (have) return have
  mkdirSync(stateDir(), { recursive: true })
  const file = localKeyFile()
  const part = `${file}.${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(part, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
  try {
    linkSync(part, file)
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err
    if (!readLocalKey()) renameSync(part, file)
  } finally {
    rmSync(part, { force: true })
  }
  const kept = readLocalKey()
  if (!kept) throw new Error(`${file} holds no key`)
  return kept
}

/** Whether a request's X-Board-Key is `key`, compared in constant time. */
export function keyMatches(given: string | null, key: string): boolean {
  if (given === null) return false
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type LocalFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * fetch for the board's own ports on 127.0.0.1 (the web board's, wake's): on the board's server
 * with the key (read at each call, as `cfg` says then); on a PC fetch itself, with what it was given.
 */
export function localFetch(cfg: { serverMode?: unknown } | null | undefined): LocalFetch {
  return (url, init) => {
    if (!serverModeOf(cfg?.serverMode)) return fetch(url, init)
    const headers = new Headers(init?.headers)
    const key = readLocalKey()
    if (key) headers.set(LOCAL_KEY_HEADER, key)
    return fetch(url, { ...init, headers })
  }
}
