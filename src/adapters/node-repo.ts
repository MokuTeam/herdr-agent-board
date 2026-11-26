// A node's checkouts (#504, docs/design/nodes 6.4, 8.4): a start its master sends by a repository's
// address becomes a folder under `node.workRoot`. Cloned when missing, fetched, and moved to the
// branch the start asks for only when nothing of the node's own would be lost. Git's prompts are
// off: a node has nobody at its keyboard, and a remote that asks for a login is a refusal. The
// author the master's checkout gives goes into the checkout's own config, never the global one (#611).
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { type GitIdentity, identityOf } from '../core/git-access.ts'
import { repoAddress } from '../core/portable.ts'
import { run } from './process.ts'

/** A clone may take minutes; a fetch, a checkout and the questions far less. */
const CLONE_MS = 10 * 60_000
const FETCH_MS = 5 * 60_000
const ASK_MS = 15_000

/** Git's environment here: no prompt for a login, an ssh that asks nothing. */
export function quiet(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  }
}

/** What git said when it failed: its last line, short and printable. */
function said(r: { stderr: string; stdout: string; error: Error | null }): string {
  const lines = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? r.error?.message ?? 'git failed').replace(/\p{Cc}/gu, ' ').slice(0, 200)
}

/** Two paths name one folder: real paths, long names on Windows (a temp folder's 8.3 one), any case there. */
function sameFolder(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return resolve(p)
    }
  }
  const [x, y] = [real(a), real(b)]
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

async function git(dir: string, args: string[], timeout = ASK_MS): Promise<{ ok: boolean; out: string; why: string }> {
  const r = await run('git', ['-C', dir, ...args], { timeout, env: quiet() })
  return { ok: r.code === 0, out: r.stdout.trim(), why: r.code === 0 ? '' : said(r) }
}

export type RepoDone = { ok: true } | { ok: false; why: string }

/** `git clone` of `url` into `dir`, which must not be there yet. */
export async function cloneRepo(url: string, dir: string): Promise<RepoDone> {
  const r = await run('git', ['clone', '--quiet', '--', url, dir], { timeout: CLONE_MS, env: quiet() })
  return r.code === 0 ? { ok: true } : { ok: false, why: said(r) }
}

/** `git fetch` of the checkout's `origin`. */
export async function fetchRepo(dir: string): Promise<RepoDone> {
  const r = await git(dir, ['fetch', '--quiet', '--prune', 'origin'], FETCH_MS)
  return r.ok ? { ok: true } : { ok: false, why: r.why }
}

/** A checkout as a start needs to know it. */
export interface RepoState {
  /** The branch HEAD is on; '' when detached. */
  branch: string
  head: string
  /** No changes in the tree or the index, untracked files included. */
  clean: boolean
  /** The branch asked for, or the remote's default branch when none was. */
  ref: string
  /** The commit of `origin/<ref>` as fetched; '' when the remote has no such branch. */
  target: string
}

/** The state of the checkout at `dir`, or why it is not one: a folder that is no checkout's top is refused. */
export async function repoState(
  dir: string,
  ref: string,
): Promise<{ ok: true; state: RepoState } | { ok: false; why: string }> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !sameFolder(top.out, dir)) return { ok: false, why: 'not a checkout' }
  let want = ref
  if (!want) {
    const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    want = head.ok ? head.out.replace(/^origin\//, '') : ''
    if (!want) return { ok: false, why: 'no default branch' }
  }
  const [branch, head, status, target] = await Promise.all([
    git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
    git(dir, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${want}^{commit}`]),
  ])
  if (!status.ok) return { ok: false, why: status.why }
  return {
    ok: true,
    state: {
      branch: branch.ok ? branch.out : '',
      head: head.ok ? head.out : '',
      clean: status.out === '',
      ref: want,
      target: target.ok ? target.out : '',
    },
  }
}

/** `user.name` and `user.email` as git gives them in the checkout (its own config, then the global one), or null. */
export async function repoIdentity(dir: string): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([
    git(dir, ['config', '--get', 'user.name']),
    git(dir, ['config', '--get', 'user.email']),
  ])
  return identityOf(name.ok ? name.out : null, email.ok ? email.out : null)
}

/**
 * The identity into the checkout's own config (`--local`, which its worktrees share). A key set
 * there more than once is replaced whole. The name is put back when the email cannot be written, so
 * the clone is never left with half of each.
 */
export async function setRepoIdentity(dir: string, id: GitIdentity): Promise<RepoDone> {
  const set = (key: string, value: string) => git(dir, ['config', '--local', '--replace-all', '--', key, value])
  const before = await git(dir, ['config', '--local', '--get', 'user.name'])
  const name = await set('user.name', id.name)
  if (!name.ok) return { ok: false, why: name.why }
  const email = await set('user.email', id.email)
  if (email.ok) return { ok: true }
  await (before.ok ? set('user.name', before.out) : git(dir, ['config', '--local', '--unset-all', 'user.name']))
  return { ok: false, why: email.why }
}

/**
 * The folder of the worktree of the checkout at `dir` (its main one too) that has `branch` checked
 * out, or null when none has (#616): a moved session goes on in its branch wherever that is.
 */
export async function worktreeWith(dir: string, branch: string): Promise<string | null> {
  const r = await git(dir, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return null
  let at = ''
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}` && at) return at
  }
  return null
}

/**
 * A new worktree of the checkout at `dir` in `path` on `branch` (#616): the local branch when there
 * is one, else one made from `origin/<branch>` and tracking it, as `git worktree add <path> <branch>` does.
 */
export async function addWorktree(dir: string, path: string, branch: string): Promise<RepoDone> {
  const r = await git(dir, ['worktree', 'add', '--quiet', '--', path, branch], FETCH_MS)
  return r.ok ? { ok: true } : { ok: false, why: r.why }
}

/** Whether commit `a` is `b` or one of its ancestors (`git merge-base --is-ancestor`, #616): a fast-forward from a to b loses nothing. */
export async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
  return (await git(dir, ['merge-base', '--is-ancestor', a, b])).ok
}

/** The checkout's branch fast-forwarded to `origin/<branch>`; refused when it has commits of its own (#616). */
export async function fastForward(dir: string, branch: string): Promise<RepoDone> {
  const r = await git(dir, ['merge', '--ff-only', '--quiet', `refs/remotes/origin/${branch}`])
  return r.ok ? { ok: true } : { ok: false, why: r.why }
}

/** A clean checkout moved to `ref` (a local branch tracking `origin/<ref>` when it has none) and fast-forwarded to it. */
export async function moveTo(dir: string, state: RepoState): Promise<RepoDone> {
  if (state.branch !== state.ref) {
    const r = await git(dir, ['checkout', '--quiet', state.ref])
    if (!r.ok) return { ok: false, why: r.why }
  }
  const ff = await git(dir, ['merge', '--ff-only', '--quiet', `refs/remotes/origin/${state.ref}`])
  return ff.ok ? { ok: true } : { ok: false, why: ff.why }
}

/**
 * The main checkout the folder `dir` belongs to (through a linked worktree too) and the addresses
 * of its remotes as core/portable.ts repoAddress gives them, or null when it is in no checkout
 * with a work tree (#816). The remotes' URLs as the checkout's git config has them, before any `insteadOf`.
 */
export async function checkoutRemotes(dir: string): Promise<{ root: string; addresses: string[] } | null> {
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out) return null
  const at = resolve(common.out)
  if (!/(^|[\\/])\.git$/.test(at)) return null
  const root = dirname(at)
  const urls = await git(root, ['config', '--get-regexp', '^remote\\..*\\.url$'])
  const addresses = new Set<string>()
  for (const line of urls.ok ? urls.out.split(/\r?\n/) : []) {
    const url = line.slice(line.indexOf(' ') + 1)
    const address = line.includes(' ') ? repoAddress(url) : null
    if (address) addresses.add(address)
  }
  return { root, addresses: [...addresses] }
}

/**
 * A new worktree of the checkout at `dir` in `path` (#816), started from `base` (a commit or a
 * remote branch): on `branch` (the local one when there is one, else made from `base` without an
 * upstream, so a push never goes to `base`'s branch), or detached with no branch.
 */
export async function addWorktreeFrom(
  dir: string,
  path: string,
  branch: string | null,
  base: string,
): Promise<RepoDone> {
  let args: string[]
  if (!branch) args = ['worktree', 'add', '--quiet', '--detach', '--', path, base]
  else if ((await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok)
    args = ['worktree', 'add', '--quiet', '--', path, branch]
  else args = ['worktree', 'add', '--quiet', '--no-track', '-b', branch, '--', path, base]
  const r = await git(dir, args, FETCH_MS)
  return r.ok ? { ok: true } : { ok: false, why: r.why }
}
