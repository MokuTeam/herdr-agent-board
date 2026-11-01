// The owner's secrets for the agents (core/secret-store.ts), on disk: one folder in the board's state
// folder, `secrets/` (0700), never synced (the profile sync reads Claude's profile folders only,
// and core/profile-sync/secrets.ts keeps this folder out by name too):
//   key        32 random bytes (0600): the key the values are sealed with
//   store.json the secrets (0600): name, scope, target, when set; each value sealed with AES-256-GCM
//              (a random IV, the secret's own id as associated data, so a value moved to another
//              entry does not open)
//   used.json  when each was last given to a session, to which and how (0600; no value)
// What a session gets lives in memory only: its own folder under $XDG_RUNTIME_DIR (tmpfs, 0700;
// without one, a folder of this user's in the temp folder), `env.sh` with its export lines and
// the files `board secret file` writes, each 0600. Nothing here writes a value anywhere else, and
// no error it throws carries one. With no store.json, nothing is made or read: hasSecretStore is
// the one look the hooks and launches take.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  exportLines,
  pickFor,
  type SecretCaller,
  type SecretMeta,
  type SecretPlace,
  type SecretScope,
  type SecretUse,
  secretId,
  sessionFolder,
} from '../core/secret-store.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { secretStoreFile, secretsDir } from './paths.ts'

export { secretStoreFile, secretsDir }
export const secretKeyFile = (): string => join(secretsDir(), 'key')
export const secretUsedFile = (): string => join(secretsDir(), 'used.json')

const POSIX = process.platform !== 'win32'
const errorCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code

/** A sealed entry as store.json keeps it. */
interface Entry extends SecretPlace {
  name: string
  targetName?: string
  setAt: number
  iv: string
  tag: string
  data: string
}
interface Store {
  v: 1
  entries: Entry[]
}
type Used = Record<string, { at: number; by: string; how: SecretUse }>

const isScope = (v: unknown): v is SecretScope => v === 'global' || v === 'profile' || v === 'session'
const isEntry = (v: unknown): v is Entry =>
  isRecord(v) &&
  typeof v.name === 'string' &&
  isScope(v.scope) &&
  (v.target === null || typeof v.target === 'string') &&
  typeof v.setAt === 'number' &&
  typeof v.iv === 'string' &&
  typeof v.tag === 'string' &&
  typeof v.data === 'string'
const isStore = (v: unknown): v is Store => isRecord(v) && Array.isArray(v.entries)
const isUsed = (v: unknown): v is Used => isRecord(v)

/** Whether the owner ever set a secret here: the one look a hook or a launch takes when none was. */
export const hasSecretStore = (): boolean => existsSync(secretStoreFile())

/** Whether a secret is set now (the store may be there, emptied). */
export const anySecrets = (): boolean => hasSecretStore() && entriesOf(readJson(secretStoreFile(), isStore)).length > 0

/** The folder, 0700, made when it is not there. */
function ensureDir(): string {
  const dir = secretsDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (POSIX) chmodSync(dir, 0o700)
  return dir
}

const KEY = /^[A-Za-z0-9+/]{43}=$/

function readKey(): Buffer | null {
  try {
    const text = readFileSync(secretKeyFile(), 'utf8').trim()
    return KEY.test(text) ? Buffer.from(text, 'base64') : null
  } catch {
    return null
  }
}

/** The key, made when there is none: written whole beside its place (0600), then linked in, so two first sets keep one key. */
function ensureKey(): Buffer {
  const have = readKey()
  if (have) return have
  ensureDir()
  const file = secretKeyFile()
  const part = `${file}.${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(part, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
  try {
    linkSync(part, file)
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err
    if (!readKey()) renameSync(part, file)
  } finally {
    rmSync(part, { force: true })
  }
  const kept = readKey()
  if (!kept) throw new Error('the secrets key could not be made')
  return kept
}

const aad = (id: string): Buffer => Buffer.from(`agent-board-secret v1 ${id}`, 'utf8')

function seal(key: Buffer, id: string, value: string): Pick<Entry, 'iv' | 'tag' | 'data'> {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(id))
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

/** The value, or null when it does not open (another key, an entry moved or changed). */
function open(key: Buffer, e: Entry): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'))
    decipher.setAAD(aad(secretId(e, e.name)))
    decipher.setAuthTag(Buffer.from(e.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

const entriesOf = (store: Store | null): Entry[] => (store?.entries ?? []).filter(isEntry)

const rank: Record<SecretScope, number> = { global: 0, profile: 1, session: 2 }

/** Every secret as anyone may see it (no value), by name, then global, profile, session. */
export function listSecrets(): SecretMeta[] {
  const used = readJson(secretUsedFile(), isUsed) ?? {}
  return entriesOf(readJson(secretStoreFile(), isStore))
    .map(e => {
      const id = secretId(e, e.name)
      const u = used[id]
      return {
        id,
        name: e.name,
        scope: e.scope,
        target: e.target,
        ...(e.targetName && { targetName: e.targetName }),
        setAt: e.setAt,
        ...(u && typeof u.at === 'number' && { usedAt: u.at, usedBy: String(u.by), usedHow: u.how }),
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : rank[a.scope] - rank[b.scope]))
}

/** Sets (or replaces) the secret `name` at `place`; what anyone may see of it. Checks are the caller's (core/secret-store.ts). */
export function setSecret(
  place: SecretPlace,
  name: string,
  value: string,
  opts: { targetName?: string; now?: number } = {},
): SecretMeta {
  return setSecrets(place, [{ name, value }], opts)[0] as SecretMeta
}

/**
 * Sets (or replaces) several secrets at `place` in one write of the store (a request's fields,
 * services/secrets.ts); what anyone may see of them, in their order. Checks are the caller's.
 */
export function setSecrets(
  place: SecretPlace,
  given: readonly { name: string; value: string }[],
  { targetName, now = Date.now() }: { targetName?: string; now?: number } = {},
): SecretMeta[] {
  const key = ensureKey()
  const target = place.scope === 'global' ? null : place.target
  const named = place.scope === 'session' && targetName ? { targetName } : {}
  const entries: Entry[] = given.map(({ name, value }) => ({
    name,
    scope: place.scope,
    target,
    ...named,
    setAt: now,
    ...seal(key, secretId(place, name), value),
  }))
  const ids = new Set(entries.map(e => secretId(e, e.name)))
  updateJson(
    secretStoreFile(),
    cur => ({ v: 1 as const, entries: [...entriesOf(cur).filter(e => !ids.has(secretId(e, e.name))), ...entries] }),
    isStore,
    { mode: 0o600 },
  )
  // A value set anew was never given to a session yet.
  updateJson(
    secretUsedFile(),
    cur => {
      if (!cur || ![...ids].some(id => id in cur)) return undefined
      return Object.fromEntries(Object.entries(cur).filter(([id]) => !ids.has(id)))
    },
    isUsed,
    { mode: 0o600 },
  )
  return entries.map(e => ({
    id: secretId(e, e.name),
    name: e.name,
    scope: e.scope,
    target: e.target,
    ...(e.targetName && { targetName: e.targetName }),
    setAt: now,
  }))
}

/** Removes the secret with this id; false when there is none. The store stays (empty), so hooks still clear what a session had. */
export function removeSecret(id: string): boolean {
  if (!hasSecretStore()) return false
  let found = false
  updateJson(
    secretStoreFile(),
    cur => {
      const all = entriesOf(cur)
      const left = all.filter(e => secretId(e, e.name) !== id)
      found = left.length !== all.length
      return found ? { v: 1 as const, entries: left } : undefined
    },
    isStore,
    { mode: 0o600 },
  )
  if (found)
    updateJson(
      secretUsedFile(),
      cur => {
        if (!cur || !(id in cur)) return undefined
        const { [id]: _gone, ...rest } = cur
        return rest
      },
      isUsed,
      { mode: 0o600 },
    )
  return found
}

/** A secret a session gets: its id, name and value. */
export interface GivenSecret {
  id: string
  name: string
  value: string
}

/** What the caller gets, one per name (core/secret-store.ts pickFor); none without a store. One that does not open is left out. */
export function secretsFor(who: SecretCaller): GivenSecret[] {
  if (!hasSecretStore()) return []
  const picked = pickFor(entriesOf(readJson(secretStoreFile(), isStore)), who)
  if (!picked.length) return []
  const key = readKey()
  if (!key) return []
  return picked.flatMap(e => {
    const value = open(key, e)
    return value === null ? [] : [{ id: secretId(e, e.name), name: e.name, value }]
  })
}

/** Records that `by` (a session key) got these secrets now, and how. Never fails the caller. */
export function markUsed(ids: readonly string[], by: string, how: SecretUse, now = Date.now()): void {
  if (!ids.length) return
  try {
    updateJson(
      secretUsedFile(),
      cur => {
        const next: Used = { ...(cur ?? {}) }
        for (const id of ids) next[id] = { at: now, by, how }
        return next
      },
      isUsed,
      { mode: 0o600 },
    )
  } catch {}
}

type Env = Record<string, string | undefined>

/** This user's name for a folder of its own in a shared temp folder. */
function ownTag(): string {
  try {
    const u = userInfo()
    return u.uid >= 0 ? String(u.uid) : u.username.replace(/[^\w.-]/g, '_')
  } catch {
    return 'user'
  }
}

/**
 * Where sessions' secrets live while they run: $XDG_RUNTIME_DIR/agent-board/secrets (memory,
 * gone at reboot), else agent-board-<uid>/secrets in the temp folder.
 */
export function secretRunDir(env: Env = process.env): string {
  const run = env.XDG_RUNTIME_DIR
  return run ? join(run, 'agent-board', 'secrets') : join(tmpdir(), `agent-board-${ownTag()}`, 'secrets')
}

/** Whether the run folder is in memory ($XDG_RUNTIME_DIR), where a session's env file may stay for its whole run. */
export const runDirInMemory = (env: Env = process.env): boolean => !!env.XDG_RUNTIME_DIR

/**
 * A folder of this user's only: made 0700 when it is not there; one that is a link, or another
 * user's, is refused (a shared temp folder).
 */
function ownFolder(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!POSIX) return
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a folder`)
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is not this user's`)
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32)

/** A session's own folder in the run folder (0700, each level of it this user's). */
export function sessionRunDir(session: string, env: Env = process.env): string {
  const base = secretRunDir(env)
  const top = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'agent-board') : join(base, '..')
  ownFolder(top)
  ownFolder(base)
  const dir = join(base, sessionFolder(session, hash))
  ownFolder(dir)
  return dir
}

/** A file written whole, 0600, beside its place and renamed in. */
function writePrivate(file: string, text: string): void {
  const part = `${file}.${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(part, text, { mode: 0o600, flag: 'wx' })
    if (POSIX) chmodSync(part, 0o600)
    renameSync(part, file)
  } finally {
    rmSync(part, { force: true })
  }
}

/** The session's env.sh with these secrets' export lines (none: emptied); its path. */
export function writeSessionEnv(session: string, secrets: readonly GivenSecret[], env: Env = process.env): string {
  const file = join(sessionRunDir(session, env), 'env.sh')
  writePrivate(file, exportLines(secrets))
  return file
}

/** The secret's value in a file of the session's own (0600), for a tool that reads one; its path. */
export function writeSessionFile(session: string, secret: GivenSecret, env: Env = process.env): string {
  const file = join(sessionRunDir(session, env), secret.name)
  writePrivate(file, secret.value)
  return file
}
