import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { profilePanesFile } from '../../src/adapters/paths.ts'
import {
  forgetProfilePane,
  forgetProfilePanes,
  profilePanes,
  recordProfilePane,
} from '../../src/adapters/profile-panes.ts'
import { isolatedHome } from '../support/env.ts'

const saved = (): Record<string, unknown> => JSON.parse(readFileSync(profilePanesFile(), 'utf8'))
const writeSaved = (value: unknown) => {
  mkdirSync(dirname(profilePanesFile()), { recursive: true })
  writeFileSync(profilePanesFile(), JSON.stringify(value))
}

test('the panes opened in a profile: recorded, read, and the ones herdr no longer has forgotten', () => {
  isolatedHome()
  expect(profilePanes()).toEqual(new Map())
  forgetProfilePanes(new Set()) // nothing recorded: nothing to do, no file
  expect(existsSync(profilePanesFile())).toBe(false)

  const before = Date.now()
  recordProfilePane('wA:p9', 'work')
  recordProfilePane('wB:p1', 'gamedev')
  expect(profilePanes()).toEqual(
    new Map([
      ['wA:p9', 'work'],
      ['wB:p1', 'gamedev'],
    ]),
  )
  const at = (saved()['wA:p9'] as { at: unknown }).at
  expect(typeof at === 'number' && at >= before).toBe(true)

  forgetProfilePanes(new Set(['wB:p1', 'wZ:p0']))
  expect(profilePanes()).toEqual(new Map([['wB:p1', 'gamedev']]))
})

test('the file keeps what it does not know; entries of the wrong kind are no panes', () => {
  isolatedHome()
  writeSaved({
    'wA:p1': { profile: 'work', at: 1, by: 'board' },
    'wA:p2': 'work',
    'wA:p3': { profile: 7 },
  })
  expect(profilePanes()).toEqual(new Map([['wA:p1', 'work']]))
  // Opened again in another profile (herdr reuses pane ids): the newest record wins, its own fields kept.
  recordProfilePane('wA:p1', 'default')
  expect(saved()['wA:p1']).toMatchObject({ profile: 'default', by: 'board' })
  expect(saved()['wA:p2']).toBe('work')
})

test('a record is of the terminal the pane held when it was opened: a pane id herdr gave out again is no record', () => {
  isolatedHome()
  recordProfilePane('wA:p9', 'work', 'term-1')
  recordProfilePane('wB:p1', 'gamedev') // herdr did not say which terminal
  expect(saved()['wA:p9']).toMatchObject({ profile: 'work', terminal: 'term-1' })
  // Read without the live panes: every record, as written.
  expect(profilePanes()).toEqual(
    new Map([
      ['wA:p9', 'work'],
      ['wB:p1', 'gamedev'],
    ]),
  )
  // Read against the live panes: only a record of the terminal the pane holds now.
  expect(profilePanes(new Map([['wA:p9', 'term-1']]))).toEqual(new Map([['wA:p9', 'work']]))
  expect(profilePanes(new Map([['wA:p9', 'term-2']]))).toEqual(new Map())
  expect(profilePanes(new Map([['wA:p9', null]]))).toEqual(new Map())
  // A record that names no terminal can never be told from a reused id.
  expect(profilePanes(new Map([['wB:p1', 'term-5']]))).toEqual(new Map())
  expect(profilePanes(new Map([['wB:p1', null]]))).toEqual(new Map())

  // Recorded again without a terminal: the old one does not stay to vouch for the new pane.
  recordProfilePane('wA:p9', 'default')
  expect(saved()['wA:p9']).not.toHaveProperty('terminal')
  expect(profilePanes(new Map([['wA:p9', 'term-1']]))).toEqual(new Map())
})

test('forgetting by the live panes and their terminals: a reused pane id goes, a Set of ids still works', () => {
  isolatedHome()
  forgetProfilePanes(new Map()) // nothing recorded: no file
  expect(existsSync(profilePanesFile())).toBe(false)

  writeSaved({
    'wA:p9': { profile: 'work', terminal: 'term-1', at: 1, by: 'board' },
    'wB:p1': { profile: 'gamedev', terminal: 'term-5', at: 1 },
    'wC:p2': { profile: 'work', at: 1 },
    'wD:p3': { profile: 'work', terminal: 'term-8', at: 1 },
  })
  forgetProfilePanes(
    new Map([
      ['wA:p9', 'term-1'], // the same terminal: kept
      ['wB:p1', 'term-6'], // herdr gave the id to another terminal
      ['wC:p2', 'term-7'], // a record that names none
      // wD:p3 is gone
    ]),
  )
  expect(saved()).toEqual({ 'wA:p9': { profile: 'work', terminal: 'term-1', at: 1, by: 'board' } })

  // Nothing to drop: the file is not written again.
  const mtime = statSync(profilePanesFile()).mtimeMs
  const text = readFileSync(profilePanesFile(), 'utf8')
  forgetProfilePanes(new Map([['wA:p9', 'term-1']]))
  forgetProfilePanes(new Set(['wA:p9']))
  expect(readFileSync(profilePanesFile(), 'utf8')).toBe(text)
  expect(statSync(profilePanesFile()).mtimeMs).toBe(mtime)

  // A Set of ids alone keeps the panes herdr has, whatever terminal they hold.
  forgetProfilePanes(new Set(['wZ:p0']))
  expect(saved()).toEqual({})
})

test('one pane forgotten: a new tab of that id opened without --env; no file is made for it', () => {
  isolatedHome()
  forgetProfilePane('wA:p9')
  expect(existsSync(profilePanesFile())).toBe(false)

  writeSaved({ 'wA:p9': { profile: 'work', terminal: 'term-1', at: 1 }, 'wB:p1': { profile: 'gamedev', at: 1 } })
  const text = readFileSync(profilePanesFile(), 'utf8')
  forgetProfilePane('wZ:p0') // not recorded: the file stays as it was
  expect(readFileSync(profilePanesFile(), 'utf8')).toBe(text)
  forgetProfilePane('wA:p9')
  expect(saved()).toEqual({ 'wB:p1': { profile: 'gamedev', at: 1 } })
})
