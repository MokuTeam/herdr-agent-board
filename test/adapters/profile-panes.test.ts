import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { profilePanesFile } from '../../src/adapters/paths.ts'
import {
  forgetProfilePane,
  forgetProfilePanes,
  possibleProfilePanes,
  provenProfilePanes,
  recordProfilePane,
} from '../../src/adapters/profile-panes.ts'
import { isolatedHome } from '../support/env.ts'

const saved = (): Record<string, unknown> => JSON.parse(readFileSync(profilePanesFile(), 'utf8'))
const writeSaved = (value: unknown) => {
  mkdirSync(dirname(profilePanesFile()), { recursive: true })
  writeFileSync(profilePanesFile(), JSON.stringify(value))
}
/** The panes live, herdr not saying which terminal each holds (as before herdr is asked). */
const unsaid = (...panes: string[]) => new Map(panes.map(p => [p, null]))

test('the panes opened in a profile: recorded, read, and the ones herdr no longer has forgotten', () => {
  isolatedHome()
  expect(possibleProfilePanes(unsaid('wA:p9'))).toEqual(new Map())
  forgetProfilePanes(new Set()) // nothing recorded: nothing to do, no file
  expect(existsSync(profilePanesFile())).toBe(false)

  const before = Date.now()
  recordProfilePane('wA:p9', 'work')
  recordProfilePane('wB:p1', 'gamedev')
  expect(possibleProfilePanes(unsaid('wA:p9', 'wB:p1', 'wZ:p0'))).toEqual(
    new Map([
      ['wA:p9', 'work'],
      ['wB:p1', 'gamedev'],
    ]),
  )
  const at = (saved()['wA:p9'] as { at: unknown }).at
  expect(typeof at === 'number' && at >= before).toBe(true)

  forgetProfilePanes(new Set(['wB:p1', 'wZ:p0']))
  expect(possibleProfilePanes(unsaid('wA:p9', 'wB:p1'))).toEqual(new Map([['wB:p1', 'gamedev']]))
})

test('the file keeps what it does not know; entries of the wrong kind are no panes', () => {
  isolatedHome()
  writeSaved({
    'wA:p1': { profile: 'work', at: 1, by: 'board' },
    'wA:p2': 'work',
    'wA:p3': { profile: 7 },
  })
  expect(possibleProfilePanes(unsaid('wA:p1', 'wA:p2', 'wA:p3'))).toEqual(new Map([['wA:p1', 'work']]))
  // Opened again in another profile (herdr reuses pane ids): the newest record wins, its own fields kept.
  recordProfilePane('wA:p1', 'default')
  expect(saved()['wA:p1']).toMatchObject({ profile: 'default', by: 'board' })
  expect(saved()['wA:p2']).toBe('work')
})

test('a pane vouches for its profile only when herdr proves it holds the terminal it was recorded with', () => {
  isolatedHome()
  recordProfilePane('wA:p9', 'work', 'term-1')
  recordProfilePane('wB:p1', 'gamedev') // herdr did not say which terminal
  expect(saved()['wA:p9']).toMatchObject({ profile: 'work', terminal: 'term-1' })
  expect(provenProfilePanes(new Map([['wA:p9', 'term-1']]))).toEqual(new Map([['wA:p9', 'work']]))
  expect(provenProfilePanes(new Map([['wA:p9', 'term-2']]))).toEqual(new Map())
  expect(provenProfilePanes(new Map([['wA:p9', null]]))).toEqual(new Map())
  // A record that names no terminal can never be told from a reused id.
  expect(provenProfilePanes(new Map([['wB:p1', 'term-5']]))).toEqual(new Map())
  expect(provenProfilePanes(new Map([['wB:p1', null]]))).toEqual(new Map())
  // A pane herdr no longer has vouches for nothing.
  expect(provenProfilePanes(new Map())).toEqual(new Map())

  // Recorded again without a terminal: the old one does not stay to vouch for the new pane.
  recordProfilePane('wA:p9', 'default')
  expect(saved()['wA:p9']).not.toHaveProperty('terminal')
  expect(provenProfilePanes(new Map([['wA:p9', 'term-1']]))).toEqual(new Map())
})

test('a pane could be in its recorded profile unless herdr proves it holds another terminal', () => {
  isolatedHome()
  writeSaved({
    'wA:p9': { profile: 'work', terminal: 'term-1', at: 1 },
    'wB:p1': { profile: 'gamedev', at: 1 }, // the terminal not recorded
  })
  // The same terminal, or one not known on either side: it still could be.
  expect(possibleProfilePanes(new Map([['wA:p9', 'term-1']]))).toEqual(new Map([['wA:p9', 'work']]))
  expect(possibleProfilePanes(new Map([['wA:p9', null]]))).toEqual(new Map([['wA:p9', 'work']]))
  expect(possibleProfilePanes(new Map([['wB:p1', 'term-5']]))).toEqual(new Map([['wB:p1', 'gamedev']]))
  expect(possibleProfilePanes(new Map([['wB:p1', null]]))).toEqual(new Map([['wB:p1', 'gamedev']]))
  // Both known and not the same: herdr gave the id to another terminal, with its own env.
  expect(possibleProfilePanes(new Map([['wA:p9', 'term-2']]))).toEqual(new Map())
  // A pane herdr no longer has is in no profile.
  expect(possibleProfilePanes(new Map())).toEqual(new Map())
})

test('forgetting by the live panes and their terminals: only a gone pane or a proven reuse goes, a Set of ids still works', () => {
  isolatedHome()
  forgetProfilePanes(new Map()) // nothing recorded: no file
  expect(existsSync(profilePanesFile())).toBe(false)

  const kept = {
    'wA:p9': { profile: 'work', terminal: 'term-1', at: 1, by: 'board' },
    'wC:p2': { profile: 'work', at: 1 },
    'wE:p4': { profile: 'work', terminal: 'term-4', at: 1 },
  }
  writeSaved({
    ...kept,
    'wB:p1': { profile: 'gamedev', terminal: 'term-5', at: 1 },
    'wD:p3': { profile: 'work', terminal: 'term-8', at: 1 },
  })
  forgetProfilePanes(
    new Map([
      ['wA:p9', 'term-1'], // the same terminal: kept
      ['wB:p1', 'term-6'], // herdr gave the id to another terminal: dropped
      ['wC:p2', 'term-7'], // a record that names none: kept, it still blocks
      ['wE:p4', null], // herdr did not say: kept
      // wD:p3 is gone
    ]),
  )
  expect(saved()).toEqual(kept)
  // The dropped reuse no longer blocks; the kept unknowns still do.
  expect(
    possibleProfilePanes(
      new Map([
        ['wB:p1', null],
        ['wC:p2', null],
        ['wE:p4', null],
      ]),
    ),
  ).toEqual(
    new Map([
      ['wC:p2', 'work'],
      ['wE:p4', 'work'],
    ]),
  )

  // Nothing to drop: the file is not written again.
  const mtime = statSync(profilePanesFile()).mtimeMs
  const text = readFileSync(profilePanesFile(), 'utf8')
  forgetProfilePanes(
    new Map([
      ['wA:p9', 'term-1'],
      ['wC:p2', null],
      ['wE:p4', 'term-4'],
    ]),
  )
  forgetProfilePanes(new Set(['wA:p9', 'wC:p2', 'wE:p4']))
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
