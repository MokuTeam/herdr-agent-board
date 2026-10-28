// The profile sync's program on the server (the board-on-own-server spec's "Next step: syncing
// the Claude profiles"), run as the board's user by core/profile-sync/remote.ts over the local
// board's admin login: one op, its request the first frame on stdin, its answer in frames on
// stdout, both gzipped (adapters/profile-sync.ts). Nothing else is written to stdout.
//
//   profile-sync.ts scan     → {t:'manifest'}, the Manifest as its body
//   profile-sync.ts pack     → {t:'file', profile, from, to, merge, hash, found} and the file, …, {t:'end'}
//   profile-sync.ts apply    ← {t:'file', profile, to, merge} and the file, …, {t:'end'}
//                            → {t:'progress', files, bytes}, …, {t:'done', created, install}
//   profile-sync.ts record   → {t:'done'}
//
// A failure: {t:'error', message}, exit 1. A profile made by apply gets the board's hooks: the
// board's install action runs once, as on the server's install.
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { isRecord } from '../adapters/json-store.ts'
import { ROOT } from '../adapters/paths.ts'
import {
  type Frame,
  type FrameSink,
  frameSink,
  framesOf,
  openTarget,
  prepare,
  recordSynced,
  scanSide,
  sideProfiles,
} from '../adapters/profile-sync.ts'
import type { Move } from '../core/profile-sync/paths.ts'
import { type ProfilePlan, profileDir, type Same } from '../core/profile-sync/plan.ts'
import type { CarryTo } from '../core/profile-sync/secrets.ts'

/** What this program speaks: a request of another version is refused. */
export const SYNC_VERSION = 1

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : [])

/** This side: its home and system, and the board's install action (run once a profile was made). */
export interface Here {
  home: string
  platform: string
  install(dirs: readonly string[]): boolean
}

/** How this side sends to the other (its system and home in the request), from here. */
const carryTo = (here: Here, v: unknown): CarryTo | null =>
  isRecord(v) && typeof v.platform === 'string' && typeof v.home === 'string'
    ? { platform: v.platform, from: here.platform, fromHome: here.home, toHome: v.home }
    : null

async function scan(here: Here, out: FrameSink, req: Record<string, unknown>): Promise<void> {
  const m = await scanSide({
    home: here.home,
    platform: here.platform,
    peer: text(req.peer),
    to: carryTo(here, req.to),
    clones: true,
  })
  await out.send({ t: 'manifest' }, Buffer.from(JSON.stringify(m), 'utf8'))
}

async function pack(here: Here, out: FrameSink, req: Record<string, unknown>): Promise<void> {
  const profiles = new Map(sideProfiles(here.home).map(p => [p.name, p]))
  const to = carryTo(here, req.to)
  if (!to) throw new Error('pack: no target named')
  const ctx = { to, moves: list(req.moves) as unknown as Move[] }
  for (const item of list(req.items)) {
    const p = profiles.get(text(item.profile))
    const ready = p ? prepare(p, text(item.from), ctx) : null
    await out.send(
      {
        t: 'file',
        profile: item.profile,
        from: item.from,
        to: item.to,
        merge: item.merge === true,
        gone: ready === null,
        hash: ready?.hash ?? null,
        found: ready?.found ?? {},
      },
      ready?.body ?? null,
    )
  }
  await out.send({ t: 'end' })
}

async function apply(
  here: Here,
  out: FrameSink,
  req: Record<string, unknown>,
  rest: AsyncGenerator<Frame>,
): Promise<void> {
  const target = openTarget({
    peer: text(req.peer),
    home: here.home,
    platform: here.platform,
    profiles: list(req.profiles) as unknown as ProfilePlan[],
  })
  for (const s of list(req.same) as unknown as Same[]) target.same(s.profile, s.to, s.there)
  for (const f of list(req.forget)) target.forget(text(f.profile), text(f.to))
  let files = 0
  let bytes = 0
  let said = Date.now()
  for await (const f of rest) {
    if (f.head.t === 'end') break
    if (f.head.t !== 'file') continue
    target.write(text(f.head.profile), text(f.head.to), f.body, f.head.merge === true)
    files++
    bytes += f.body.length
    if (Date.now() - said > 1000) {
      said = Date.now()
      await out.send({ t: 'progress', files, bytes })
    }
  }
  // the deletions ticked, once every file has come
  for (const d of list(req.deletions)) target.remove(text(d.profile), text(d.to))
  const { created } = target.finish()
  const install = created.length ? here.install(created.map(n => profileDir(here.home, n, here.platform))) : null
  await out.send({ t: 'done', files, bytes, created, install })
}

/** One op: its request and frames read from `input`, its answer written to `output`; the exit code. */
export async function serve(op: string, input: Readable, output: Writable, here: Here): Promise<number> {
  const out = frameSink(output)
  const frames = framesOf(input.pipe(createGunzip()))
  try {
    const first = await frames.next()
    const req = first.done ? null : first.value.head
    if (!req || req.op !== op || req.v !== SYNC_VERSION)
      throw new Error(`the board on this server speaks sync ${SYNC_VERSION}; it was asked ${String(req?.v)}`)
    if (op === 'scan') await scan(here, out, req)
    else if (op === 'pack') await pack(here, out, req)
    else if (op === 'apply') await apply(here, out, req, frames)
    else if (op === 'record') {
      recordSynced(
        text(req.peer),
        list(req.changes).map(c => ({
          profile: text(c.profile),
          rel: text(c.rel),
          hash: typeof c.hash === 'string' ? c.hash : null,
        })),
      )
      await out.send({ t: 'done' })
    } else throw new Error(`no op ${op}`)
    await out.end()
    return 0
  } catch (err) {
    await out.send({ t: 'error', message: err instanceof Error ? err.message : String(err) })
    await out.end()
    return 1
  }
}

/**
 * The board's install action, as the board's user, once per profile the sync made, with
 * CLAUDE_CONFIG_DIR pointing at it: the install shows the profile its env points to, so its hooks
 * go in, whatever the board's config shows (a profile found anew is added hidden there).
 */
function installAction(dirs: readonly string[]): boolean {
  let ok = true
  for (const dir of dirs) {
    const r = Bun.spawnSync([process.execPath, join(ROOT, 'src', 'entrypoints', 'install.ts')], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 5 * 60_000,
    })
    ok &&= r.exitCode === 0
  }
  return ok
}

if (import.meta.main)
  process.exitCode = await serve(process.argv[2] ?? '', process.stdin, process.stdout, {
    home: homedir(),
    platform: process.platform,
    install: installAction,
  })
