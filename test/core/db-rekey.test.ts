import { expect, test } from 'bun:test'
import {
  formatRekeyReport,
  rekeyActorText,
  rekeyColumnValue,
  rekeyKey,
  rekeyMoveMark,
  rekeyOwnerWatchState,
  rekeyParty,
  rekeyScheduleEntry,
  SYNTHETIC_FROM_KEYS,
  validateRekeyDevices,
} from '../../src/core/db-rekey.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Card } from '../../src/core/types.ts'

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const PANE = 'pane-w1:p2'
const WIN_PI = 'C:\\Users\\anna\\.pi\\sessions\\my session 50% тест.jsonl'
const POSIX_PI = '/home/anna/work/proj 100%/тест.jsonl'

test('validateRekeyDevices accepts valid device pairs and rejects invalid ones', () => {
  expect(validateRekeyDevices('laptop', 'server-1')).toEqual({ ok: true, from: 'laptop', to: 'server-1' })
  expect(validateRekeyDevices(' laptop ', ' atlas-2 ')).toEqual({ ok: true, from: 'laptop', to: 'atlas-2' })
  expect(validateRekeyDevices(undefined, 'server-1').ok).toBe(false)
  expect(validateRekeyDevices('laptop', undefined).ok).toBe(false)
  expect(validateRekeyDevices('local', 'server-1').ok).toBe(false)
  expect(validateRekeyDevices('laptop', 'local').ok).toBe(false)
  expect(validateRekeyDevices('laptop', 'laptop').ok).toBe(false)
  expect(validateRekeyDevices('BadCase', 'server-1').ok).toBe(false)
  expect(validateRekeyDevices('bad:id', 'server-1').ok).toBe(false)
  expect(validateRekeyDevices('@bad', 'server-1').ok).toBe(false)
})

test('rekeyKey maps local <-> @device: both ways across UUID, pane, Windows and POSIX paths', () => {
  for (const raw of [UUID, PANE, WIN_PI, POSIX_PI]) {
    const movedOut = rekeyKey(raw, 'laptop', 'server-1')
    expect(movedOut).toBe(`@laptop:${raw}`)
    expect(rekeyKey(movedOut, 'server-1', 'laptop')).toBe(raw)

    const movedIn = rekeyKey(`@server-1:${raw}`, 'laptop', 'server-1')
    expect(movedIn).toBe(raw)
    expect(rekeyKey(movedIn, 'server-1', 'laptop')).toBe(`@server-1:${raw}`)

    const thirdParty = `@atlas-2:${raw}`
    expect(rekeyKey(thirdParty, 'laptop', 'server-1')).toBe(thirdParty)
    expect(rekeyKey(thirdParty, 'server-1', 'laptop')).toBe(thirdParty)

    // Already prefixed with old master stays as-is (does not double-prefix).
    expect(rekeyKey(`@laptop:${raw}`, 'laptop', 'server-1')).toBe(`@laptop:${raw}`)
  }
  expect(rekeyKey('', 'laptop', 'server-1')).toBe('')
})

test('rekeyParty and rekeyActorText preserve non-session actors and rekey session actors', () => {
  expect(rekeyParty({ kind: 'owner' }, 'laptop', 'server-1')).toEqual({ value: { kind: 'owner' }, changed: false })
  expect(rekeyParty({ kind: 'peer', peer: 'ben', name: 'Ben' }, 'laptop', 'server-1').changed).toBe(false)
  expect(rekeyParty({ kind: 'session', key: UUID, name: 'Anna' }, 'laptop', 'server-1')).toEqual({
    value: { kind: 'session', key: `@laptop:${UUID}`, name: 'Anna' },
    changed: true,
  })
  expect(rekeyParty({ kind: 'session', key: `@server-1:${UUID}`, name: 'Ben' }, 'laptop', 'server-1')).toEqual({
    value: { kind: 'session', key: UUID, name: 'Ben' },
    changed: true,
  })

  expect(rekeyActorText('user', 'laptop', 'server-1')).toEqual({ value: 'user', changed: false })
  expect(rekeyActorText('import', 'laptop', 'server-1')).toEqual({ value: 'import', changed: false })
  const actor = rekeyActorText(JSON.stringify({ key: UUID, name: 'Cleo' }), 'laptop', 'server-1')
  expect(actor.changed).toBe(true)
  expect(JSON.parse(actor.value)).toEqual({ key: `@laptop:${UUID}`, name: 'Cleo' })
})

test('rekeyColumnValue handles every ColumnRekeyKind', () => {
  expect(rekeyColumnValue('none', UUID, 'laptop', 'server-1')).toEqual({ value: UUID, changed: false })
  expect(rekeyColumnValue('key', null, 'laptop', 'server-1')).toEqual({ value: null, changed: false })
  expect(rekeyColumnValue('key', UUID, 'laptop', 'server-1')).toEqual({ value: `@laptop:${UUID}`, changed: true })
  expect(rekeyColumnValue('key-pk', `@server-1:${PANE}`, 'laptop', 'server-1')).toEqual({ value: PANE, changed: true })

  const proposed = rekeyColumnValue(
    'json-proposed',
    JSON.stringify({ by: { kind: 'session', key: UUID, name: 'Anna' }, at: 1, why: 'done' }),
    'laptop',
    'server-1',
  )
  expect(proposed.changed).toBe(true)
  expect(JSON.parse(proposed.value ?? '')).toEqual({
    by: { kind: 'session', key: `@laptop:${UUID}`, name: 'Anna' },
    at: 1,
    why: 'done',
  })

  const scope = rekeyColumnValue(
    'json-scope',
    JSON.stringify({
      kind: 'local',
      request: { to: 'team', history: true, by: { kind: 'session', key: `@server-1:${UUID}`, name: 'Ben' }, at: 2 },
    }),
    'laptop',
    'server-1',
  )
  expect(scope.changed).toBe(true)
  expect(JSON.parse(scope.value ?? '').request.by.key).toBe(UUID)

  const state = rekeyColumnValue(
    'json-state',
    JSON.stringify({ text: 'ok', at: 3, by: { kind: 'session', key: UUID, name: 'Atlas' } }),
    'laptop',
    'server-1',
  )
  expect(state.changed).toBe(true)
  expect(JSON.parse(state.value ?? '').by.key).toBe(`@laptop:${UUID}`)

  const verify = rekeyColumnValue(
    'json-verify',
    JSON.stringify({
      on: true,
      accept: [],
      run: { key: `@server-1:${UUID}`, name: 'Check', at: 4, until: 5 },
      fails: 0,
      last: null,
    }),
    'laptop',
    'server-1',
  )
  expect(verify.changed).toBe(true)
  expect(JSON.parse(verify.value ?? '').run.key).toBe(UUID)

  const entrySet = rekeyColumnValue(
    'json-entry-set',
    JSON.stringify({
      assignee: { kind: 'session', key: UUID, name: 'Anna' },
      verifier: { key: `@server-1:${PANE}`, name: 'Verifier', at: 6, until: 7 },
    }),
    'laptop',
    'server-1',
  )
  expect(entrySet.changed).toBe(true)
  expect(JSON.parse(entrySet.value ?? '')).toEqual({
    assignee: { kind: 'session', key: `@laptop:${UUID}`, name: 'Anna' },
    verifier: { key: PANE, name: 'Verifier', at: 6, until: 7 },
  })
})

test('rekeyScheduleEntry rekeys key, agent from, movedFrom while keeping synthetic from keys and receipts', () => {
  const base: ScheduleEntry = {
    id: 'a1b2c3',
    key: UUID,
    text: 'ping',
    next: 1000,
    from: { key: `@server-1:${PANE}`, name: 'Ben' },
    movedFrom: { key: 'old-local', name: 'Old' },
    fromDevice: 'server-1',
    receipt: { key: 'h', session: UUID, reportId: 'r1', hash: '0'.repeat(64) },
  }
  const r = rekeyScheduleEntry(base, 'laptop', 'server-1')
  expect(r.changed).toBe(true)
  expect(r.fields).toEqual(['key', 'from', 'movedFrom'])
  expect(r.entry.key).toBe(`@laptop:${UUID}`)
  expect(r.entry.from).toEqual({ key: PANE, name: 'Ben' })
  expect(r.entry.movedFrom).toEqual({ key: '@laptop:old-local', name: 'Old' })
  expect(r.entry.fromDevice).toBe('server-1')
  expect(r.entry.receipt).toEqual(base.receipt)

  for (const syn of SYNTHETIC_FROM_KEYS) {
    const e: ScheduleEntry = {
      id: 'f00112',
      key: `@server-1:${UUID}`,
      text: 'x',
      next: 1,
      from: { key: syn, name: syn },
    }
    const res = rekeyScheduleEntry(e, 'laptop', 'server-1')
    expect(res.entry.key).toBe(UUID)
    expect(res.entry.from).toEqual({ key: syn, name: syn })
    expect(res.fields).toEqual(['key'])
  }
})

test('rekeyMoveMark rewrites legacy local/board marks to old master and leaves real devices untouched', () => {
  const legacyBoard: Card = { key: UUID, moved: { to: 'board', cwd: '/tmp', at: 10 } }
  expect(rekeyMoveMark(legacyBoard, 'laptop', 'server-1')).toEqual({
    card: { key: UUID, moved: { to: 'laptop', cwd: '/tmp', at: 10 } },
    changed: true,
    fromTo: 'board',
  })

  const legacyLocal: Card = { key: UUID, moved: { to: 'local', cwd: '/tmp', at: 10 } }
  expect(rekeyMoveMark(legacyLocal, 'laptop', 'server-1').card.moved).toEqual({ to: 'laptop', cwd: '/tmp', at: 10 })

  const realDevice: Card = { key: UUID, moved: { to: 'server-1', cwd: '/tmp', at: 10 } }
  expect(rekeyMoveMark(realDevice, 'laptop', 'server-1').changed).toBe(false)

  // Never rewrite 'board' when one of the device ids is literally 'board'.
  expect(rekeyMoveMark(legacyBoard, 'board', 'server-1').changed).toBe(false)
  expect(rekeyMoveMark(legacyBoard, 'laptop', 'board').changed).toBe(false)
})

test('rekeyOwnerWatchState rekeys watcher session keys and card:<key> entries', () => {
  const raw = {
    [UUID]: {
      at: 10,
      told: { [`card:${UUID}`]: { who: 'Anna', text: 'q1' }, 'thread:t1': { who: 'atlas-1', text: 'q2' } },
      base: { [`card:@server-1:${PANE}`]: { who: 'Ben', text: 'q3' } },
    },
    [`@server-1:${PANE}`]: {
      at: 20,
      told: { [`card:@atlas-2:${UUID}`]: { who: 'Cleo', text: 'q4' } },
    },
  }
  const r = rekeyOwnerWatchState(raw, 'laptop', 'server-1')
  expect(r.changed).toBe(true)
  expect(r.sessions).toBe(2)
  expect(r.cards).toBe(2)
  expect(Object.keys(r.state).sort()).toEqual([`@laptop:${UUID}`, PANE])
  expect((r.state[`@laptop:${UUID}`] as { told: Record<string, unknown> }).told).toEqual({
    [`card:@laptop:${UUID}`]: { who: 'Anna', text: 'q1' },
    'thread:t1': { who: 'atlas-1', text: 'q2' },
  })
  expect((r.state[`@laptop:${UUID}`] as { base: Record<string, unknown> }).base).toEqual({
    [`card:${PANE}`]: { who: 'Ben', text: 'q3' },
  })
  expect((r.state[PANE] as { told: Record<string, unknown> }).told).toEqual({
    [`card:@atlas-2:${UUID}`]: { who: 'Cleo', text: 'q4' },
  })
})

test('formatRekeyReport formats dry-run, real run and idempotent output without em/en dashes', () => {
  const lines = formatRekeyReport({
    from: 'laptop',
    to: 'server-1',
    dryRun: true,
    already: false,
    backup: null,
    db: { exists: true, total: 3, tables: [{ table: 'threads', column: 'assignee', rows: 3 }] },
    schedule: {
      entries: [{ id: 'a1b2c3', kind: 'entry', fromKey: 's1', toKey: '@laptop:s1', fields: ['key'] }],
      watches: [],
    },
    moveMarks: [],
    ownerWatch: { exists: false, sessions: 0, cards: 0 },
  })
  expect(lines[0]).toBe('dry-run · rekey laptop -> server-1 (no changes written)')
  expect(lines.join('\n')).not.toMatch(/[\u2013\u2014]/)
  expect(
    formatRekeyReport({
      from: 'laptop',
      to: 'server-1',
      dryRun: false,
      already: true,
      backup: null,
      db: { exists: true, total: 0, tables: [] },
      schedule: { entries: [], watches: [] },
      moveMarks: [],
      ownerWatch: { exists: false, sessions: 0, cards: 0 },
    }),
  ).toEqual(['ok · already rekeyed from laptop to server-1 (0 changes)'])
})
