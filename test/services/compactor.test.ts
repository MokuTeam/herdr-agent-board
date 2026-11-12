// Auto-compact (#378) against a fake herdr: sessions in panes whose context the status line's file
// says, cards with their limits, the compactor in a child process. /compact is a logged
// `herdr agent prompt` call; the run it leaves is on the session's card.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { asleepInFile, herdrAsleep, projectDir, SID as SLEEPER } from '../support/sleeper-fixtures.ts'

setDefaultTimeout(20_000)

const S1 = 'c0a1e5f2-0000-4000-8000-0000000000a1'
const S2 = 'c0a1e5f2-0000-4000-8000-0000000000a2'
const S3 = 'c0a1e5f2-0000-4000-8000-0000000000a3'

const RULE = '─'.repeat(40)
/** Claude's input box as `herdr agent read --ansi` shows it; `typed`: the owner's unsent text. */
const screen = (typed = ''): string =>
  ['● done', RULE, `❯ ${typed || '\x1b[2mtry: run the tests\x1b[0m'}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

type Pane = { pane: string; session: string; status: string }

/** herdr with Claude sessions in panes, each idle, working or blocked as given; the screen `typed` shows. */
function herdrWith(box: Sandbox, panes: Pane[], typed = ''): void {
  const cwd = folder(box)
  const state: Record<string, unknown> = {
    'api snapshot': {
      result: {
        snapshot: {
          panes: panes.map(p => ({
            pane_id: p.pane,
            agent: 'claude',
            agent_session: { value: p.session },
            agent_status: p.status,
            cwd,
            terminal_title_stripped: `Session ${p.pane}`,
          })),
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent read': { text: screen(typed) },
    'agent prompt': { result: {} },
  }
  for (const p of panes)
    state[`agent get ${p.pane}`] = {
      result: { agent: { agent: 'claude', agent_status: p.status, agent_session: { value: p.session } } },
    }
  box.state(state)
}

/** The sessions' folder: a space, Cyrillic and `%`, as the other setups' paths have. */
function folder(box: Sandbox): string {
  const dir = join(box.dir, 'Проект 100% x')
  mkdirSync(dir, { recursive: true })
  return dir
}

const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')

/** What the status line last wrote of a session's context: so many tokens of a 1M window, now. */
function context(box: Sandbox, session: string, tokens: number): void {
  const dir = join(stateDir(box), 'context')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${session}.json`),
    JSON.stringify({ at: Date.now(), tokens, usedPercentage: tokens / 10_000, size: 1_000_000 }),
  )
}

/** A session's transcript in the default profile's folder; `lines` after a first prompt. */
function transcript(box: Sandbox, session: string, lines: Record<string, unknown>[] = []): void {
  const dir = join(box.env.HOME as string, '.claude', 'projects', projectFolderName(folder(box)))
  mkdirSync(dir, { recursive: true })
  const first = { type: 'user', message: { content: 'watch the queue' }, timestamp: new Date(0).toISOString() }
  writeFileSync(join(dir, `${session}.jsonl`), `${[first, ...lines].map(l => JSON.stringify(l)).join('\n')}\n`)
}

const boundary = (at: number, pre: number, post: number) => ({
  type: 'system',
  subtype: 'compact_boundary',
  isSidechain: false,
  timestamp: new Date(at).toISOString(),
  compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post },
})

type Card = Record<string, unknown> & { compactRun?: Record<string, unknown> }
const cardFile = (box: Sandbox, key: string): string => join(box.cards, `${key}.json`)
function card(box: Sandbox, key: string, fields: Record<string, unknown>): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(cardFile(box, key), JSON.stringify({ key, ...fields }))
}
const cardOf = (box: Sandbox, key: string): Card | null =>
  existsSync(cardFile(box, key)) ? JSON.parse(readFileSync(cardFile(box, key), 'utf8')) : null

/** The prompts typed, with the pane each went to. */
const prompts = (box: Sandbox): { pane: string; text: string }[] =>
  box
    .calls()
    .filter(a => a[0] === 'agent' && a[1] === 'prompt')
    .map(a => ({ pane: String(a[2]), text: String(a[3]) }))
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function compactor(box: Sandbox, cfg: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  const proc = box.run(
    'compactor',
    { categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, compactTickSec: 0.1, ...cfg },
    extra,
  )
  return until(() => proc.messages.some(m => (m as { ready?: boolean }).ready)).then(() => proc)
}
const logs = (proc: { messages: unknown[] }): string[] =>
  proc.messages.map(m => (m as { log?: string }).log).filter((l): l is string => typeof l === 'string')

describe('auto-compact', () => {
  test('over its limit while idle: /compact goes in once, with its instructions, and the run is on its card', async () => {
    const box = await sandbox()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    transcript(box, S1)
    context(box, S1, 150_000)
    card(box, S1, { compactAt: '100k', compactNote: 'keep the ticket list' })
    const proc = await compactor(box)
    await until(() => prompts(box).length === 1)
    expect(prompts(box)).toEqual([{ pane: 'p1', text: '/compact keep the ticket list' }])
    expect(cardOf(box, S1)?.compactRun).toMatchObject({ state: 'sent', from: 150_000, limit: 100_000, setting: '100k' })
    // Ticks go on; the run on its way is not typed again.
    await sleep(800)
    expect(prompts(box)).toHaveLength(1)
    expect(logs(proc).some(l => /context 150k at or above 100k \(session\), \/compact typed/.test(l))).toBe(true)
  })

  test('reached mid-turn: nothing until the turn is over, then once', async () => {
    const box = await sandbox()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'working' }])
    transcript(box, S1)
    context(box, S1, 150_000)
    card(box, S1, { compactAt: '100k' })
    await compactor(box)
    await sleep(800)
    expect(prompts(box)).toEqual([])
    expect(cardOf(box, S1)?.compactRun).toBeUndefined()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    await until(() => prompts(box).length === 1)
    await sleep(500)
    expect(prompts(box)).toEqual([{ pane: 'p1', text: '/compact' }])
  })

  test("never into a dialog, a question waiting on the owner, the owner's unsent text, or a sleeping session", async () => {
    const box = await sandbox()
    herdrWith(box, [
      { pane: 'p1', session: S1, status: 'blocked' },
      { pane: 'p2', session: S2, status: 'idle' },
    ])
    for (const s of [S1, S2]) {
      transcript(box, s)
      context(box, s, 150_000)
    }
    card(box, S1, { compactAt: '100k' })
    card(box, S2, { compactAt: '100k', ask: 'Which branch?', askSince: Date.now() })
    await compactor(box)
    await sleep(1000)
    expect(prompts(box)).toEqual([])

    // An idle session with the owner's text in its input box: Enter would send that too.
    const draft = await sandbox()
    herdrWith(draft, [{ pane: 'p1', session: S1, status: 'idle' }], 'half a sentence')
    transcript(draft, S1)
    context(draft, S1, 150_000)
    card(draft, S1, { compactAt: '100k' })
    await compactor(draft)
    await sleep(1000)
    expect(prompts(draft)).toEqual([])

    // Asleep: not woken for it, nothing typed.
    const asleep = await sandbox()
    const cwd = projectDir(asleep)
    herdrAsleep(asleep, cwd)
    asleepInFile(asleep, { cwd })
    context(asleep, SLEEPER, 150_000)
    card(asleep, SLEEPER, { compactAt: '100k' })
    await compactor(asleep)
    await sleep(1000)
    const calls = asleep.calls().map(a => a.slice(0, 2).join(' '))
    expect(calls).toContain('api snapshot')
    expect(calls).not.toContain('agent prompt')
    expect(calls).not.toContain('pane run')
  })

  test("Settings' default applies; a session's own limit beats it, its own never beats both", async () => {
    const box = await sandbox()
    herdrWith(box, [
      { pane: 'p1', session: S1, status: 'idle' },
      { pane: 'p2', session: S2, status: 'idle' },
      { pane: 'p3', session: S3, status: 'idle' },
    ])
    for (const s of [S1, S2, S3]) {
      transcript(box, s)
      context(box, s, 150_000)
    }
    card(box, S2, { compactAt: '200k' })
    card(box, S3, { compactAt: 'never' })
    await compactor(box, { compact: { at: '100k', note: 'keep the open questions' } })
    await until(() => prompts(box).length >= 1)
    await sleep(800)
    expect(prompts(box)).toEqual([{ pane: 'p1', text: '/compact keep the open questions' }])
  })

  test('a compaction that leaves it above the limit holds it (no loop); below the limit again it is armed', async () => {
    const box = await sandbox()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    const typed = Date.now() - 60_000
    transcript(box, S1, [boundary(typed + 20_000, 612_000, 120_000)])
    context(box, S1, 120_000)
    card(box, S1, {
      compactAt: '100k',
      compactRun: { state: 'sent', at: typed, from: 612_000, limit: 100_000, setting: '100k' },
    })
    const proc = await compactor(box)
    await until(() => cardOf(box, S1)?.compactRun?.state === 'done')
    expect(cardOf(box, S1)?.compactRun).toMatchObject({
      state: 'done',
      from: 612_000,
      to: 120_000,
      doneAt: typed + 20_000,
      hold: true,
    })
    // Its time is kept, so the conversation marks this compaction as the board's.
    expect(cardOf(box, S1)?.compactDone).toEqual([typed + 20_000])
    await sleep(800)
    expect(prompts(box)).toEqual([])
    expect(
      logs(proc).some(l => /compacted 612k → 120k \(limit 100k\), still at or above the limit; held/.test(l)),
    ).toBe(true)
    // The owner's own /compact brought it down: armed again, and over the limit later it compacts.
    context(box, S1, 40_000)
    await until(() => cardOf(box, S1)?.compactRun?.hold === undefined)
    expect(prompts(box)).toEqual([])
    context(box, S1, 130_000)
    await until(() => prompts(box).length === 1)
    expect(prompts(box)).toEqual([{ pane: 'p1', text: '/compact' }])
  })

  test('a small summary but a first request after it still above the limit: measured there, held, no /compact on every turn', async () => {
    const box = await sandbox()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    const typed = Date.now() - 60_000
    const reply = (at: number, cached: number) => ({
      type: 'assistant',
      timestamp: new Date(at).toISOString(),
      message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: cached }, content: [] },
    })
    transcript(box, S1, [boundary(typed + 20_000, 612_000, 8_000)])
    // No request since the compaction: what the transcript says it left.
    context(box, S1, 8_000)
    card(box, S1, {
      compactAt: '30k',
      compactRun: { state: 'sent', at: typed, from: 612_000, limit: 30_000, setting: '30k' },
    })
    const proc = await compactor(box)
    await until(() => cardOf(box, S1)?.compactRun?.state === 'done')
    expect(cardOf(box, S1)?.compactRun).toMatchObject({ to: 8_000 })
    expect(cardOf(box, S1)?.compactRun?.hold).toBeUndefined()
    // The next turn: the system prompt and tools are back in the context, above the limit.
    transcript(box, S1, [boundary(typed + 20_000, 612_000, 8_000), reply(typed + 40_000, 41_000)])
    context(box, S1, 41_002)
    await until(() => cardOf(box, S1)?.compactRun?.measured === true)
    expect(cardOf(box, S1)?.compactRun).toMatchObject({ state: 'done', to: 41_002, measured: true, hold: true })
    await sleep(800)
    expect(prompts(box)).toEqual([])
    expect(
      logs(proc).some(l => /after the compaction the context is 41k, still at or above the limit; held/.test(l)),
    ).toBe(true)
  })

  test('a /compact no compaction followed holds it too, until its limit changes', async () => {
    const box = await sandbox()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    transcript(box, S1)
    context(box, S1, 150_000)
    const typed = Date.now() - 11 * 60_000
    card(box, S1, {
      compactAt: '100k',
      compactRun: { state: 'sent', at: typed, from: 150_000, limit: 100_000, setting: '100k' },
    })
    await compactor(box)
    await until(() => cardOf(box, S1)?.compactRun?.state === 'failed')
    expect(cardOf(box, S1)?.compactRun?.hold).toBe(true)
    await sleep(600)
    expect(prompts(box)).toEqual([])
    // Another limit: armed again, and the session is over it.
    card(box, S1, { ...cardOf(box, S1), compactAt: '120k' })
    await until(() => prompts(box).length === 1)
  })

  test('the setting and a run on its way survive a restart: the next board does not type it again', async () => {
    const box = await sandbox()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    transcript(box, S1)
    context(box, S1, 150_000)
    card(box, S1, { compactAt: '100k' })
    const first = await compactor(box)
    await until(() => prompts(box).length === 1)
    first.kill()
    await first.exited
    await compactor(box)
    await sleep(1000)
    expect(prompts(box)).toHaveLength(1)
    expect(cardOf(box, S1)).toMatchObject({ compactAt: '100k', compactRun: { state: 'sent' } })
  })

  test('nothing set anywhere: the compactor asks herdr nothing', async () => {
    const box = await sandbox()
    herdrWith(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    transcript(box, S1)
    context(box, S1, 900_000)
    card(box, S1, { category: 'other', doing: 'watching' })
    await compactor(box)
    await sleep(1000)
    expect(box.calls()).toEqual([])
  })
})
