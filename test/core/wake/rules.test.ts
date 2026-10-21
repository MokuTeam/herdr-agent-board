import { expect, test } from 'bun:test'
import {
  CANNOT_WAKE,
  canWake,
  clearKeyFor,
  ownSleepers,
  plainProfile,
  type WakeProfile,
  wakeLine,
} from '../../../src/core/wake/rules.ts'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('can wake: board on PATH, the profile folder known, the transcript in it', () => {
  expect(canWake({ boardOnPath: true, profileDir: 'C:\\Users\\a\\.claude-work', transcript: 'x.jsonl' })).toBeNull()
  expect(canWake({ boardOnPath: false, profileDir: 'd', transcript: 't' })).toBe('board')
  expect(canWake({ boardOnPath: true, profileDir: null, transcript: 't' })).toBe('profile')
  expect(canWake({ boardOnPath: true, profileDir: 'd', transcript: null })).toBe('transcript')
})

test('why a session cannot wake, in the words the reaper and the API give', () => {
  expect(CANNOT_WAKE).toEqual({
    board: 'board is not on PATH',
    profile: 'its profile folder is not known',
    transcript: 'no transcript in its profile folder',
  })
})

test('the wake line: one command every shell runs, no folder, no quotes; the profile only as a plain id', () => {
  expect(wakeLine(SID, 'work')).toBe(`board resume ${SID} --profile work`)
  expect(wakeLine(SID)).toBe(`board resume ${SID}`)
  for (const id of ['Иван', 'a b', '100%', "o'k"]) expect(wakeLine(SID, id)).toBe(`board resume ${SID}`)
  for (const key of ['pane-w1:p2', 'pi-session-file.jsonl', '']) expect(wakeLine(key, 'work')).toBeNull()
})

test('a plain profile id is the one the wake line carries as --profile', () => {
  for (const id of ['work', 'a.b-c_1', 'Work2']) {
    expect(plainProfile(id)).toBe(true)
    expect(wakeLine(SID, id)).toBe(`board resume ${SID} --profile ${id}`)
  }
  for (const id of ['', 'Иван', 'a b', '100%', "o'k", 'work;rm', 'C:\\Users\\a\\.claude-work']) {
    expect(plainProfile(id)).toBe(false)
    expect(wakeLine(SID, id)).toBe(`board resume ${SID}`)
  }
})

test('the prompt line is cleared by the pane’s shell; an unknown one by the OS', () => {
  expect(['pwsh.exe', 'powershell.exe', 'cmd.exe', 'PWSH'].map(s => clearKeyFor(s, 'linux'))).toEqual([
    'esc',
    'esc',
    'esc',
    'esc',
  ])
  expect(['bash', 'zsh', 'fish', 'sh', 'bash.exe'].map(s => clearKeyFor(s, 'win32'))).toEqual([
    'ctrl+u',
    'ctrl+u',
    'ctrl+u',
    'ctrl+u',
    'ctrl+u',
  ])
  expect([clearKeyFor(null, 'win32'), clearKeyFor('nu', 'darwin')]).toEqual(['esc', 'ctrl+u'])
  expect([clearKeyFor('dash', 'win32'), clearKeyFor('ksh', 'win32'), clearKeyFor('nu', 'win32')]).toEqual([
    'ctrl+u',
    'ctrl+u',
    'esc',
  ])
})

test('the hooks keep their own profile’s sleepers, the folder spelled any way', () => {
  const home = 'C:\\Users\\Иван Петров'
  const work = { name: 'w', profile: { dir: 'C:\\Users\\Иван Петров\\.claude-work 100%', id: 'work' } }
  const dflt = { name: 'd', profile: { dir: 'C:\\Users\\Иван Петров\\.claude' } }
  // Taken over from the old plugin: no profile.
  const legacy: { name: string; profile?: WakeProfile } = { name: 'old' }
  const list = [work, dflt, legacy]
  expect(ownSleepers(list, { configDir: undefined, home, platform: 'win32' })).toEqual([dflt, legacy])
  expect(ownSleepers(list, { configDir: 'c:/users/иван петров/.CLAUDE-WORK 100%/', home, platform: 'win32' })).toEqual([
    work,
  ])
  expect(ownSleepers(list, { configDir: '~/.claude', home, platform: 'win32' })).toEqual([dflt, legacy])
  expect(
    ownSleepers([{ name: 'p', profile: { dir: '/home/u/.claude-work' } }], {
      configDir: '/home/u/.claude-work/',
      home: '/home/u',
      platform: 'linux',
    }),
  ).toHaveLength(1)
})
