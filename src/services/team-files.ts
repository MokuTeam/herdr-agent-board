// Files in Team threads, the board's side of their bytes (#371). A post with a file (team-hub.ts)
// seals it (core/team-file.ts), keeps the sealed bytes on disk and hands them here: they go to the
// hub in chunks, at most BLOB_WINDOW in flight, and only when the hub says the blob is ready are the
// post's copies sent. A copy that came in with a file is fetched here, one file at a time, window
// by window: the hash checked against the signed one, the file key unwrapped with this board's box
// key, the bytes opened, and kept with the board's uploads, where the existing route shows images
// inline and offers anything else as a download. Nothing is opened, run or handed to a session.
// A broken connection starts both over on the next welcome: uploads where the hub stopped,
// downloads from the start.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { uploadsDir } from '../adapters/paths.ts'
import {
  audit,
  changeBlobs,
  dropSealed,
  type InboxItem,
  type InFile,
  type OutBlob,
  readAllInbox,
  readBlobs,
  readBoxKey,
  readSealed,
  setInFile,
} from '../adapters/team-store.ts'
import { BLOB_CHUNK, BLOB_WINDOW, b64u, type ErrorCode, type FileRef, type Frame, unb64u } from '../core/team.ts'
import { unwrapSecret } from '../core/team-box.ts'
import { type FileMeta, fileContext, openFile, openMeta } from '../core/team-file.ts'
import { safeName } from '../core/upload-name.ts'

export interface FileTransferDeps {
  frame(f: Frame): void
  /** Whether the socket is up and authenticated. */
  authed(): boolean
  /** This board's peer id. */
  me(): string | null
  now(): number
  log(line: string): void
  changed(): void
  /** The copies of a post that waited for its blob: send them now. */
  release(blob: string): void
  /** The copies of a post whose blob the hub refused: settle them as refused with its code. */
  refuse(blob: string, code: ErrorCode): void
}

export interface FileTransfer {
  /** A blob to send, its record kept already: its sealed bytes are on disk; opened on the hub now or on the next welcome. */
  send(blob: OutBlob): void
  /** The socket is (back) up: uploads resume where the hub stopped, the next download starts. */
  welcome(): void
  /** A blob frame from the hub; false for any other. */
  frame(f: Frame): boolean
  /** An error the hub named with an id: true when it was a blob of ours, or the one being fetched. */
  error(id: string, code: ErrorCode): boolean
  /** Starts the next fetch, when none runs (a file came in, a key was trusted). */
  kick(): void
  /** How far a blob is, up or down, as a fraction; undefined when it is not moving now. */
  progress(blob: string): number | undefined
  /** Lets go of what is in memory; what is on disk stays for the next start. */
  stop(): void
}

/** Saves the bytes of a file that came in with the uploads; its path and the board's address for it. */
export function saveIncoming(bytes: Uint8Array, name: string, blob: string, now: Date): { path: string; url: string } {
  const day = now.toISOString().slice(0, 10)
  const stamp = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const dir = join(uploadsDir(), day)
  mkdirSync(dir, { recursive: true })
  // The blob's start keeps two files of one name in one second apart; safeName again keeps it the
  // name the uploads route serves.
  const file = safeName(`${stamp}-${blob.slice(0, 8)}-${safeName(name).slice(-100)}`)
  const path = join(dir, file)
  writeFileSync(path, bytes)
  return { path, url: `/uploads/${day}/${encodeURIComponent(file)}` }
}

interface Up {
  bytes: Uint8Array
  size: number
  /** The hub said where it stands since this socket opened it. */
  opened: boolean
  sent: number
  have: number
}

interface Down {
  peer: string
  id: string
  ref: FileRef
  secret: Uint8Array
  meta: FileMeta
  parts: Uint8Array[]
  have: number
  /** Where the last blob_get asked from. */
  asked: number
}

export function createFileTransfer(deps: FileTransferDeps): FileTransfer {
  const ups = new Map<string, Up>()
  let down: Down | null = null
  /** A fetch that is being started or finished (an await is under way). */
  let busy = false
  let gen = 0

  const settle = (id: string, change: Partial<OutBlob>) =>
    changeBlobs(all => {
      const b = Object.hasOwn(all, id) ? all[id] : undefined
      if (b) Object.assign(b, change, { at: deps.now() })
    })

  function open(b: OutBlob): void {
    const bytes = readSealed(b.id)
    if (!bytes || bytes.length !== b.size) {
      refused(b.id, 'no_blob')
      return
    }
    ups.set(b.id, { bytes, size: b.size, opened: false, sent: 0, have: 0 })
    deps.frame({ t: 'blob_open', id: b.id, size: b.size, hash: b.hash, to: b.to, ttl_s: b.ttl_s })
  }

  function pump(id: string, u: Up): void {
    while (u.sent < u.size && u.sent - u.have < BLOB_WINDOW * BLOB_CHUNK) {
      const data = u.bytes.subarray(u.sent, u.sent + BLOB_CHUNK)
      deps.frame({ t: 'blob_put', id, at: u.sent, data: b64u(data) })
      u.sent += data.length
    }
  }

  function refused(id: string, code: ErrorCode): void {
    ups.delete(id)
    settle(id, { state: 'refused', code })
    dropSealed(id)
    audit('file_refused', null, { blob: id, code })
    deps.log(`team: the hub refused a file (${code})`)
    deps.refuse(id, code)
    deps.changed()
  }

  /** The next file to fetch: one that came in, is not held back, and was not settled. */
  function nextPending(): { peer: string; item: InboxItem; ref: FileRef } | null {
    for (const [peer, list] of Object.entries(readAllInbox()))
      for (const item of list)
        if (!item.held && item.file?.state === 'pending' && item.file.ref) return { peer, item, ref: item.file.ref }
    return null
  }

  function failDown(peer: string, id: string, why: string): void {
    setInFile(peer, id, { state: 'failed', why })
    audit('file_failed', peer, { id, why })
    deps.log(`team: a file that came in did not arrive (${why})`)
    deps.changed()
  }

  /** Starts fetching the next file; true when one was settled on the way and another may follow. */
  async function start(mine: number): Promise<boolean> {
    const next = nextPending()
    const me = deps.me()
    const box = readBoxKey()
    if (!next || !me) return false
    const { peer, item, ref } = next
    const secret = box ? await unwrapSecret(ref.key, ref.eph, { peer: me, box }, fileContext(ref.blob)) : null
    const meta = secret ? await openMeta(ref.meta, secret, ref.blob) : null
    if (mine !== gen) return false
    if (!secret || !meta) {
      failDown(peer, item.id, 'key')
      return true
    }
    // The name and size show while the bytes come.
    setInFile(peer, item.id, { state: 'pending', ref, name: meta.name, type: meta.type, size: meta.size })
    deps.changed()
    down = { peer, id: item.id, ref, secret, meta, parts: [], have: 0, asked: 0 }
    deps.frame({ t: 'blob_get', id: ref.blob, at: 0 })
    return false
  }

  async function finish(d: Down, mine: number): Promise<void> {
    const bytes = new Uint8Array(Buffer.concat(d.parts))
    const opened = await openFile(d.ref, bytes, d.secret)
    if (mine !== gen) return
    if (!opened.ok) return failDown(d.peer, d.id, opened.why)
    let saved: { path: string; url: string }
    try {
      saved = saveIncoming(opened.bytes, opened.meta.name, d.ref.blob, new Date(deps.now()))
    } catch (err) {
      deps.log(`team: a file that came in could not be saved: ${err instanceof Error ? err.message : String(err)}`)
      return failDown(d.peer, d.id, 'disk')
    }
    const done: InFile = {
      state: 'ready',
      name: opened.meta.name,
      type: opened.meta.type,
      size: opened.meta.size,
      ...saved,
    }
    setInFile(d.peer, d.id, done)
    deps.frame({ t: 'blob_done', id: d.ref.blob })
    audit('file_in', d.peer, { id: d.id, blob: d.ref.blob, size: opened.meta.size })
    deps.changed()
  }

  function kick(): void {
    if (down || busy || !deps.authed()) return
    busy = true
    const mine = gen
    void start(mine)
      .catch(err => {
        deps.log(`team: ${err instanceof Error ? err.message : String(err)}`)
        return false
      })
      .then(again => {
        if (mine !== gen) return
        busy = false
        if (again) kick()
      })
  }

  function onData(f: Extract<Frame, { t: 'blob_data' }>): void {
    const d = down
    if (!d || f.id !== d.ref.blob || f.at !== d.have) return
    const bytes = unb64u(f.data)
    if (!bytes?.length || d.have + bytes.length > d.ref.size) {
      down = null
      failDown(d.peer, d.id, 'data')
      kick()
      return
    }
    d.parts.push(bytes)
    d.have += bytes.length
    if (d.have === d.ref.size) {
      down = null
      busy = true
      const mine = gen
      void finish(d, mine)
        .catch(err => deps.log(`team: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          if (mine !== gen) return
          busy = false
          kick()
        })
      return
    }
    if (d.have - d.asked >= BLOB_WINDOW * BLOB_CHUNK) {
      d.asked = d.have
      deps.frame({ t: 'blob_get', id: d.ref.blob, at: d.have })
    }
    deps.changed()
  }

  return {
    send(b) {
      if (deps.authed()) open(b)
    },
    welcome() {
      gen++
      ups.clear()
      down = null
      busy = false
      for (const b of readBlobs()) if (b.state === 'uploading') open(b)
      kick()
    },
    frame(f) {
      switch (f.t) {
        case 'blob_have': {
          const u = ups.get(f.id)
          if (!u) return true
          // The first answer since this socket opened it says where the hub stands (a resume).
          if (!u.opened || f.have > u.sent) {
            u.opened = true
            u.sent = f.have
          }
          u.have = f.have
          pump(f.id, u)
          deps.changed()
          return true
        }
        case 'blob_ready': {
          if (!ups.delete(f.id) && !readBlobs().some(b => b.id === f.id && b.state === 'uploading')) return true
          settle(f.id, { state: 'up' })
          dropSealed(f.id)
          audit('file_up', null, { blob: f.id })
          deps.release(f.id)
          deps.changed()
          return true
        }
        case 'blob_data':
          onData(f)
          return true
        default:
          return false
      }
    },
    error(id, code) {
      if (ups.has(id) || readBlobs().some(b => b.id === id && b.state === 'uploading')) {
        refused(id, code)
        return true
      }
      const d = down
      if (d && d.ref.blob === id) {
        down = null
        failDown(d.peer, d.id, code)
        kick()
        return true
      }
      return false
    },
    kick,
    progress(blob) {
      const u = ups.get(blob)
      if (u) return u.size ? u.have / u.size : 0
      if (down && down.ref.blob === blob) return down.have / down.ref.size
      return undefined
    },
    stop() {
      gen++
      ups.clear()
      down = null
      busy = false
    },
  }
}
