// The board's update of itself from git (#617, core/self-update.ts): the switch as config.json has
// it, what skips a check before the fetch, what a pull needs after it (bun install, the installer, a
// restart), the lock files bun install takes before the merge, the titles of what came in, when the
// schedule asks for a check, and how it stands for Settings and board doctor.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  afterFetch,
  autoUpdateConfig,
  type CheckoutLook,
  due,
  lastSlot,
  lockChanges,
  parseCounts,
  parseTitles,
  planFor,
  selfUpdateCheck,
  skipBefore,
  standing,
  type UpdateRecord,
} from '../../src/core/self-update.ts'

const english = translator('en')
const HOUR = 3_600_000
const MIN = 60_000

test('the switch: absent, false and on:false are off; true and an object are on, hourly at 04:00 by default', () => {
  expect(autoUpdateConfig(undefined)).toEqual({ on: false, every: 'hour', at: '04:00' })
  expect(autoUpdateConfig(false).on).toBe(false)
  expect(autoUpdateConfig({ on: false, every: 'day' })).toEqual({ on: false, every: 'day', at: '04:00' })
  expect(autoUpdateConfig(true)).toEqual({ on: true, every: 'hour', at: '04:00' })
  expect(autoUpdateConfig({ every: 'day', at: '06:30' })).toEqual({ on: true, every: 'day', at: '06:30' })
  // values it does not know fall back
  expect(autoUpdateConfig({ every: 'week', at: '25:00' })).toEqual({ on: true, every: 'hour', at: '04:00' })
})

const LOOK: CheckoutLook = {
  node: false,
  checkout: true,
  branch: 'main',
  upstream: 'origin/main',
  dirty: false,
  canRestart: true,
  pending: false,
}

test('before the fetch: a node, an update under way, no checkout, a detached HEAD, no upstream, changes, no run.ts', () => {
  expect(skipBefore(LOOK)).toBeNull()
  expect(skipBefore({ ...LOOK, node: true, checkout: false })).toBe('node')
  expect(skipBefore({ ...LOOK, pending: true })).toBe('running')
  expect(skipBefore({ ...LOOK, checkout: false })).toBe('no-checkout')
  expect(skipBefore({ ...LOOK, branch: null })).toBe('detached')
  expect(skipBefore({ ...LOOK, upstream: null })).toBe('no-upstream')
  expect(skipBefore({ ...LOOK, dirty: true })).toBe('dirty')
  expect(skipBefore({ ...LOOK, canRestart: false })).toBe('restart')
})

test('after the fetch: current, behind, or gone its own way', () => {
  expect(parseCounts('0\t3\n')).toEqual({ ahead: 0, behind: 3 })
  expect(parseCounts('garbage')).toBeNull()
  expect(afterFetch(0, 0)).toBe('current')
  expect(afterFetch(2, 0)).toBe('current')
  expect(afterFetch(0, 3)).toBe('behind')
  expect(afterFetch(1, 3)).toBe('diverged')
})

test('what a pull needs: bun install for the lock files, the installer for its inputs, a restart for code', () => {
  expect(planFor(['README.md', 'docs/design/x.md'])).toEqual({ install: false, installer: false, restart: false })
  expect(planFor(['src/core/board.ts'])).toEqual({ install: false, installer: false, restart: true })
  expect(planFor(['web/styles/app.css'])).toEqual({ install: false, installer: false, restart: true })
  expect(planFor(['bun.lock'])).toEqual({ install: true, installer: false, restart: true })
  expect(planFor(['package.json', 'src/a.ts'])).toEqual({ install: true, installer: false, restart: true })
  expect(planFor(['packages/no-canvas/index.js']).install).toBe(true)
  expect(planFor(['skills/herdr-agents/SKILL.md'])).toEqual({ install: false, installer: true, restart: false })
  expect(planFor(['src/core/install-plan.ts'])).toEqual({ install: false, installer: true, restart: true })
  expect(planFor(['src/adapters/hook-settings.ts']).installer).toBe(true)
})

test('lock files bun install takes before the merge: only ones changed in place', () => {
  expect(lockChanges('')).toEqual([])
  expect(lockChanges('M\tpackage.json\nM\tbun.lock\n')).toEqual(['package.json', 'bun.lock'])
  expect(lockChanges('A\tbun.lock')).toBe('lockfiles')
  expect(lockChanges('M\tpackage.json\nD\tbun.lockb')).toBe('lockfiles')
})

test('the titles of what came in: squashed subjects as they are, a merge commit by its body', () => {
  const F = '\x1f'
  const E = '\x1e'
  const log = [
    `A start waits for a dialog (#602) (#607)${F}${E}`,
    `\nMerge pull request #12 from anna/fix${F}Cards keep their lane\n\nmore${E}`,
    `\nMerge pull request #13 from ben/x${F}${E}\n`,
  ].join('')
  expect(parseTitles(log)).toEqual([
    'A start waits for a dialog (#602) (#607)',
    'Cards keep their lane (#12)',
    'Merge pull request #13 from ben/x',
  ])
  const many = Array.from({ length: 35 }, (_, i) => `c${i}${F}${E}`).join('')
  const titles = parseTitles(many)
  expect(titles).toHaveLength(31)
  expect(titles.at(-1)).toBe('+5')
})

test('the schedule: hourly an hour after the last check; daily once the time passed since the last', () => {
  const day = new Date(2026, 10, 23, 12, 0, 0).getTime()
  const hourly = autoUpdateConfig({ every: 'hour' })
  expect(due(hourly, undefined, day, day)).toBe(true)
  const last: UpdateRecord = { at: day, outcome: 'current' }
  expect(due(hourly, last, day + 59 * MIN, day)).toBe(false)
  expect(due(hourly, last, day + HOUR, day)).toBe(true)
  expect(due(autoUpdateConfig(undefined), undefined, day, day)).toBe(false)

  const daily = autoUpdateConfig({ every: 'day', at: '04:00' })
  const four = new Date(2026, 10, 23, 4, 0, 0).getTime()
  expect(lastSlot('04:00', day)).toBe(four)
  expect(lastSlot('13:00', day)).toBe(new Date(2026, 10, 22, 13, 0, 0).getTime())
  // started after today's 04:00 with no check yet: waits for tomorrow's
  expect(due(daily, undefined, day, day - HOUR)).toBe(false)
  expect(due(daily, undefined, four + 24 * HOUR, day)).toBe(true)
  // checked yesterday: due once 04:00 passed today
  expect(due(daily, { at: four - 2 * HOUR, outcome: 'current' }, four - MIN, 0)).toBe(false)
  expect(due(daily, { at: four - 2 * HOUR, outcome: 'current' }, four + MIN, 0)).toBe(true)
  expect(due(daily, { at: four + MIN, outcome: 'current' }, day, 0)).toBe(false)
})

test('a check that waited on a launch is tried again in five minutes, whatever the schedule', () => {
  const now = new Date(2026, 10, 23, 12, 0, 0).getTime()
  const daily = autoUpdateConfig({ every: 'day', at: '04:00' })
  const busy: UpdateRecord = { at: now, outcome: 'skipped', reason: 'busy' }
  expect(due(daily, busy, now + 4 * MIN, 0)).toBe(false)
  expect(due(daily, busy, now + 5 * MIN, 0)).toBe(true)
  // by hand it does not come back by itself
  expect(due(daily, { ...busy, byHand: true }, now + 5 * MIN, 0)).toBe(false)
})

test('how it stands: a board that did not come back first, then failures, skips, and the plain states', () => {
  const now = 10 * HOUR
  const on = autoUpdateConfig(true)
  const off = autoUpdateConfig(undefined)
  expect(standing(off, {}, now)).toBeNull()
  expect(standing(on, {}, now)?.key).toBe('notYet')
  const pending = {
    at: now - MIN,
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    branch: 'main',
    installer: false,
    came: [],
    byHand: false,
    wake: false,
  }
  expect(standing(on, { pending }, now)?.key).toBe('restarting')
  const stale = standing(off, { pending: { ...pending, at: now - 4 * MIN } }, now)
  expect(stale).toMatchObject({ level: 'error', key: 'notBack', values: { to: 'bbbbbbbb', from: 'aaaaaaaa' } })
  expect(standing(on, { last: { at: now, outcome: 'failed', reason: 'install', detail: 'x' } }, now)).toMatchObject({
    level: 'error',
    key: 'failed.install',
  })
  expect(standing(on, { last: { at: now, outcome: 'skipped', reason: 'dirty' } }, now)?.level).toBe('warn')
  expect(standing(on, { last: { at: now, outcome: 'skipped', reason: 'node' } }, now)?.level).toBe('ok')
  expect(standing(on, { last: { at: now, outcome: 'current', commit: 'c'.repeat(40) } }, now)).toMatchObject({
    key: 'current',
    values: { commit: 'cccccccc' },
  })
  // off, a plain state is nothing to say
  expect(standing(off, { last: { at: now, outcome: 'current' } }, now)).toBeNull()
})

test("board doctor's line: none while off with nothing done; an error with its fix for a board that did not come back", () => {
  const now = 10 * HOUR
  expect(selfUpdateCheck(undefined, {}, now, english)).toBeNull()
  const ok = selfUpdateCheck(
    { every: 'day', at: '05:00' },
    { last: { at: now, outcome: 'current', commit: 'c'.repeat(40) } },
    now,
    english,
  )
  expect(ok).toMatchObject({ id: 'self-update', level: 'ok', fix: '' })
  expect(ok?.detail).toContain('Up to date at cccccccc')
  expect(ok?.detail).toContain('Once a day at 05:00')
  const pending = {
    at: now - 5 * MIN,
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    branch: 'main',
    installer: false,
    came: [],
    byHand: true,
    wake: false,
  }
  const bad = selfUpdateCheck(undefined, { pending }, now, english)
  expect(bad?.level).toBe('error')
  expect(bad?.detail).toContain('did not come back after updating to bbbbbbbb')
  // the board is down: board update cannot reach it, a pull by hand can
  expect(bad?.fix).toContain('git pull')
  const failed = selfUpdateCheck(true, { last: { at: now, outcome: 'failed', reason: 'install' } }, now, english)
  expect(failed?.fix).toContain('board update')
})
