import { expect, setDefaultTimeout, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { fakeClaudeOn } from '../support/fake-claude.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

// After a herdr restart a session in another profile than the default one comes back in it
// (core/resume.ts): its SessionStart hook has the reporter tell herdr `board resume …`
// (test/entrypoints/hook.test.ts), and herdr types that into the restored pane.
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const COMMAND = ['board', 'resume', SID, '--profile', 'work']

const claudeIn = (session: string) => ({
  result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: session } } },
})

/** The reporter as the hook starts it, to its end. */
async function report(box: Sandbox): Promise<void> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/resume-report.ts'), 'w1:p1', SID, ...COMMAND], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
}

test('the reporter waits until herdr holds the session in the pane, then reports once', async () => {
  const box = await sandbox()
  box.state({
    'agent get': { seq: [{ result: { agent: null } }, claudeIn(SID)] },
    'pane report-agent-session': { result: null },
  })
  const before = Date.now()
  await report(box)
  const calls = box.calls()
  expect(calls.slice(0, 2)).toEqual([
    ['agent', 'get', 'w1:p1'],
    ['agent', 'get', 'w1:p1'],
  ])
  expect(calls).toHaveLength(3)
  const sent = calls[2] ?? []
  expect(sent.slice(0, 7)).toEqual([
    'pane',
    'report-agent-session',
    'w1:p1',
    '--source',
    'herdr:claude',
    '--agent',
    'claude',
  ])
  // Newer than herdr's own report, which its hook made at the start (ms).
  expect(sent[7]).toBe('--seq')
  expect(Number(sent[8])).toBeGreaterThan(before)
  expect(Number(sent[8])).toBeLessThanOrEqual(Date.now())
  expect(sent.slice(9)).toEqual(['--agent-session-id', SID, '--', ...COMMAND])
})

test('the reporter tries again when herdr refuses, and says nothing once another session has the pane', async () => {
  const box = await sandbox()
  box.state({
    'agent get': { seq: [claudeIn(SID), claudeIn(OTHER)] },
    'pane report-agent-session': {
      error: 'resume_argv requires the reporter to hold the pane',
      code: 'resume_not_accepted',
    },
  })
  await report(box)
  // A /clear since: the pane's session is another one, which this command would not resume.
  expect(box.calls().map(c => c.slice(0, 2).join(' '))).toEqual(['agent get', 'pane report-agent-session', 'agent get'])
})

/** The board's config and a fake `claude` on PATH; `board resume` as herdr types it into a restored pane. */
function setUp(box: Sandbox, config: Record<string, unknown> = {}): { bin: string; log: string; work: string } {
  const home = box.env.USERPROFILE as string
  const work = join(home, '.claude-work')
  for (const dir of [join(home, '.claude'), work]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{}')
  }
  const cfgDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...config }))
  const bin = join(box.dir, 'bin')
  fakeClaudeOn(bin)
  return { bin, log: join(box.dir, 'claude.json'), work }
}

function putCard(box: Sandbox, key: string, card: Record<string, unknown>): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${key}.json`), JSON.stringify({ key, ...card }))
}

async function boardResume(
  box: Sandbox,
  args: string[],
  { bin, log }: { bin: string; log: string },
  env: Record<string, string> = {},
  cwd: string = box.dir,
): Promise<{ code: number; out: string; claude: { args: string[]; configDir: string | null; cwd: string } | null }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'resume', ...args], {
    cwd,
    env: { ...box.env, PATH: `${bin}${delimiter}${box.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXIT: '7', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const claude = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : null
  return { code, out: `${stdout}${stderr}`.trim(), claude }
}

test('board resume: Claude in the profile the card names, with launch.claude and the profile’s args', async () => {
  const box = await sandbox()
  const s = setUp(box, {
    launch: { claude: ['claude', '--allow-dangerously-skip-permissions'] },
    profiles: [
      { id: 'work', title: 'Work', dir: join(box.env.USERPROFILE as string, '.claude-work'), args: ['--verbose'] },
    ],
  })
  putCard(box, SID, { profile: 'work', profileDir: s.work })
  // The restored shell's env: the default profile, as the owner's .bashrc exports it.
  const r = await boardResume(box, [SID, '--profile', 'work'], s, {
    CLAUDE_CONFIG_DIR: join(box.env.USERPROFILE as string, '.claude'),
  })
  // Claude's exit code is board resume's.
  expect(r.code).toBe(7)
  expect(r.claude).toMatchObject({
    args: ['--allow-dangerously-skip-permissions', '--verbose', '--resume', SID],
    configDir: s.work,
  })
  expect(box.calls()).toEqual([])
})

test('board resume: no card, the profile named; neither, the env as it is', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const named = await boardResume(box, [SID, '--profile', 'work'], s)
  expect(named.code).toBe(7)
  expect(named.claude?.args).toEqual(['--resume', SID])
  expect(named.claude?.configDir).toBe(s.work)
  const none = await boardResume(box, [SID], s)
  expect(none.claude?.configDir).toBeNull()
})

test('board resume refuses what is not a session id, and says so', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const r = await boardResume(box, ['nope'], s)
  expect(r.code).toBe(1)
  expect(r.out).toMatch(/^board: "nope" is not a session id/)
  expect(r.claude).toBeNull()
})

// Which folder Claude resumes in (spec call 29): herdr restores a pane in its folder, where the
// session's transcript is; a wake may type `board resume` into a pane in another folder.

/** The session's transcript under the profile's projects/<folder>, its first line recording `cwd`. */
function putTranscript(profileDir: string, folder: string, session: string, cwd: string): void {
  const dir = join(profileDir, 'projects', folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${session}.jsonl`), `${JSON.stringify({ cwd })}\n{"type":"user"}\n`)
}

/** `board resume` started in `cwd`; what Claude saw, never a log left from an earlier run. */
function resumeIn(
  box: Sandbox,
  s: { bin: string; log: string },
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  rmSync(s.log, { force: true })
  return boardResume(box, args, s, env, cwd)
}

test('board resume stays in the pane’s folder when the transcript is there (a restored pane)', async () => {
  const box = await sandbox()
  const s = setUp(box)
  putTranscript(s.work, projectFolderName(box.dir), SID, box.dir)
  const r = await resumeIn(box, s, [SID, '--profile', 'work'], box.dir)
  expect(r.code).toBe(7)
  expect(r.claude).toEqual({ args: ['--resume', SID], configDir: s.work, cwd: realpathSync(box.dir) })
  // Nothing printed, herdr asked nothing.
  expect(r.out).toBe('')
  expect(box.calls()).toEqual([])
})

test('in a folder that is not the project, it goes to the folder the transcript recorded', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const home = box.env.USERPROFILE as string
  // A Windows path on Windows; other alphabets, spaces and `%` everywhere.
  for (const project of [join(box.dir, 'Проект x 50%'), join(box.dir, 'a b')]) {
    mkdirSync(project, { recursive: true })
    const session = randomUUID()
    putTranscript(s.work, projectFolderName(project), session, project)
    const r = await resumeIn(box, s, [session, '--profile', 'work'], home)
    expect(r.code).toBe(7)
    expect(r.claude).toEqual({ args: ['--resume', session], configDir: s.work, cwd: realpathSync(project) })
    expect(r.out).toBe('')
  }
  expect(box.calls()).toEqual([])
})

test('found nowhere, or that folder gone: the current folder, as today', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const home = box.env.USERPROFILE as string
  const stays = async (session: string): Promise<void> => {
    const r = await resumeIn(box, s, [session, '--profile', 'work'], home)
    expect(r.code).toBe(7)
    expect(r.claude).toEqual({ args: ['--resume', session], configDir: s.work, cwd: realpathSync(home) })
  }
  // No transcript at all.
  await stays(SID)
  // The folder it recorded is gone.
  const gone = randomUUID()
  putTranscript(s.work, projectFolderName(join(box.dir, 'gone')), gone, join(box.dir, 'gone'))
  await stays(gone)
  // It recorded no folder.
  const blank = randomUUID()
  mkdirSync(join(s.work, 'projects', 'x'), { recursive: true })
  writeFileSync(join(s.work, 'projects', 'x', `${blank}.jsonl`), '{"type":"user"}\n')
  await stays(blank)
  // Only in another profile than the session's: not this session's transcript.
  const elsewhere = randomUUID()
  const project = join(box.dir, 'project')
  mkdirSync(project)
  putTranscript(join(home, '.claude'), projectFolderName(project), elsewhere, project)
  await stays(elsewhere)
  expect(box.calls()).toEqual([])
})

test('the same in every profile: the default one, Work, and a listed profile with spaces and Cyrillic in its folder', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const listed = join(box.dir, 'Иван Петров', '.claude-work 100%')
  mkdirSync(listed, { recursive: true })
  writeFileSync(join(listed, 'settings.json'), '{}')
  const s = setUp(box, { profiles: [{ id: 'ivan', title: 'Иван', dir: listed }] })
  const project = join(box.dir, 'Проект x 50%')
  mkdirSync(project)
  const profiles: [id: string, dir: string, configDir: string | null][] = [
    ['default', join(home, '.claude'), null],
    ['work', s.work, s.work],
    ['ivan', listed, listed],
  ]
  for (const [id, dir, configDir] of profiles) {
    const session = randomUUID()
    putCard(box, session, { profileDir: dir })
    putTranscript(dir, projectFolderName(project), session, project)
    // The pane herdr restored, in the project: it stays.
    const here = await resumeIn(box, s, [session, '--profile', id], project)
    expect(here.claude).toEqual({ args: ['--resume', session], configDir, cwd: realpathSync(project) })
    // A pane in another folder: it goes to the project.
    const away = await resumeIn(box, s, [session, '--profile', id], home)
    expect(away.code).toBe(7)
    expect(away.claude).toEqual({ args: ['--resume', session], configDir, cwd: realpathSync(project) })
  }
  expect(box.calls()).toEqual([])
})

test('no card and no profile named: the transcript is looked for in the folder the env gives (unset: the default one)', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const home = box.env.USERPROFILE as string
  const project = join(box.dir, 'a b')
  mkdirSync(project)
  const plain = randomUUID()
  putTranscript(join(home, '.claude'), projectFolderName(project), plain, project)
  const unset = await resumeIn(box, s, [plain], home)
  expect(unset.claude).toEqual({ args: ['--resume', plain], configDir: null, cwd: realpathSync(project) })
  const work = randomUUID()
  putTranscript(s.work, projectFolderName(project), work, project)
  const set = await resumeIn(box, s, [work], home, { CLAUDE_CONFIG_DIR: s.work })
  expect(set.claude).toEqual({ args: ['--resume', work], configDir: s.work, cwd: realpathSync(project) })
  expect(box.calls()).toEqual([])
})

test('a profile folder named from the pane’s folder (a relative CLAUDE_CONFIG_DIR) keeps Claude there, as today', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const home = box.env.USERPROFILE as string
  const project = join(box.dir, 'a b')
  mkdirSync(project)
  // `.claude-work` from home is Work, where the transcript is; from the project it is no folder.
  const session = randomUUID()
  putTranscript(s.work, projectFolderName(project), session, project)
  const r = await resumeIn(box, s, [session], home, { CLAUDE_CONFIG_DIR: '.claude-work' })
  expect(r.code).toBe(7)
  expect(r.claude).toEqual({ args: ['--resume', session], configDir: '.claude-work', cwd: realpathSync(home) })
  expect(box.calls()).toEqual([])
})
