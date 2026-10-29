import { expect, onTestFinished, setDefaultTimeout, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { projectFolderName } from '../../src/core/resume.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeClaudeOn } from '../support/fake-claude.ts'
import { root, type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

// `board move` (#250): a session moved to another Claude profile keeps its conversation. The CLI and
// the scheduler run in child processes against a fake herdr; herdr-wake is a small HTTP server that
// lists the sleepers. Every folder is the sandbox's: a Default (.claude) and a Work (.claude-work)
// profile in its home.
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const BUSY = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const TWIN = '1b2c3d4e-5f60-4718-8a9b-c0d1e2f3a4b5'
const BARE = '2c3d4e5f-6071-4829-9bac-d1e2f3a4b5c6'
const RUNS = '3d4e5f60-7182-493a-8cbd-e2f3a4b5c6d7'

/** A pane: the shell a sleeper left (status null), or Claude at work. */
type Pane = { id: string; session: string; name: string; status: string | null }

interface World {
  home: string
  claude: string
  work: string
  /** The project folder every session runs in: spaces, Cyrillic and %. */
  cwd: string
  wake: string
}

function herdrWith(box: Sandbox, panes: Pane[], cwd: string): void {
  const state: Record<string, unknown> = {
    'api snapshot': {
      result: {
        snapshot: {
          panes: panes.map(p =>
            p.status
              ? {
                  pane_id: p.id,
                  agent: 'claude',
                  agent_session: { value: p.session },
                  agent_status: p.status,
                  cwd,
                  terminal_title_stripped: p.name,
                }
              : { pane_id: p.id, agent: null, cwd },
          ),
          tabs: [],
          workspaces: [],
        },
      },
    },
  }
  for (const p of panes)
    state[`agent get ${p.id}`] = {
      result: {
        agent: p.status ? { agent: 'claude', agent_status: p.status, agent_session: { value: p.session } } : null,
      },
    }
  box.state(state)
}

/**
 * herdr-wake listing `asleep` as sleeping, with the profile folder `dirs` names for a session
 * (as the new wake's entries have it); nothing else is asked of it here.
 */
async function fakeWake(asleep: Pane[], dirs: Record<string, string> = {}): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = []
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping')
      return res.end(
        JSON.stringify(
          asleep.map(p => ({
            session: p.session,
            pane: p.id,
            name: p.name,
            slept_at: new Date().toISOString(),
            ...(dirs[p.session] && { profile: { dir: dirs[p.session] } }),
          })),
        ),
      )
    calls.push(req.url ?? '')
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls }
}

const asleep = (id: string, session: string, name: string): Pane => ({ id, session, name, status: null })

/**
 * The sandbox's home with both profiles (Work only when `work`), the board's config, a card per
 * session in Default (`old`: written before the board kept profiles, none named, wake's entry
 * naming Default's folder), and herdr and herdr-wake with these panes.
 */
async function world(box: Sandbox, panes: Pane[], { work = true, old = [] as string[] } = {}): Promise<World> {
  const home = box.env.USERPROFILE as string
  const claude = join(home, '.claude')
  const workDir = join(home, '.claude-work')
  for (const dir of work ? [claude, workDir] : [claude]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{}')
  }
  const cwd = join(box.dir, 'Проект x 50%')
  mkdirSync(cwd, { recursive: true })
  herdrWith(box, panes, cwd)
  const wake = await fakeWake(
    panes.filter(p => !p.status),
    Object.fromEntries(old.map(session => [session, claude])),
  )
  const cfgDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  const profiles = work ? [{ id: 'work', title: 'Work', dir: workDir, hidden: false }] : []
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, wakeUrl: wake.url, profiles }))
  mkdirSync(box.cards, { recursive: true })
  for (const p of panes)
    writeFileSync(
      join(box.cards, `${p.session}.json`),
      JSON.stringify(
        old.includes(p.session)
          ? { key: p.session, name: p.name }
          : { key: p.session, name: p.name, profile: 'default', profileDir: claude, profileWant: 'default' },
      ),
    )
  return { home, claude, work: workDir, cwd, wake: wake.url }
}

/** A conversation in a profile: its transcript, its own folder and its file history. */
function conversation(w: World, dir: string, session: string): string {
  const project = join(dir, 'projects', projectFolderName(w.cwd))
  mkdirSync(join(project, session, 'subagents'), { recursive: true })
  writeFileSync(join(project, `${session}.jsonl`), `${JSON.stringify({ cwd: w.cwd, sessionId: session })}\n`)
  writeFileSync(join(project, session, 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n')
  mkdirSync(join(dir, 'file-history', session), { recursive: true })
  writeFileSync(join(dir, 'file-history', session, 'abc@v1'), 'old text')
  return join(project, `${session}.jsonl`)
}

async function board(box: Sandbox, args: string[]): Promise<{ code: number | null; out: string }> {
  const out = await box.run('cli', { args, env: {} }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

const card = (box: Sandbox, key: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(box.cards, `${key}.json`), 'utf8'))
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'))

test('board move: an asleep session goes to Work with its conversation and trust, and resumes there', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing')])
  const source = conversation(w, w.claude, SID)
  const key = w.cwd.replace(/\\/g, '/')
  // Default trusts only a folder above the project (as this machine's trusts C:/Work): Work gets the project's own.
  writeFileSync(
    join(w.home, '.claude.json'),
    JSON.stringify({ projects: { [box.dir]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } } }),
  )
  writeFileSync(join(w.work, '.claude.json'), JSON.stringify({ numStartups: 3, projects: { [key]: { lastCost: 1 } } }))

  const r = await board(box, ['move', 'Billing', '--profile', 'work'])
  expect(r).toEqual({ code: 0, out: 'ok · 1 moved to work\nBilling (p1): moved to work · folder trust copied' })
  // Copied: the transcript, its folder and its file history; the originals stay.
  const project = join(w.work, 'projects', projectFolderName(w.cwd))
  expect(readFileSync(join(project, `${SID}.jsonl`), 'utf8')).toBe(readFileSync(source, 'utf8'))
  expect(existsSync(join(project, SID, 'subagents', 'agent-1.jsonl'))).toBe(true)
  expect(readFileSync(join(w.work, 'file-history', SID, 'abc@v1'), 'utf8')).toBe('old text')
  expect(existsSync(source)).toBe(true)
  expect(existsSync(join(w.claude, 'file-history', SID, 'abc@v1'))).toBe(true)
  // The card names Work, with nothing left that would tag it "wrong profile".
  expect(card(box, SID)).toMatchObject({ profile: 'work', profileDir: w.work })
  expect(card(box, SID)).not.toHaveProperty('profileWant')
  // Only the trust of that project, never the folder above it; the rest of Claude's file as it was.
  expect(json(join(w.work, '.claude.json'))).toEqual({
    numStartups: 3,
    projects: { [key]: { lastCost: 1, hasTrustDialogAccepted: true } },
  })
  // Nothing was put to sleep or woken for a session asleep already.
  expect(box.calls().filter(c => c[0] === 'pane')).toEqual([])

  // `board resume`, which every wake types, now runs Claude in Work.
  const bin = join(box.dir, 'bin')
  fakeClaudeOn(bin)
  const log = join(box.dir, 'claude.json')
  const proc = Bun.spawn(
    [process.execPath, join(root, 'src/entrypoints/cli.ts'), 'resume', SID, '--profile', 'default'],
    {
      cwd: w.cwd,
      env: { ...box.env, PATH: `${bin}${delimiter}${box.env.PATH}`, FAKE_CLAUDE_LOG: log },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  await proc.exited
  expect(json(log)).toMatchObject({ args: ['--resume', SID], configDir: w.work })

  // Asked again, it is in Work already.
  const again = await board(box, ['move', SID, '--profile', 'work'])
  expect(again.out).toBe('ok · 0 moved to work, 1 refused\nBilling (p1): refused, it is in the profile "work" already')
})

test('board move refuses what it cannot move, and takes a busy one once it is free with --when-free', async () => {
  const box = await sandbox()
  const busy: Pane = { id: 'p2', session: BUSY, name: 'Busy', status: 'working' }
  const w = await world(box, [
    asleep('p1', SID, 'Billing'),
    busy,
    asleep('p3', TWIN, 'Twin'),
    asleep('p4', BARE, 'Bare'),
    asleep('p5', RUNS, 'Runs'),
  ])
  conversation(w, w.claude, SID)
  conversation(w, w.claude, TWIN)
  conversation(w, w.claude, RUNS)
  // Woken in Default meanwhile (a reminder, a message): its registry has it running.
  mkdirSync(join(w.claude, 'sessions'), { recursive: true })
  writeFileSync(
    join(w.claude, 'sessions', '99999.json'),
    JSON.stringify({ sessionId: RUNS, kind: 'interactive', pid: process.pid, status: 'idle' }),
  )
  // Work has another conversation under Twin's id: not this one.
  writeFileSync(conversation(w, w.work, TWIN), '{"type":"user","message":"something else"}\n')
  const before = readdirSync(w.work, { recursive: true }).sort()

  const r = await board(box, ['move', 'Busy', 'Twin', 'Bare', 'Runs', 'nobody', '--profile', 'work'])
  expect(r.code).toBe(0)
  expect(r.out.split('\n')).toEqual([
    'ok · 0 moved to work, 5 refused',
    `Busy (p2): refused, working; put it to sleep first (board sleep ${BUSY}), or add --when-free`,
    `Twin (p3): refused, ${w.work} has another conversation under ${TWIN} already (${join(w.work, 'projects', projectFolderName(w.cwd), `${TWIN}.jsonl`)})`,
    `Bare (p4): refused, no conversation ${BARE} in ${w.claude}`,
    'Runs (p5): refused, it is running again',
    '"nobody": refused, no such session on the board',
  ])
  expect((await board(box, ['move', 'Billing', '--profile', 'nope'])).out).toBe(
    'ok · 0 moved to nope, 1 refused\n"Billing": refused, no profile "nope" (the profiles: work, default)',
  )
  // Nothing was copied, and no card changed.
  expect(readdirSync(w.work, { recursive: true }).sort()).toEqual(before)
  for (const key of [SID, BUSY, TWIN, BARE, RUNS]) expect(card(box, key)).toMatchObject({ profileDir: w.claude })

  const later = await board(box, ['move', 'Busy', '--profile', 'work', '--when-free'])
  expect(later.code).toBe(0)
  const lines = later.out.split('\n')
  expect(lines[0]).toStartWith('ok · 0 moved to work, 1 once free')
  expect(lines[1]).toMatch(
    /^Busy \(p2\): working; goes to sleep once it is free, then moves to work · cancel: board unschedule [0-9a-f]{6}$/,
  )
  const schedule = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
  const entries = readdirSync(schedule)
    .filter(n => n.endsWith('.json'))
    .map(n => json(join(schedule, n)))
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ kind: 'sleep', key: BUSY, moveTo: 'work' })
})

test('a move cut off after the copy runs again to its end; a half-written transcript is never left', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing')])
  const source = conversation(w, w.claude, SID)
  // The first run copied the transcript, then stopped before the card (Ctrl+C, a lock that timed out).
  const project = join(w.work, 'projects', projectFolderName(w.cwd))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${SID}.jsonl`), readFileSync(source))
  const r = await board(box, ['move', 'Billing', '--profile', 'work'])
  expect(r.out).toBe(
    'ok · 1 moved to work\nBilling (p1): moved to work · its conversation was there already, from a move cut off before · folder not trusted in work: Claude will ask once',
  )
  expect(card(box, SID)).toMatchObject({ profile: 'work', profileDir: w.work })
  expect(existsSync(join(project, SID, 'subagents', 'agent-1.jsonl'))).toBe(true)
  expect(readdirSync(project).filter(n => n.endsWith('.tmp'))).toEqual([])
})

test('the scheduler moves a session once its sleep entry with moveTo finds it asleep', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing')])
  conversation(w, w.claude, SID)
  const schedule = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
  mkdirSync(schedule, { recursive: true })
  const at = Date.now() - 1000
  writeFileSync(
    join(schedule, 'eeee01.json'),
    JSON.stringify({
      id: 'eeee01',
      key: SID,
      name: 'Billing',
      pane: 'p1',
      cwd: w.cwd,
      kind: 'sleep',
      moveTo: 'work',
      idle: true,
      by: 'agent',
      text: '',
      at,
      next: at,
      created: at,
    }),
  )
  const cfg = JSON.parse(
    readFileSync(join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json'), 'utf8'),
  )
  const proc = box.run('scheduler', {
    ...cfg,
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    scheduleTickSec: 0.2,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  const log = join(schedule, 'log.jsonl')
  await until(() => existsSync(log) && readFileSync(log, 'utf8').trim() !== '')
  const run = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0] ?? '{}')
  expect(run).toMatchObject({
    id: 'eeee01',
    kind: 'sleep',
    result: 'sent',
    why: 'moved to work: folder not trusted in work: Claude will ask once',
  })
  expect(existsSync(join(w.work, 'projects', projectFolderName(w.cwd), `${SID}.jsonl`))).toBe(true)
  expect(card(box, SID)).toMatchObject({ profile: 'work', profileDir: w.work })
})

test('one profile shown: board move has nowhere to go, and nothing changes', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing')], { work: false })
  conversation(w, w.claude, SID)
  const r = await board(box, ['move', 'Billing', '--profile', 'default'])
  expect(r.out).toBe(
    'ok · 0 moved to default, 1 refused\n"Billing": refused, a move needs two profiles shown (Settings → Profiles)',
  )
  expect(card(box, SID)).toEqual({
    key: SID,
    name: 'Billing',
    profile: 'default',
    profileDir: w.claude,
    profileWant: 'default',
  })
})

test('moving back and forth: default, work, default, work, the conversation going on in each', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing')])
  const inDefault = conversation(w, w.claude, SID)
  const project = (dir: string) => join(dir, 'projects', projectFolderName(w.cwd))
  const inWork = join(project(w.work), `${SID}.jsonl`)
  const line = (n: number) => `${JSON.stringify({ type: 'user', message: `turn ${n}` })}\n`
  const move = async (to: string) => (await board(box, ['move', 'Billing', '--profile', to])).out.split('\n')

  expect((await move('work'))[0]).toBe('ok · 1 moved to work')
  expect(readFileSync(inWork, 'utf8')).toBe(readFileSync(inDefault, 'utf8'))
  // It runs in Work: its transcript goes on, a subagent and an edit with it.
  appendFileSync(inWork, line(1))
  writeFileSync(join(project(w.work), SID, 'subagents', 'agent-2.jsonl'), '{"type":"user"}\n')
  writeFileSync(join(w.work, 'file-history', SID, 'abc@v2'), 'new text')

  // Back to Default: its older copy there is brought up to date, not refused.
  const back = await move('default')
  expect(back[0]).toBe('ok · 1 moved to default')
  expect(back[1]).toStartWith('Billing (p1): moved to default · its older copy in default brought up to date')
  expect(readFileSync(inDefault, 'utf8')).toBe(readFileSync(inWork, 'utf8'))
  expect(existsSync(join(project(w.claude), SID, 'subagents', 'agent-2.jsonl'))).toBe(true)
  expect(readFileSync(join(w.claude, 'file-history', SID, 'abc@v2'), 'utf8')).toBe('new text')
  expect(readFileSync(join(w.claude, 'file-history', SID, 'abc@v1'), 'utf8')).toBe('old text')
  expect(card(box, SID)).toMatchObject({ profile: 'default', profileDir: w.claude })

  // It goes on in Default, then to Work again.
  appendFileSync(inDefault, line(2))
  const again = await move('work')
  expect(again[1]).toStartWith('Billing (p1): moved to work · its older copy in work brought up to date')
  expect(readFileSync(inWork, 'utf8')).toBe(readFileSync(inDefault, 'utf8'))
  expect(readFileSync(inWork, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
  expect(card(box, SID)).toMatchObject({ profile: 'work', profileDir: w.work })
  // The originals were never taken away, and no temp file is left.
  expect(existsSync(inDefault)).toBe(true)
  expect(readdirSync(project(w.claude)).filter(n => n.endsWith('.tmp'))).toEqual([])
  expect(readdirSync(project(w.work)).filter(n => n.endsWith('.tmp'))).toEqual([])
})

test('moving back to a copy that went on by itself is still refused, and nothing changes', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing')])
  const inDefault = conversation(w, w.claude, SID)
  expect((await board(box, ['move', 'Billing', '--profile', 'work'])).code).toBe(0)
  const inWork = join(w.work, 'projects', projectFolderName(w.cwd), `${SID}.jsonl`)
  appendFileSync(inWork, '{"type":"user","message":"in work"}\n')
  // Default's copy was resumed by hand meanwhile: no longer the start of Work's.
  appendFileSync(inDefault, '{"type":"user","message":"in default"}\n')
  const before = { work: readFileSync(inWork, 'utf8'), default: readFileSync(inDefault, 'utf8') }

  const r = await board(box, ['move', 'Billing', '--profile', 'default'])
  expect(r.out).toBe(
    `ok · 0 moved to default, 1 refused\nBilling (p1): refused, ${w.claude} has another conversation under ${SID} already (${inDefault})`,
  )
  expect({ work: readFileSync(inWork, 'utf8'), default: readFileSync(inDefault, 'utf8') }).toEqual(before)
  expect(card(box, SID)).toMatchObject({ profile: 'work', profileDir: w.work })
})

test('a card from before profiles moves from the folder its wake entry names', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing'), asleep('p2', TWIN, 'Twin')], { old: [SID, TWIN] })
  conversation(w, w.claude, SID)
  conversation(w, w.claude, TWIN)
  // Twin's wake entry names no folder either: not known, as before.
  const wake = await fakeWake([asleep('p1', SID, 'Billing'), asleep('p2', TWIN, 'Twin')], { [SID]: w.claude })
  const cfgFile = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), wakeUrl: wake.url }))

  const r = await board(box, ['move', 'Billing', 'Twin', '--profile', 'work'])
  expect(r.out.split('\n')).toEqual([
    'ok · 1 moved to work, 1 refused',
    'Billing (p1): moved to work · folder not trusted in work: Claude will ask once',
    'Twin (p2): refused, its profile is not known',
  ])
  expect(existsSync(join(w.work, 'projects', projectFolderName(w.cwd), `${SID}.jsonl`))).toBe(true)
  expect(card(box, SID)).toMatchObject({ profile: 'work', profileDir: w.work })
  expect(card(box, TWIN)).toEqual({ key: TWIN, name: 'Twin' })
})

test('POST /api/move moves as board move does, and only for this page', async () => {
  const box = await sandbox()
  const w = await world(box, [asleep('p1', SID, 'Billing')])
  conversation(w, w.claude, SID)
  const cfg = JSON.parse(
    readFileSync(join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json'), 'utf8'),
  )
  const { port: _port, ...rest } = cfg
  const { url } = await serveBoard(box, rest)
  // Fresh herdr data first: a move goes through herdr.
  for (let tries = 0; ((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale; tries++) {
    if (tries > 200) throw new Error('the board did not refresh')
    await Bun.sleep(25)
  }
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: JSON.stringify(body),
    }).then(async res => [res.status, await res.json()])

  // Another site's page, or one without the board's header, moves nothing.
  expect(await post({ targets: [SID], profile: 'work' }, { origin: 'https://example.com' })).toEqual([
    403,
    { error: 'origin' },
  ])
  expect(await post({ targets: [SID], profile: 'work' }, { 'x-board': '0' })).toEqual([403, { error: 'header' }])
  expect((await post({ targets: [], profile: 'work' }))[0]).toBe(400)
  expect(card(box, SID)).toMatchObject({ profile: 'default', profileDir: w.claude })

  const [status, body] = await post({ targets: [SID], profile: 'work' })
  expect(status).toBe(200)
  expect(body).toMatchObject({ ok: true, results: [{ target: SID, result: 'moved', key: SID, name: 'Billing' }] })
  expect(card(box, SID)).toMatchObject({ profile: 'work', profileDir: w.work })
  expect(existsSync(join(w.work, 'projects', projectFolderName(w.cwd), `${SID}.jsonl`))).toBe(true)
})
