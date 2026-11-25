// The guard of a Windows node's update (#699, services/node/update-guard.ts): it says it runs, waits
// for go, puts the new copy in place, counts the board's time from then, and at the deadline takes the
// pending record and puts the copy before back, again and again when that fails.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aliveAt,
  applyUpdate,
  claimPending,
  type PendingUpdate,
  readPending,
  restorePlugin,
  setPhase,
  writeAlive,
  writePending,
} from '../../src/adapters/plugin-update.ts'
import { type GuardDeps, guardUpdate } from '../../src/services/node/update-guard.ts'

const base: PendingUpdate = {
  commit: 'b'.repeat(40),
  from: 'a'.repeat(40),
  root: '/p/agent-board',
  old: '/p/agent-board.old',
  fresh: '/p/agent-board.new',
  phase: 'go',
  at: 1,
}

/**
 * Fake deps on a clock the sleeps move. `record` is the record on disk (null: none); `goAt`: the
 * time the board says go (never: not at all); `backAt`: the time the board settles the record.
 */
function fake(
  o: {
    goAt?: number | null
    backAt?: number | null
    applyMs?: number
    applyThrows?: boolean
    restoreFails?: number
    over?: Partial<GuardDeps>
  } = {},
) {
  let clock = 0
  let record: PendingUpdate | null = { ...base, phase: 'ready' }
  const calls: string[] = []
  const sleeps: number[] = []
  let restores = 0
  const deps: GuardDeps = {
    file: '/state/pending.json',
    waitMs: 10_000,
    pollMs: 1000,
    goMs: 5000,
    retries: [100, 200],
    read: () => {
      if (record?.phase === 'ready' && o.goAt !== null && clock >= (o.goAt ?? 2000)) record = { ...record, phase: 'go' }
      if (record?.phase === 'applied' && o.backAt != null && clock >= o.backAt) record = null
      return record
    },
    write: (_f, p) => {
      record = p
      calls.push(`write ${p.phase}@${p.at}`)
    },
    claim: () => {
      const taken = record
      record = null
      calls.push(taken ? 'claim' : 'claim none')
      return taken
    },
    alive: () => void calls.push('alive'),
    apply: (fresh, root, old) => {
      calls.push(`apply ${fresh} ${root} ${old}`)
      clock += o.applyMs ?? 0
      if (o.applyThrows) throw new Error('EBUSY')
    },
    restore: (old, root) => {
      restores++
      calls.push(`restore ${old} ${root}`)
      if (restores <= (o.restoreFails ?? 0)) throw new Error('EPERM')
    },
    drop: fresh => void calls.push(`drop ${fresh}`),
    touch: root => void calls.push(`touch ${root}`),
    log: t => void calls.push(`log ${t}`),
    sleep: async ms => {
      expect(ms).toBeGreaterThanOrEqual(0)
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    ...o.over,
  }
  return { deps, calls, sleeps, at: () => clock, record: () => record }
}

const logs = (calls: string[]): string => calls.filter(c => c.startsWith('log ')).join('\n')

describe('the guard of a Windows update', () => {
  test('it says it runs at once, and a record that is gone before go ends it with nothing done', async () => {
    const { deps, calls, record } = fake({ over: { read: () => null } })
    expect(await guardUpdate(deps)).toBe('cancelled')
    expect(calls).toEqual(['alive'])
    expect(record()).not.toBeNull()
  })

  test('no go within its time: the record taken, the new copy dropped, nothing applied', async () => {
    const { deps, calls, record } = fake({ goAt: null })
    expect(await guardUpdate(deps)).toBe('cancelled')
    expect(calls.filter(c => c.startsWith('apply') || c.startsWith('restore') || c.startsWith('touch'))).toEqual([])
    expect(calls).toContain('claim')
    expect(calls).toContain(`drop ${base.fresh}`)
    expect(record()).toBeNull()
    expect(logs(calls)).toContain('got no go')
  })

  test('go: the new copy applied, the record rewritten as applied from that moment, a code file touched', async () => {
    const { deps, calls } = fake({ applyMs: 5000, backAt: 12_000 })
    expect(await guardUpdate(deps)).toBe('started')
    const order = calls.filter(c => !c.startsWith('alive'))
    expect(order.slice(0, 4)).toEqual([
      `apply ${base.fresh} ${base.root} ${base.old}`,
      `drop ${base.fresh}`,
      'write applied@7000',
      `touch ${base.root}`,
    ])
    expect(logs(calls)).toContain('is in place')
    expect(calls.some(c => c.startsWith('restore'))).toBe(false)
  })

  test('the board has waitMs from the copy in place, not from the start', async () => {
    const { deps, calls, at } = fake({ applyMs: 5000 })
    expect(await guardUpdate(deps)).toBe('rolled-back')
    // go at 2000, applied at 7000, the deadline at 7000 + 10000
    expect(at()).toBe(17_000)
    expect(calls.filter(c => c.startsWith('restore'))).toEqual([`restore ${base.old} ${base.root}`])
    expect(calls.filter(c => c.startsWith('touch'))).toHaveLength(2)
    expect(logs(calls)).toContain('did not start within 10 s')
    expect(logs(calls)).toContain('is back in place')
    expect(logs(calls)).toContain(base.commit.slice(0, 12))
    expect(logs(calls)).toContain(base.from.slice(0, 12))
  })

  test('a copy that cannot be put in place is put back at once, without the wait', async () => {
    const { deps, calls, at } = fake({ applyThrows: true })
    expect(await guardUpdate(deps)).toBe('rolled-back')
    expect(at()).toBeLessThan(5000)
    expect(calls.some(c => c.startsWith('write applied'))).toBe(false)
    expect(calls).toContain(`restore ${base.old} ${base.root}`)
    expect(logs(calls)).toContain('could not be put in place (EBUSY)')
  })

  test('a record the board took at the last moment is left alone', async () => {
    const { deps, calls } = fake({ over: { claim: () => null } })
    expect(await guardUpdate(deps)).toBe('started')
    expect(calls.some(c => c.startsWith('restore'))).toBe(false)
  })

  test('a restore that fails is tried again after the pauses, the record kept as restoring between the tries', async () => {
    const { deps, calls, sleeps } = fake({ restoreFails: 2 })
    expect(await guardUpdate(deps)).toBe('rolled-back')
    expect(calls.filter(c => c.startsWith('restore'))).toHaveLength(3)
    expect(calls.filter(c => c.startsWith('write restoring'))).toHaveLength(2)
    expect(sleeps.slice(-2)).toEqual([100, 200])
    expect(logs(calls)).toContain('could not be put back: EPERM')
  })

  test('a restore that always fails ends failed with the record left as restoring', async () => {
    const { deps, calls, record } = fake({ restoreFails: 99 })
    expect(await guardUpdate(deps)).toBe('failed')
    expect(record()?.phase).toBe('restoring')
    expect(calls.filter(c => c.startsWith('restore'))).toHaveLength(3)
    expect(calls.filter(c => c.startsWith('touch')).length).toBe(1)
  })

  test('the record taken by someone else between the tries of a restore ends it', async () => {
    let claims = 0
    const { deps, calls } = fake({
      restoreFails: 99,
      over: {
        claim: () => (++claims === 1 ? { ...base, phase: 'applied' } : null),
      },
    })
    // the first claim is the guard's own at the deadline; go, apply and the wait come before it
    expect(await guardUpdate({ ...deps, read: () => ({ ...base, phase: 'go' }) })).toBe('started')
    expect(calls.filter(c => c.startsWith('restore'))).toHaveLength(1)
  })

  test('it says it runs on every pause, and the pauses never pass a deadline', async () => {
    const { deps, calls, at } = fake({ goAt: null, over: { goMs: 2500 } })
    await guardUpdate(deps)
    expect(at()).toBe(2500)
    expect(calls.filter(c => c === 'alive').length).toBeGreaterThanOrEqual(3)
  })
})

describe('the guard on files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-update-guard-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const text = (...p: string[]): string => readFileSync(join(...p), 'utf8')
  const put = (base: string, rel: string, data: string): void => {
    mkdirSync(join(base, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(base, ...rel.split('/')), data)
  }

  /** Real deps; the board says go at once, and the test decides whether it comes back. */
  function real(file: string, settle: boolean, waitMs: number): GuardDeps {
    return {
      file,
      waitMs,
      pollMs: 10,
      goMs: 2000,
      retries: [10],
      read: f => {
        const p = readPending(f)
        if (p?.phase === 'applied' && settle) {
          claimPending(f)
          return null
        }
        return p
      },
      write: writePending,
      claim: claimPending,
      alive: writeAlive,
      apply: applyUpdate,
      restore: restorePlugin,
      drop: fresh => rmSync(fresh, { recursive: true, force: true }),
      touch: () => {},
      log: () => {},
      sleep: ms => Bun.sleep(ms),
      now: Date.now,
    }
  }

  function scene(checkout = false) {
    const root = join(dir, 'agent-board')
    const old = join(dir, 'agent-board.old')
    const fresh = join(dir, 'agent-board.new')
    put(root, 'src/a.ts', 'A')
    put(root, '.archive-commit', 'a\n')
    if (checkout) put(root, '.git/HEAD', 'ref')
    put(old, 'src/a.ts', 'A')
    put(old, '.archive-commit', 'a\n')
    put(fresh, 'src/a.ts', 'B')
    put(fresh, 'src/b.ts', 'B')
    put(fresh, '.archive-commit', 'b\n')
    const file = join(dir, 'state', 'pending.json')
    writePending(file, { commit: 'b'.repeat(40), from: 'a'.repeat(40), root, old, fresh, phase: 'ready', at: 1 })
    setPhase(file, 'go')
    return { root, old, fresh, file }
  }

  test('the board that settles the record: the new copy stays', async () => {
    const { root, old, fresh, file } = scene()
    expect(await guardUpdate(real(file, true, 2000))).toBe('started')
    expect(text(root, 'src', 'a.ts')).toBe('B')
    expect(text(root, 'src', 'b.ts')).toBe('B')
    expect(text(root, '.archive-commit')).toBe('b\n')
    expect(existsSync(join(old, '.git'))).toBe(false)
    expect(existsSync(fresh)).toBe(false)
    expect(readdirSync(join(dir, 'state')).filter(f => f !== 'pending.json.alive')).toEqual([])
    expect(aliveAt(file)).not.toBeNull()
  })

  test('a board that does not come back: the plugin is the copy before again, the record gone', async () => {
    const { root, file } = scene()
    expect(await guardUpdate(real(file, false, 60))).toBe('rolled-back')
    expect(text(root, 'src', 'a.ts')).toBe('A')
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
    expect(text(root, '.archive-commit')).toBe('a\n')
    expect(readdirSync(join(dir, 'state')).filter(f => f !== 'pending.json.alive')).toEqual([])
  })

  test('a plugin that is a checkout (#793): nothing applied, its .git never moved, the copy before put back at once', async () => {
    const { root, old, file } = scene(true)
    expect(await guardUpdate(real(file, true, 2000))).toBe('rolled-back')
    expect(text(root, '.git', 'HEAD')).toBe('ref')
    expect(existsSync(join(old, '.git'))).toBe(false)
    expect(text(root, 'src', 'a.ts')).toBe('A')
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
    expect(text(root, '.archive-commit')).toBe('a\n')
  })
})
