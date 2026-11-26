// This computer's side of the functions registry's sync (#864, core/fn-sync.ts): what its MokuTab
// functions folder is (a repository, its branch and commit, its changes not committed), a bundle of
// its commits for the master, and the master's commits taken by a fast-forward only. A node answers
// these on its door (server/routes/node.ts); the master asks its own folder the same way.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bundleOf, cloneInto, fastForward, hasRepo, headFromFiles, repoLook } from '../../adapters/fn-git.ts'
import type { FnLook } from '../../core/fn-sync.ts'

/**
 * The functions folder as MokuTab finds it: `MOKUTAB_FN_DIR` when set, else `<data dir>/functions`, the
 * data dir being `MOKUTAB_DATA_DIR` or `~/.mokutab`. A MokuTab 1.x machine not yet moved over still
 * keeps them in `~/.workatomcp/functions`: that one, while `~/.mokutab/functions` is not there.
 */
export function functionsDir(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  const fn = env.MOKUTAB_FN_DIR?.trim()
  if (fn) return fn
  const data = env.MOKUTAB_DATA_DIR?.trim()
  if (data) return join(data, 'functions')
  const dir = join(home, '.mokutab', 'functions')
  const legacy = join(home, '.workatomcp', 'functions')
  return !exists(dir) && exists(legacy) ? legacy : dir
}

/** MokuTab's own lock on the folder: its saves hold it, and so does the board while it fast-forwards. */
export const FN_SAVE_LOCK = '.fn-save.lock'
/** MokuTab deletes a lock older than this as left behind; the board keeps its hold well under it. */
const LOCK_STALE_MS = 60_000
const LOCK_TOUCH_MS = 20_000

/**
 * `fn` while holding `<dir>/.fn-save.lock` the way MokuTab's bridge does: made with an exclusive
 * create, our pid in it, removed after. A lock younger than 60 s is MokuTab's save in progress: the
 * board never takes it over and answers `busy`, to come back next time; an older one was left behind
 * and goes. A hold that runs long is touched, so the bridge never reads it as stale.
 */
export async function withFnSaveLock<T>(
  dir: string,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T | 'busy'> {
  const path = join(dir, FN_SAVE_LOCK)
  const mark = `agent-board ${process.pid} ${now()}`
  const grab = (): boolean => {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, mark)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      return false
    }
  }
  let held = grab()
  if (!held) {
    try {
      if (now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return 'busy'
      unlinkSync(path)
    } catch {}
    held = grab()
    if (!held) return 'busy'
  }
  const touch = setInterval(() => {
    try {
      const t = new Date(now())
      utimesSync(path, t, t)
    } catch {}
  }, LOCK_TOUCH_MS)
  try {
    return await fn()
  } finally {
    clearInterval(touch)
    try {
      // Only our own: a lock that went stale under us and was taken by a save stays the save's.
      if (readFileSync(path, 'utf8') === mark) unlinkSync(path)
    } catch {}
  }
}

export type FnTaken = { ok: true; head: string } | { ok: false; why: string }

export interface NodeFunctions {
  readonly dir: string
  look(): Promise<FnLook>
  /** A bundle of its branch without the commits `have` names (those it knows); null when there is none. */
  bundle(have: readonly string[]): Promise<Uint8Array | null>
  /** The master's commits: a fast-forward from `expect` (an empty folder: a checkout of them). */
  take(bytes: Uint8Array, branch: string, expect: string | null): Promise<FnTaken>
  /** A stamp of the folder's branch and commit for the node's status, read with no git run; undefined without the folder. */
  stamp(): string | undefined
}

export interface NodeFunctionsDeps {
  dir: string
  /** Runs `fn` while MokuTab's own saves wait, or says `busy`; by default its `.fn-save.lock` in the folder. */
  locked?<T>(fn: () => Promise<T>): Promise<T | 'busy'>
  log?(text: string): void
}

const folderState = (dir: string): 'none' | 'empty' | 'files' => {
  try {
    if (!statSync(dir).isDirectory()) return 'none'
    // MokuTab's lock alone (a save starting in an empty folder) is no content.
    return readdirSync(dir).some(n => n !== FN_SAVE_LOCK) ? 'files' : 'empty'
  } catch {
    return 'none'
  }
}

export function createNodeFunctions(d: NodeFunctionsDeps): NodeFunctions {
  const locked = d.locked ?? (<T>(fn: () => Promise<T>): Promise<T | 'busy'> => withFnSaveLock(d.dir, fn))
  return {
    dir: d.dir,
    async look() {
      const st = folderState(d.dir)
      if (st !== 'files') return { state: st }
      if (!hasRepo(d.dir)) return { state: 'not-repo' }
      const r = await repoLook(d.dir)
      return r ? { state: 'repo', ...r } : { state: 'not-repo' }
    },
    async bundle(have) {
      const r = await repoLook(d.dir)
      return r ? bundleOf(d.dir, r.branch, have) : null
    },
    async take(bytes, branch, expect) {
      if (folderState(d.dir) === 'none') return { ok: false, why: 'changed' }
      const got = await locked(async (): Promise<FnTaken> => {
        const st = folderState(d.dir)
        if (expect === null) {
          if (st !== 'empty') return { ok: false, why: 'changed' }
          const r = await cloneInto(d.dir, bytes, branch)
          const head = r.ok ? (await repoLook(d.dir))?.head : undefined
          return head ? { ok: true, head } : { ok: false, why: r.why ?? 'git' }
        }
        const r = await fastForward(d.dir, bytes, branch, expect)
        if (!r.ok) d.log?.(`functions sync: not taken here (${r.why})`)
        return r
      })
      return got === 'busy' ? { ok: false, why: 'busy' } : got
    },
    stamp() {
      const st = folderState(d.dir)
      if (st === 'none') return undefined
      const h = headFromFiles(d.dir)
      return createHash('sha256')
        .update(h ? `${h.branch}\n${h.head}` : st)
        .digest('hex')
    },
  }
}
