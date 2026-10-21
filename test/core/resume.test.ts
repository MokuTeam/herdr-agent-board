import { expect, test } from 'bun:test'
import type { Profile } from '../../src/core/profiles.ts'
import {
  herdrWakeResumes,
  parseResume,
  type ResumeFacts,
  reportArgs,
  resumeCommand,
  resumePlan,
} from '../../src/core/resume.ts'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const H = 'C:\\Users\\me'
const DEFAULT: Profile = { id: 'default', title: 'Default', dir: `${H}\\.claude`, color: 'indigo', hidden: false }
const WORK: Profile = {
  id: 'work',
  title: 'Work',
  dir: `${H}\\.claude-work`,
  color: 'teal',
  hidden: false,
  args: ['--model', 'opus'],
}
const LIST = [DEFAULT, WORK]

/** A SessionStart in herdr pane, on Windows, in `dir`. */
const start = (dir: string, more: Partial<ResumeFacts> = {}): ResumeFacts => ({
  event: 'SessionStart',
  session: SID,
  dir,
  home: H,
  platform: 'win32',
  profiles: LIST,
  env: { HERDR_ENV: '1' },
  ...more,
})

test('a session in another profile than the default one comes back through board resume in it', () => {
  expect(resumeCommand(start(WORK.dir))).toEqual(['board', 'resume', SID, '--profile', 'work'])
  // However the folder is spelled.
  expect(resumeCommand(start('c:/users/me/.claude-work/'))).toEqual(['board', 'resume', SID, '--profile', 'work'])
  // On Linux and macOS too.
  const posix = start('/home/me/.claude-work', {
    home: '/home/me',
    platform: 'linux',
    profiles: [{ ...WORK, dir: '/home/me/.claude-work' }],
  })
  expect(resumeCommand(posix)).toEqual(['board', 'resume', SID, '--profile', 'work'])
})

test('a folder with spaces, another alphabet or % never goes into the command: only the profile’s id', () => {
  const home = 'C:\\Users\\Имя Фамилия 100%'
  const work: Profile = { ...WORK, dir: `${home}\\.claude-work` }
  const facts = start(`${home}\\.claude-work`, { home, profiles: [{ ...DEFAULT, dir: `${home}\\.claude` }, work] })
  expect(resumeCommand(facts)).toEqual(['board', 'resume', SID, '--profile', 'work'])
  expect(resumeCommand({ ...facts, dir: `${home}\\.claude` })).toBeNull()
  // An id that is not a plain word (config.json can name one so) stays out; the card has the folder.
  for (const id of ['работа', 'work 2', '100%']) {
    expect(resumeCommand({ ...facts, profiles: [{ ...work, id }] })).toEqual(['board', 'resume', SID])
  }
  // A board key that is no Claude session id (a bare pane's, pi's file) gets no command.
  expect(resumeCommand({ ...facts, session: 'pane-w1:p2' })).toBeNull()
})

test('a folder no profile has: board resume finds it on the card, no --profile', () => {
  expect(resumeCommand(start('D:\\claude homes\\odd'))).toEqual(['board', 'resume', SID])
  // An id herdr would not take as a plain word stays out of the command.
  const odd: Profile = { ...WORK, id: "o'brien" }
  expect(resumeCommand(start(WORK.dir, { profiles: [DEFAULT, odd] }))).toEqual(['board', 'resume', SID])
})

test('the default folder, however spelled, is left to herdr: no command', () => {
  for (const dir of [DEFAULT.dir, `${H}\\.claude\\`, 'c:/users/me/.claude', 'C:/Users/me/.claude/']) {
    expect(resumeCommand(start(dir))).toBeNull()
  }
  expect(resumeCommand(start('/home/me/.claude', { home: '/home/me', platform: 'linux' }))).toBeNull()
})

test('only a SessionStart of a pane’s own Claude session in herdr gets a command', () => {
  expect(resumeCommand(start(WORK.dir, { event: 'UserPromptSubmit' }))).toBeNull()
  expect(resumeCommand(start(WORK.dir, { event: undefined }))).toBeNull()
  // Outside herdr, or herdr not saying so.
  expect(resumeCommand(start(WORK.dir, { env: {} }))).toBeNull()
  expect(resumeCommand(start(WORK.dir, { env: { HERDR_ENV: '0' } }))).toBeNull()
  // A subagent's SessionStart is not the pane's session.
  expect(resumeCommand(start(WORK.dir, { agentId: 'agent-1' }))).toBeNull()
  // pi's bridge: pi reports its own resume (pi --session), never a Claude one.
  expect(resumeCommand(start(WORK.dir, { env: { HERDR_ENV: '1', PI_CODING_AGENT: 'true' } }))).toBeNull()
  // Not a Claude session id, or a folder named relative to wherever Claude runs.
  expect(resumeCommand(start(WORK.dir, { session: 'not-an-id' }))).toBeNull()
  expect(resumeCommand(start('.claude-work'))).toBeNull()
})

test('the report: herdr’s own Claude source, a newer seq, the session, then the command after --', () => {
  expect(reportArgs('w1:p2', SID, 1_760_000_000_123, ['board', 'resume', SID, '--profile', 'work'])).toEqual([
    'pane',
    'report-agent-session',
    'w1:p2',
    '--source',
    'herdr:claude',
    '--agent',
    'claude',
    '--seq',
    '1760000000123',
    '--agent-session-id',
    SID,
    '--',
    'board',
    'resume',
    SID,
    '--profile',
    'work',
  ])
})

const wakeHook = (path: string) => ({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${path}" session-start` }] }] },
})

test('herdr-wake keeps its own report where its hook is in the profile and its wakeCommand is its own', () => {
  const hooked = wakeHook('C:\\Users\\me\\AppData\\Roaming\\herdr\\plugins\\config\\herdr-wake\\hook.mjs')
  expect(herdrWakeResumes(hooked, { wakeCommand: 'claude-tg --resume {session}' })).toBe(true)
  expect(herdrWakeResumes(hooked, { wakeCommand: 'board resume {session}' })).toBe(true)
  // Its default it does not report: herdr resumes that way itself.
  expect(herdrWakeResumes(hooked, { wakeCommand: 'claude --resume {session}' })).toBe(false)
  expect(herdrWakeResumes(hooked, {})).toBe(false)
  expect(herdrWakeResumes(hooked, null)).toBe(false)
  // One it would not report (a path, quotes).
  expect(herdrWakeResumes(hooked, { wakeCommand: 'C:\\bin\\claude.exe --resume {session}' })).toBe(false)
  expect(herdrWakeResumes(hooked, { wakeCommand: "claude --name 'x' --resume {session}" })).toBe(false)
  // Its hook not in this profile (it installs into ~/.claude only), or another hook.
  expect(herdrWakeResumes({}, { wakeCommand: 'claude-tg --resume {session}' })).toBe(false)
  expect(herdrWakeResumes(null, { wakeCommand: 'claude-tg --resume {session}' })).toBe(false)
  const other = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/x/other/hook.mjs" go' }] }] } }
  expect(herdrWakeResumes(other, { wakeCommand: 'claude-tg --resume {session}' })).toBe(false)
})

test('board resume takes a session id and, if given, a profile id', () => {
  expect(parseResume([SID])).toEqual({ session: SID })
  expect(parseResume([SID, '--profile', 'work'])).toEqual({ session: SID, profile: 'work' })
  expect(parseResume(['--profile', 'work', SID])).toEqual({ session: SID, profile: 'work' })
  expect(() => parseResume([])).toThrow(/which session/)
  expect(() => parseResume(['abc'])).toThrow(/not a session id/)
  expect(() => parseResume([SID, '--profile'])).toThrow(/--profile needs/)
  expect(() => parseResume([SID, SID])).toThrow(/unexpected/)
  expect(() => parseResume([SID, '--fast'])).toThrow(/unexpected/)
})

const plan = (more: Partial<Parameters<typeof resumePlan>[0]> = {}) =>
  resumePlan({
    session: SID,
    card: { profileDir: WORK.dir },
    profiles: LIST,
    launch: { claude: ['claude', '--allow-dangerously-skip-permissions'] },
    env: { PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: '/c/Users/me/.claude' },
    home: H,
    platform: 'win32',
    ...more,
  })

test('board resume: the folder from the card, launch.claude with the profile’s args, --resume', () => {
  const p = plan()
  expect(p.argv).toEqual(['claude', '--allow-dangerously-skip-permissions', '--model', 'opus', '--resume', SID])
  // The restored shell's default folder (as the owner's .bashrc exports it) gives way to work's.
  expect(p.env).toEqual({ PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: WORK.dir })
  expect(p.dir).toBe(WORK.dir)
  // Spelled as the profile has it, however the card spells it.
  expect(plan({ card: { profileDir: 'c:/users/me/.claude-work/' } }).env.CLAUDE_CONFIG_DIR).toBe(WORK.dir)
})

test('board resume: a folder the env points to already leaves the env as it is', () => {
  const env = { PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: 'c:/users/me/.claude-work' }
  expect(plan({ env }).env).toBe(env)
  // The default folder, set or unset in the env, and the session's.
  const set = { CLAUDE_CONFIG_DIR: `${H}\\.claude` }
  expect(plan({ env: set, card: { profileDir: DEFAULT.dir } }).env).toBe(set)
  const unset = { PATH: 'C:\\bin' }
  expect(plan({ env: unset, card: { profileDir: DEFAULT.dir } }).env).toBe(unset)
})

test('board resume: the default folder unsets a variable that points elsewhere', () => {
  const p = plan({ env: { PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: WORK.dir }, card: { profileDir: DEFAULT.dir } })
  expect(p.env).toEqual({ PATH: 'C:\\bin' })
  expect(p.argv).toEqual(['claude', '--allow-dangerously-skip-permissions', '--resume', SID])
})

test('board resume: without a card, the profile named; without either, the env as it is', () => {
  const named = plan({ card: null, profile: 'work' })
  expect(named.env.CLAUDE_CONFIG_DIR).toBe(WORK.dir)
  expect(named.argv).toContain('opus')
  // The card decides over the profile named.
  const carded = plan({ card: { profileDir: DEFAULT.dir }, profile: 'work' })
  expect(carded.dir).toBe(DEFAULT.dir)
  expect(carded.env.CLAUDE_CONFIG_DIR).toBe('/c/Users/me/.claude')
  // A folder no profile has, from the card, as it is.
  expect(plan({ card: { profileDir: 'D:\\odd' } }).env.CLAUDE_CONFIG_DIR).toBe('D:\\odd')
  const env = { PATH: 'C:\\bin' }
  const none = plan({ card: null, env })
  expect(none.env).toBe(env)
  expect(none.dir).toBeNull()
  expect(plan({ card: null, profile: 'gone', env }).env).toBe(env)
  // A relative folder on the card is no folder to set.
  expect(plan({ card: { profileDir: '.claude-work' }, env }).env).toBe(env)
  // A folder with spaces, another alphabet or % is set as it is: no shell reads it.
  const odd = 'C:\\Users\\Имя Фамилия 100%\\.claude-work'
  expect(plan({ card: { profileDir: odd }, env }).env).toEqual({ PATH: 'C:\\bin', CLAUDE_CONFIG_DIR: odd })
})

test('board resume: launch.claude unset is claude with launch.args; one that picks its session is refused', () => {
  expect(plan({ launch: undefined, card: null }).argv).toEqual(['claude', '--resume', SID])
  expect(plan({ launch: { args: ['--verbose'] }, card: null }).argv).toEqual(['claude', '--verbose', '--resume', SID])
  expect(plan({ launch: { claude: 'claude-tg' }, card: null }).argv).toEqual(['claude-tg', '--resume', SID])
  expect(() => plan({ launch: { claude: ['claude', '--continue'] } })).toThrow(/picks its own session/)
  // The profile's own start command (an alias, say) is not run: board resume sets its folder itself.
  const aliased = plan({ profiles: [DEFAULT, { ...WORK, command: 'cld-work' }] })
  expect(aliased.argv[0]).toBe('claude')
})

test('board resume on Linux and macOS', () => {
  const work: Profile = { ...WORK, dir: '/home/me/.claude-work', args: [] }
  const p = resumePlan({
    session: SID,
    card: { profileDir: '/home/me/.claude-work' },
    profiles: [{ ...DEFAULT, dir: '/home/me/.claude' }, work],
    launch: undefined,
    env: { HOME: '/home/me' },
    home: '/home/me',
    platform: 'darwin',
  })
  expect(p).toEqual({
    argv: ['claude', '--resume', SID],
    env: { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/home/me/.claude-work' },
    dir: '/home/me/.claude-work',
  })
})
