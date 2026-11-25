// What the board's update of itself (#617, services/self-update.ts) runs on this computer: git and
// bun in the plugin's folder, the installer, the copies of settings.json, wake's status, and the
// state file (<state>/self-update.json).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PLUGIN_REPO } from '../core/node-oneshot.ts'
import { shownProfiles } from '../core/profiles.ts'
import {
  FAIL_REASONS,
  firstLines,
  type PendingUpdate,
  SKIP_REASONS,
  shortSha,
  type UpdateRecord,
  type UpdateState,
} from '../core/self-update.ts'
import { wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import type { AdoptResult, GitResult, StepResult } from '../services/self-update.ts'
import { configFile, readConfigFile } from './config-file.ts'
import { ARCHIVE_COMMIT_FILE } from './git.ts'
import { isRecord, readJson, renameWithRetry, replaceFile } from './json-store.ts'
import { quiet } from './node-repo.ts'
import { stateDir } from './paths.ts'
import { run } from './process.ts'
import { inheritedProfileDir, loadProfiles } from './profiles.ts'
import { wakeAlive } from './wake-api.ts'
import { readWakeStatus } from './wake-files.ts'

export const selfUpdateFile = (): string => join(stateDir(), 'self-update.json')
const backupsDir = (): string => join(stateDir(), 'self-update', 'settings')
/** The dated copies of settings.json kept: the newest this many updates' worth. */
const KEEP_BACKUPS = 10
const INSTALL_MS = 10 * 60_000
const INSTALLER_MS = 3 * 60_000
const ADOPT_FETCH_MS = 120_000
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
/** How long the new board waits for wake to come back. */
const WAKE_BACK_MS = 90_000

const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : [])

function asRecord(v: unknown): UpdateRecord | undefined {
  if (!isRecord(v) || !num(v.at)) return undefined
  const outcome = v.outcome
  if (outcome !== 'current' && outcome !== 'updated' && outcome !== 'skipped' && outcome !== 'failed') return undefined
  const reason = [...SKIP_REASONS, ...FAIL_REASONS].find(r => r === v.reason)
  return {
    at: v.at,
    outcome,
    ...(reason && { reason }),
    ...(str(v.detail) && { detail: v.detail }),
    ...(str(v.branch) && { branch: v.branch }),
    ...(str(v.commit) && { commit: v.commit }),
    ...(str(v.from) && { from: v.from }),
    ...(str(v.to) && { to: v.to }),
    ...(Array.isArray(v.came) && { came: strings(v.came) }),
    ...(v.byHand === true && { byHand: true }),
  }
}

function asPending(v: unknown): PendingUpdate | undefined {
  if (!isRecord(v) || !num(v.at) || !str(v.from) || !str(v.to) || !str(v.branch)) return undefined
  return {
    at: v.at,
    from: v.from,
    to: v.to,
    branch: v.branch,
    installer: v.installer === true,
    came: strings(v.came),
    byHand: v.byHand === true,
    wake: v.wake === true,
  }
}

/** The state file as it is; an unreadable one reads as empty. */
export function readSelfUpdate(file = selfUpdateFile()): UpdateState {
  const raw = readJson(file, isRecord)
  if (!raw) return {}
  const last = asRecord(raw.last)
  const lastUpdate = asRecord(raw.lastUpdate)
  const pending = asPending(raw.pending)
  const failure = asRecord(raw.failure)
  const inst = raw.installing
  const installing =
    isRecord(inst) && num(inst.at) && Array.isArray(inst.files)
      ? { at: inst.at, files: strings(inst.files) }
      : undefined
  return {
    ...(last && { last }),
    ...(lastUpdate && { lastUpdate }),
    ...(pending && { pending }),
    ...(failure && { failure }),
    ...(installing && { installing }),
  }
}

export function saveSelfUpdate(state: UpdateState, file = selfUpdateFile()): void {
  mkdirSync(stateDir(), { recursive: true })
  replaceFile(file, `${JSON.stringify(state, null, 1)}\n`)
}

/**
 * git in `root`, never asking for anything (no terminal prompt, no credential manager window, ssh in
 * batch mode: a fetch that needs a login fails instead of waiting), without taking the index lock for
 * a read, and with paths unquoted (a name outside ASCII is matched as it is).
 */
const gitResultOf = (r: Awaited<ReturnType<typeof run>>): GitResult => ({
  ok: r.code === 0,
  out: r.stdout,
  err: r.stderr || (r.error && r.code !== 1 ? r.error.message : ''),
})

export async function gitIn(root: string, args: string[], timeout = 30_000): Promise<GitResult> {
  return gitResultOf(
    await run('git', ['-C', root, '--no-optional-locks', '-c', 'core.quotePath=false', ...args], {
      timeout,
      env: quiet(),
    }),
  )
}

/**
 * Turn an archive install (`.archive-commit`, no `.git`) into a git checkout of `repoUrl` at
 * `commit`, tracking `origin/main`. Staged in a temporary folder inside `root` and verified clean
 * against `commit` before `.git` is placed; any mismatch or failure cleans up and leaves `root`
 * untouched.
 */
export async function adoptArchive(root: string, commit: string, repoUrl = DEFAULT_PLUGIN_REPO): Promise<AdoptResult> {
  if (!COMMIT_RE.test(commit)) {
    return { ok: false, reason: 'archive', detail: `invalid commit in ${ARCHIVE_COMMIT_FILE}` }
  }
  const gitDir = join(root, '.git')
  if (existsSync(gitDir)) return { ok: true }

  let tmp = ''
  let placed = false
  const gitBare = async (args: string[], timeout = 30_000): Promise<GitResult> =>
    gitResultOf(
      await run('git', ['--git-dir', tmp, '--no-optional-locks', '-c', 'core.quotePath=false', ...args], {
        timeout,
        env: quiet(),
      }),
    )
  const gitWork = async (args: string[], timeout = 30_000): Promise<GitResult> =>
    gitResultOf(
      await run(
        'git',
        ['--git-dir', tmp, '--work-tree', root, '--no-optional-locks', '-c', 'core.quotePath=false', ...args],
        { timeout, env: quiet() },
      ),
    )
  const fail = (reason: 'fetch' | 'archive-dirty' | 'archive', r: GitResult | string): AdoptResult => ({
    ok: false,
    reason,
    detail: typeof r === 'string' ? r : firstLines(r.err || r.out) || 'git failed',
  })

  try {
    tmp = mkdtempSync(join(root, '.git-adopt-'))
    const init = gitResultOf(await run('git', ['init', '--bare', '--quiet', tmp], { timeout: 30_000, env: quiet() }))
    if (!init.ok) return fail('archive', init)
    const bare = await gitBare(['config', 'core.bare', 'false'])
    if (!bare.ok) return fail('archive', bare)
    const reflog = await gitBare(['config', 'core.logallrefupdates', 'true'])
    if (!reflog.ok) return fail('archive', reflog)
    const remote = await gitBare(['remote', 'add', 'origin', repoUrl])
    if (!remote.ok) return fail('archive', remote)
    const fetched = await gitBare(['fetch', '--quiet', 'origin'], ADOPT_FETCH_MS)
    if (!fetched.ok) return fail('fetch', fetched)
    const has = await gitBare(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
    if (!has.ok)
      return fail('archive', `commit ${shortSha(commit)} from ${ARCHIVE_COMMIT_FILE} was not found in ${repoUrl}`)
    const ref = await gitBare(['update-ref', 'refs/heads/main', commit])
    if (!ref.ok) return fail('archive', ref)
    const head = await gitBare(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    if (!head.ok) return fail('archive', head)
    const track = await gitBare(['branch', '--set-upstream-to=origin/main', 'main'])
    if (!track.ok) return fail('archive', track)
    const reset = await gitWork(['reset', '--mixed', '--quiet', commit])
    if (!reset.ok) return fail('archive', reset)
    const status = await gitWork(['status', '--porcelain', '--untracked-files=no'])
    if (!status.ok) return fail('archive', status)
    if (status.out.trim() !== '') return fail('archive-dirty', firstLines(status.out))
    if (!existsSync(gitDir)) {
      renameWithRetry(tmp, gitDir)
      placed = true
    }
    try {
      rmSync(join(root, ARCHIVE_COMMIT_FILE), { force: true })
      rmSync(join(root, '.archive-sha256'), { force: true })
    } catch {}
    return { ok: true }
  } catch (err) {
    return fail('archive', firstLines(err instanceof Error ? err.message : String(err)) || 'archive')
  } finally {
    if (!placed && tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {}
    }
  }
}

const stepOf = (r: Awaited<ReturnType<typeof run>>): StepResult => ({
  ok: r.code === 0,
  detail: `${r.stdout}\n${r.stderr}`.trim() || (r.error?.message ?? ''),
})

/** bun install with the lockfile as it is (never rewriting it: the checkout stays clean). */
export async function bunInstall(root: string): Promise<StepResult> {
  return stepOf(await run(process.execPath, ['install', '--frozen-lockfile'], { cwd: root, timeout: INSTALL_MS }))
}

/** The installer of the code now in `root`, with this board's environment (its profiles). */
export async function runInstaller(root: string): Promise<StepResult> {
  const script = join(root, 'src', 'entrypoints', 'install.ts')
  return stepOf(await run(process.execPath, [script], { cwd: root, timeout: INSTALLER_MS, env: { ...process.env } }))
}

const stamp = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * A dated copy of each shown profile's settings.json (<state>/self-update/settings/<date>/<profile>.json),
 * before the installer writes them; the newest KEEP_BACKUPS dates stay.
 */
export function backupSettings(now = new Date(), dir = backupsDir()): string[] {
  const to = join(dir, stamp(now))
  const written: string[] = []
  for (const p of shownProfiles(loadProfiles({ shownDir: inheritedProfileDir() }))) {
    const from = join(p.dir, 'settings.json')
    if (!existsSync(from)) continue
    mkdirSync(to, { recursive: true })
    const file = join(to, `${p.id.replace(/[^\w.-]/g, '_')}.json`)
    copyFileSync(from, file)
    written.push(file)
  }
  try {
    const dates = readdirSync(dir).sort()
    for (const old of dates.slice(0, Math.max(0, dates.length - KEEP_BACKUPS)))
      rmSync(join(dir, old), { recursive: true, force: true })
  } catch {}
  return written
}

const wakeOn = (): boolean => wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })
const wakePort = (): number => readWakeStatus()?.port ?? wakeConfig(readConfigFile()?.wake).port

/** Wake is switched on, runs and answers. */
export async function wakeUp(): Promise<boolean> {
  if (!wakeOn() || readWakeStatus()?.state !== 'running') return false
  return wakeAlive(wakePort(), 5000)
}

/** Wake runs again after `since` (its status rewritten since then) and answers; waited for up to 90 s. */
export async function wakeBack(since: number, waitMs = WAKE_BACK_MS, pauseMs = 2000): Promise<boolean> {
  const end = Date.now() + waitMs
  for (;;) {
    const s = readWakeStatus()
    if (s?.state === 'running' && s.at >= since && (await wakeAlive(wakePort(), 5000))) return true
    if (Date.now() >= end) return false
    await new Promise(r => setTimeout(r, pauseMs))
  }
}
