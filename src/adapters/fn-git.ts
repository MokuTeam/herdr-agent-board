// Git for the MokuTab functions registry (#864): the folder is MokuTab's own git repository (every
// chrome_fn_save is a commit), and the master keeps a bare hub of it in the board's state. Commits
// travel between them as git bundles over the board's node link. Nothing here commits, rebases or
// resets a branch that has work on it: a machine only ever fast-forwards, with its tracked files clean.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitRun {
  code: number
  out: Uint8Array
  text: string
  err: string
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/
export const isSha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v)
/** A branch name the sync carries: plain, never an option or a range. */
export const isBranch = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(v) && !v.includes('..') && !v.endsWith('.lock')

/** git in `cwd` with no hooks, pager or prompt; `input` on stdin. Never throws for an exit code. */
export async function git(cwd: string, args: string[], input?: Uint8Array, timeoutMs = 60_000): Promise<GitRun> {
  const proc = Bun.spawn(
    ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
    {
      stdin: input ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', GIT_EXTERNAL_DIFF: '', LC_ALL: 'C' },
    },
  )
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const bytes = new Uint8Array(out)
    return { code, out: bytes, text: new TextDecoder().decode(bytes), err: err.slice(0, 2000) }
  } finally {
    clearTimeout(timer)
  }
}

const ok = async (cwd: string, args: string[], input?: Uint8Array): Promise<string> => {
  const r = await git(cwd, args, input)
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.err.split('\n')[0] ?? r.code}`)
  return r.text
}

/** `fn` with a bundle's bytes in a temp file, which goes after. */
async function withBundleFile<T>(bytes: Uint8Array, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'board-fn-'))
  const file = join(dir, 'in.bundle')
  try {
    writeFileSync(file, bytes, { mode: 0o600 })
    return await fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether `dir` holds a git repository of its own (a `.git` folder or file in it). */
export function hasRepo(dir: string): boolean {
  try {
    statSync(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * The checked-out branch and its commit, read from the files under `.git` with no git run (the
 * node's status asks every 30 s); null when it cannot be read that way (a worktree, a detached
 * HEAD, no commit yet).
 */
export function headFromFiles(dir: string): { branch: string; head: string } | null {
  try {
    const gitDir = join(dir, '.git')
    if (!statSync(gitDir).isDirectory()) return null
    const ref = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const m = /^ref: refs\/heads\/(.+)$/.exec(ref)
    if (!m?.[1]) return null
    const branch = m[1]
    try {
      const head = readFileSync(join(gitDir, 'refs', 'heads', ...branch.split('/')), 'utf8').trim()
      if (isSha(head)) return { branch, head }
    } catch {}
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(' ')
      if (name === `refs/heads/${branch}` && isSha(sha)) return { branch, head: sha }
    }
    return null
  } catch {
    return null
  }
}

/** The machine's side: branch, commit, and the tracked paths with changes not committed. */
export async function repoLook(dir: string): Promise<{ branch: string; head: string; dirty: string[] } | null> {
  const branch = (await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])).text.trim()
  const head = (await git(dir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).text.trim()
  if (!isBranch(branch) || !isSha(head)) return null
  const st = await git(dir, ['status', '--porcelain=v1', '--untracked-files=no'])
  if (st.code !== 0) return null
  const dirty = st.text
    .split('\n')
    .filter(Boolean)
    .map(l => l.slice(3))
  return { branch, head, dirty }
}

/** Whether `sha` is a commit this repository has. */
export const hasCommit = async (dir: string, sha: string): Promise<boolean> =>
  isSha(sha) && (await git(dir, ['cat-file', '-e', `${sha}^{commit}`])).code === 0

/** Whether `a` is an ancestor of `b` (or the same commit). */
export const isAncestor = async (dir: string, a: string, b: string): Promise<boolean> =>
  (await git(dir, ['merge-base', '--is-ancestor', a, b])).code === 0

/** A bundle of `branch` without what `have` already holds (those of them this repository knows). */
export async function bundleOf(dir: string, branch: string, have: readonly string[]): Promise<Uint8Array | null> {
  if (!isBranch(branch)) return null
  const known: string[] = []
  for (const h of have) if (await hasCommit(dir, h)) known.push(h)
  const r = await git(dir, ['bundle', 'create', '-', `refs/heads/${branch}`, ...known.map(h => `^${h}`)])
  return r.code === 0 && r.out.length ? r.out : null
}

/** A bundle's commits into `ref` of the repository (the hub, or the machine before its fast-forward). */
export async function fetchBundle(dir: string, bytes: Uint8Array, branch: string, ref: string): Promise<string> {
  return withBundleFile(bytes, async file => {
    await ok(dir, ['bundle', 'verify', '-q', file])
    await ok(dir, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', file, `+refs/heads/${branch}:${ref}`])
    return (await ok(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  })
}

/** The hub: a bare repository, made the first time. */
export async function hubInit(dir: string): Promise<void> {
  if ((await git(dir, ['rev-parse', '--is-bare-repository'])).text.trim() === 'true') return
  await ok(tmpdir(), ['init', '-q', '--bare', dir])
}

/** A ref's commit, or null. */
export async function refHead(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])
  const sha = r.text.trim()
  return r.code === 0 && isSha(sha) ? sha : null
}

export const setRef = (dir: string, ref: string, sha: string): Promise<string> => ok(dir, ['update-ref', ref, sha])
export const dropRef = async (dir: string, ref: string): Promise<void> => {
  await git(dir, ['update-ref', '-d', ref])
}

/** Every blob the commits `to` adds over `from` (null: all of `to`'s history), with its path and size. */
export async function newBlobs(
  dir: string,
  to: string,
  from: string | null,
): Promise<{ sha: string; path: string; size: number }[]> {
  const list = await ok(dir, ['rev-list', '--objects', to, ...(from ? [`^${from}`] : [])])
  const named = new Map<string, string>()
  for (const line of list.split('\n')) {
    const at = line.indexOf(' ')
    if (at > 0) named.set(line.slice(0, at), line.slice(at + 1))
  }
  if (!named.size) return []
  const check = await ok(
    dir,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    new TextEncoder().encode(`${[...named.keys()].join('\n')}\n`),
  )
  const out: { sha: string; path: string; size: number }[] = []
  for (const line of check.split('\n')) {
    const [sha, type, size] = line.split(' ')
    if (type === 'blob' && sha) out.push({ sha, path: named.get(sha) ?? '', size: Number(size) })
  }
  return out
}

export const blob = async (dir: string, sha: string): Promise<Uint8Array> => {
  const r = await git(dir, ['cat-file', 'blob', sha])
  if (r.code !== 0) throw new Error('git cat-file')
  return r.out
}

/** The tree of `commit`: how many files, how many bytes. */
export async function treeSize(dir: string, commit: string): Promise<{ files: number; bytes: number }> {
  const text = await ok(dir, ['ls-tree', '-r', '-l', commit])
  let files = 0
  let bytes = 0
  for (const line of text.split('\n')) {
    const m = /^\S+ blob \S+\s+(\d+)\t/.exec(line)
    if (m) {
      files++
      bytes += Number(m[1])
    }
  }
  return { files, bytes }
}

/**
 * The machine takes the bundle: its commits fetched beside the branch, then the branch fast-forwarded
 * to them, only when it still is at `expect` and its tracked files are clean. `why`: `changed` (it
 * moved meanwhile), `dirty`, `not-ff`, `git`.
 */
export async function fastForward(
  dir: string,
  bytes: Uint8Array,
  branch: string,
  expect: string,
): Promise<{ ok: true; head: string } | { ok: false; why: string }> {
  const look = await repoLook(dir)
  if (!look || look.branch !== branch || look.head !== expect) return { ok: false, why: 'changed' }
  if (look.dirty.length) return { ok: false, why: 'dirty' }
  try {
    const got = await fetchBundle(dir, bytes, branch, 'refs/board/incoming')
    if (!(await isAncestor(dir, expect, got))) return { ok: false, why: 'not-ff' }
    const r = await git(dir, ['merge', '-q', '--ff-only', got])
    if (r.code !== 0) return { ok: false, why: 'not-ff' }
    return { ok: true, head: got }
  } catch {
    return { ok: false, why: 'git' }
  } finally {
    await dropRef(dir, 'refs/board/incoming')
  }
}

/** An empty folder becomes a checkout of the bundle's branch. */
export async function cloneInto(
  dir: string,
  bytes: Uint8Array,
  branch: string,
): Promise<{ ok: boolean; why?: string }> {
  try {
    await ok(dir, ['init', '-q'])
    const got = await fetchBundle(dir, bytes, branch, 'refs/board/incoming')
    await ok(dir, ['checkout', '-q', '-B', branch, got])
    await dropRef(dir, 'refs/board/incoming')
    return { ok: true }
  } catch {
    return { ok: false, why: 'git' }
  }
}
