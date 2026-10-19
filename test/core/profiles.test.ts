import { expect, test } from 'bun:test'
import { sameDir } from '../../src/core/launch/names.ts'
import {
  configDirFor,
  defaultProfileDir,
  envRejected,
  mergeProfiles,
  type Profile,
  profileIdOf,
  profileReport,
  profileSet,
  profileTitleOf,
  resolveProfileDir,
  sessionProfile,
  shownProfiles,
  spawnEnv,
} from '../../src/core/profiles.ts'

const H = 'C:\\Users\\me'
const DEFAULT: Profile = {
  id: 'default',
  title: 'Default',
  dir: 'C:\\Users\\me\\.claude',
  color: 'indigo',
  hidden: false,
}
const WORK: Profile = { id: 'work', title: 'Work', dir: 'C:\\Users\\me\\.claude-work', color: 'teal', hidden: false }
const GAMEDEV: Profile = {
  id: 'gamedev',
  title: 'Gamedev',
  dir: 'C:\\Users\\me\\.claude-gamedev',
  color: 'pink',
  hidden: true,
}
const LIST = [DEFAULT, WORK]
const L = [DEFAULT, WORK, GAMEDEV]
const SET = profileSet(L, DEFAULT.dir)
const ONE_SHOWN = profileSet([DEFAULT, { ...WORK, hidden: true }], DEFAULT.dir)

test('every spelling of the default folder is the default profile', () => {
  const d = defaultProfileDir(H, 'win32') // 'C:\\Users\\me\\.claude'
  for (const v of [
    undefined,
    '',
    '  ',
    '~/.claude',
    '~\\.claude',
    'C:\\Users\\me\\.claude\\',
    'C:/Users/me/.claude/',
    'c:/users/me/.claude',
    '"C:\\Users\\me\\.claude"',
    '/c/Users/me/.claude',
  ])
    expect(sameDir(resolveProfileDir(v, H, 'win32'), d)).toBe(true)
  expect(resolveProfileDir('C:\\', H, 'win32')).toBe('C:\\')
  expect(resolveProfileDir('/c/x', '/home/me', 'linux')).toBe('/c/x')
  expect(resolveProfileDir(undefined, '/home/me', 'linux')).toBe('/home/me/.claude')
  expect(resolveProfileDir('~/.claude-work', '/home/me', 'linux')).toBe('/home/me/.claude-work')
})

test('ids and titles from the folder', () => {
  expect(profileIdOf('C:\\Users\\me\\.claude', H)).toBe('default')
  expect(profileIdOf('C:\\Users\\me\\.claude-work', H)).toBe('work')
  expect(profileIdOf('C:\\Users\\me\\.claude-Game Dev', H)).toBe('game-dev')
  expect(profileIdOf('D:\\profiles\\acme', H)).toBe('acme')
  expect(profileIdOf('D:\\x\\.claude-work', H, new Set(['work']))).toBe('work-2')
  expect([profileTitleOf('default'), profileTitleOf('work')]).toEqual(['Default', 'Work'])
})

test('found folders join the list: default shown, the others hidden, colors in order', () => {
  const found = [`${H}\\.claude`, `${H}\\.claude-gamedev`, `${H}\\.claude-work`]
  const { list, added } = mergeProfiles(undefined, found, H)
  expect(list.map(p => [p.id, p.title, p.hidden, p.color])).toEqual([
    ['default', 'Default', false, 'indigo'],
    ['gamedev', 'Gamedev', true, 'teal'],
    ['work', 'Work', true, 'pink'],
  ])
  expect(added.length).toBe(3)
  expect(
    mergeProfiles(undefined, found, H, `${H}\\.claude-work`, 'win32').list.find(p => p.id === 'work')?.hidden,
  ).toBe(false)
  expect(mergeProfiles(undefined, [], H).list.map(p => p.id)).toEqual(['default'])
  expect(mergeProfiles(undefined, [], H, 'D:\\claude', 'win32').list.map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
    ['claude', false],
  ])
})

test('a listed profile keeps its id, folder, title and unknown fields; only new folders are added', () => {
  const listed = [
    { id: 'default', title: 'Private', dir: `${H}\\.claude`, color: 'indigo', hidden: false, note: 'mine' },
    'junk',
    { id: 'work', title: 'Work', dir: 'c:/USERS/me/.claude-work/', color: 'nope', hidden: 'yes' },
  ]
  const found = [`${H}\\.claude`, `${H}\\.claude-gamedev`, `${H}\\.claude-work`]
  const { list, added } = mergeProfiles(listed, found, H, null, 'win32')
  expect(list.map(p => p.id)).toEqual(['default', 'work', 'gamedev'])
  expect(list[0]).toMatchObject({ title: 'Private', note: 'mine' })
  // The folder as resolveProfileDir reads it (no trailing separator), not as typed.
  expect(list[1]).toMatchObject({ dir: 'c:/USERS/me/.claude-work', color: 'teal', hidden: false })
  expect(added.map(p => [p.id, p.hidden, p.color])).toEqual([['gamedev', true, 'pink']])
})

test('a start leaves the env alone only for the inherited profile', () => {
  expect(configDirFor({ dir: 'c:/users/me/.claude/' }, 'C:\\Users\\me\\.claude')).toBeNull()
  expect(configDirFor({ dir: 'C:\\Users\\me\\.claude-work' }, 'c:/users/me/.claude-work')).toBeNull()
  expect(configDirFor({ dir: 'C:\\Users\\me\\.claude-work' }, 'C:\\Users\\me\\.claude')).toBe(
    'C:\\Users\\me\\.claude-work',
  )
  expect(profileSet(LIST, 'c:/users/me/.claude-work').inherited?.id).toBe('work')
  expect(profileSet(LIST, 'D:\\other').inherited).toBeNull()
})

test('a session’s profile from its card', () => {
  const two = LIST // default, work
  expect(sessionProfile({ profileDir: 'C:\\Users\\me\\.claude-work' }, two)).toEqual({ profile: 'work' })
  expect(sessionProfile({ profileDir: 'D:\\old\\.claude-x' }, two)).toEqual({
    profile: null,
    profileFolder: 'D:\\old\\.claude-x',
  })
  expect(sessionProfile({}, two)).toEqual({ profile: null })
  expect(sessionProfile(null, [DEFAULT])).toEqual({ profile: 'default' })
  expect(sessionProfile({ profileDir: WORK.dir, profileWant: 'default' }, two)).toEqual({
    profile: 'work',
    profileWanted: 'default',
  })
  expect(sessionProfile({ profileDir: 'D:\\x', profileWant: 'work' }, two)).toEqual({
    profile: null,
    profileFolder: 'D:\\x',
    profileWanted: 'work',
  })
  expect(sessionProfile({ profileWant: 'work' }, two)).toEqual({ profile: null })
  expect(sessionProfile({ profileDir: WORK.dir, profileWant: 'work' }, two)).toEqual({ profile: 'work' })
})

test('what a card is told about its profile: only what changed', () => {
  const ODD = 'C:\\Users\\me\\odd'
  // A new card: the folder and its profile.
  expect(profileReport(null, WORK.dir, LIST)).toEqual({ profileDir: WORK.dir, profile: 'work' })
  // Another folder: both change.
  expect(profileReport({ profile: 'default', profileDir: DEFAULT.dir }, WORK.dir, LIST)).toEqual({
    profileDir: WORK.dir,
    profile: 'work',
  })
  // The same folder, its id not on the card yet (or another one): only the id.
  expect(profileReport({ profileDir: WORK.dir }, WORK.dir, LIST)).toEqual({ profile: 'work' })
  expect(profileReport({ profile: 'old', profileDir: WORK.dir }, WORK.dir, LIST)).toEqual({ profile: 'work' })
  // Unchanged, the folder spelled another way included: nothing to write.
  expect(profileReport({ profile: 'work', profileDir: WORK.dir }, WORK.dir, LIST)).toEqual({})
  expect(profileReport({ profile: 'work', profileDir: 'c:/users/me/.claude-work/' }, WORK.dir, LIST)).toEqual({})
  // A folder no profile has: the folder kept, the id cleared ('' removes it), never another's.
  expect(profileReport({ profile: 'default', profileDir: DEFAULT.dir }, ODD, LIST)).toEqual({
    profileDir: ODD,
    profile: '',
  })
  expect(profileReport(undefined, ODD, LIST)).toEqual({ profileDir: ODD })
  expect(profileReport({ profileDir: ODD }, ODD, LIST)).toEqual({})
  // Another unknown folder: only the folder changes.
  expect(profileReport({ profileDir: ODD }, 'D:\\other', LIST)).toEqual({ profileDir: 'D:\\other' })
})

test('hidden profiles are left out of the shown ones; the inherited one is the default', () => {
  expect(shownProfiles(SET.list).map(p => p.id)).toEqual(['default', 'work'])
  expect(shownProfiles(ONE_SHOWN.list).map(p => p.id)).toEqual(['default'])
  expect(SET.inherited).toBe(DEFAULT)
})

test('a card that names a profile without a folder is never folded into another', () => {
  expect(sessionProfile({ profile: 'work' }, LIST)).toEqual({ profile: 'work' })
  expect(sessionProfile({ profile: 'gamedev' }, [DEFAULT])).toEqual({ profile: null })
  expect(sessionProfile({ profile: '' }, [DEFAULT])).toEqual({ profile: 'default' })
})

test('listed fields of the wrong kind read safely', () => {
  const { list } = mergeProfiles(
    [
      { id: 'default', title: '  ', dir: `${H}\\.claude`, args: ['--model', 5, 'sonnet'] },
      { id: 'work', dir: `${H}\\.claude-work`, args: '--model sonnet' },
      { id: '', dir: 'D:\\x' },
      { id: 'nodir', dir: '' },
      null,
    ],
    [],
    H,
    null,
    'win32',
  )
  expect(list.map(p => [p.id, p.title, p.args])).toEqual([
    ['default', 'Default', ['--model', 'sonnet']],
    ['work', 'Work', undefined],
  ])
  expect('args' in (list[1] ?? {})).toBe(false)
})

test('the default folder is added first and shown; a stray one named like it stays hidden', () => {
  const found = [`${H}\\.claude-gamedev`, `${H}\\.claude`]
  expect(mergeProfiles(undefined, found, H).list.map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
    ['gamedev', true],
  ])
  const { added } = mergeProfiles(
    [{ ...DEFAULT, id: 'private' }],
    [`${H}\\.claude`, `${H}\\.claude-default`],
    H,
    null,
    'win32',
  )
  expect(added.map(p => [p.id, p.hidden])).toEqual([['default', true]])
})

test('a listed folder written by hand is the folder it names: ~, Git Bash /c/…, a trailing separator', () => {
  const found = [`${H}\\.claude`, `${H}\\.claude-work`]
  for (const dir of ['~/.claude-work', '~\\.claude-work', '/c/Users/me/.claude-work', `${H}\\.claude-work\\`]) {
    const { list, added } = mergeProfiles([{ id: 'work', dir }], found, H, null, 'win32')
    expect(list.map(p => p.id)).toEqual(['work', 'default'])
    expect(added.map(p => p.id)).toEqual(['default'])
    const work = list[0]?.dir ?? ''
    expect(sameDir(work, `${H}\\.claude-work`)).toBe(true)
    expect(work.startsWith('~') || work.startsWith('/') || /[\\/]$/.test(work)).toBe(false)
  }
  const linux = mergeProfiles([{ id: 'work', dir: '~/.claude-work' }], [], '/home/me', null, 'linux')
  expect(linux.list[0]?.dir).toBe('/home/me/.claude-work')
})

test('a relative folder is never a profile: neither a listed one nor the board’s own', () => {
  const found = [`${H}\\.claude`, `${H}\\.claude-work`]
  const listed = [
    { id: 'acme', dir: 'acme' },
    { id: 'here', dir: '.\\.claude-work' },
    { id: 'drive', dir: 'C:x' },
  ]
  const { list, added } = mergeProfiles(listed, found, H, null, 'win32')
  expect(list.map(p => [p.id, p.dir])).toEqual([
    ['default', `${H}\\.claude`],
    ['work', `${H}\\.claude-work`],
  ])
  expect(added.length).toBe(2)
  // The board's own folder named relative: nothing is added for it, nothing shown.
  for (const own of ['work', '.claude-work', 'D:x'])
    expect(mergeProfiles(undefined, found, H, own, 'win32').list.map(p => [p.id, p.dir, p.hidden])).toEqual([
      ['default', `${H}\\.claude`, false],
      ['work', `${H}\\.claude-work`, true],
    ])
  expect(mergeProfiles(undefined, [], '/home/me', 'work', 'linux').list.map(p => p.dir)).toEqual(['/home/me/.claude'])
  // A Windows folder is no absolute one elsewhere.
  expect(mergeProfiles([{ id: 'w', dir: 'C:\\w' }], [], '/home/me', null, 'linux').list.map(p => p.id)).toEqual([
    'default',
  ])
})

test('spawn-agent starts in the folder of the agent that runs it, or the profile it names', () => {
  // An agent's own start: herdr's env is taken to be the default profile's, so that needs no --env.
  expect(spawnEnv({}, undefined, L, H, 'win32')).toEqual({ ok: true, configDir: null, profile: DEFAULT })
  expect(spawnEnv({}, 'c:/users/me/.claude/', L, H, 'win32')).toEqual({ ok: true, configDir: null, profile: DEFAULT })
  expect(spawnEnv({}, '~/.claude-work', L, H, 'win32')).toEqual({ ok: true, configDir: WORK.dir, profile: WORK })
  // A hidden parent profile is kept.
  expect(spawnEnv({}, GAMEDEV.dir, L, H, 'win32')).toMatchObject({ ok: true, configDir: GAMEDEV.dir })
  expect(spawnEnv({}, 'D:\\odd', L, H, 'win32')).toEqual({ ok: false, error: 'unknown', detail: 'D:\\odd' })
  // A folder named relative to wherever the agent runs is never a profile.
  expect(spawnEnv({}, '.claude-work', L, H, 'win32')).toEqual({ ok: false, error: 'unknown', detail: '.claude-work' })
  // --profile overrides the parent's: a listed, shown one.
  expect(spawnEnv({ profile: 'work' }, undefined, L, H, 'win32')).toEqual({
    ok: true,
    configDir: WORK.dir,
    profile: WORK,
  })
  expect(spawnEnv({ profile: 'gamedev' }, undefined, L, H, 'win32')).toMatchObject({ ok: false, error: 'hidden' })
  expect(spawnEnv({ profile: 'nope' }, undefined, L, H, 'win32')).toMatchObject({ ok: false, error: 'missing' })
  // --profile default names the folder herdr's env is taken to be: no --env, from any agent's env.
  expect(spawnEnv({ profile: 'default' }, undefined, L, H, 'win32')).toEqual({
    ok: true,
    configDir: null,
    profile: DEFAULT,
  })
  expect(spawnEnv({ profile: 'default' }, WORK.dir, L, H, 'win32')).toEqual({
    ok: true,
    configDir: null,
    profile: DEFAULT,
  })
  const spelled = { ...DEFAULT, dir: 'c:/users/me/.claude/' }
  expect(spawnEnv({ profile: 'default' }, WORK.dir, [spelled, WORK], H, 'win32')).toEqual({
    ok: true,
    configDir: null,
    profile: spelled,
  })
  // The board's own starts: the env as it is, or the folder it checked.
  expect(spawnEnv({ keepEnv: true }, WORK.dir, L, H, 'win32')).toEqual({ ok: true, configDir: null, profile: WORK })
  expect(spawnEnv({ keepEnv: true }, 'D:\\odd', L, H, 'win32')).toEqual({ ok: true, configDir: null, profile: null })
  expect(spawnEnv({ configDir: 'C:\\x' }, undefined, L, H, 'win32')).toEqual({
    ok: true,
    configDir: 'C:\\x',
    profile: null,
  })
  expect(spawnEnv({ configDir: WORK.dir }, undefined, L, H, 'win32')).toEqual({
    ok: true,
    configDir: WORK.dir,
    profile: WORK,
  })
})

test('herdr that does not take --env says so', () => {
  expect(envRejected("error: unexpected argument '--env' found")).toBe(true)
  expect(envRejected(new Error("herdr tab create: error: unexpected argument '--env' found"))).toBe(true)
  expect(envRejected("error: unrecognized option '--env'")).toBe(true)
  expect(envRejected('unknown flag: --env')).toBe(true)
  expect(envRejected('no such pane')).toBe(false)
  expect(envRejected(undefined)).toBe(false)
})
