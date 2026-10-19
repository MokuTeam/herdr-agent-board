import { expect, test } from 'bun:test'
import { useLanguage } from '../../src/core/lang.ts'
import { sameDir } from '../../src/core/launch/names.ts'
import {
  configDirFor,
  defaultProfileDir,
  envRejected,
  inBoardProfile,
  launchTarget,
  mayWake,
  mergeProfiles,
  type Profile,
  profileIdOf,
  profileReport,
  profileSet,
  profileTag,
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
const LIST1_SET = profileSet([DEFAULT], DEFAULT.dir)

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
})

test('a board whose own folder is elsewhere shows ~/.claude only when it is in use', () => {
  // A teammate's CLAUDE_CONFIG_DIR is D:\claude, ~/.claude is not there or empty: one profile shown.
  expect(mergeProfiles(undefined, [], H, 'D:\\claude', 'win32').list.map(p => [p.id, p.hidden])).toEqual([
    ['default', true],
    ['claude', false],
  ])
  // ~/.claude holds settings.json or projects/ (found): shown, as on every board.
  expect(mergeProfiles(undefined, [`${H}\\.claude`], H, 'D:\\claude', 'win32').list.map(p => [p.id, p.hidden])).toEqual(
    [
      ['default', false],
      ['claude', false],
    ],
  )
  // The board's own folder is ~/.claude (unset, or set to it however spelled): shown, found or not.
  for (const own of [undefined, null, `${H}\\.claude`, 'c:/users/me/.claude/', '~/.claude'])
    expect(mergeProfiles(undefined, [], H, own, 'win32').list.map(p => [p.id, p.hidden])).toEqual([['default', false]])
  // Its own folder named relative is none: the default one stands for it, shown.
  expect(mergeProfiles(undefined, [], H, 'claude', 'win32').list.map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
  ])
  // A listed profile keeps what config.json says.
  expect(
    mergeProfiles([{ ...DEFAULT, hidden: false }], [], H, 'D:\\claude', 'win32').list.map(p => [p.id, p.hidden]),
  ).toEqual([
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
  expect(spawnEnv({ configDir: WORK.dir }, undefined, L, H, 'win32')).toEqual({
    ok: true,
    configDir: WORK.dir,
    profile: WORK,
  })
  // The folder as given, of the listed profile it is (another spelling; a hidden one: a parent's).
  expect(spawnEnv({ configDir: 'c:/users/me/.claude-work/' }, undefined, L, H, 'win32')).toEqual({
    ok: true,
    configDir: 'c:/users/me/.claude-work/',
    profile: WORK,
  })
  expect(spawnEnv({ configDir: GAMEDEV.dir }, undefined, L, H, 'win32')).toEqual({
    ok: true,
    configDir: GAMEDEV.dir,
    profile: GAMEDEV,
  })
  // A folder no listed profile has: nothing could say which profile its session is in.
  expect(spawnEnv({ configDir: 'C:\\x' }, undefined, L, H, 'win32')).toEqual({
    ok: false,
    error: 'unlisted',
    detail: 'C:\\x',
  })
  expect(spawnEnv({ configDir: '.claude-work' }, WORK.dir, L, H, 'win32')).toEqual({
    ok: false,
    error: 'unlisted',
    detail: '.claude-work',
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

test('the profile a board launch starts in: the one chosen, the parent’s, or the only one shown', () => {
  // No parent: a listed, shown profile, or the only one shown; never a guess between two.
  expect(launchTarget(undefined, null, SET)).toEqual({ ok: false, error: 'choose', id: '' })
  expect(launchTarget('work', null, SET)).toEqual({ ok: true, profile: WORK, configDir: WORK.dir })
  expect(launchTarget('default', null, SET)).toMatchObject({ ok: true, configDir: null })
  expect(launchTarget('gamedev', null, SET)).toMatchObject({ ok: false, error: 'hidden' })
  expect(launchTarget('nope', null, SET)).toMatchObject({ ok: false, error: 'missing' })
  // Started from a session: its profile, hidden or not; another one asked for is refused.
  expect(launchTarget(undefined, { name: 'G', profile: 'gamedev' }, SET)).toEqual({
    ok: true,
    profile: GAMEDEV,
    configDir: GAMEDEV.dir,
  })
  expect(launchTarget('gamedev', { name: 'G', profile: 'gamedev' }, SET)).toMatchObject({ ok: true, profile: GAMEDEV })
  expect(launchTarget('work', { name: 'G', profile: 'gamedev' }, SET)).toMatchObject({
    ok: false,
    error: 'parent',
    id: 'gamedev',
  })
  // A parent whose profile the board does not know: the owner chooses, and the choice is checked.
  expect(launchTarget(undefined, { name: 'X', profile: null }, SET)).toMatchObject({
    ok: false,
    error: 'unknownParent',
  })
  expect(launchTarget(undefined, { name: 'X', profile: 'gone' }, SET)).toMatchObject({
    ok: false,
    error: 'unknownParent',
  })
  expect(launchTarget('work', { name: 'X', profile: null }, SET)).toMatchObject({ ok: true, profile: WORK })
  expect(launchTarget('gamedev', { name: 'X', profile: null }, SET)).toMatchObject({ ok: false, error: 'hidden' })
  // A parent in another profile than its start asked for: which one was meant is not known, so
  // neither is taken without asking; the owner's choice of either goes.
  const wrong = { name: 'E', profile: 'default', profileWanted: 'work' }
  for (const set of [SET, ONE_SHOWN])
    expect(launchTarget(undefined, wrong, set)).toEqual({ ok: false, error: 'unknownParent', id: '' })
  expect(launchTarget('work', wrong, SET)).toMatchObject({ ok: true, profile: WORK })
  expect(launchTarget('default', wrong, SET)).toMatchObject({ ok: true, profile: DEFAULT })
  expect(launchTarget('gamedev', { ...wrong, profile: 'gamedev' }, SET)).toMatchObject({ ok: false, error: 'hidden' })
  // With one profile listed, a parent's is that one, unless it reported a folder no profile has.
  expect(launchTarget(undefined, { name: 'X', profile: null }, profileSet([DEFAULT], DEFAULT.dir))).toEqual({
    ok: true,
    profile: DEFAULT,
    configDir: null,
  })
  const elsewhere = { name: 'X', profile: null, profileFolder: 'D:\\elsewhere' }
  expect(launchTarget(undefined, elsewhere, profileSet([DEFAULT], DEFAULT.dir))).toMatchObject({
    ok: false,
    error: 'unknownParent',
  })
  expect(launchTarget('default', elsewhere, profileSet([DEFAULT], DEFAULT.dir))).toMatchObject({ ok: true })
  // One shown: that one, with the env left alone however the board's env spells its folder.
  expect(launchTarget(undefined, null, ONE_SHOWN)).toEqual({ ok: true, profile: DEFAULT, configDir: null })
  // A parent that names none is the one shown, as with one listed; a hidden one found besides
  // changes nothing. A folder no profile has is still never folded into it.
  expect(launchTarget(undefined, { name: 'X', profile: null }, ONE_SHOWN)).toEqual({
    ok: true,
    profile: DEFAULT,
    configDir: null,
  })
  expect(launchTarget(undefined, elsewhere, ONE_SHOWN)).toMatchObject({ ok: false, error: 'unknownParent' })
  expect(launchTarget(undefined, { name: 'W', profile: 'work' }, ONE_SHOWN)).toMatchObject({
    ok: true,
    profile: { id: 'work' },
  })
  expect(launchTarget('default', null, profileSet(LIST, 'c:/users/me/.claude/'))).toMatchObject({
    ok: true,
    configDir: null,
  })
  // The board in work: work leaves the env alone, default sets its folder.
  expect(launchTarget('work', null, profileSet(LIST, WORK.dir))).toMatchObject({ ok: true, configDir: null })
  expect(launchTarget('default', null, profileSet(LIST, WORK.dir))).toMatchObject({ ok: true, configDir: DEFAULT.dir })
})

test('a wake only where the profile is sure: the board’s own, or a pane the board opened in it', () => {
  useLanguage('en')
  expect(mayWake({ profile: 'work', pane: 'p1' }, SET, new Map())).toEqual({ ok: false, profile: 'Work' })
  expect(mayWake({ profile: 'work', pane: 'p1' }, SET, new Map([['p1', 'work']]))).toEqual({ ok: true })
  expect(mayWake({ profile: 'work', pane: 'p1' }, SET, new Map([['p1', 'default']]))).toEqual({
    ok: false,
    profile: 'Work',
  })
  expect(mayWake({ profile: 'default', pane: 'p1' }, SET, new Map())).toEqual({ ok: true })
  expect(mayWake({ profile: null, pane: 'p1' }, SET, new Map())).toEqual({ ok: false, profile: 'unknown profile' })
  expect(mayWake({ profile: null, profileFolder: 'D:\\x', pane: 'p1' }, SET, new Map())).toEqual({
    ok: false,
    profile: 'D:\\x',
  })
  expect(mayWake({ profile: null, pane: 'p1' }, LIST1_SET, new Map())).toEqual({ ok: true })
  // A folder no profile has is never the only one's.
  expect(mayWake({ profile: null, profileFolder: 'D:\\x', pane: 'p1' }, LIST1_SET, new Map())).toEqual({
    ok: false,
    profile: 'D:\\x',
  })
  // Another pane's record vouches for nothing; a hidden profile's pane does for its session.
  expect(mayWake({ profile: 'work', pane: 'p2' }, SET, new Map([['p1', 'work']]))).toEqual({
    ok: false,
    profile: 'Work',
  })
  expect(mayWake({ profile: 'work', pane: null }, SET, new Map([['p1', 'work']]))).toEqual({
    ok: false,
    profile: 'Work',
  })
  expect(mayWake({ profile: 'gamedev', pane: 'p1' }, SET, new Map([['p1', 'gamedev']]))).toEqual({ ok: true })
  // A board started in work: work is its own, default is not.
  expect(mayWake({ profile: 'work', pane: 'p1' }, profileSet(LIST, WORK.dir), new Map())).toEqual({ ok: true })
  expect(mayWake({ profile: 'default', pane: 'p1' }, profileSet(LIST, WORK.dir), new Map())).toEqual({
    ok: false,
    profile: 'Default',
  })

  expect([inBoardProfile({ profile: 'default' }, SET), inBoardProfile({ profile: 'work' }, SET)]).toEqual([true, false])
  expect(inBoardProfile({ profile: null }, SET)).toBe(false)
  expect(inBoardProfile({ profile: null }, LIST1_SET)).toBe(true)
  expect(inBoardProfile({ profile: null, profileFolder: 'D:\\x' }, LIST1_SET)).toBe(false)
  expect(inBoardProfile({ profile: 'work' }, profileSet(LIST, WORK.dir))).toBe(true)
})

test('a session that names no profile is the one shown, a hidden one found besides or not', () => {
  useLanguage('en')
  expect(mayWake({ profile: null, pane: 'p1' }, ONE_SHOWN, new Map())).toEqual({ ok: true })
  expect(inBoardProfile({ profile: null }, ONE_SHOWN)).toBe(true)
  // A folder no profile has is never the shown one's; a session of the hidden one is its own.
  expect(mayWake({ profile: null, profileFolder: 'D:\\x', pane: 'p1' }, ONE_SHOWN, new Map())).toEqual({
    ok: false,
    profile: 'D:\\x',
  })
  expect(inBoardProfile({ profile: null, profileFolder: 'D:\\x' }, ONE_SHOWN)).toBe(false)
  expect(mayWake({ profile: 'work', pane: 'p1' }, ONE_SHOWN, new Map())).toEqual({ ok: false, profile: 'Work' })
  expect(inBoardProfile({ profile: 'work' }, ONE_SHOWN)).toBe(false)
  // Two shown: not known.
  expect(inBoardProfile({ profile: null }, profileSet(LIST, DEFAULT.dir))).toBe(false)
})

test('a pane the board opened in another profile is never woken into, the board’s own profile included', () => {
  useLanguage('en')
  const work = new Map([['p1', 'work']])
  // herdr-wake would resume the default session with the pane's env, work's.
  expect(mayWake({ profile: 'default', pane: 'p1' }, SET, new Map(), work)).toEqual({
    ok: false,
    profile: 'Default',
    pane: 'Work',
  })
  expect(mayWake({ profile: null, pane: 'p1' }, ONE_SHOWN, new Map(), work)).toEqual({
    ok: false,
    profile: 'Default',
    pane: 'Work',
  })
  // A work session in a pane put in default; a profile no longer listed reads as its id.
  expect(mayWake({ profile: 'work', pane: 'p1' }, SET, new Map(), new Map([['p1', 'default']]))).toEqual({
    ok: false,
    profile: 'Work',
    pane: 'Default',
  })
  expect(mayWake({ profile: 'default', pane: 'p1' }, SET, new Map(), new Map([['p1', 'gone']]))).toEqual({
    ok: false,
    profile: 'Default',
    pane: 'gone',
  })
  // Its own profile's record blocks nothing; another pane's record says nothing of this one.
  expect(mayWake({ profile: 'work', pane: 'p1' }, SET, work, work)).toEqual({ ok: true })
  expect(mayWake({ profile: 'default', pane: 'p1' }, SET, new Map(), new Map([['p1', 'default']]))).toEqual({
    ok: true,
  })
  expect(mayWake({ profile: 'default', pane: 'p2' }, SET, new Map(), work)).toEqual({ ok: true })
  expect(mayWake({ profile: 'default', pane: null }, SET, new Map(), work)).toEqual({ ok: true })
  // A session whose profile is not known is refused as before.
  expect(mayWake({ profile: null, pane: 'p1' }, SET, new Map(), work)).toEqual({
    ok: false,
    profile: 'unknown profile',
  })
})

test('the profile tag: a known profile while the switch shows them all, a hidden one, a folder, a wrong start', () => {
  expect(profileTag({ profile: 'work' }, L)).toEqual({ kind: 'profile', profile: WORK })
  expect(profileTag({ profile: 'work' }, L, 'all')).toEqual({ kind: 'profile', profile: WORK })
  // The switch shows one profile: its cards need no tag.
  expect(profileTag({ profile: 'work' }, L, 'work')).toBeNull()
  // No report (no card yet), or a profile the list lacks: none.
  expect(profileTag({ profile: null }, L)).toBeNull()
  expect(profileTag({}, L)).toBeNull()
  expect(profileTag({ profile: 'gone' }, L)).toBeNull()
  expect(profileTag({ profile: 'work' }, [])).toBeNull()
  // A folder no profile has is named, never folded into one.
  expect(profileTag({ profile: null, profileFolder: 'D:\\x' }, L)).toEqual({ kind: 'unknown', folder: 'D:\\x' })
  expect(profileTag({ profile: null, profileFolder: 'D:\\x' }, L, 'work')).toEqual({ kind: 'unknown', folder: 'D:\\x' })
  // Started for one profile, running in another: always said, whatever the switch shows.
  expect(profileTag({ profile: 'default', profileWanted: 'work' }, L)).toEqual({
    kind: 'wrong',
    wantId: 'work',
    want: WORK,
  })
  expect(profileTag({ profile: 'default', profileWanted: 'work' }, L, 'default')).toEqual({
    kind: 'wrong',
    wantId: 'work',
    want: WORK,
  })
  expect(profileTag({ profile: null, profileFolder: 'D:\\x', profileWanted: 'gone' }, L)).toEqual({
    kind: 'wrong',
    wantId: 'gone',
    want: null,
  })
  // A hidden profile's session is named under any pick.
  expect(profileTag({ profile: 'gamedev' }, L)).toEqual({ kind: 'profile', profile: GAMEDEV })
  expect(profileTag({ profile: 'gamedev' }, L, 'work')).toEqual({ kind: 'profile', profile: GAMEDEV })
  // One shown: its sessions untagged, as before profiles; a hidden one's tagged.
  expect(profileTag({ profile: 'default' }, ONE_SHOWN.list)).toBeNull()
  expect(profileTag({ profile: 'default' }, ONE_SHOWN.list, 'default')).toBeNull()
  expect(profileTag({ profile: 'work' }, ONE_SHOWN.list)).toEqual({
    kind: 'profile',
    profile: { ...WORK, hidden: true },
  })
  expect(profileTag({ profile: 'default' }, LIST1_SET.list)).toBeNull()
})
