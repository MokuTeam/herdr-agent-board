// The board's update of itself from git (#617, core/self-update.ts decides): the web board's process
// checks when it is due or asked, fetches, and fast-forwards its checkout. Everything the old code
// needs is done before the merge: when package.json or bun.lock changed they are checked out from
// the upstream first and bun install runs while the old code still runs, so no .ts file changes and
// nothing restarts half installed. A pending record is written, then the merge. The merge rewrites
// files under src: run.ts restarts the board and wake-run.ts restarts wake, as on any code change
// (one code file is touched too, for a pull that changes only the page or the dependencies). The new
// board finishes the pending record at its start (resume): the installer when its inputs changed,
// with a dated copy of each settings.json first, then whether wake came back, then the record. A
// pending record that nobody finishes is a board that did not come back: Settings and board doctor
// say so in red.
import {
  afterFetch,
  autoUpdateConfig,
  BACK_MS,
  due,
  type FailReason,
  firstLines,
  lockChanges,
  type PendingUpdate,
  parseCounts,
  parseTitles,
  planFor,
  type SkipReason,
  shortSha,
  skipBefore,
  stalePending,
  TITLES_FORMAT,
  type UpdateRecord,
  type UpdateState,
} from '../core/self-update.ts'

export interface GitResult {
  ok: boolean
  out: string
  err: string
}

export interface StepResult {
  ok: boolean
  detail: string
}

export type AdoptResult = { ok: true } | { ok: false; reason: 'fetch' | 'archive-dirty' | 'archive'; detail: string }

export interface SelfUpdateDeps {
  /** git in the plugin's folder. */
  git(args: string[], timeoutMs?: number): Promise<GitResult>
  /** The plugin's folder has a .git of its own. */
  isCheckout(): boolean
  /** The commit stamp from `.archive-commit` when not a git checkout, or null. */
  archiveCommit?(): string | null
  /** Turn an archive install at `commit` into a clean git checkout tracking origin/main. */
  adoptArchive?(commit: string): Promise<AdoptResult>
  /** config.json has `node`: the board follows its master's commit (#590). */
  node(): boolean
  /** config.json's `autoUpdate` as it is now. */
  config(): unknown
  /** Something starts the board again when it ends (run.ts, over IPC). */
  canRestart: boolean
  /** A restart would hurt now (a launch in flight): what holds it, or null. */
  busy(): string | null
  /** bun install in the plugin's folder (the lockfile as it is). */
  install(): Promise<StepResult>
  /** entrypoints/install.ts of the code now in the folder. */
  installer(): Promise<StepResult>
  /** A dated copy of each shown profile's settings.json: the files written. */
  backupSettings(): string[]
  /** The board and wake restart on the code now in the folder (run.ts and wake-run.ts watch it). */
  restart(): void
  /** Wake runs and answers now. */
  wakeUp(): Promise<boolean>
  /** Wake came back after `since` (waits for it a while). */
  wakeBack(since: number): Promise<boolean>
  load(): UpdateState
  save(state: UpdateState): void
  /** One line in the board's log (web.log). */
  log(text: string): void
  now(): number
  /** The view changed: the board's payload goes out again. */
  changed?(): void
}

export type CheckResult = UpdateRecord & { restarting?: true }

export interface SelfUpdate {
  /** One check now: by hand (board update, Check now) or by the schedule. */
  check(o?: { byHand?: boolean }): Promise<CheckResult>
  /** At the board's start: a pending update is finished on the new code. */
  resume(): Promise<UpdateRecord | null>
  /** The schedule's tick: a check when one is due. */
  tick(): Promise<CheckResult | null>
  /** A check runs now. */
  running(): boolean
}

const FETCH_MS = 120_000

export function createSelfUpdate(d: SelfUpdateDeps): SelfUpdate {
  let running = false
  const startedAt = d.now()

  /** The state with `change` made to it, saved; the payload goes out again. */
  function update(change: (s: UpdateState) => void): void {
    const s = d.load()
    change(s)
    d.save(s)
    d.changed?.()
  }

  function record(r: UpdateRecord, o: { pending?: null; failure?: UpdateRecord | null } = {}): UpdateRecord {
    update(s => {
      s.last = r
      if (r.outcome === 'updated') {
        s.lastUpdate = r
        delete s.failure
      }
      if (o.pending === null) delete s.pending
      if (o.failure === null) delete s.failure
      else if (o.failure) s.failure = o.failure
    })
    return r
  }

  const head = async (ref = 'HEAD'): Promise<string> => {
    const r = await d.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return r.ok ? r.out.trim() : ''
  }

  /** Puts the lock files back as HEAD has them, and the dependencies with them. */
  async function putBack(files: string[], installed: boolean): Promise<void> {
    if (files.length) {
      const r = await d.git(['checkout', 'HEAD', '--', ...files])
      if (!r.ok) d.log(`self-update: could not put ${files.join(', ')} back: ${firstLines(r.err, 2)}`)
    }
    if (installed) {
      const again = await d.install()
      if (!again.ok)
        d.log(`self-update: bun install after putting the lock files back failed: ${firstLines(again.detail, 2)}`)
    }
    update(s => {
      delete s.installing
    })
  }

  /** Lock files a board that ended mid-install left taken from upstream: put back first. */
  async function mend(): Promise<void> {
    const left = d.load().installing
    if (!left || d.load().pending) return
    d.log(
      `self-update: putting back ${left.files.join(', ') || 'the dependencies'} left from an update that did not finish`,
    )
    await putBack(left.files, true)
  }

  /** The installer of the code now here, with a dated copy of each settings.json first; why it failed, or null. */
  async function install(): Promise<string | null> {
    let copies: string[]
    try {
      copies = d.backupSettings()
    } catch (err) {
      return `settings.json not copied: ${err instanceof Error ? err.message : String(err)}`
    }
    const r = await d.installer()
    if (!r.ok) return firstLines(r.detail) || 'the installer failed'
    for (const line of r.detail.split(/\r?\n/))
      if (line.includes(': not changed:')) d.log(`self-update: ${line.trim()}`)
    d.log(`self-update: the installer ran; settings.json copied to ${copies.join(', ') || 'nothing (none there)'}`)
    return null
  }

  async function finish(p: PendingUpdate): Promise<UpdateRecord> {
    const base = { at: d.now(), branch: p.branch, from: p.from, to: p.to, came: p.came, byHand: p.byHand }
    const fail = (reason: FailReason, detail: string, commit: string, keep: boolean): UpdateRecord => {
      d.log(
        `self-update: ${p.branch} ${shortSha(p.from)} -> ${shortSha(p.to)} failed (${reason}): ${firstLines(detail, 1)}`,
      )
      const r: UpdateRecord = { ...base, outcome: 'failed', reason, detail, commit }
      return record(r, { pending: null, ...(keep && { failure: r }) })
    }
    const now = await head()
    // On the merged commit, or past it (a pull by hand since): the board came back on it.
    const there = now === p.to || (!!now && (await d.git(['merge-base', '--is-ancestor', p.to, now])).ok)
    if (!there)
      return fail(
        now === p.from ? 'merge' : 'not-back',
        `the checkout is on ${shortSha(now) || 'no commit'}`,
        now,
        false,
      )
    if (p.installer) {
      const why = await install()
      if (why) return fail('installer', why, now, true)
    }
    if (p.wake && !(await d.wakeBack(p.at))) return fail('wake', '', now, true)
    d.log(
      `self-update: ${p.branch} ${shortSha(p.from)} -> ${shortSha(p.to)} done${p.came.length ? `: ${p.came.join('; ')}` : ''}`,
    )
    return record({ ...base, outcome: 'updated', commit: now }, { pending: null })
  }

  /** A check that finds the branch current mends what the last update left: the installer again, wake back. */
  async function mendFailure(): Promise<void> {
    const f = d.load().failure
    if (f?.reason === 'installer' && !(await install())) {
      d.log('self-update: the installer ran again and went through')
      update(s => {
        delete s.failure
      })
    } else if (f?.reason === 'wake' && (await d.wakeUp()))
      update(s => {
        delete s.failure
      })
  }

  async function check(byHand: boolean): Promise<CheckResult> {
    const at = d.now()
    const skip = (reason: SkipReason, more: Partial<UpdateRecord> = {}): UpdateRecord => {
      const r: UpdateRecord = { at, outcome: 'skipped', reason, ...more, ...(byHand && { byHand }) }
      d.log(`self-update: skipped (${reason})${more.detail ? `: ${firstLines(more.detail, 1)}` : ''}`)
      return record(r)
    }
    // A node takes its master's commit: nothing of git is asked.
    if (d.node()) return skip('node')
    const state = d.load()
    const pending = !!state.pending && !stalePending(state, at)
    if (!pending) await mend()
    let checkout = d.isCheckout()
    if (!checkout && !pending) {
      const stamp = d.archiveCommit?.() ?? null
      if (stamp) {
        if (!d.canRestart) return skip('restart', { commit: stamp })
        if (d.adoptArchive) {
          const adopted = await d.adoptArchive(stamp)
          if (!adopted.ok) return skip(adopted.reason, { commit: stamp, detail: adopted.detail })
          d.log(`self-update: turned archive install at ${shortSha(stamp)} into a git checkout`)
          checkout = true
        }
      }
    }
    const branchOf = checkout ? await d.git(['symbolic-ref', '--quiet', '--short', 'HEAD']) : null
    // symbolic-ref says nothing and ends with 1 on a detached HEAD; anything else is git failing
    if (branchOf && !branchOf.ok && branchOf.err.trim())
      return skip('no-checkout', { detail: firstLines(branchOf.err) })
    const branch = branchOf?.ok ? branchOf.out.trim() : null
    const upOf = branch ? await d.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) : null
    const upstream = upOf?.ok ? upOf.out.trim() : null
    const status = upstream ? await d.git(['status', '--porcelain', '--untracked-files=no']) : null
    const why = skipBefore({
      node: false,
      pending,
      checkout,
      branch,
      upstream,
      dirty: !!status && (!status.ok || status.out.trim() !== ''),
      canRestart: d.canRestart,
    })
    const on = branch ?? undefined
    if (why)
      return skip(why, {
        ...(on && { branch: on }),
        ...(why === 'dirty' && status && { detail: firstLines(status.ok ? status.out : status.err) }),
      })
    const b = branch as string
    const from = await head()
    const remote = (await d.git(['config', `branch.${b}.remote`])).out.trim() || 'origin'
    const fetched = await d.git(['fetch', '--quiet', remote], FETCH_MS)
    if (!fetched.ok) return skip('fetch', { branch: b, commit: from, detail: firstLines(fetched.err || fetched.out) })
    const counts = parseCounts((await d.git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).out)
    if (!counts) return skip('fetch', { branch: b, commit: from, detail: 'git rev-list did not count' })
    const where = afterFetch(counts.ahead, counts.behind)
    if (where === 'current') {
      await mendFailure()
      return record({ at, outcome: 'current', branch: b, commit: from, ...(byHand && { byHand }) })
    }
    if (where === 'diverged')
      return skip('diverged', { branch: b, commit: from, detail: `${counts.ahead} ahead, ${counts.behind} behind` })
    const to = await head('@{u}')
    const diff = await d.git(['diff', '--name-only', from, to])
    if (!to || !diff.ok)
      return skip('fetch', { branch: b, commit: from, detail: firstLines(diff.err) || 'git diff failed' })
    const changed = diff.out.split(/\r?\n/).filter(Boolean)
    const plan = planFor(changed)
    const holds = d.busy()
    if (holds) return skip('busy', { branch: b, commit: from, detail: holds })
    let locks: string[] = []
    if (plan.install) {
      const ns = await d.git(['diff', '--name-status', from, to, '--', 'package.json', 'bun.lock', 'packages'])
      if (!ns.ok) return skip('fetch', { branch: b, commit: from, detail: firstLines(ns.err) || 'git diff failed' })
      const lc = lockChanges(ns.out)
      if (lc === 'lockfiles') return skip('lockfiles', { branch: b, commit: from })
      locks = lc
    }
    const came = parseTitles(
      (await d.git(['log', '--first-parent', `--format=${TITLES_FORMAT}`, `${from}..${to}`])).out,
    )
    const base = { at, branch: b, from, to, came, ...(byHand && { byHand }) }
    const failed = (reason: FailReason, detail: string): UpdateRecord => {
      d.log(`self-update: ${b} ${shortSha(from)} -> ${shortSha(to)} failed (${reason}): ${firstLines(detail, 1)}`)
      return record({ ...base, outcome: 'failed', reason, detail, commit: from })
    }
    d.log(
      `self-update: ${b} ${shortSha(from)} -> ${shortSha(to)}: ${changed.length} files${plan.install ? ', bun install' : ''}`,
    )
    // The dependencies first, while the old code runs: no code file changes yet. What a board that
    // ends in between leaves is noted first, and put back by the next one (mend).
    let installed = false
    try {
      if (plan.install) {
        update(s => {
          s.installing = { at: d.now(), files: locks }
        })
        if (locks.length) {
          const co = await d.git(['checkout', to, '--', ...locks])
          if (!co.ok) {
            await putBack(locks, false)
            return failed('install', firstLines(co.err))
          }
        }
        const r = await d.install()
        installed = true
        if (!r.ok) {
          await putBack(locks, true)
          return failed('install', firstLines(r.detail))
        }
        // a session start that began while bun install ran would be cut short by the restart
        const late = d.busy()
        if (late) {
          await putBack(locks, true)
          return skip('busy', { branch: b, commit: from, detail: late })
        }
      }
      // Written before the merge, the clock from now: the board may be gone a moment after it.
      const p: PendingUpdate = {
        at: d.now(),
        from,
        to,
        branch: b,
        installer: plan.installer,
        came,
        byHand,
        // wake restarts only with the code; without a restart it is not waited for
        wake: plan.restart && (await d.wakeUp()),
      }
      update(s => {
        s.pending = p
        delete s.installing
      })
      const merged = await d.git(['merge', '--ff-only', '--quiet', to])
      if (!merged.ok) {
        update(s => {
          delete s.pending
        })
        await putBack(locks, installed)
        return failed('merge', firstLines(merged.err || merged.out))
      }
      if (!plan.restart) return finish(p)
      d.log(`self-update: merged ${shortSha(to)}; the board and wake restart on it`)
      d.changed?.()
      d.restart()
      return { ...base, outcome: 'updated', commit: to, restarting: true }
    } catch (err) {
      // a step that threw (a state file that could not be written): the lock files go back
      if (!d.load().pending && d.load().installing) await putBack(locks, installed).catch(() => {})
      throw err
    }
  }

  const api: SelfUpdate = {
    running: () => running,
    async check(o = {}) {
      if (running) return { at: d.now(), outcome: 'skipped', reason: 'running' }
      running = true
      try {
        return await check(!!o.byHand)
      } finally {
        running = false
      }
    },
    async resume() {
      if (running) return null
      running = true
      try {
        const p = d.load().pending
        if (!p) {
          await mend()
          return null
        }
        return await finish(p)
      } finally {
        running = false
      }
    },
    async tick() {
      if (running) return null
      const cfg = autoUpdateConfig(d.config())
      if (!cfg.on) return null
      const s = d.load()
      // A pending update this board did not finish at its start is not looked at again here.
      if (s.pending && d.now() - s.pending.at <= BACK_MS) return null
      if (!due(cfg, s.last, d.now(), startedAt)) return null
      return api.check()
    },
  }
  return api
}
