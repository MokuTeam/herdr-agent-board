// Git, read-only: the checkout a folder is in, and a bounded view of its changes.
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { repoAddress } from '../core/portable.ts'
import { run } from './process.ts'

const LIMIT = 256 * 1024

interface GitOutput {
  text: string
  truncated: boolean
}

export type CheckoutChanges =
  | { available: false }
  | {
      available: true
      root: string
      branch: string
      status: string
      diff: string
      truncated: boolean
      collectedAt: number
    }

function git(cwd: string, args: string[]): Promise<GitOutput> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      [
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        cwd,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: LIMIT,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_PAGER: '' },
      },
      (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return fail(new Error('Git checkout unavailable'))
        done({ text: String(stdout).slice(0, LIMIT), truncated: !!err })
      },
    )
  })
}

/** A bounded, read-only view of the checkout containing the session's cwd. */
export async function checkoutChanges(cwd: unknown): Promise<CheckoutChanges> {
  if (!cwd || typeof cwd !== 'string') return { available: false }
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).text.trim()
    if (!top) return { available: false }
    const root = resolve(top) // git says C:/x on Windows; the rest of the board writes C:\x
    // allSettled: every git run is over before this returns, even when one failed early (a repo
    // with no commit yet), so none is left working in the folder.
    const runs = await Promise.allSettled([
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(root, ['status', '--porcelain=v1', '--untracked-files=normal']),
      git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--']),
    ])
    const [branch, status, diff] = runs
    if (branch.status !== 'fulfilled' || status.status !== 'fulfilled' || diff.status !== 'fulfilled')
      return { available: false }
    return {
      available: true,
      root,
      branch: branch.value.text.trim(),
      status: status.value.text,
      diff: diff.value.text,
      truncated: status.value.truncated || diff.value.truncated,
      collectedAt: Date.now(),
    }
  } catch {
    return { available: false }
  }
}

const known = new Map<string, { at: number; yes: boolean }>() // folder -> answer

/** Whether a folder sits in a git checkout; a minute per folder, since the session sheet asks on every open. */
export async function isCheckout(cwd: unknown): Promise<boolean> {
  if (!cwd || typeof cwd !== 'string') return false
  const hit = known.get(cwd)
  if (hit && Date.now() - hit.at < 60_000) return hit.yes
  let yes = false
  try {
    yes = !!(await git(cwd, ['rev-parse', '--show-toplevel'])).text.trim()
  } catch {}
  known.set(cwd, { at: Date.now(), yes })
  return yes
}

/** The git checkout a folder is in: { root, branch }, or null. */
export async function gitInfo(dir: string): Promise<{ root: string; branch: string } | null> {
  const r = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeout: 5000 })
  if (r.code !== 0) return null
  const [root, branch] = r.stdout.trim().split(/\r?\n/)
  return root ? { root: resolve(root), branch: branch ?? '' } : null
}

/** The commit a checkout is on, for a base when it has no branch (detached), or null. */
export async function headCommit(dir: string): Promise<string | null> {
  const r = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5000 })
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

/**
 * The main checkout of the repository `dir` belongs to (a linked worktree included), or null.
 * herdr links a worktree to the repository, not to the worktree it was made from, so this is
 * the folder a new worktree is created from and named after.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    timeout: 5000,
  })
  if (r.code !== 0) return null
  const common = resolve(r.stdout.trim())
  return /(^|[\\/])\.git$/.test(common) ? dirname(common) : null
}

/** git's answer, trimmed, or null when it fails (a ref that does not exist, no checkout). */
async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).text.trim()
  } catch {
    return null
  }
}

/** What the portability rule (core/portable.ts) reads of a checkout, without a fetch. */
export interface CheckoutFacts {
  root: string
  /** The remote HEAD's upstream is on, else `origin`, else the first; null when there is none. */
  remote: { name: string; url: string; address: string | null } | null
  /** No changes in the tree or the index, untracked files included. */
  clean: boolean
  /** HEAD equals its upstream as last fetched; false with no upstream or no commit. */
  headPushed: boolean
}

/** The remotes of a checkout, and the one a branch with no upstream would go to. */
async function remotes(root: string): Promise<{ names: string[]; fallback: string | null }> {
  const names = ((await gitLine(root, ['remote'])) ?? '').split(/\r?\n/).filter(Boolean)
  return { names, fallback: names.includes('origin') ? 'origin' : (names[0] ?? null) }
}

/** The facts of the checkout a folder is in, or null when it is in none. */
export async function checkoutFacts(dir: string): Promise<CheckoutFacts | null> {
  const top = await gitLine(dir, ['rev-parse', '--show-toplevel'])
  if (!top) return null
  const root = resolve(top)
  const [known, status, head, upstream, upstreamRef] = await Promise.all([
    remotes(root),
    git(root, ['status', '--porcelain=v1', '--untracked-files=normal']).catch(() => null),
    gitLine(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    gitLine(root, ['rev-parse', '--verify', '--quiet', '@{upstream}^{commit}']),
    gitLine(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']),
  ])
  if (!status) return null
  // refs/remotes/<remote>/<branch>; a remote's name may hold a slash, so the longest that fits.
  const tracked = upstreamRef?.startsWith('refs/remotes/')
    ? known.names.filter(n => upstreamRef.startsWith(`refs/remotes/${n}/`)).sort((a, b) => b.length - a.length)[0]
    : undefined
  const name = tracked ?? known.fallback
  const url = name ? await gitLine(root, ['remote', 'get-url', name]) : null
  return {
    root,
    remote: name && url ? { name, url, address: repoAddress(url) } : null,
    clean: !status.truncated && status.text.trim() === '',
    headPushed: !!head && head === upstream,
  }
}

/**
 * Whether a branch equals its remote branch, as last fetched: its upstream, or the same name on
 * the checkout's remote when it has none. A remote-tracking branch itself (`origin/main`) is on
 * the remote already. A branch on neither side: false.
 */
export async function branchPushed(dir: string, branch: string): Promise<boolean> {
  if (!branch) return false
  const local = await gitLine(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  if (!local) return !!(await gitLine(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${branch}^{commit}`]))
  let remote = await gitLine(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}@{upstream}^{commit}`])
  if (!remote) {
    const { fallback } = await remotes(dir)
    if (fallback)
      remote = await gitLine(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${fallback}/${branch}^{commit}`])
  }
  return !!remote && remote === local
}
