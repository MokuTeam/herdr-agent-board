// The guard of a Windows node's update (#699, services/node/update-guard.ts): it stands down when the
// board confirmed, and at its deadline takes the pending record and puts the copy before back.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimPending, mirrorTree, type PendingUpdate, writePending } from '../../src/adapters/plugin-update.ts'
import { type GuardDeps, guardUpdate } from '../../src/services/node/update-guard.ts'

const record: PendingUpdate = {
  commit: 'b'.repeat(40),
  from: 'a'.repeat(40),
  root: '/p/agent-board',
  old: '/p/agent-board.old',
  at: 1,
}

/** Fake deps on a clock the sleeps move; `gone` ends the record after that many ms. */
function fake(over: Partial<GuardDeps> = {}, gone: number | null = null) {
  let clock = 0
  const calls: string[] = []
  const deps: GuardDeps = {
    file: '/state/pending.json',
    waitMs: 10_000,
    pollMs: 1000,
    pending: () => gone === null || clock < gone,
    claim: () => {
      calls.push('claim')
      return record
    },
    restore: (old, root) => void calls.push(`restore ${old} ${root}`),
    touch: root => void calls.push(`touch ${root}`),
    log: t => void calls.push(`log ${t}`),
    sleep: async ms => {
      expect(ms).toBeGreaterThanOrEqual(0)
      clock += ms
    },
    now: () => clock,
    ...over,
  }
  return { deps, calls, at: () => clock }
}

describe('the guard of a Windows update', () => {
  test('a record that goes before the deadline: the board is back, nothing is restored', async () => {
    const { deps, calls } = fake({}, 3000)
    expect(await guardUpdate(deps)).toBe('started')
    expect(calls).toEqual([])
  })

  test('a record still there at the deadline: taken, the copy before put back, a code file touched, said in the log', async () => {
    const { deps, calls, at } = fake()
    expect(await guardUpdate(deps)).toBe('rolled-back')
    expect(at()).toBe(10_000)
    expect(calls.slice(0, 3)).toEqual(['claim', 'restore /p/agent-board.old /p/agent-board', 'touch /p/agent-board'])
    expect(calls[3]).toContain('did not start within 10 s')
    expect(calls[3]).toContain(record.commit.slice(0, 12))
    expect(calls[3]).toContain(record.from.slice(0, 12))
  })

  test('a record the board took at the last moment is left alone', async () => {
    const { deps, calls } = fake({ claim: () => null })
    expect(await guardUpdate(deps)).toBe('started')
    expect(calls).toEqual([])
  })

  test('a copy that cannot be put back is said, and no restart is asked for', async () => {
    const { deps, calls } = fake({
      restore: () => {
        throw new Error('EPERM')
      },
    })
    expect(await guardUpdate(deps)).toBe('failed')
    expect(calls.some(c => c.startsWith('touch'))).toBe(false)
    expect(calls.join('\n')).toContain('could not be put back: EPERM')
  })

  test('a wait that is not a multiple of the poll ends at the deadline, never past it', async () => {
    const { deps, at } = fake({ waitMs: 2500 })
    await guardUpdate(deps)
    expect(at()).toBe(2500)
  })
})

describe('the guard on files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-update-guard-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('the plugin is back at the copy before, the record and its claim are gone', async () => {
    const root = join(dir, 'agent-board')
    const old = join(dir, 'agent-board.old')
    mkdirSync(join(old, 'src'), { recursive: true })
    writeFileSync(join(old, 'src', 'a.ts'), 'A')
    writeFileSync(join(old, '.archive-commit'), 'a\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'B')
    writeFileSync(join(root, 'src', 'b.ts'), 'B')
    writeFileSync(join(root, '.archive-commit'), 'b\n')
    const file = join(dir, 'state', 'pending.json')
    writePending(file, { commit: 'b'.repeat(40), from: 'a'.repeat(40), root, old, at: 1 })
    const logs: string[] = []
    const touched: string[] = []
    const result = await guardUpdate({
      file,
      waitMs: 30,
      pollMs: 10,
      pending: existsSync,
      claim: claimPending,
      restore: (o, r) => mirrorTree(o, r),
      touch: r => void touched.push(r),
      log: t => void logs.push(t),
      sleep: ms => Bun.sleep(ms),
      now: Date.now,
    })
    expect(result).toBe('rolled-back')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('A')
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
    expect(readFileSync(join(root, '.archive-commit'), 'utf8')).toBe('a\n')
    expect(readdirSync(join(dir, 'state'))).toEqual([])
    expect(touched).toEqual([root])
  })
})
