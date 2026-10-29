import { expect, onTestFinished, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { projectFolderName } from '../../src/core/resume.ts'
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

/** herdr-wake listing `asleep` as sleeping; nothing else is asked of it here. */
async function fakeWake(asleep: Pane[]): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = []
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping')
      return res.end(
        JSON.stringify(
          asleep.map(p => ({ session: p.session, pane: p.id, name: p.name, slept_at: new Date().toISOString() })),
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
 * session in Default, and herdr and herdr-wake with these panes.
 */
async function world(box: Sandbox, panes: Pane[], { work = true } = {}): Promise<World> {
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
  const wake = await fakeWake(panes.filter(p => !p.status))
  const cfgDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  const profiles = work ? [{ id: 'work', title: 'Work', dir: workDir, hidden: false }] : []
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, wakeUrl: wake.url, profiles }))
  mkdirSync(box.cards, { recursive: true })
  for (const p of panes)
    writeFileSync(
      join(box.cards, `${p.session}.json`),
      JSON.stringify({ key: p.session, name: p.name, profile: 'default', profileDir: claude, profileWant: 'default' }),
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
  writeFileSync(
    join(w.home, '.claude.json'),
    JSON.stringify({ projects: { [w.cwd]: { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } } }),
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
  // Only the trust of that project, the rest of Claude's file as it was.
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
  ])
  conversation(w, w.claude, SID)
  conversation(w, w.claude, TWIN)
  conversation(w, w.work, TWIN)
  const before = readdirSync(w.work, { recursive: true }).sort()

  const r = await board(box, ['move', 'Busy', 'Twin', 'Bare', 'nobody', '--profile', 'work'])
  expect(r.code).toBe(0)
  expect(r.out.split('\n')).toEqual([
    'ok · 0 moved to work, 4 refused',
    `Busy (p2): refused, working; put it to sleep first (board sleep ${BUSY}), or add --when-free`,
    `Twin (p3): refused, ${w.work} has a conversation ${TWIN} already (${join(w.work, 'projects', projectFolderName(w.cwd), `${TWIN}.jsonl`)})`,
    `Bare (p4): refused, no conversation ${BARE} in ${w.claude}`,
    '"nobody": refused, no such session on the board',
  ])
  expect((await board(box, ['move', 'Billing', '--profile', 'nope'])).out).toBe(
    'ok · 0 moved to nope, 1 refused\n"Billing": refused, no profile "nope" (the profiles: work, default)',
  )
  // Nothing was copied, and no card changed.
  expect(readdirSync(w.work, { recursive: true }).sort()).toEqual(before)
  for (const key of [SID, BUSY, TWIN, BARE]) expect(card(box, key)).toMatchObject({ profileDir: w.claude })

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
  expect(run).toMatchObject({ id: 'eeee01', kind: 'sleep', result: 'sent', why: 'moved to work' })
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
