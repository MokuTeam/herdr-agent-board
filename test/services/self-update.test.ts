// The board's update of itself from git (#617, services/self-update.ts), against a fake git and fake
// processes: when it fetches, merges, installs, runs the installer and restarts, and when it skips;
// the order of the steps (the dependencies before the merge, the pending record before the merge,
// the copies of settings.json before the installer); what a failure leaves behind; a node that asks
// git for nothing; and the new board finishing what the old one merged.
import { expect, test } from 'bun:test'
import type { SkipReason, UpdateState } from '../../src/core/self-update.ts'
import { createSelfUpdate, type GitResult, type SelfUpdateDeps } from '../../src/services/self-update.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const MIN = 60_000

interface Repo {
  checkout: boolean
  branch: string | null
  upstream: string | null
  dirty: string
  head: string
  up: string
  ahead: number
  behind: number
  changed: string[]
  locks: string
  log: string
  fetchFails?: string
  mergeFails?: string
}

function world(repo: Partial<Repo> = {}, over: Partial<SelfUpdateDeps> = {}) {
  const r: Repo = {
    checkout: true,
    branch: 'main',
    upstream: 'origin/main',
    dirty: '',
    head: A,
    up: B,
    ahead: 0,
    behind: 2,
    changed: ['src/core/board.ts'],
    locks: '',
    log: 'Cards keep their lane (#12)\x1f\x1e',
    ...repo,
  }
  const events: string[] = []
  const git: string[][] = []
  let clock = 1_000_000
  let state: UpdateState = {}
  const ok = (out = ''): GitResult => ({ ok: true, out, err: '' })
  const no = (err = 'fatal'): GitResult => ({ ok: false, out: '', err })
  const deps: SelfUpdateDeps = {
    async git(args) {
      git.push(args)
      const [cmd, ...rest] = args
      const joined = args.join(' ')
      if (cmd === 'symbolic-ref') return r.branch ? ok(`${r.branch}\n`) : no()
      if (joined.includes('--symbolic-full-name')) return r.upstream ? ok(`${r.upstream}\n`) : no()
      if (cmd === 'status') return ok(r.dirty)
      if (cmd === 'rev-parse') return ok(`${rest.at(-1)?.startsWith('@{u}') ? r.up : r.head}\n`)
      if (cmd === 'config') return ok('origin\n')
      if (cmd === 'fetch') {
        events.push('fetch')
        return r.fetchFails ? no(r.fetchFails) : ok()
      }
      if (cmd === 'rev-list') return ok(`${r.ahead}\t${r.behind}\n`)
      if (cmd === 'diff' && rest[0] === '--name-only') return ok(r.changed.join('\n'))
      if (cmd === 'diff' && rest[0] === '--name-status') return ok(r.locks)
      if (cmd === 'log') return ok(r.log)
      if (cmd === 'checkout') {
        events.push(`checkout ${rest[0] === r.up ? 'up' : rest[0]} ${rest.slice(2).join(' ')}`)
        return ok()
      }
      if (cmd === 'merge') {
        events.push('merge')
        if (r.mergeFails) return no(r.mergeFails)
        r.head = r.up
        return ok()
      }
      throw new Error(`unexpected git ${joined}`)
    },
    isCheckout: () => r.checkout,
    node: () => false,
    config: () => true,
    canRestart: true,
    busy: () => null,
    install: async () => {
      events.push('install')
      return { ok: true, detail: '' }
    },
    installer: async () => {
      events.push('installer')
      return { ok: true, detail: '' }
    },
    backupSettings: () => {
      events.push('backup')
      return ['/state/self-update/settings/x/default.json']
    },
    restart: () => events.push('restart'),
    wakeUp: async () => false,
    wakeBack: async () => true,
    load: () => structuredClone(state),
    save: s => {
      if (s.pending && !state.pending) events.push('pending')
      state = structuredClone(s)
    },
    log: () => {},
    now: () => clock,
    ...over,
  }
  return {
    repo: r,
    events,
    git,
    deps,
    state: () => state,
    setState: (s: UpdateState) => {
      state = s
    },
    tick: (ms: number) => {
      clock += ms
    },
  }
}

test('behind on code: fetch, the pending record, the merge, then a restart; the new board finishes it', async () => {
  const w = world()
  const r = await createSelfUpdate(w.deps).check({ byHand: true })
  expect(r).toMatchObject({
    outcome: 'updated',
    restarting: true,
    from: A,
    to: B,
    came: ['Cards keep their lane (#12)'],
  })
  expect(w.events).toEqual(['fetch', 'pending', 'merge', 'restart'])
  expect(w.state().pending).toMatchObject({ from: A, to: B, branch: 'main', installer: false, byHand: true })
  // the board restarts on the new code: a new process with the same state file
  w.tick(15_000)
  const done = await createSelfUpdate(w.deps).resume()
  expect(done).toMatchObject({ outcome: 'updated', from: A, to: B, commit: B, byHand: true })
  expect(w.state().pending).toBeUndefined()
  expect(w.state().lastUpdate?.came).toEqual(['Cards keep their lane (#12)'])
})

test('package.json and bun.lock changed: taken from upstream and installed before the merge', async () => {
  const w = world({ changed: ['package.json', 'bun.lock', 'src/a.ts'], locks: 'M\tpackage.json\nM\tbun.lock\n' })
  const r = await createSelfUpdate(w.deps).check()
  expect(r.outcome).toBe('updated')
  expect(w.events).toEqual(['fetch', 'checkout up package.json bun.lock', 'install', 'pending', 'merge', 'restart'])
})

test('bun install fails: the lock files go back, the dependencies with them, and nothing is merged', async () => {
  let installs = 0
  const w = world(
    { changed: ['bun.lock'], locks: 'M\tbun.lock' },
    {
      install: async () => {
        installs++
        return installs === 1 ? { ok: false, detail: 'error: network down' } : { ok: true, detail: '' }
      },
    },
  )
  const r = await createSelfUpdate(w.deps).check()
  expect(r).toMatchObject({ outcome: 'failed', reason: 'install', detail: 'error: network down', commit: A })
  expect(w.events).toEqual(['fetch', 'checkout up bun.lock', 'checkout HEAD bun.lock'])
  expect(installs).toBe(2)
  expect(w.repo.head).toBe(A)
  expect(w.state().pending).toBeUndefined()
})

test('the merge fails: the lock files go back, no pending record stays, no restart', async () => {
  const w = world({
    changed: ['package.json'],
    locks: 'M\tpackage.json',
    mergeFails: 'fatal: Not possible to fast-forward',
  })
  const r = await createSelfUpdate(w.deps).check()
  expect(r).toMatchObject({ outcome: 'failed', reason: 'merge', detail: 'fatal: Not possible to fast-forward' })
  expect(w.events).toEqual([
    'fetch',
    'checkout up package.json',
    'install',
    'pending',
    'merge',
    'checkout HEAD package.json',
    'install',
  ])
  expect(w.state().pending).toBeUndefined()
  expect(w.events).not.toContain('restart')
})

test('a lock file added or removed upstream is skipped, before anything changes', async () => {
  const w = world({ changed: ['bun.lock'], locks: 'A\tbun.lock' })
  expect(await createSelfUpdate(w.deps).check()).toMatchObject({ outcome: 'skipped', reason: 'lockfiles' })
  expect(w.events).toEqual(['fetch'])
})

test('only docs: merged and finished at once, no install, no installer, no restart', async () => {
  const w = world({ changed: ['README.md'] })
  const r = await createSelfUpdate(w.deps).check()
  expect(r).toMatchObject({ outcome: 'updated', commit: B })
  expect(r.restarting).toBeUndefined()
  expect(w.events).toEqual(['fetch', 'pending', 'merge'])
  expect(w.state().pending).toBeUndefined()
})

test('hooks or skills changed: the new board copies settings.json, then runs the installer', async () => {
  const w = world({ changed: ['src/adapters/hook-settings.ts', 'skills/herdr-agents/SKILL.md'] })
  await createSelfUpdate(w.deps).check()
  expect(w.events).toEqual(['fetch', 'pending', 'merge', 'restart'])
  await createSelfUpdate(w.deps).resume()
  expect(w.events.slice(4)).toEqual(['backup', 'installer'])
  expect(w.state().last?.outcome).toBe('updated')
})

test('the installer fails on the new board: said with its words, the checkout stays on the new commit', async () => {
  const w = world(
    { changed: ['src/entrypoints/install.ts'] },
    { installer: async () => ({ ok: false, detail: 'settings.json is not valid JSON' }) },
  )
  await createSelfUpdate(w.deps).check()
  const r = await createSelfUpdate(w.deps).resume()
  expect(r).toMatchObject({
    outcome: 'failed',
    reason: 'installer',
    commit: B,
    detail: 'settings.json is not valid JSON',
  })
  expect(w.state().pending).toBeUndefined()
})

test('wake ran before and does not come back: a failure; wake that was not running is not waited for', async () => {
  const down = world({}, { wakeUp: async () => true, wakeBack: async () => false })
  await createSelfUpdate(down.deps).check()
  expect(await createSelfUpdate(down.deps).resume()).toMatchObject({ outcome: 'failed', reason: 'wake' })
  let asked = false
  const off = world(
    {},
    {
      wakeUp: async () => false,
      wakeBack: async () => {
        asked = true
        return false
      },
    },
  )
  await createSelfUpdate(off.deps).check()
  expect(await createSelfUpdate(off.deps).resume()).toMatchObject({ outcome: 'updated' })
  expect(asked).toBe(false)
})

test('the board came back on another commit than the merge left: said, not taken for an update', async () => {
  const w = world()
  await createSelfUpdate(w.deps).check()
  w.repo.head = 'c'.repeat(40)
  expect(await createSelfUpdate(w.deps).resume()).toMatchObject({ outcome: 'failed', reason: 'not-back' })
  // a board that ended between the record and the merge: still on the commit before
  const w2 = world()
  w2.setState({
    pending: { at: 0, from: A, to: B, branch: 'main', installer: false, came: [], byHand: false, wake: false },
  })
  expect(await createSelfUpdate(w2.deps).resume()).toMatchObject({ outcome: 'failed', reason: 'merge' })
})

test('skips before the fetch, each with its reason, and nothing written to the checkout', async () => {
  const cases: [Partial<Repo>, Partial<SelfUpdateDeps>, SkipReason][] = [
    [{ checkout: false }, {}, 'no-checkout'],
    [{ branch: null }, {}, 'detached'],
    [{ upstream: null }, {}, 'no-upstream'],
    [{ dirty: ' M src/a.ts\n' }, {}, 'dirty'],
    [{}, { canRestart: false }, 'restart'],
  ]
  for (const [repo, over, reason] of cases) {
    const w = world(repo, over)
    const r = await createSelfUpdate(w.deps).check()
    expect(r).toMatchObject({ outcome: 'skipped', reason })
    expect(w.events).toEqual([])
    expect(w.state().last?.reason).toBe(reason)
  }
  const dirty = world({ dirty: ' M src/a.ts\n' })
  expect((await createSelfUpdate(dirty.deps).check()).detail).toBe(' M src/a.ts')
})

test('a node asks git for nothing: it follows its master', async () => {
  const w = world({}, { node: () => true })
  expect(await createSelfUpdate(w.deps).check()).toMatchObject({ outcome: 'skipped', reason: 'node' })
  expect(w.git).toEqual([])
})

test('a failed fetch, a current branch and a diverged one: skipped, current, skipped; never merged', async () => {
  const f = world({ fetchFails: 'fatal: could not read from remote' })
  expect(await createSelfUpdate(f.deps).check()).toMatchObject({
    outcome: 'skipped',
    reason: 'fetch',
    detail: 'fatal: could not read from remote',
  })
  const c = world({ behind: 0, ahead: 1 })
  expect(await createSelfUpdate(c.deps).check()).toMatchObject({ outcome: 'current', commit: A })
  const d = world({ ahead: 1, behind: 3 })
  expect(await createSelfUpdate(d.deps).check()).toMatchObject({
    outcome: 'skipped',
    reason: 'diverged',
    detail: '1 ahead, 3 behind',
  })
  for (const w of [f, c, d]) expect(w.events).not.toContain('merge')
})

test('a launch in flight holds it, and the schedule comes back in five minutes', async () => {
  let busy: string | null = '1 session start in flight'
  const w = world({}, { busy: () => busy, config: () => ({ every: 'day', at: '04:00' }) })
  const u = createSelfUpdate(w.deps)
  expect(await u.check()).toMatchObject({ outcome: 'skipped', reason: 'busy', detail: '1 session start in flight' })
  expect(w.events).toEqual(['fetch'])
  w.tick(4 * MIN)
  expect(await u.tick()).toBeNull()
  busy = null
  w.tick(MIN)
  expect(await u.tick()).toMatchObject({ outcome: 'updated' })
})

test('the schedule: off reads nothing; a recent pending record waits; one check at a time', async () => {
  let loads = 0
  const off = world({}, { config: () => undefined })
  const load = off.deps.load
  off.deps.load = () => {
    loads++
    return load()
  }
  expect(await createSelfUpdate(off.deps).tick()).toBeNull()
  expect(loads).toBe(0)
  expect(off.git).toEqual([])

  const pend = world()
  pend.setState({
    pending: { at: 1_000_000, from: A, to: B, branch: 'main', installer: false, came: [], byHand: false, wake: false },
  })
  expect(await createSelfUpdate(pend.deps).tick()).toBeNull()
  expect(await createSelfUpdate(pend.deps).check()).toMatchObject({ outcome: 'skipped', reason: 'running' })

  let release = () => {}
  const slow = world(
    {},
    {
      install: () =>
        new Promise(done => {
          release = () => done({ ok: true, detail: '' })
        }),
    },
  )
  slow.repo.changed = ['bun.lock']
  slow.repo.locks = 'M\tbun.lock'
  const u = createSelfUpdate(slow.deps)
  const first = u.check()
  await new Promise(r => setTimeout(r, 5))
  expect(u.running()).toBe(true)
  expect(await u.check()).toMatchObject({ outcome: 'skipped', reason: 'running' })
  release()
  expect((await first).outcome).toBe('updated')
})
