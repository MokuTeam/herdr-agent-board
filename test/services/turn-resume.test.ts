// Integration and isolation tests for continue-after-restart (#633):
// - Active Claude turn writes midTurn mark and clears it when the turn ends
// - Board/computer restart with session returning idle drops mark first and sends one continue via scheduler
// - Overlapping boards race: two createTurnResume instances claim at most once
// - Skip with reason on different session, timeout, asleep, and same-process turn completion
// - Herdr crash/restart while board stays running (observeFailure -> recovery)
// - Settings switch via POST /api/settings (turnResume: false/true and invalid 409)
// - Other setups (pi with spaces/Cyrillic/% and Windows paths, codex, agy, pane-<id>, MokuPilot day/call) untouched
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { configFile } from '../../src/adapters/config-file.ts'
import { listEntries, readLog } from '../../src/adapters/schedule-store.ts'
import { TURN_RESUME_KIND, TURN_RESUME_TEXT } from '../../src/core/turn-resume.ts'
import type { Item } from '../../src/core/types.ts'
import { createTurnResume } from '../../src/services/turn-resume.ts'
import { type BoardMessage, logged, serveBoard } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const S1 = '33333333-3333-4333-8333-333333333331'
const S2 = '33333333-3333-4333-8333-333333333332'
const CODEX_SID = '44444444-4444-4444-8444-444444444444'
const AGY_SID = '55555555-5555-4555-8555-555555555555'
const DAY_SID = '66666666-6666-4666-8666-666666666666'
const CALL_SID = '77777777-7777-4777-8777-777777777777'

const RULE = '─'.repeat(40)
const screen = (typed = ''): string =>
  ['● done', RULE, `❯ ${typed || '\x1b[2mtry: run the tests\x1b[0m'}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

const cardPath = (box: Sandbox, key: string): string => join(box.cards, `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
const readBoxCard = (box: Sandbox, key: string): Record<string, unknown> | null =>
  existsSync(cardPath(box, key)) ? JSON.parse(readFileSync(cardPath(box, key), 'utf8')) : null
const scheduleFiles = (box: Sandbox): string[] => {
  const dir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
  if (!existsSync(dir)) return []
  return Array.from(new Bun.Glob('*.json').scanSync(dir))
}
const scheduleLog = (box: Sandbox): Record<string, unknown>[] => {
  const file = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule/log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
}
const prompts = (box: Sandbox): { pane: string; text: string }[] =>
  box
    .calls()
    .filter(a => a[0] === 'agent' && a[1] === 'prompt')
    .map(a => ({ pane: String(a[2]), text: String(a[3]) }))

function claudeHerdr(box: Sandbox, panes: { pane: string; session: string | null; status: string; cwd?: string }[]) {
  const cwd = join(box.dir, 'Проект 100% x')
  mkdirSync(cwd, { recursive: true })
  const state: Record<string, unknown> = {
    'api snapshot': {
      result: {
        snapshot: {
          panes: panes.map(p => ({
            pane_id: p.pane,
            agent: 'claude',
            ...(p.session ? { agent_session: { value: p.session } } : {}),
            agent_status: p.status,
            cwd: p.cwd ?? cwd,
            terminal_title_stripped: `Session ${p.pane}`,
          })),
          tabs: [],
          workspaces: [],
        },
      },
    },
    'agent read': { text: screen() },
    'agent prompt': { result: {} },
  }
  for (const p of panes) {
    state[`agent get ${p.pane}`] = {
      result: {
        agent: {
          agent: 'claude',
          agent_status: p.status,
          ...(p.session ? { agent_session: { value: p.session } } : {}),
        },
      },
    }
  }
  box.state(state)
  return cwd
}

async function refreshServer(proc: Child): Promise<void> {
  const before = proc.messages.filter(m => (m as BoardMessage).refreshed).length
  proc.send('refresh')
  await until(() => proc.messages.filter(m => (m as BoardMessage).refreshed).length > before)
}

function claudeItem(overrides: Partial<Item> = {}): Item {
  return {
    key: S1,
    session: S1,
    pane: 'p1',
    workspace: 'ws',
    cwd: '/work/atlas',
    status: 'idle',
    name: 'anna',
    autoName: 'anna',
    category: 'other',
    categorySet: false,
    column: 'idle',
    attention: '',
    agent: 'claude',
    sleeping: false,
    ...overrides,
  }
}

describe('turn-resume service (#633)', () => {
  test('marks active Claude turn on card and clears it when the turn ends normally', async () => {
    const box = await sandbox()
    claudeHerdr(box, [{ pane: 'p1', session: S1, status: 'working' }])
    const { proc } = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })

    await until(() => readBoxCard(box, S1)?.midTurn !== undefined)
    const marked = readBoxCard(box, S1)?.midTurn as Record<string, unknown>
    expect(marked.session).toBe(S1)
    expect(marked.pane).toBe('p1')
    expect(typeof marked.startedAt).toBe('number')

    claudeHerdr(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    await refreshServer(proc)
    await until(() => readBoxCard(box, S1)?.midTurn === undefined)

    await Bun.sleep(150)
    expect(prompts(box)).toEqual([])
    expect(scheduleFiles(box)).toEqual([])
    proc.kill()
    await proc.exited
  })

  test('after board restart, sends one continue when session returns idle and drops mark before sending', async () => {
    const box = await sandbox()
    claudeHerdr(box, [{ pane: 'p1', session: S1, status: 'working' }])
    const first = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })
    await until(() => readBoxCard(box, S1)?.midTurn !== undefined)

    // Board crashes / stops while session is mid-turn: mark survives on disk.
    first.proc.kill()
    await first.proc.exited
    expect(readBoxCard(box, S1)?.midTurn).toBeDefined()

    // Computer/herdr restarts and session resumes idle.
    claudeHerdr(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    const second = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })

    await until(() => prompts(box).length === 1 && scheduleLog(box).length === 1)
    expect(prompts(box)).toEqual([{ pane: 'p1', text: `[board reminder] ${TURN_RESUME_TEXT}` }])
    expect(readBoxCard(box, S1)?.midTurn).toBeUndefined()
    expect(scheduleFiles(box)).toEqual([])
    expect(logged(second.proc, 'queued continue after restart')).toBe(true)

    // A second restart does NOT send another continue.
    second.proc.kill()
    await second.proc.exited
    const third = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })
    await refreshServer(third.proc)
    await Bun.sleep(150)
    expect(prompts(box)).toHaveLength(1)
    third.proc.kill()
    await third.proc.exited
  })

  test('overlapping boards claim the mark atomically so only one continue is scheduled', () => {
    isolatedHome()
    writeCard(S1, { name: 'anna', midTurn: { session: S1, startedAt: 1000, pane: 'p1' } })
    const logsA: string[] = []
    const logsB: string[] = []
    const a = createTurnResume({ cfg: {}, log: line => logsA.push(line) })
    const b = createTurnResume({ cfg: {}, log: line => logsB.push(line) })

    const idle = [claudeItem({ status: 'idle' })]
    a.observe(idle)
    b.observe(idle)

    const entries = listEntries().filter(e => e.key === S1 && e.kind === TURN_RESUME_KIND)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe(TURN_RESUME_TEXT)
    expect(readCard(S1)?.midTurn).toBeUndefined()
    expect(logsA.some(l => l.includes('queued continue after restart'))).toBe(true)
    expect(logsB.some(l => l.includes('mark already claimed'))).toBe(true)
    a.stop()
    b.stop()
  })

  test('skips with reason when another session returns in the pane, on timeout, or on same-process completion', async () => {
    const box = await sandbox()
    // 1. Different session returns in the same pane
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(
      cardPath(box, S1),
      JSON.stringify({ key: S1, name: 'anna', midTurn: { session: S1, startedAt: 1000, pane: 'p1' } }),
    )
    claudeHerdr(box, [{ pane: 'p1', session: S2, status: 'idle' }])
    const srv1 = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })
    await until(() => logged(srv1.proc, 'skipped') && readBoxCard(box, S1)?.midTurn === undefined)
    expect(logged(srv1.proc, 'came back with another session')).toBe(true)
    expect(prompts(box)).toEqual([])
    srv1.proc.kill()
    await srv1.proc.exited

    // 2. Timeout when session never comes back within BOARD_TURN_RESUME_WAIT_MS
    writeFileSync(
      cardPath(box, S1),
      JSON.stringify({ key: S1, name: 'anna', midTurn: { session: S1, startedAt: 1000, pane: 'p1' } }),
    )
    claudeHerdr(box, [])
    const srv2 = await serveBoard(
      box,
      { scheduleTickSec: 0.1 },
      { BOARD_TEST_PACE: '0.02', BOARD_TURN_RESUME_WAIT_MS: '60' },
    )
    await Bun.sleep(90)
    await refreshServer(srv2.proc)
    await until(() => readBoxCard(box, S1)?.midTurn === undefined)
    expect(logged(srv2.proc, 'did not come back')).toBe(true)
    expect(prompts(box)).toEqual([])
    srv2.proc.kill()
    await srv2.proc.exited

    // 3. Same Claude process finished turn during a board-only restart (processStartedAt === since)
    const sessionsDir = join(box.env.HOME as string, '.claude', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        kind: 'interactive',
        sessionId: S1,
        cwd: join(box.dir, 'Проект 100% x'),
        startedAt: 5000,
      }),
    )
    writeFileSync(
      cardPath(box, S1),
      JSON.stringify({
        key: S1,
        name: 'anna',
        midTurn: { session: S1, startedAt: 5500, pane: 'p1', processStartedAt: 5000 },
      }),
    )
    claudeHerdr(box, [{ pane: 'p1', session: S1, status: 'idle' }])
    const srv3 = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })
    await until(() => logged(srv3.proc, 'same Claude process') && readBoxCard(box, S1)?.midTurn === undefined)
    expect(prompts(box)).toEqual([])
    srv3.proc.kill()
    await srv3.proc.exited
  })

  test('herdr restart while board stays running promotes active marks via observeFailure', () => {
    isolatedHome()
    let nowMs = 1000
    const logs: string[] = []
    const svc = createTurnResume({ cfg: {}, log: line => logs.push(line), now: () => nowMs })

    svc.observe([claudeItem({ status: 'working', since: 500 })])
    expect(readCard(S1)?.midTurn).toEqual({ session: S1, startedAt: 1000, pane: 'p1', processStartedAt: 500 })

    // Herdr goes offline transiently, then restarts with a new Claude process (since: 2000) idle.
    svc.observeFailure()
    nowMs = 2500
    svc.observe([claudeItem({ status: 'idle', since: 2000 })])

    expect(readCard(S1)?.midTurn).toBeUndefined()
    const entries = listEntries().filter(e => e.key === S1 && e.kind === TURN_RESUME_KIND)
    expect(entries).toHaveLength(1)
    expect(logs.some(l => l.includes('queued continue after restart'))).toBe(true)
    expect(readLog(5)).toEqual([])
    svc.stop()
  })

  test('missing active pane without observeFailure clears mark; disabling clears pending marks; independent timeouts', () => {
    isolatedHome()
    let nowMs = 1000
    const logs: string[] = []
    const cfg: { turnResume?: unknown } = { turnResume: { waitSec: 60 } }
    const svc = createTurnResume({ cfg, log: line => logs.push(line), now: () => nowMs })

    // 1. Active session disappears on a clean collect (pane closed): mark cleared so later manual resume does not fire.
    svc.observe([claudeItem({ status: 'working', since: 500 })])
    expect(readCard(S1)?.midTurn).toBeDefined()
    svc.observe([])
    expect(readCard(S1)?.midTurn).toBeUndefined()
    svc.observe([claudeItem({ status: 'idle', since: 2000 })])
    expect(listEntries()).toEqual([])
    svc.stop()

    // 2. Two pending marks at different times have independent recovery deadlines; disabling clears pending marks too.
    writeCard(S1, { name: 'anna', midTurn: { session: S1, startedAt: 100, pane: 'p1' } })
    const svc2 = createTurnResume({ cfg, log: line => logs.push(line), now: () => nowMs })
    svc2.observe([claudeItem({ key: S2, session: S2, pane: 'p2', status: 'working', since: 200, name: 'ben' })])
    svc2.observeFailure()
    nowMs = 30_000
    // S1 was pending since t=1000 (expires at 61_000); S2 is promoted at t=30_000 (expires at 90_000).
    svc2.observe([])
    expect(readCard(S1)?.midTurn).toBeDefined()
    expect(readCard(S2)?.midTurn).toBeDefined()

    nowMs = 62_000
    svc2.observe([])
    expect(readCard(S1)?.midTurn).toBeUndefined()
    expect(readCard(S2)?.midTurn).toBeDefined()

    // Turning off while S2 is still in pending drops S2's mark on disk as well.
    cfg.turnResume = false
    svc2.observe([])
    expect(readCard(S2)?.midTurn).toBeUndefined()
    svc2.stop()
  })

  test('Settings switch via POST /api/settings disables and re-enables turnResume cleanly', async () => {
    const box = await sandbox()
    claudeHerdr(box, [{ pane: 'p1', session: S1, status: 'working' }])
    const cfgFile = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(cfgFile, '..'), { recursive: true })
    writeFileSync(
      cfgFile,
      JSON.stringify({
        language: 'en',
        categories: [{ id: 'other', title: 'Other', color: 'gray', paths: [] }],
        wakeUrl: null,
        refreshSec: 3600,
        scheduleTickSec: 0.1,
      }),
    )
    const { url, proc } = await serveBoard(
      box,
      { scheduleTickSec: 0.1 },
      { BOARD_TEST_PACE: '0.02', TEST_LIVE_CONFIG: '1' },
    )
    await until(() => readBoxCard(box, S1)?.midTurn !== undefined)

    const post = (body: unknown) =>
      fetch(`${url}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
      })

    const bad = await post({ turnResume: 'yes' })
    expect(bad.status).toBe(409)

    // Turn off: updates config.json, sets payload.turnResume = false, and clears active mark.
    const off = await post({ turnResume: false })
    expect(off.status).toBe(200)
    await until(() => readBoxCard(box, S1)?.midTurn === undefined)
    await refreshServer(proc)
    const payloadOff = (await (await fetch(`${url}/api/board`)).json()) as { turnResume?: boolean }
    expect(payloadOff.turnResume).toBe(false)
    expect(JSON.parse(readFileSync(cfgFile, 'utf8')).turnResume).toBe(false)

    // Turn back on: payload omits turnResume (default on), and working session marks again.
    const on = await post({ turnResume: true })
    expect(on.status).toBe(200)
    await until(() => readBoxCard(box, S1)?.midTurn !== undefined)
    await refreshServer(proc)
    const payloadOn = (await (await fetch(`${url}/api/board`)).json()) as { turnResume?: boolean }
    expect('turnResume' in payloadOn).toBe(false)
    proc.kill()
    await proc.exited
  })

  test('other setups (pi, codex, agy, pane-<id>, MokuPilot day/call) get zero marks or prompts', async () => {
    const box = await sandbox()
    const cwd = join(box.dir, 'Проект 50% y')
    mkdirSync(cwd, { recursive: true })
    const piUnix = '/home/anna w/.pi/sessions/Тест 50%.jsonl'
    const piWin = 'C:\\Users\\anna w\\.pi\\sessions\\Тест 50%.jsonl'

    // Pre-seed MokuPilot day & call files so both appear on the board as working.
    const dayDir = join(box.env.HOME as string, '.meeting-copilot', 'day')
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(
      join(dayDir, 'current.json'),
      JSON.stringify({ session: DAY_SID, pane: 'p-day', folder: dayDir, status: 'busy' }),
    )
    const claudeSessions = join(box.env.HOME as string, '.claude', 'sessions')
    mkdirSync(claudeSessions, { recursive: true })
    writeFileSync(
      join(claudeSessions, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: DAY_SID, cwd, status: 'busy', startedAt: 1000 }),
    )
    const callDir = join(box.env.HOME as string, '.meeting-copilot', 'call-agents')
    mkdirSync(callDir, { recursive: true })
    writeFileSync(
      join(callDir, `${CALL_SID}.json`),
      JSON.stringify({
        session: CALL_SID,
        harness: 'claude',
        cwd,
        phase: 'on',
        busy: true,
        started: 1000,
        updated: 2000,
      }),
    )

    const panes = [
      { pane_id: 'p-pi-1', agent: 'pi', agent_session: { value: piUnix }, agent_status: 'working', cwd },
      { pane_id: 'p-pi-2', agent: 'pi', agent_session: { value: piWin }, agent_status: 'working', cwd },
      { pane_id: 'p-codex', agent: 'codex', agent_session: { value: CODEX_SID }, agent_status: 'working', cwd },
      { pane_id: 'p-agy', agent: 'agy', agent_session: { value: AGY_SID }, agent_status: 'working', cwd },
      { pane_id: 'p-nosid', agent: 'claude', agent_status: 'working', cwd },
    ]
    box.state({
      'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
      'agent read': { text: screen() },
      'agent prompt': { result: {} },
    })

    const first = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })
    await refreshServer(first.proc)

    for (const key of [piUnix, piWin, CODEX_SID, AGY_SID, 'pane-p-nosid', DAY_SID, CALL_SID]) {
      expect(readBoxCard(box, key)).toBeNull()
    }
    first.proc.kill()
    await first.proc.exited

    // Return all of them as idle on a fresh board: still zero continue prompts.
    box.state({
      'api snapshot': {
        result: {
          snapshot: { panes: panes.map(p => ({ ...p, agent_status: 'idle' })), tabs: [], workspaces: [] },
        },
      },
      'agent read': { text: screen() },
      'agent prompt': { result: {} },
    })
    const second = await serveBoard(box, { scheduleTickSec: 0.1 }, { BOARD_TEST_PACE: '0.02' })
    await refreshServer(second.proc)
    await Bun.sleep(150)
    expect(prompts(box)).toEqual([])
    expect(scheduleFiles(box)).toEqual([])
    expect(configFile()).toContain('config.json')
    second.proc.kill()
    await second.proc.exited
  })
})
