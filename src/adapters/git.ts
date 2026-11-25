// Git, read-only: the checkout a folder is in, and a bounded view of its changes.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type GitIdentity, identityOf } from '../core/git-access.ts'
import { ARCHIVE_COMMIT_FILE } from '../core/node-texts.ts'
import { repoAddress } from '../core/portable.ts'
import { run } from './process.ts'

export { ARCHIVE_COMMIT_FILE }

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

/** The most a plugin archive may be: the board's checkout is about 20 MB as a tar. */
const ARCHIVE_MOST = 256 * 1024 * 1024
const ARCHIVE_MS = 120_000

/**
 * The checkout at `commit` as one tar archive (`git archive`): the plugin "Add a server" sends
 * a node (#509, design 11.1 step 6), so the node's code is the master's code at its commit. null
 * when git fails or the archive is past 256 MB.
 */
export async function archiveCommit(dir: string, commit: string): Promise<Uint8Array | null> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return null
  try {
    const p = Bun.spawn(
      ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-C', dir, 'archive', '--format=tar', commit],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        windowsHide: true,
      },
    )
    // a git that hangs (a lock, a network filesystem) does not hold the form for good
    const timer = setTimeout(() => p.kill(), ARCHIVE_MS)
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of p.stdout) {
      size += chunk.length
      if (size > ARCHIVE_MOST) {
        p.kill()
        return null
      }
      chunks.push(chunk)
    }
    const code = await p.exited
    clearTimeout(timer)
    return code === 0 ? Buffer.concat(chunks) : null
  } catch {
    return null
  }
}

/**
 * The commit a plugin unpacked from such an archive was made at (core/node-texts.ts
 * ARCHIVE_COMMIT_FILE, written by the node's install): read only where git finds no checkout.
 */
export function archiveStamp(dir: string): string | null {
  try {
    const sha = readFileSync(join(dir, ARCHIVE_COMMIT_FILE), 'utf8').trim()
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null
  } catch {
    return null
  }
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
  /**
   * The remote HEAD's branch is pushed to (its upstream's, else `origin`, else the first); null
   * when there is none. The URL without a password; the address as core/portable.ts's repoAddress.
   */
  remote: { name: string; url: string; address: string | null } | null
  /** No changes in the tree or the index, untracked files included. */
  clean: boolean
  /** HEAD is a branch that equals its remote branch (see branchPushed); false detached or with no commit. */
  headPushed: boolean
}

interface Remotes {
  names: string[]
  /** Where a branch with no upstream on a remote goes: `origin`, else the first. */
  fallback: string | null
}

async function remotes(dir: string): Promise<Remotes> {
  const names = ((await gitLine(dir, ['remote'])) ?? '').split(/\r?\n/).filter(Boolean)
  return { names, fallback: names.includes('origin') ? 'origin' : (names[0] ?? null) }
}

/**
 * The commit of a local branch's remote branch, as last fetched, and the remote it is on: its
 * upstream when that is a remote-tracking branch (one tracking a local branch is not pushed
 * anywhere), else the same name on the fallback remote, which is what `git push origin <branch>`
 * without `-u` leaves. Null when neither exists.
 */
async function remoteBranch(
  dir: string,
  branch: string,
  known: Remotes,
): Promise<{ remote: string; commit: string } | null> {
  const up = await gitLine(dir, ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', `${branch}@{upstream}`])
  if (up?.startsWith('refs/remotes/')) {
    // refs/remotes/<remote>/<branch>; a remote's name may hold a slash, so the longest that fits.
    const remote = known.names.filter(n => up.startsWith(`refs/remotes/${n}/`)).sort((a, b) => b.length - a.length)[0]
    const commit = await gitLine(dir, ['rev-parse', '--verify', '--quiet', `${up}^{commit}`])
    if (remote && commit) return { remote, commit }
  }
  if (!known.fallback) return null
  const commit = await gitLine(dir, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/${known.fallback}/${branch}^{commit}`,
  ])
  return commit ? { remote: known.fallback, commit } : null
}

/**
 * A remote's URL as it may be shown and sent on. Over http and https the login goes whole, since a
 * token is often the user itself (`https://<token>@host/x`); over other schemes the user stays
 * (`ssh://git@host/x`) and only a password goes.
 */
function shownUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:]*):[^/@]*@/i, '$1@')
}

/** The facts of the checkout a folder is in, or null when it is in none. */
export async function checkoutFacts(dir: string): Promise<CheckoutFacts | null> {
  const top = await gitLine(dir, ['rev-parse', '--show-toplevel'])
  if (!top) return null
  const root = resolve(top)
  const [known, status, head, branch] = await Promise.all([
    remotes(root),
    git(root, ['status', '--porcelain=v1', '--untracked-files=normal']).catch(() => null),
    gitLine(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    gitLine(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ])
  if (!status) return null
  const pushed = head && branch ? await remoteBranch(root, branch, known) : null
  const name = pushed?.remote ?? known.fallback
  const url = name ? await gitLine(root, ['remote', 'get-url', name]) : null
  return {
    root,
    remote: name && url ? { name, url: shownUrl(url), address: repoAddress(url) } : null,
    clean: !status.truncated && status.text.trim() === '',
    headPushed: !!pushed && pushed.commit === head,
  }
}

/**
 * The author a commit made in this folder carries: `user.name` and `user.email` as git gives them
 * there, so its includes (`includeIf "gitdir:..."`) and the checkout's own config count (#611). null
 * when either is not set or does not fit (core/git-access.ts identityOf).
 */
export async function checkoutIdentity(dir: string): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([
    gitLine(dir, ['config', '--get', 'user.name']),
    gitLine(dir, ['config', '--get', 'user.email']),
  ])
  return identityOf(name, email)
}

/**
 * Whether a branch equals its remote branch, as last fetched (see remoteBranch). A
 * remote-tracking branch itself (`origin/main`) is on the remote already. A branch on neither
 * side: false.
 */
export async function branchPushed(dir: string, branch: string): Promise<boolean> {
  if (!branch) return false
  const local = await gitLine(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  if (!local) return !!(await gitLine(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${branch}^{commit}`]))
  const pushed = await remoteBranch(dir, branch, await remotes(dir))
  return pushed?.commit === local
}
