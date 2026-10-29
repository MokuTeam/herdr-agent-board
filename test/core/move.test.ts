// `board move` (#250): which profile a session may move to, from where, and the folder trust that
// goes with it into the target profile's `.claude.json` (core/move.ts).
import { expect, test } from 'bun:test'
import { claudeStateFile, moveProfile, moveSource, parseMove, trustedKey, withTrust } from '../../src/core/move.ts'
import type { Profile } from '../../src/core/profiles.ts'

const HOME = 'C:\\Users\\Иван Пе%'
const profile = (id: string, dir: string, hidden = false): Profile => ({ id, title: id, dir, color: 'teal', hidden })
const DEFAULT = profile('default', `${HOME}\\.claude`)
const WORK = profile('work', `${HOME}\\.claude-work`)
const OLD = profile('old', `${HOME}\\.claude-old`, true)
const LIST = [DEFAULT, WORK, OLD]

test('parseMove: the sessions and --profile, else the usage', () => {
  expect(parseMove(['Billing', 'w1:p2', '--profile', 'work'])).toEqual({
    targets: ['Billing', 'w1:p2'],
    profile: 'work',
  })
  expect(() => parseMove(['Billing'])).toThrow('to which profile? board move')
  expect(() => parseMove(['--profile', 'work'])).toThrow('which sessions? board move')
  expect(() => parseMove(['Billing', '--profile'])).toThrow('--profile needs a profile id')
  expect(() => parseMove(['Billing', '--profile', 'work', '--force'])).toThrow('unexpected "--force"')
})

test('moveProfile: a listed, shown profile, and only with two shown', () => {
  expect(moveProfile(LIST, 'work')).toEqual({ profile: WORK })
  expect(moveProfile(LIST, 'old')).toEqual({
    error: 'the profile "old" is hidden: show it in Settings → Profiles first',
  })
  expect(moveProfile(LIST, 'nope')).toEqual({ error: 'no profile "nope" (the profiles: default, work, old)' })
  // One profile shown (a teammate's board): nothing to move to.
  expect(moveProfile([DEFAULT, OLD], 'default')).toEqual({
    error: 'a move needs two profiles shown (Settings → Profiles)',
  })
})

test('moveSource: the profile the session is in, else the folder it reported; not the target, not unknown', () => {
  expect(moveSource({ profile: 'default' }, LIST, WORK)).toEqual({ dir: DEFAULT.dir })
  expect(moveSource({ profile: 'old' }, LIST, WORK)).toEqual({ dir: OLD.dir })
  expect(moveSource({ profile: null, profileFolder: 'D:\\x' }, LIST, WORK)).toEqual({ dir: 'D:\\x' })
  expect(moveSource({ profile: 'work' }, LIST, WORK)).toEqual({ error: 'it is in the profile "work" already' })
  expect(moveSource({ profile: null }, LIST, WORK)).toEqual({ error: 'its profile is not known' })
})

test('claudeStateFile: ~/.claude.json for the default folder, <dir>/.claude.json for another', () => {
  expect(claudeStateFile(`${HOME}\\.claude\\`, HOME, 'win32')).toBe(`${HOME}\\.claude.json`)
  expect(claudeStateFile(WORK.dir, HOME, 'win32')).toBe(`${HOME}\\.claude-work\\.claude.json`)
  expect(claudeStateFile('/home/me/.claude', '/home/me', 'linux')).toBe('/home/me/.claude.json')
  expect(claudeStateFile('/home/me/.claude-work', '/home/me', 'linux')).toBe('/home/me/.claude-work/.claude.json')
})

test('trustedKey: the nearest trusted folder at or above the cwd, any spelling', () => {
  const state = {
    projects: {
      'C:/Work': { hasTrustDialogAccepted: true },
      'C:\\Work\\BSD\\Centium': { hasTrustDialogAccepted: true },
      'C:/Work/BSD/Centium x': { hasTrustDialogAccepted: false },
      'C:/Work/BS': { hasTrustDialogAccepted: true },
    },
  }
  expect(trustedKey(state, 'c:\\work\\bsd\\centium\\sub')).toBe('C:\\Work\\BSD\\Centium')
  expect(trustedKey(state, 'C:\\Work\\BSD\\Centium x')).toBe('C:/Work')
  expect(trustedKey(state, 'D:\\Other')).toBeNull()
  expect(trustedKey(null, 'C:\\Work')).toBeNull()
})

test('withTrust: only that project gets hasTrustDialogAccepted, under the source key with / on Windows', () => {
  const cwd = 'C:\\Work\\BSD\\Проект 50%'
  const source = { projects: { 'C:\\Work\\BSD\\Проект 50%': { hasTrustDialogAccepted: true, allowedTools: ['x'] } } }
  const target = {
    numStartups: 3,
    projects: {
      'C:/Work/BSD/Проект 50%': { allowedTools: [], lastCost: 1 },
      'C:/Other': { hasTrustDialogAccepted: true },
    },
  }
  expect(withTrust(source, target, cwd, 'win32')).toEqual({
    numStartups: 3,
    projects: {
      'C:/Work/BSD/Проект 50%': { allowedTools: [], lastCost: 1, hasTrustDialogAccepted: true },
      'C:/Other': { hasTrustDialogAccepted: true },
    },
  })
  // A target with no projects yet gets the one.
  expect(withTrust(source, { userID: 'u' }, cwd, 'win32')).toEqual({
    userID: 'u',
    projects: { 'C:/Work/BSD/Проект 50%': { hasTrustDialogAccepted: true } },
  })
  // Nothing to change: the target trusts it (here a folder above), the source does not, no target file.
  expect(withTrust(source, { projects: { 'C:/Work': { hasTrustDialogAccepted: true } } }, cwd, 'win32')).toBeNull()
  expect(withTrust({ projects: {} }, target, cwd, 'win32')).toBeNull()
  expect(withTrust(source, null, cwd, 'win32')).toBeNull()
  expect(withTrust(source, target, '', 'win32')).toBeNull()
  // Elsewhere the folder is spelled as it is.
  const posix = { projects: { '/work/a b/c': { hasTrustDialogAccepted: true } } }
  expect(withTrust(posix, {}, '/work/a b/c/', 'linux')).toEqual({
    projects: { '/work/a b/c': { hasTrustDialogAccepted: true } },
  })
})

test('withTrust: a source that trusts only a folder above gives the target the session’s own folder, never that one', () => {
  // This machine's Default trusts C:/Work itself; Work keeps clients apart and must not trust it all.
  const source = { projects: { 'C:/Work': { hasTrustDialogAccepted: true } } }
  expect(withTrust(source, { projects: {} }, 'C:\\Work\\BSD\\Centium', 'win32')).toEqual({
    projects: { 'C:/Work/BSD/Centium': { hasTrustDialogAccepted: true } },
  })
  // The key the target has for that folder, however spelled, is the one set.
  const target = { projects: { 'c:\\work\\bsd\\centium': { allowedTools: [] } } }
  expect(withTrust(source, target, 'C:\\Work\\BSD\\Centium', 'win32')).toEqual({
    projects: { 'c:\\work\\bsd\\centium': { allowedTools: [], hasTrustDialogAccepted: true } },
  })
  expect(withTrust({ projects: { '/work': { hasTrustDialogAccepted: true } } }, {}, '/work/a b', 'linux')).toEqual({
    projects: { '/work/a b': { hasTrustDialogAccepted: true } },
  })
})
