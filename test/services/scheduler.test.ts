import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { clockIn, localZone } from '../../src/core/time.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(15_000)

// The scheduler runs in a child process against a fake herdr: entries are files in the sandbox's
// schedule folder, the session's prompt is a logged `herdr agent prompt` call.
const HOUR = 3600e3
const dirOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')

type Stored = Record<string, unknown> & { why?: string; pendingSince?: number; claim?: unknown; next: number }

function put(box: Sandbox, entry: Record<string, unknown>): void {
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(
    join(dirOf(box), `${entry.id}.json`),
    JSON.stringify({ key: 's1', name: 'Test', created: Date.now(), ...entry }),
  )
}
const read = (box: Sandbox, id: string): Stored | null =>
  existsSync(join(dirOf(box), `${id}.json`)) ? JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) : null
const runs = (box: Sandbox): Record<string, unknown>[] =>
  existsSync(join(dirOf(box), 'log.jsonl'))
    ? readFileSync(join(dirOf(box), 'log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
const prompts = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(a => a[1] === 'prompt')
    .map(a => a[3] as string)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
/** The start of the current minute: an entry due then is not late (that takes two minutes). */
const thisMinute = (): number => Math.floor(Date.now() / 60_000) * 60_000

/** Claude's input box as `herdr agent read --ansi` shows it; a suggestion is drawn dim. */
const RULE = '─'.repeat(40)
const screen = (typed = '', dim = ''): string =>
  ['● done', RULE, `❯ ${typed}${dim ? `\x1b[2m${dim}\x1b[0m` : ''}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

/** herdr with one Claude session s1 in pane p1. */
function herdrWith(box: Sandbox, status: string, extra: Record<string, unknown> = {}): void {
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: status, cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: 's1' } } } },
    'agent read': { text: screen('', 'try: run the tests') },
    'agent prompt': { result: {} },
    ...extra,
  })
}

async function scheduler(box: Sandbox, cfg: Record<string, unknown> = {}) {
  const proc = box.run('scheduler', {
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    scheduleTickSec: 0.2,
    ...cfg,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}

/** Two idle sessions s1 (pane p1) and another (pane p2). */
function twoSessions(box: Sandbox, other: string): void {
  const snapshot = {
    panes: ['s1', other].map((s, i) => ({
      pane_id: `p${i + 1}`,
      agent: 'claude',
      agent_session: { value: s },
      agent_status: 'idle',
    })),
    tabs: [],
    workspaces: [],
  }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get p1': { result: { agent: { agent_status: 'idle', agent_session: { value: 's1' } } } },
    'agent get p2': { result: { agent: { agent_status: 'idle', agent_session: { value: other } } } },
    'agent read': { text: screen() },
    'agent prompt': { result: {} },
  })
}

describe('startScheduler', () => {
  test('a due reminder goes into an idle session, then it is gone and logged', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle')
    put(box, { id: 'aaaaa1', text: 'check the CI run', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(box)
    await until(() => prompts(box).length === 1 && runs(box).length === 1)
    assert.deepEqual(prompts(box), ['[board reminder] check the CI run'])
    assert.equal(read(box, 'aaaaa1'), null)
    assert.equal(runs(box)[0]?.result, 'sent')
  })

  test('after the board was off: a one-off says how late, a cron entry runs once for all it missed', async () => {
    const box = await sandbox()
    const top = new Date()
    top.setMinutes(0, 0, 0)
    put(box, { id: 'bbbbb1', text: 'late one', at: Date.now() - 3 * HOUR, next: Date.now() - 3 * HOUR })
    put(box, { id: 'bbbbb2', key: 's2', text: 'hourly', cron: '0 * * * *', next: top.getTime() - 3 * HOUR })
    twoSessions(box, 's2')
    await scheduler(box)
    await until(() => prompts(box).length === 2 && runs(box).length === 2)
    const [late] = prompts(box).filter(p => p.endsWith('late one'))
    expect(late).toMatch(/^\[board reminder; 3 h late, due .+\] late one$/)
    const [hourly] = prompts(box).filter(p => p.endsWith('hourly'))
    expect(hourly).toMatch(/^\[board schedule bbbbb2: 0 \* \* \* \*; 4 runs since .+, sent once\] hourly$/)
    const cron = read(box, 'bbbbb2')
    assert.ok(cron && cron.next > Date.now())
    assert.equal(cron.runs, 1)
    assert.equal(cron.claim, undefined)
  })

  test("#806 a cron entry's next run is on the owner's clock (time.zone); without one, on this computer's", async () => {
    const other = localZone() === 'Pacific/Kiritimati' ? 'Asia/Yerevan' : 'Pacific/Kiritimati'
    const zoned = await sandbox()
    herdrWith(zoned, 'idle')
    put(zoned, { id: 'dddd01', text: 'monitor', cron: '57 7 * * *', next: thisMinute() })
    await scheduler(zoned, { time: { zone: other } })
    await until(() => runs(zoned).length === 1)
    const z = read(zoned, 'dddd01')
    assert.ok(z && z.next > Date.now())
    assert.deepEqual(clockIn(z.next, other), [7, 57, 0])

    const plain = await sandbox()
    herdrWith(plain, 'idle')
    put(plain, { id: 'dddd02', text: 'monitor', cron: '57 7 * * *', next: thisMinute() })
    await scheduler(plain)
    await until(() => runs(plain).length === 1)
    const p = read(plain, 'dddd02')
    assert.ok(p && p.next > Date.now())
    assert.deepEqual([new Date(p.next).getHours(), new Date(p.next).getMinutes()], [7, 57])
  })

  test('on time, a working session gets it queued into its turn; a dialog and a draft still hold it', async () => {
    const box = await sandbox()
    herdrWith(box, 'working')
    put(box, { id: 'cdcd01', text: 'mid-turn', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(box)
    await until(() => prompts(box).length === 1)
    assert.deepEqual(prompts(box), ['[board reminder] mid-turn'])

    const dialog = await sandbox()
    herdrWith(dialog, 'blocked')
    put(dialog, { id: 'cdcd02', text: 'not into a dialog', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(dialog)
    await until(() => read(dialog, 'cdcd02')?.why === 'dialog')

    const draft = await sandbox()
    herdrWith(draft, 'working', { 'agent read': { text: screen('the user types') } })
    put(draft, { id: 'cdcd03', text: 'not over a draft', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(draft)
    await until(() => read(draft, 'cdcd03')?.why === 'draft')
    await sleep(400)
    assert.deepEqual([...prompts(dialog), ...prompts(draft)], [])
  })

  test("a Codex session: a reminder is not typed over a draft in its composer; Claude's screen read stays Claude's", async () => {
    const codexHerdr = (box: Sandbox, status: string, text: string): void => {
      const snapshot = {
        panes: [{ pane_id: 'p1', agent: 'codex', agent_session: { value: 's1' }, agent_status: status, cwd: box.dir }],
        tabs: [],
        workspaces: [],
      }
      box.state({
        'api snapshot': { result: { snapshot } },
        'agent get': { result: { agent: { agent: 'codex', agent_status: status, agent_session: { value: 's1' } } } },
        'agent read': { text },
        'agent prompt': { result: {} },
      })
    }
    const free = await sandbox()
    codexHerdr(free, 'idle', '\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[0m\n \x1b[2m? for shortcuts\x1b[0m')
    put(free, { id: 'cdcd11', text: 'into the empty composer', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(free)
    await until(() => prompts(free).length === 1)
    assert.deepEqual(prompts(free), ['[board reminder] into the empty composer'])

    const draft = await sandbox()
    codexHerdr(draft, 'working', '\x1b[1m›\x1b[22m the user types\n \x1b[2m? for shortcuts\x1b[0m')
    put(draft, { id: 'cdcd12', text: 'not over a draft', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(draft)
    await until(() => read(draft, 'cdcd12')?.why === 'draft')
    await sleep(400)
    assert.deepEqual(prompts(draft), [])
  })

  test('--idle: a working session gets it once it is free; one that stays busy has it logged as missed', async () => {
    const box = await sandbox()
    herdrWith(box, 'working')
    put(box, { id: 'ccccc1', idle: true, text: 'when free', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(box, { scheduleWaitMin: 1 })
    await until(() => read(box, 'ccccc1')?.pendingSince)
    await sleep(600)
    assert.deepEqual(prompts(box), [])
    assert.equal(read(box, 'ccccc1')?.why, 'busy')
    herdrWith(box, 'idle')
    await until(() => prompts(box).length === 1)
    assert.deepEqual(prompts(box), ['[board reminder] when free'])

    const busy = await sandbox()
    herdrWith(busy, 'blocked')
    put(busy, { id: 'ccccc2', idle: true, text: 'never free', at: Date.now() - 1000, next: Date.now() - 1000 })
    put(busy, { id: 'ccccc3', key: 's1', text: 'cron never free', cron: '* * * * *', next: Date.now() - 1000 })
    await scheduler(busy, { scheduleWaitMin: 0.01 })
    await until(() => runs(busy).length >= 2, 8000)
    assert.deepEqual(prompts(busy), [])
    assert.ok(runs(busy).every(r => r.result === 'missed' && r.why === 'dialog'))
    assert.equal(read(busy, 'ccccc2'), null)
    const cron = read(busy, 'ccccc3')
    assert.ok(cron)
    assert.equal(cron.missed, 1)
    assert.ok(cron.next > Date.now() - 1000)
    assert.equal(cron.pendingSince, undefined)
  })

  test('reminders due for one session in one minute go as one prompt, a line each (#306)', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle')
    // Due in this minute, so none of them is late (that takes two minutes); one in the minute
    // before goes on its own.
    const at = (ms: number) => {
      const t = thisMinute() + ms
      return { at: t, next: t, created: t }
    }
    put(box, { id: 'abab01', text: 'check the CI run', ...at(0) })
    put(box, { id: 'abab02', text: 'ping anna about 50% of the sheet', ...at(1) })
    put(box, { id: 'abab03', text: 'проверить отчёт', from: { key: 's9', name: 'ben atlas' }, ...at(2) })
    put(box, { id: 'abab04', text: 'the minute before', ...at(-60_000) })
    await scheduler(box)
    await until(() => runs(box).length === 4, 12_000)
    await sleep(400)
    const [before, joined] = prompts(box)
    expect(before).toMatch(/^\[board reminder(; .+)?\] the minute before$/)
    assert.equal(
      joined,
      [
        '[board reminder] check the CI run',
        '[board reminder] ping anna about 50% of the sheet',
        '[board reminder from ben atlas] проверить отчёт',
      ].join('\n'),
    )
    assert.equal(prompts(box).length, 2)
    assert.ok(runs(box).every(r => r.result === 'sent'))
    assert.deepEqual(
      runs(box)
        .map(r => r.id)
        .sort(),
      ['abab01', 'abab02', 'abab03', 'abab04'],
    )
    for (const id of ['abab01', 'abab02', 'abab03', 'abab04']) assert.equal(read(box, id), null)

    // Two in one minute: one prompt.
    const two = await sandbox()
    herdrWith(two, 'idle')
    put(two, { id: 'acac01', text: 'first', ...at(0) })
    put(two, { id: 'acac02', text: 'second', ...at(1) })
    await scheduler(two)
    await until(() => runs(two).length === 2, 12_000)
    await sleep(400)
    assert.deepEqual(prompts(two), ['[board reminder] first\n[board reminder] second'])
  })

  test('cron entries, --idle ones beside plain ones and another session go on their own (#306)', async () => {
    const box = await sandbox()
    twoSessions(box, 's2')
    const minute = thisMinute()
    const at = { next: minute, created: minute }
    put(box, { id: 'adad01', text: 'plain', at: minute, ...at })
    put(box, { id: 'adad02', text: 'hourly', cron: '* * * * *', ...at })
    put(box, { id: 'adad03', text: 'when free', idle: true, at: minute, ...at })
    put(box, { id: 'adad04', key: 's2', name: 'Other', text: 'for the other one', at: minute, ...at })
    await scheduler(box)
    await until(() => prompts(box).length === 4 && runs(box).length === 4, 12_000)
    await sleep(400)
    const got = prompts(box)
    assert.equal(got.length, 4)
    assert.ok(got.every(p => !p.includes('\n')))
    assert.ok(got.includes('[board reminder] plain'))
    assert.ok(got.includes('[board reminder] when free'))
    assert.ok(got.includes('[board reminder] for the other one'))
    assert.ok(got.some(p => /^\[board schedule adad02: \* \* \* \* \*.*\] hourly$/.test(p)))
  })

  test('reminders held by a dialog stay together and go as one prompt once it is gone (#306)', async () => {
    const box = await sandbox()
    herdrWith(box, 'blocked')
    const now = Date.now() - 1000
    put(box, { id: 'aeae01', text: 'one', at: now, next: now, created: now })
    await scheduler(box)
    await until(() => read(box, 'aeae01')?.why === 'dialog')
    // One more comes due while the first waits.
    put(box, { id: 'aeae02', text: 'two', at: now, next: now, created: now + 1 })
    await until(() => read(box, 'aeae02')?.why === 'dialog')
    await sleep(400)
    herdrWith(box, 'idle')
    await until(() => runs(box).length === 2, 12_000)
    await sleep(400)
    assert.deepEqual(prompts(box), ['[board reminder] one\n[board reminder] two'])
  })

  test('a restart, a sleep, a call report and a retry-safe report never join a reminder (#306)', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle')
    const minute = thisMinute()
    const at = (n: number) => ({ at: minute, next: minute, created: minute + n })
    put(box, { id: 'afaf01', text: 'plain', ...at(0) })
    put(box, { id: 'afaf02', kind: 'call', text: '# Call with cleo\nShip it.', ...at(1) })
    put(box, { id: 'afaf03', kind: 'restart', text: 'after the restart', ...at(2) })
    put(box, { id: 'afaf04', kind: 'sleep', text: '', ...at(3) })
    put(box, {
      id: 'afaf05',
      text: 'a report',
      receipt: { key: 's1', session: 's1', reportId: 'r1', hash: 'h' },
      ...at(4),
    })
    await scheduler(box)
    await until(() => prompts(box).length >= 2 && !read(box, 'afaf01') && !read(box, 'afaf02'), 12_000)
    await sleep(600)
    assert.equal(prompts(box)[0], '[board reminder] plain')
    assert.ok(prompts(box).every(p => !p.includes('[board reminder] plain\n')))
    assert.ok(prompts(box).some(p => p.startsWith('[mokupilot call report]\n# Call with cleo')))
  })

  test('a sleeping session is woken once for reminders due together; a no-wake one waits (#306)', async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
    let wakes = 0
    const wake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/sleeping') {
        return res.end(
          JSON.stringify(
            wakes ? [] : [{ session: 's1', pane: 'p1', name: 'Sleepy', slept_at: new Date().toISOString() }],
          ),
        )
      }
      wakes++
      herdrWith(box, 'idle')
      res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
    try {
      const minute = thisMinute()
      const at = (n: number) => ({ at: minute, next: minute, created: minute + n })
      put(box, { id: 'a9a901', text: 'wake up', ...at(0) })
      put(box, { id: 'a9a902', text: 'and this', ...at(1) })
      put(box, {
        id: 'a9a903',
        text: 'atlas-12 done',
        from: { key: 'threads', name: 'threads' },
        noWake: true,
        ...at(2),
      })
      await scheduler(box, { wakeUrl: `http://127.0.0.1:${(wake.address() as AddressInfo).port}` })
      await until(() => prompts(box).length === 2, 12_000)
      await sleep(400)
      assert.equal(wakes, 1)
      assert.deepEqual(prompts(box), [
        '[board reminder] wake up\n[board reminder] and this',
        '[board reminder from threads] atlas-12 done',
      ])
    } finally {
      await new Promise(resolve => wake.close(resolve))
    }
  })

  test('long reminders due together go in more than one prompt, none over the cap (#306)', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle')
    const minute = thisMinute()
    const long = (c: string) => c.repeat(2000)
    for (const [i, c] of ['a', 'b', 'c', 'd', 'e'].entries())
      put(box, { id: `a7a70${i}`, text: long(c), at: minute, next: minute, created: minute + i })
    await scheduler(box)
    await until(() => runs(box).length === 5, 12_000)
    await sleep(400)
    // 8000 characters of text at most: three of them, then the other two.
    assert.deepEqual(
      prompts(box).map(p => p.split('\n').length),
      [3, 2],
    )
  })

  test('a pi session gets each reminder in a prompt of its own, as before (#306)', async () => {
    const box = await sandbox()
    const snapshot = {
      panes: [{ pane_id: 'p1', agent: 'pi', agent_status: 'idle', cwd: box.dir }],
      tabs: [],
      workspaces: [],
    }
    box.state({
      'api snapshot': { result: { snapshot } },
      'agent get': { result: { agent: { agent: 'pi', agent_status: 'idle' } } },
      'agent read': { text: screen() },
      'agent prompt': { result: {} },
    })
    const minute = thisMinute()
    put(box, { id: 'a8a801', key: 'pane-p1', name: 'pi one', text: 'first', at: minute, next: minute, created: minute })
    put(box, {
      id: 'a8a802',
      key: 'pane-p1',
      name: 'pi one',
      text: 'second',
      at: minute,
      next: minute,
      created: minute + 1,
    })
    await scheduler(box)
    await until(() => runs(box).length === 2, 12_000)
    await sleep(400)
    assert.deepEqual(prompts(box), ['[board reminder] first', '[board reminder] second'])
  })

  test('text the user left in the input box holds the reminder back until it is gone', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle', { 'agent read': { text: screen('half a thought') } })
    put(box, { id: 'ddddd2', text: 'not over your draft', at: Date.now() - 1000, next: Date.now() - 1000 })
    await scheduler(box)
    await until(() => read(box, 'ddddd2')?.why === 'draft')
    assert.deepEqual(prompts(box), [])
    herdrWith(box, 'idle')
    await until(() => prompts(box).length === 1)
    assert.deepEqual(prompts(box), ['[board reminder] not over your draft'])
  })

  test('after /clear the reminder goes to the new session in the same pane and folder', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle')
    // Set by session s0, which /clear replaced with s1 in pane p1.
    put(box, {
      id: 'ddddd3',
      key: 's0',
      pane: 'p1',
      cwd: box.dir,
      text: 'still yours',
      at: Date.now() - 1000,
      next: Date.now() - 1000,
    })
    put(box, {
      id: 'ddddd4',
      key: 's8',
      pane: 'p1',
      cwd: join(box.dir, 'elsewhere'),
      text: 'another folder',
      at: Date.now() - 1000,
      next: Date.now() - 1000,
    })
    await scheduler(box)
    await until(() => prompts(box).length === 1 && runs(box).length === 1)
    // The receiver hears it was set before /clear, so it can judge whether it still applies.
    assert.deepEqual(prompts(box), ['[board reminder; set by Test before /clear] still yours'])
    assert.equal(runs(box)[0]?.key, 's1')
    await until(() => read(box, 'ddddd4')?.why === 'gone')
  })

  test('a reminder set in a work session never goes to a default session now in its pane and folder', async () => {
    const box = await sandbox()
    const home = join(box.dir, 'home')
    for (const name of ['.claude', '.claude-work']) {
      mkdirSync(join(home, name), { recursive: true })
      writeFileSync(join(home, name, 'settings.json'), '{}')
    }
    herdrWith(box, 'idle')
    // s0 ran in work and is gone (exited); s1, started with `cld` in its pane and folder, reports the default folder.
    mkdirSync(box.cards, { recursive: true })
    const card = (key: string, dir: string) =>
      writeFileSync(join(box.cards, `${key}.json`), JSON.stringify({ key, profileDir: dir }))
    card('s0', join(home, '.claude-work'))
    card('s1', join(home, '.claude'))
    const past = Date.now() - 1000
    put(box, {
      id: 'dddd05',
      key: 's0',
      name: 'work one',
      pane: 'p1',
      cwd: box.dir,
      text: 'for work',
      at: past,
      next: past,
    })
    await scheduler(box, {
      profiles: [
        { id: 'default', title: 'Private', dir: join(home, '.claude'), color: 'indigo', hidden: false },
        { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
      ],
    })
    const why =
      'The session now in its pane runs in profile Private, not in Work, where this was set, so it does not go there; if it is for that session, set it there again'
    await until(() => read(box, 'dddd05')?.why === why)
    const first = read(box, 'dddd05')?.tried
    // Tried again on a later tick, and held again: still for s0, nothing typed.
    await until(() => {
      const e = read(box, 'dddd05')
      return e?.tried !== first && e?.why === why
    })
    expect(read(box, 'dddd05')).toMatchObject({ key: 's0', pendingSince: expect.any(Number) })
    assert.deepEqual(prompts(box), [])
    assert.deepEqual(runs(box), [])
    // The session in its pane runs in work after all (its hooks say so): the reminder follows it there.
    card('s1', join(home, '.claude-work'))
    await until(() => prompts(box).length === 1)
    assert.deepEqual(prompts(box), ['[board reminder; set by work one before /clear] for work'])
  })

  test('a reminder set for another session says who set it', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle')
    const past = Date.now() - 1000
    put(box, {
      id: 'abab01',
      text: 'review my PR',
      at: past,
      next: past,
      from: { key: 's7', name: 'lead-session' },
    })
    await scheduler(box)
    await until(() => prompts(box).length === 1)
    assert.deepEqual(prompts(box), ['[board reminder from lead-session] review my PR'])
    // Set by s7 for s0, which /clear turned into s1: both are said.
    put(box, {
      id: 'abab02',
      key: 's0',
      name: 'old',
      pane: 'p1',
      cwd: box.dir,
      text: 'cron',
      cron: '0 * * * *',
      next: past,
      from: { key: 's7', name: 'lead-session' },
    })
    await until(() => prompts(box).length === 2)
    assert.equal(
      prompts(box)[1],
      '[board schedule abab02 from lead-session: 0 * * * *; set for old before /clear] cron',
    )
    // Its own reminder has no "from", also after /clear.
    put(box, {
      id: 'abab03',
      key: 's0',
      name: 'old',
      pane: 'p1',
      cwd: box.dir,
      text: 'mine',
      at: past,
      next: past,
      from: { key: 's0', name: 'old' },
    })
    await until(() => prompts(box).length === 3)
    assert.equal(prompts(box)[2], '[board reminder; set by old before /clear] mine')
  })

  test('a cron entry whose session stays gone is dropped after three runs in a row', async () => {
    const box = await sandbox()
    herdrWith(box, 'idle')
    const past = Date.now() - 1000
    put(box, { id: 'acac01', key: 's-gone', text: 'orphan', cron: '0 * * * *', next: past, gone: 2, missed: 2 })
    put(box, { id: 'acac02', key: 's-gone2', text: 'first miss', cron: '0 * * * *', next: past })
    await scheduler(box, { scheduleWaitMin: 0.01 })
    await until(() => runs(box).length === 2, 8000)
    assert.equal(read(box, 'acac01'), null)
    const dropped = runs(box).find(r => r.id === 'acac01')
    assert.equal(dropped?.result, 'dropped')
    assert.equal(dropped?.n, 3)
    const kept = read(box, 'acac02')
    assert.equal(kept?.gone, 1)
    assert.equal(kept?.missed, 1)
    assert.equal(runs(box).find(r => r.id === 'acac02')?.result, 'missed')
    assert.deepEqual(prompts(box), [])
  })

  test('a sleeping session is woken through herdr-wake before it gets the text', async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
    let wakes = 0
    const wake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/sleeping') {
        return res.end(
          JSON.stringify(
            wakes ? [] : [{ session: 's1', pane: 'p1', name: 'Sleepy', slept_at: new Date().toISOString() }],
          ),
        )
      }
      assert.equal(req.url, '/wake')
      wakes++
      herdrWith(box, 'idle')
      res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
    try {
      put(box, { id: 'ddddd1', text: 'wake up', at: Date.now() - 1000, next: Date.now() - 1000 })
      await scheduler(box, { wakeUrl: `http://127.0.0.1:${(wake.address() as AddressInfo).port}` })
      await until(() => prompts(box).length === 1)
      assert.equal(wakes, 1)
      assert.deepEqual(prompts(box), ['[board reminder] wake up'])
    } finally {
      await new Promise(resolve => wake.close(resolve))
    }
  })

  test('a reminder that would wake a work session started outside the board is held with the reason', async () => {
    const box = await sandbox()
    const home = join(box.dir, 'home')
    for (const name of ['.claude', '.claude-work']) {
      mkdirSync(join(home, name), { recursive: true })
      writeFileSync(join(home, name, 'settings.json'), '{}')
    }
    // The sleeper's card: its hooks reported the work folder. Its pane is a plain terminal now.
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(join(box.cards, 's1.json'), JSON.stringify({ key: 's1', profileDir: join(home, '.claude-work') }))
    const panes = [{ pane_id: 'p1', terminal_id: 'term-1' }]
    box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
    let wakes = 0
    const wake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/sleeping')
        return res.end(
          JSON.stringify([{ session: 's1', pane: 'p1', name: 'Sleepy', slept_at: new Date().toISOString() }]),
        )
      wakes++
      res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
    try {
      put(box, { id: 'dddd02', text: 'wake up', at: Date.now() - 1000, next: Date.now() - 1000 })
      await scheduler(box, {
        wakeUrl: `http://127.0.0.1:${(wake.address() as AddressInfo).port}`,
        profiles: [
          { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
          { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
        ],
      })
      const why =
        'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it'
      await until(() => read(box, 'dddd02')?.why === why)
      const first = read(box, 'dddd02')?.tried
      // Tried again on a later tick, and held again.
      await until(() => {
        const e = read(box, 'dddd02')
        return e?.tried !== first && e?.why === why
      })
      const held = read(box, 'dddd02')
      assert.ok(held)
      assert.equal(typeof held.pendingSince, 'number')
      assert.equal(wakes, 0)
      assert.deepEqual(prompts(box), [])
      assert.deepEqual(runs(box), [])
    } finally {
      await new Promise(resolve => wake.close(resolve))
    }
  })

  test('a run another board claimed is left alone until its claim runs out', async () => {
    const box = await sandbox()
    put(box, {
      id: 'eeeee1',
      text: 'claimed',
      at: Date.now() - 1000,
      next: Date.now() - 1000,
      claim: { pid: process.pid, at: Date.now() },
    })
    put(box, {
      id: 'eeeee2',
      key: 's9',
      text: 'stale claim',
      at: Date.now() - 1000,
      next: Date.now() - 1000,
      claim: { pid: process.pid, at: Date.now() - 600_000 },
    })
    twoSessions(box, 's9')
    await scheduler(box)
    await until(() => prompts(box).length === 1)
    await sleep(800)
    assert.deepEqual(prompts(box), ['[board reminder] stale claim'])
    assert.ok(read(box, 'eeeee1'))
  })

  test('an entry cancelled while its run is on the way stays cancelled', async () => {
    const box = await sandbox()
    const gate = join(box.dir, 'prompt-gate')
    herdrWith(box, 'idle', { 'agent prompt': { result: {}, waitFor: gate } })
    put(box, { id: 'fffff1', text: 'every minute', cron: '* * * * *', next: Date.now() - 1000 })
    await scheduler(box)
    await until(() => prompts(box).length === 1)
    // `board unschedule`, as an agent runs it; no board answers on port 9.
    const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ language: 'en', port: 9 }))
    const out = await box.run('cli', { args: ['unschedule', 'fffff1'], env: {} }).exited
    expect(`${out.stdout}${out.stderr}`).toMatch(/removed fffff1/)
    writeFileSync(gate, '')
    await until(() => runs(box).length === 1)
    await sleep(300)
    assert.equal(read(box, 'fffff1'), null)
  })
})

test('a call report waits for a working session, then goes in as information; the log keeps its title', async () => {
  const box = await sandbox()
  herdrWith(box, 'working')
  const text = '# Release 2.4 call\n\n- Decided: ship on Monday'
  put(box, { id: 'dddd01', kind: 'call', idle: true, text, at: Date.now() - 1000, next: Date.now() - 1000 })
  await scheduler(box)
  await until(() => read(box, 'dddd01')?.pendingSince)
  assert.deepEqual(prompts(box), [])
  herdrWith(box, 'idle')
  await until(() => prompts(box).length === 1 && runs(box).length === 1)
  const [prompt = ''] = prompts(box)
  assert.ok(prompt.startsWith(`[mokupilot call report]\n${text}\n\nThis is for your information`), prompt)
  assert.deepEqual([runs(box)[0]?.result, runs(box)[0]?.kind, runs(box)[0]?.text], ['sent', 'call', 'Release 2.4 call'])
  assert.equal(read(box, 'dddd01'), null)
})
