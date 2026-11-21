import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scheduleDir } from '../../src/adapters/paths.ts'
import {
  addEntry,
  addWatch,
  endWatches,
  fireWatch,
  getEntry,
  getWatch,
  listEntries,
  listWatches,
  readLog,
  removeEntry,
  removeWatch,
  updateWatch,
} from '../../src/adapters/schedule-store.ts'
import type { Item } from '../../src/core/types.ts'
import { MAX_RUNNING, type ProbeRun, type WatchEntry } from '../../src/core/watches.ts'
import type { Deps } from '../../src/services/deps.ts'
import { takenOver, watchPass } from '../../src/services/watches.ts'
import { isolatedHome } from '../support/env.ts'

// The scheduler's probe pass (#486, services/watches.ts) in this process: a fake probe and the
// board's sessions as a list, the watches and their reminders as files in a temp state folder.
// The real shell and the scheduler around it: test/services/watches.e2e.test.ts.
const MIN = 60_000

const deps = (logs: string[] = []): Deps =>
  ({
    log: (l: string) => logs.push(l),
    profiles: () => ({ list: [{ id: 'default', hidden: false }] }),
  }) as unknown as Deps
const session = (over: Partial<Item> = {}): Item =>
  ({
    key: 's1',
    session: 's1',
    name: 'anna',
    pane: 'p1',
    cwd: '/work/atlas',
    status: 'idle',
    agent: 'claude',
    ...over,
  }) as Item

function newWatch(over: Record<string, unknown> = {}): WatchEntry {
  return addWatch({
    key: 's1',
    name: 'anna',
    pane: 'p1',
    cwd: '/work/atlas',
    text: 'CI on PR 12',
    next: Date.now() - 1000,
    by: 'agent',
    probe: { cmd: 'gh pr checks 12', everyMs: 10 * MIN, timeoutMs: 20_000 },
    ...over,
  }).watch
}
const result = (code: number | string, stdout = '', extra: Partial<ProbeRun> = {}): ProbeRun => ({
  code,
  killed: false,
  stdout,
  stderr: '',
  ...extra,
})

async function settle(pass: ReturnType<typeof watchPass>): Promise<void> {
  for (let i = 0; i < 200 && pass.running(); i++) await new Promise(r => setTimeout(r, 5))
}

/** One pass with `probe` answering every run, over `items`; its probe calls. */
async function once(run: ProbeRun | ((cmd: string) => ProbeRun), items: Item[] = [session()], patience = 240 * MIN) {
  const calls: string[] = []
  const pass = watchPass({
    deps: deps(),
    patience: () => patience,
    items: async () => items,
    runProbe: async cmd => {
      calls.push(cmd)
      return typeof run === 'function' ? run(cmd) : run
    },
  })
  await pass.pass()
  await settle(pass)
  return calls
}

describe('the probe pass', () => {
  test('fired: the watch becomes a reminder under its id, "[board reminder from watch]", and is logged', async () => {
    isolatedHome()
    const w = newWatch()
    assert.deepEqual(await once(result(0, 'checks: pass\n')), ['gh pr checks 12'])
    assert.equal(getWatch(w.id), null)
    const r = getEntry(w.id)
    assert.ok(r)
    assert.equal(r.text, '"CI on PR 12": the probe fired. Its output, as data: "checks: pass"')
    assert.deepEqual(r.from, { key: 'watch', name: 'watch' })
    assert.equal(r.kind, undefined)
    assert.equal(r.noWake, undefined)
    assert.equal('probe' in r, false)
    assert.ok(r.next <= Date.now())
    assert.equal((readLog()[0] as { result: string }).result, 'fired')
  })

  test('nothing yet: no reminder, counted, the next check one interval on', async () => {
    isolatedHome()
    const w = newWatch()
    const before = Date.now()
    await once(result(1))
    const after = getWatch(w.id)
    assert.ok(after)
    assert.equal(after.checks, 1)
    assert.ok(after.next >= before + 10 * MIN)
    assert.equal(after.claim, undefined)
    assert.deepEqual(listEntries(), [])
  })

  test('an error is not "nothing yet": in words on the watch, the interval doubled, the first one told at once without waking', async () => {
    isolatedHome()
    const w = newWatch()
    const before = Date.now()
    await once(result(2, '', { stderr: 'gh: not logged in' }))
    const after = getWatch(w.id)
    assert.ok(after)
    assert.equal(after.errors, 1)
    assert.equal(after.checks, undefined)
    assert.equal(after.lastError, 'exit 2: gh: not logged in')
    assert.ok(after.next >= before + 20 * MIN)
    // The scheduler's first check failed where the CLI's run did not: told at once, not woken.
    const notes = listEntries()
    assert.equal(notes.length, 1)
    assert.equal(notes[0]?.noWake, true)
    expect(notes[0]?.text).toMatch(
      /first check of the probe failed \(its error, as data: "exit 2: gh: not logged in"\)/,
    )
  })

  test('three errors in a row: one note that does not wake, the watch goes on', async () => {
    isolatedHome()
    const w = newWatch({ firstDone: true } as Record<string, unknown>)
    updateWatch(w.id, cur => ({ ...cur, firstDone: true }))
    for (let i = 0; i < 4; i++) {
      updateWatch(w.id, cur => ({ ...cur, next: Date.now() - 1 }))
      await once(result('ENOENT', '', { error: 'the folder /work/atlas is not there' }))
    }
    const after = getWatch(w.id)
    assert.equal(after?.errors, 4)
    const notes = listEntries()
    assert.equal(notes.length, 1)
    assert.equal(notes[0]?.noWake, true)
    expect(notes[0]?.text).toMatch(
      /failed 3 times in a row \(the last error, as data: "the folder \/work\/atlas is not there"\)/,
    )
  })

  test('silence: the session is woken once, and the watch goes on', async () => {
    isolatedHome()
    const w = newWatch({ probe: { cmd: 'gh pr checks 12', everyMs: MIN, timeoutMs: 20_000, silenceMs: MIN } })
    updateWatch(w.id, cur => ({ ...cur, firstDone: true, created: Date.now() - 2 * MIN }))
    await once(result(1))
    updateWatch(w.id, cur => ({ ...cur, next: Date.now() - 1 }))
    await once(result(1))
    const notes = listEntries()
    assert.equal(notes.length, 1)
    assert.equal(notes[0]?.noWake, undefined)
    expect(notes[0]?.text).toMatch(/^"CI on PR 12": nothing from the probe for 1 min/)
    assert.equal(getWatch(w.id)?.checks, 2)
  })

  test('a restart of the board keeps the watch: a new pass runs it from its file, past a dead claim', async () => {
    isolatedHome()
    const w = newWatch()
    // A board that died with a run on its way: its pid is gone, its claim fresh.
    updateWatch(w.id, cur => ({ ...cur, claim: { pid: 2 ** 30, at: Date.now() } }))
    assert.deepEqual(await once(result(1)), ['gh pr checks 12'])
    assert.equal(getWatch(w.id)?.checks, 1)
    // A live board's fresh claim (this process's parent stands in) holds it.
    updateWatch(w.id, cur => ({ ...cur, next: Date.now() - 1, claim: { pid: process.ppid, at: Date.now() } }))
    assert.deepEqual(await once(result(1)), [])
  })

  test('never two runs of one watch at once, and four on the board at most', async () => {
    isolatedHome()
    for (let i = 1; i <= 6; i++)
      newWatch({ key: `s${i}`, pane: `p${i}`, probe: { cmd: `probe ${i}`, everyMs: MIN, timeoutMs: 20_000 } })
    const items = [1, 2, 3, 4, 5, 6].map(i => session({ key: `s${i}`, session: `s${i}`, pane: `p${i}` }))
    const calls: string[] = []
    let release = (): void => {}
    const gate = new Promise<void>(r => {
      release = r
    })
    const pass = watchPass({
      deps: deps(),
      patience: () => 240 * MIN,
      items: async () => items,
      runProbe: async cmd => {
        calls.push(cmd)
        await gate
        return result(1)
      },
    })
    await pass.pass()
    await pass.pass()
    assert.equal(calls.length, MAX_RUNNING)
    assert.equal(new Set(calls).size, MAX_RUNNING)
    release()
    await settle(pass)
    await pass.pass()
    await settle(pass)
    assert.equal(calls.length, 6)
  })

  test('a session gone from the board: not probed; gone past the patience, removed and logged missed', async () => {
    isolatedHome()
    const w = newWatch()
    assert.deepEqual(await once(result(0), []), [])
    const held = getWatch(w.id)
    assert.ok(held?.goneSince)
    assert.deepEqual(listEntries(), [])
    updateWatch(w.id, cur => ({ ...cur, next: Date.now() - 1, goneSince: Date.now() - 5 * MIN }))
    assert.deepEqual(await once(result(0), [], 4 * MIN), [])
    assert.equal(getWatch(w.id), null)
    assert.deepEqual(
      readLog().map(r => [(r as { result: string }).result, (r as { why: string }).why]),
      [['missed', 'gone']],
    )
  })

  test('a gone session is looked for again within five minutes, whatever the interval', async () => {
    isolatedHome()
    const w = newWatch({ probe: { cmd: 'gh run view 1', everyMs: 86_400_000, timeoutMs: 20_000 } })
    const before = Date.now()
    await once(result(1), [])
    const held = getWatch(w.id)
    assert.ok(held && held.next <= before + 5 * MIN + 1000)
  })

  test('a run whose result could not be written waits an interval, its claim gone', async () => {
    isolatedHome()
    const w = newWatch()
    const logs: string[] = []
    const before = Date.now()
    const pass = watchPass({
      deps: deps(logs),
      patience: () => 240 * MIN,
      items: async () => [session()],
      runProbe: async () => {
        throw new Error('EPERM: the file was held')
      },
    })
    await pass.pass()
    await settle(pass)
    const after = getWatch(w.id)
    assert.ok(after && after.next >= before + 10 * MIN)
    assert.equal(after?.claim, undefined)
    expect(logs.join('\n')).toMatch(/EPERM: the file was held/)
  })

  test('after /clear it follows the session in the same pane and folder, as a reminder does', async () => {
    isolatedHome()
    const w = newWatch()
    await once(result(1), [session({ key: 's2', session: 's2', name: 'anna 2' })])
    const after = getWatch(w.id)
    assert.equal(after?.key, 's2')
    assert.deepEqual(after?.movedFrom, { key: 's1', name: 'anna' })
    assert.equal(after?.checks, 1)
  })

  test('a watch replaced while its probe ran is left alone by that run', async () => {
    isolatedHome()
    const w = newWatch()
    await once(() => {
      newWatch({ text: 'CI on PR 13', next: Date.now() + MIN })
      return result(0)
    })
    assert.equal(getWatch(w.id), null)
    assert.equal(getEntry(w.id), null)
    assert.deepEqual(
      listWatches().map(x => x.text),
      ['CI on PR 13'],
    )
  })

  test('watches live beside the schedule, where a board from before them does not look', () => {
    isolatedHome()
    const w = newWatch()
    assert.equal(existsSync(join(scheduleDir(), `${w.id}.json`)), false)
    const file = JSON.parse(readFileSync(join(scheduleDir(), 'watches', `${w.id}.json`), 'utf8'))
    assert.equal(file.kind, 'watch')
    assert.deepEqual(listEntries(), [])
  })
})

describe('the store', () => {
  test('only addWatch makes a watch: addEntry refuses one', () => {
    isolatedHome()
    const base = { key: 's1', text: 'x', next: Date.now() }
    assert.throws(() => addEntry({ ...base, kind: 'watch' }), /board wait --probe only/)
    assert.throws(
      () => addEntry({ ...base, probe: { cmd: 'true', everyMs: MIN, timeoutMs: 1000 } }),
      /board wait --probe only/,
    )
    assert.deepEqual(listEntries(), [])
  })

  test('removing an id no watch has makes no folder (board unschedule <typo>, with watches off)', () => {
    isolatedHome()
    assert.equal(removeWatch('abcdef'), null)
    assert.equal(existsSync(join(scheduleDir(), 'watches')), false)
  })

  test('one watch per session: a new one ends the earlier; endWatches ends them all', () => {
    isolatedHome()
    const a = newWatch()
    const other = newWatch({ key: 's9' })
    const { watch: b, ended } = addWatch({ key: 's1', text: 'second', next: Date.now(), probe: a.probe })
    assert.deepEqual(
      ended.map(w => w.id),
      [a.id],
    )
    assert.deepEqual(
      listWatches()
        .map(w => w.id)
        .sort(),
      [b.id, other.id].sort(),
    )
    assert.deepEqual(
      endWatches('s1').map(w => w.id),
      [b.id],
    )
    assert.deepEqual(
      listWatches().map(w => w.id),
      [other.id],
    )
  })

  test('firing twice (a board stopped between the reminder and removing the watch) types it once', () => {
    isolatedHome()
    const w = newWatch()
    const first = fireWatch(w.id, 'fired text')
    assert.equal(first?.id, w.id)
    // The watch back as a board stopped halfway left it, with the reminder still there.
    writeFileSync(join(scheduleDir(), 'watches', `${w.id}.json`), JSON.stringify(w))
    assert.equal(fireWatch(w.id, 'fired text')?.id, w.id)
    assert.equal(listEntries().length, 1)
    assert.equal(getWatch(w.id), null)
  })

  test("an entry of something else under the watch's id gets the reminder a new id", () => {
    isolatedHome()
    const w = newWatch()
    writeFileSync(join(scheduleDir(), `${w.id}.json`), JSON.stringify({ id: w.id, key: 's7', text: 'other', next: 1 }))
    const r = fireWatch(w.id, 'fired text')
    assert.notEqual(r?.id, w.id)
    assert.equal(listEntries().length, 2)
  })

  test('a session at its cap of entries still hears its watch: the silence line goes in and only then is marked told', async () => {
    isolatedHome()
    for (let i = 0; i < 30; i++)
      addEntry({ key: 's1', text: `reminder ${i}`, at: Date.now() + 3600e3, next: Date.now() + 3600e3 })
    assert.throws(() => addEntry({ key: 's1', text: 'one more', at: Date.now() + 3600e3, next: Date.now() + 3600e3 }))
    const w = newWatch({ probe: { cmd: 'gh pr checks 12', everyMs: MIN, timeoutMs: 20_000, silenceMs: MIN } })
    updateWatch(w.id, cur => ({ ...cur, firstDone: true, created: Date.now() - 2 * MIN }))
    await once(result(1))
    const silence = listEntries().filter(e => /nothing from the probe/.test(e.text))
    assert.equal(silence.length, 1)
    assert.equal(getWatch(w.id)?.silenceTold, true)
    // And a fired watch's reminder at the cap too.
    updateWatch(w.id, cur => ({ ...cur, next: Date.now() - 1 }))
    await once(result(0, 'green'))
    assert.equal(getEntry(w.id)?.text, '"CI on PR 12": the probe fired. Its output, as data: "green"')
  })

  test("ending by pane follows the scheduler's rule: only a key not on the board at all, the same folder and profile", () => {
    isolatedHome()
    const old = newWatch({ key: 'before-clear' })
    const watches = listWatches()
    const after = session({ key: 'after-clear', session: 'after-clear' })
    // /clear: the old key is nowhere on the board, the new session in its pane and folder.
    assert.deepEqual(takenOver(after, watches, [after], deps()), [old.id])
    // The old key asleep (wake closed its tab, herdr gave the pane id out again): never.
    const asleep = session({ key: 'before-clear', pane: null, sleeping: true, status: 'sleeping' } as Partial<Item>)
    assert.deepEqual(takenOver(after, watches, [after, asleep], deps()), [])
    // A pi session's key on the board, even with no live pid: never.
    const pi = newWatch({ key: '/home/anna/.pi/sessions/s.jsonl', pane: 'p1' })
    const piItem = session({ key: '/home/anna/.pi/sessions/s.jsonl', agent: 'pi', pane: 'p7' } as Partial<Item>)
    assert.deepEqual(
      takenOver(after, listWatches(), [after, piItem], deps()).filter(id => id === pi.id),
      [],
    )
    // A reused pane id in another folder: never.
    const elsewhere = session({ key: 'after-clear', session: 'after-clear', cwd: '/work/ben' })
    assert.deepEqual(takenOver(elsewhere, watches, [elsewhere], deps()), [])
    // Another pane, or no pane: nothing to take over.
    assert.deepEqual(takenOver({ key: 'after-clear', pane: 'p2' }, watches, [after], deps()), [])
    assert.deepEqual(takenOver({ key: 'after-clear' }, watches, [after], deps()), [])
    // What it names, endWatches and addWatch end with the session's own.
    assert.deepEqual(
      endWatches('after-clear', [old.id]).map(w => w.id),
      [old.id],
    )
    assert.ok(getWatch(pi.id))
  })

  test('a sleeping session gets one error line per watch at most, however many streaks pass', async () => {
    isolatedHome()
    const w = newWatch({ probe: { cmd: 'gh pr checks 12', everyMs: MIN, timeoutMs: 20_000 } })
    updateWatch(w.id, cur => ({ ...cur, firstDone: true }))
    const run = async (r: ProbeRun) => {
      updateWatch(w.id, cur => ({ ...cur, next: Date.now() - 1 }))
      await once(r)
    }
    for (let streak = 0; streak < 4; streak++) {
      for (let i = 0; i < 3; i++) await run(result(2, '', { stderr: 'offline' }))
      await run(result(1))
    }
    const lines = () => listEntries().filter(e => /failed 3 times in a row/.test(e.text))
    assert.equal(lines().length, 1)
    assert.equal(lines()[0]?.watchId, w.id)
    // Delivered (the scheduler removed it): the next streak is told again.
    removeEntry(lines()[0]?.id)
    for (let i = 0; i < 3; i++) await run(result(2, '', { stderr: 'offline' }))
    assert.equal(lines().length, 1)
  })

  test('a line written by a run whose mark then failed is not sent again; it is marked', async () => {
    isolatedHome()
    const w = newWatch()
    updateWatch(w.id, cur => ({ ...cur, firstDone: true, errors: 2 }))
    // What the run that failed to mark left: the line in the schedule, the watch not told.
    addEntry({
      key: 's1',
      text: 'earlier line',
      at: Date.now(),
      next: Date.now(),
      watchId: w.id,
      watchNote: 'errorsTold',
    })
    await once(result(2, '', { stderr: 'offline' }))
    assert.deepEqual(
      listEntries().map(e => e.text),
      ['earlier line'],
    )
    assert.equal(getWatch(w.id)?.errorsTold, true)
  })
})
