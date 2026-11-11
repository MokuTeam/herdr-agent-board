// A file sealed for a thread's boards (#371, core/team-box.ts): a random 32-byte file key per file,
// two AES-256-GCM keys from it with HKDF (one for the bytes, one for the name, type and size), and
// the file key wrapped per board. The blob the hub keeps is the sealed bytes; the signed message
// carries its SHA-256, the sealed meta and the wrapped key, so the hub reads no name, no type and
// no byte of it. One shot over the whole file: 25 MB fits in memory, as the board's uploads do.
import { concat, hkdf, open, randomBytes, seal } from './team-box.ts'
import { b64u, hasUnprintable, unb64u } from './team.ts'
import { MAX_FILE_NAME } from './team-wire.ts'

/** What a file is, as only its boards read it. */
export interface FileMeta {
  name: string
  type: string
  size: number
}

export interface SealedFile {
  /** The sealed bytes: what the hub keeps. */
  blob: Uint8Array
  /** SHA-256 of the blob, base64url. */
  hash: string
  /** The sealed meta, base64url. */
  meta: string
  /** The file key, to wrap for each board (and to forget after). */
  secret: Uint8Array
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const label = (what: 'data' | 'meta', blob: string): Uint8Array => enc(`hab-team/1 file-${what}\n${blob}`)
const EMPTY = new Uint8Array(0)

/** What a file key is wrapped for (team-box.ts wrapSecret's context): this blob. */
export const fileContext = (blob: string): string => `file\n${blob}`

export async function sha256(bytes: Uint8Array): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)))
}

/** The two keys of a file key: one for its bytes, one for its meta, each bound to the blob's id. */
async function keysOf(secret: Uint8Array, blob: string): Promise<{ data: Uint8Array; meta: Uint8Array }> {
  return { data: await hkdf(secret, EMPTY, label('data', blob)), meta: await hkdf(secret, EMPTY, label('meta', blob)) }
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/

/** A file's meta as a board takes it: a printable name of 1 to MAX_FILE_NAME characters, a media type, a size. */
export function checkMeta(v: unknown): FileMeta | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const m = v as Record<string, unknown>
  if (Object.keys(m).length !== 3) return null
  const { name, type, size } = m
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_FILE_NAME || hasUnprintable(name)) return null
  if (name.trim() !== name || /[\\/]/.test(name)) return null
  if (typeof type !== 'string' || !MIME.test(type)) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
  return { name, type, size }
}

/** What a test fixes for its known answers. */
export interface SealFixed {
  secret?: Uint8Array
  dataNonce?: Uint8Array
  metaNonce?: Uint8Array
}

/** Seals a file for the blob `blob`: its bytes and its meta, under a new file key. */
export async function sealFile(bytes: Uint8Array, meta: FileMeta, blob: string, fixed: SealFixed = {}): Promise<SealedFile> {
  const checked = checkMeta(meta)
  if (!checked || checked.size !== bytes.length) throw new TypeError('sealFile: a meta that does not fit the file')
  const secret = fixed.secret ?? randomBytes(32)
  const keys = await keysOf(secret, blob)
  const sealed = await seal(keys.data, bytes, label('data', blob), fixed.dataNonce)
  const metaJson = enc(JSON.stringify({ name: checked.name, type: checked.type, size: checked.size }))
  const metaSealed = await seal(keys.meta, metaJson, label('meta', blob), fixed.metaNonce)
  return { blob: sealed, hash: await sha256(sealed), meta: b64u(metaSealed), secret }
}

/** The meta of a file, or null when it does not open with this key or is no meta. */
export async function openMeta(meta: string, secret: Uint8Array, blob: string): Promise<FileMeta | null> {
  const sealed = unb64u(meta)
  if (!sealed) return null
  const plain = await open((await keysOf(secret, blob)).meta, sealed, label('meta', blob))
  if (!plain) return null
  try {
    return checkMeta(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)))
  } catch {
    return null
  }
}

export type Opened = { ok: true; bytes: Uint8Array; meta: FileMeta } | { ok: false; why: 'hash' | 'key' | 'data' }

/**
 * Opens a fetched blob: its SHA-256 must be the signed one, its meta must open with the file key,
 * its bytes too, and their length must be the meta's size. `key`: the meta or the file key is
 * wrong; `data`: the bytes are not what was sealed.
 */
export async function openFile(
  ref: { blob: string; hash: string; meta: string },
  bytes: Uint8Array,
  secret: Uint8Array,
): Promise<Opened> {
  if ((await sha256(bytes)) !== ref.hash) return { ok: false, why: 'hash' }
  const meta = await openMeta(ref.meta, secret, ref.blob)
  if (!meta) return { ok: false, why: 'key' }
  const plain = await open((await keysOf(secret, ref.blob)).data, bytes, label('data', ref.blob))
  if (!plain || plain.length !== meta.size) return { ok: false, why: 'data' }
  return { ok: true, bytes: plain, meta }
}

/** The blob's bytes as frames carry them, BLOB_CHUNK at a time from `at`. */
export const chunkOf = (blob: Uint8Array, at: number, n: number): string => b64u(blob.subarray(at, at + n))

/** The parts one after the other, for a blob fetched in chunks. */
export const joinChunks = (parts: Uint8Array[]): Uint8Array => concat(...parts)
