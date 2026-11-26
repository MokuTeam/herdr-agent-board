// This computer's side of the functions registry's sync (#864, core/fn-sync.ts): what its MokuTab
// functions folder is (a repository, its branch and commit, its changes not committed), a bundle of
// its commits for the master, and the master's commits taken by a fast-forward only. A node answers
// these on its door (server/routes/node.ts); the master asks its own folder the same way.
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bundleOf, cloneInto, fastForward, hasRepo, headFromFiles, repoLook } from '../../adapters/fn-git.ts'
import type { FnLook } from '../../core/fn-sync.ts'

/** The functions folder: `<MOKUTAB_DATA_DIR or ~/.mokutab>/functions`. */
export function functionsDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const data = env.MOKUTAB_DATA_DIR?.trim()
  return join(data || join(home, '.mokutab'), 'functions')
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
  /** Runs `fn` while MokuTab's own saves wait (its lock), when there is one. */
  locked?<T>(fn: () => Promise<T>): Promise<T>
  log?(text: string): void
}

const folderState = (dir: string): 'none' | 'empty' | 'files' => {
  try {
    if (!statSync(dir).isDirectory()) return 'none'
    return readdirSync(dir).length ? 'files' : 'empty'
  } catch {
    return 'none'
  }
}

export function createNodeFunctions(d: NodeFunctionsDeps): NodeFunctions {
  const locked = d.locked ?? (<T>(fn: () => Promise<T>): Promise<T> => fn())
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
    take(bytes, branch, expect) {
      return locked(async () => {
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
