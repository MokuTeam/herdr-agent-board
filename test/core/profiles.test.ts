import { expect, test } from 'bun:test'
import { sameDir } from '../../src/core/launch/names.ts'
import {
  configDirFor,
  defaultProfileDir,
  mergeProfiles,
  type Profile,
  profileIdOf,
  profileSet,
  profileTitleOf,
  resolveProfileDir,
  sessionProfile,
  shownProfiles,
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
  expect(mergeProfiles(undefined, found, H, `${H}\\.claude-work`).list.find(p => p.id === 'work')?.hidden).toBe(false)
  expect(mergeProfiles(undefined, [], H).list.map(p => p.id)).toEqual(['default'])
  expect(mergeProfiles(undefined, [], H, 'D:\\claude').list.map(p => [p.id, p.hidden])).toEqual([
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
  const { list, added } = mergeProfiles(listed, [`${H}\\.claude`, `${H}\\.claude-gamedev`, `${H}\\.claude-work`], H)
  expect(list.map(p => p.id)).toEqual(['default', 'work', 'gamedev'])
  expect(list[0]).toMatchObject({ title: 'Private', note: 'mine' })
  expect(list[1]).toMatchObject({ dir: 'c:/USERS/me/.claude-work/', color: 'teal', hidden: false })
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
  const { added } = mergeProfiles([{ ...DEFAULT, id: 'private' }], [`${H}\\.claude`, `${H}\\.claude-default`], H)
  expect(added.map(p => [p.id, p.hidden])).toEqual([['default', true]])
})
