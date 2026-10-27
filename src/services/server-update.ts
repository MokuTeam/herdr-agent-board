// `board update [--ref <ref>]` on a server the board was installed on (core/server-install.ts,
// call 10), as the board's user: the ref its code came from fetched again (or the one given), the
// checkout moved to it in place, its packages and the board's install action run again; run.ts
// restarts the board when its code changes. After an install from a pack of a local checkout
// (path B), it refuses without a ref. Where the code came from is in the user's source.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, ROOT } from '../adapters/paths.ts'
import { t } from '../core/lang.ts'
import { SOURCE_FILE, sourceOf, updateRef } from '../core/server-install.ts'
import { shQuote } from '../core/server-shell.ts'
import { syncInto } from './server-install.ts'

const TRIES = Math.max(1, Math.min(50, Number(process.env.BOARD_INSTALL_TRIES) || 3))

async function sh(script: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['sh', '-c', script], { cwd: ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: `${out}${err}` }
}

async function tried(script: string): Promise<{ code: number; out: string }> {
  let r = { code: 1, out: '' }
  for (let i = 0; i < TRIES; i++) {
    r = await sh(script)
    if (r.code === 0) return r
    await Bun.sleep(2000)
  }
  return r
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

export async function update(args: readonly string[]): Promise<number> {
  const at = args.indexOf('--ref')
  const ref = at >= 0 ? (args[at + 1] ?? '') : null
  let saved: unknown = null
  try {
    saved = JSON.parse(readFileSync(join(configDir(), SOURCE_FILE), 'utf8'))
  } catch {}
  const source = sourceOf(saved)
  const to = updateRef(source, ref)
  if ('error' in to) {
    console.error(to.error)
    return 1
  }
  const dir = ROOT
  const d = shQuote(dir)
  const git = existsSync(join(dir, '.git'))
  if (git) {
    const dirty = await sh(`git -C ${d} status --porcelain --untracked-files=no`)
    if (dirty.code !== 0 || dirty.out.trim()) {
      console.error(t('update.changes', { dir }))
      return 1
    }
  }
  console.log(t('update.fetching', { ref: to.ref, repo: to.repo }))
  const repo = shQuote(to.repo)
  const r = shQuote(to.ref)
  let fetched: { code: number; out: string }
  if (git) {
    fetched = await tried(
      `git -C ${d} remote set-url origin ${repo} 2>/dev/null || git -C ${d} remote add origin ${repo}; git -C ${d} fetch -q --depth 1 origin ${r}`,
    )
    if (fetched.code !== 0) {
      console.error(t('update.failed', { why: lastLine(fetched.out) }))
      return 1
    }
    const [now, next] = await Promise.all([sh(`git -C ${d} rev-parse HEAD`), sh(`git -C ${d} rev-parse FETCH_HEAD`)])
    const commit = next.out.trim()
    if (now.out.trim() === commit && source?.kind === 'git' && source.ref === to.ref && source.repo === to.repo) {
      console.log(t('update.same', { ref: to.ref, commit: commit.slice(0, 7) }))
      return 0
    }
    const moved = await sh(`git -C ${d} checkout -q --detach FETCH_HEAD`)
    if (moved.code !== 0) {
      console.error(t('update.failed', { why: lastLine(moved.out) }))
      return 1
    }
  } else {
    // a pack's checkout, no git: the ref cloned beside it, then written over it in place
    const tmp = shQuote(`${dir}.new`)
    fetched = await tried(
      `rm -rf ${tmp} && git init -q ${tmp} && git -C ${tmp} remote add origin ${repo} && git -C ${tmp} fetch -q --depth 1 origin ${r} && git -C ${tmp} checkout -q --detach FETCH_HEAD`,
    )
    if (fetched.code !== 0) {
      console.error(t('update.failed', { why: lastLine(fetched.out) }))
      return 1
    }
    const synced = await sh(`${syncInto(`${dir}.new`, dir)} && rm -rf ${tmp}`)
    if (synced.code !== 0) {
      console.error(t('update.failed', { why: lastLine(synced.out) }))
      return 1
    }
  }
  const commit = (await sh(`git -C ${d} rev-parse HEAD`)).out.trim()
  const bun = shQuote(process.execPath)
  for (const step of [`${bun} install --production`, `${bun} src/entrypoints/install.ts`]) {
    const done = step.includes('install --production') ? await tried(step) : await sh(step)
    if (done.code !== 0) {
      console.error(t('update.failed', { why: lastLine(done.out) }))
      return 1
    }
  }
  writeFileSync(
    join(configDir(), SOURCE_FILE),
    `${JSON.stringify({ kind: 'git', repo: to.repo, ref: to.ref, commit }, null, 2)}\n`,
  )
  console.log(t('update.done', { ref: to.ref, commit: commit.slice(0, 7) }))
  return 0
}
