import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { profilePanesFile } from '../../src/adapters/paths.ts'
import { forgetProfilePanes, profilePanes, recordProfilePane } from '../../src/adapters/profile-panes.ts'
import { isolatedHome } from '../support/env.ts'

const saved = (): Record<string, unknown> => JSON.parse(readFileSync(profilePanesFile(), 'utf8'))

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
  mkdirSync(dirname(profilePanesFile()), { recursive: true })
  writeFileSync(
    profilePanesFile(),
    JSON.stringify({
      'wA:p1': { profile: 'work', at: 1, by: 'board' },
      'wA:p2': 'work',
      'wA:p3': { profile: 7 },
    }),
  )
  expect(profilePanes()).toEqual(new Map([['wA:p1', 'work']]))
  // Opened again in another profile (herdr reuses pane ids): the newest record wins, its own fields kept.
  recordProfilePane('wA:p1', 'default')
  expect(saved()['wA:p1']).toMatchObject({ profile: 'default', by: 'board' })
  expect(saved()['wA:p2']).toBe('work')
})
