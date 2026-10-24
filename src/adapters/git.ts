// Git, read-only: the checkout a folder is in, and a bounded view of its changes.
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
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
