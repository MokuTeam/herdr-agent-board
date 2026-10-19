import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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
