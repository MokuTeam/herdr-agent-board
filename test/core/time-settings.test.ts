// Settings → Time's changes of config.json's `time` (#237, core/time-settings.ts): each keeps what
// the section has that it does not change, and refuses what it cannot make sense of.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { timeConfig } from '../../src/core/time.ts'
import { editedTime, newProblems, type TimeEdit } from '../../src/core/time-settings.ts'

const NY = 'America/New_York'
const ZONE = 'Europe/Istanbul'
const BASE = {
  zone: NY,
  excludeTags: ['deferred'],
  clients: {
    'client-a': {
      projects: ['Support', 'Migration'],
      billing: [{ group: 'ref', step: 30, round: 'up' }],
      nonBillable: ['Migration'],
      systems: ['erp'],
      ref: '^Case (\\d{5})',
    },
    personal: { projects: ['Internal'], billable: false },
  },
}

/** The section after one edit; a refusal fails the test. */
function edited(time: unknown, e: TimeEdit): Record<string, unknown> {
  const r = editedTime(time, e, ZONE)
  if ('key' in r) assert.fail(`refused: ${r.key}`)
  return r.time as Record<string, unknown>
}
const refusal = (time: unknown, e: TimeEdit): string => {
  const r = editedTime(time, e, ZONE)
  return 'key' in r ? r.key : 'none'
}
const client = (time: Record<string, unknown>, id: string) =>
  (time.clients as Record<string, Record<string, unknown>>)[id] as Record<string, unknown>

test('on and off: off keeps every setting, on again takes `on` out; on from nothing is the zone and no lane yet', () => {
  const off = edited(BASE, { op: 'on', on: false })
  assert.deepEqual(off, { ...BASE, on: false })
  assert.equal(timeConfig(off), null)
  assert.deepEqual(edited(off, { op: 'on', on: true }), BASE)
  assert.deepEqual(edited(undefined, { op: 'on', on: true }), { zone: ZONE, clients: {} })
  assert.equal(edited(true, { op: 'on', on: true }), true)
  // `true` off and on again: every lane in this computer's zone, as `true` was
  assert.deepEqual(edited(edited(true, { op: 'on', on: false }), { op: 'on', on: true }), { zone: ZONE })
  // the input is not changed in place
  assert.equal('on' in BASE, false)
})

test('the zone: one Intl knows, else refused', () => {
  assert.equal(edited(BASE, { op: 'zone', zone: ' Europe/Berlin ' }).zone, 'Europe/Berlin')
  assert.equal(refusal(BASE, { op: 'zone', zone: 'Nowhere/Here' }), 'time.err.zone')
})

test('lanes: a lane takes time with an empty list; a client off and on; every lane made explicit, each with any project', () => {
  const took = edited(BASE, { op: 'client', client: 'client-b', on: true })
  assert.deepEqual(client(took, 'client-b'), { projects: [] })
  const off = edited(took, { op: 'client', client: 'client-a', on: false })
  assert.equal(client(off, 'client-a').on, false)
  assert.deepEqual(client(off, 'client-a').projects, ['Support', 'Migration'], 'its settings stay')
  assert.equal('on' in client(edited(off, { op: 'client', client: 'client-a', on: true }), 'client-a'), false)
  // every lane: its choice made explicit first
  assert.equal(refusal(true, { op: 'client', client: 'x', on: true }), 'time.set.err.every')
  assert.deepEqual(edited(true, { op: 'lanes', lanes: ['a', 'b', 'a'] }), { zone: ZONE, clients: { a: {}, b: {} } })
  // no time at all: set up off, nothing but On turns it on; the lanes chosen are its first clients
  assert.deepEqual(edited(undefined, { op: 'client', client: 'a', on: true }), {
    on: false,
    zone: ZONE,
    clients: { a: { projects: [] } },
  })
  assert.deepEqual(edited(undefined, { op: 'lanes', lanes: ['a'] }), { on: false, zone: ZONE, clients: { a: {} } })
  assert.deepEqual(edited(BASE, { op: 'lanes', lanes: ['x'] }), BASE, 'lanes chosen already: left as they are')
})

test('projects: added once (case and spaces aside), renamed in every list that names it, retired and brought back', () => {
  assert.deepEqual(client(edited(BASE, { op: 'project', client: 'client-a', name: ' Audit ' }), 'client-a').projects, [
    'Support',
    'Migration',
    'Audit',
  ])
  assert.equal(refusal(BASE, { op: 'project', client: 'client-a', name: 'support ' }), 'time.set.err.exists')
  assert.equal(refusal(BASE, { op: 'project', client: 'nope', name: 'X' }), 'time.set.err.client')
  const renamed = client(
    edited(BASE, { op: 'rename', client: 'client-a', from: 'Migration', to: 'Upgrade' }),
    'client-a',
  )
  assert.deepEqual([renamed.projects, renamed.nonBillable], [['Support', 'Upgrade'], ['Upgrade']])
  // a case of its own may change; another project's name may not
  assert.deepEqual(
    client(edited(BASE, { op: 'rename', client: 'client-a', from: 'Support', to: 'SUPPORT' }), 'client-a').projects,
    ['SUPPORT', 'Migration'],
  )
  assert.equal(
    refusal(BASE, { op: 'rename', client: 'client-a', from: 'Support', to: 'migration' }),
    'time.set.err.exists',
  )
  assert.equal(refusal(BASE, { op: 'rename', client: 'client-a', from: 'Nope', to: 'X' }), 'time.set.err.noSuch')
  const retired = edited(BASE, { op: 'retire', client: 'client-a', project: 'Migration' })
  assert.deepEqual(
    [client(retired, 'client-a').projects, client(retired, 'client-a').retired],
    [['Support'], ['Migration']],
  )
  // retired is a name the client has: typed again, it is brought back
  assert.equal(
    refusal(retired, { op: 'rename', client: 'client-a', from: 'Support', to: 'migration' }),
    'time.set.err.exists',
  )
  const again = client(edited(retired, { op: 'project', client: 'client-a', name: 'migration' }), 'client-a')
  assert.deepEqual([again.projects, 'retired' in again], [['Support', 'Migration'], false])
  assert.deepEqual(timeConfig(retired)?.problems, [], 'a retired project may stay non-billable')
})

test('a client that took any project keeps a list from the projects given; adding to "any" is refused', () => {
  const any = { zone: NY, clients: { a: {} } }
  assert.equal(refusal(any, { op: 'project', client: 'a', name: 'X' }), 'time.set.err.anyProject')
  assert.deepEqual(client(edited(any, { op: 'list', client: 'a', projects: ['Support', 'support ', 'Calls'] }), 'a'), {
    projects: ['Support', 'Calls'],
  })
})

test('billable: the client’s (true is its default, no key), a project’s (nonBillable), systems with a name or none', () => {
  const p = edited(BASE, { op: 'billable', client: 'personal', billable: true })
  assert.equal('billable' in client(p, 'personal'), false)
  assert.equal(
    client(edited(BASE, { op: 'billable', client: 'client-a', billable: false }), 'client-a').billable,
    false,
  )
  const billed = edited(BASE, { op: 'projectBillable', client: 'client-a', project: 'Migration', billable: true })
  assert.equal('nonBillable' in client(billed, 'client-a'), false)
  assert.deepEqual(
    client(edited(BASE, { op: 'projectBillable', client: 'client-a', project: 'Support', billable: false }), 'client-a')
      .nonBillable,
    ['Migration', 'Support'],
  )
  const systems = edited(BASE, {
    op: 'systems',
    client: 'client-a',
    systems: [
      { id: 'erp', title: 'erp' },
      { id: 'tracker', title: 'Tracker' },
    ],
  })
  assert.deepEqual(client(systems, 'client-a').systems, ['erp', { id: 'tracker', title: 'Tracker' }])
  assert.equal('systems' in client(edited(BASE, { op: 'systems', client: 'client-a', systems: [] }), 'client-a'), false)
  assert.equal(
    refusal(BASE, { op: 'systems', client: 'client-a', systems: [{ id: 'Bad Id', title: '' }] }),
    'time.set.err.system',
  )
  // what Settings → Time does not touch stays as it is
  assert.deepEqual(client(systems, 'client-a').billing, BASE.clients['client-a'].billing)
  assert.equal(client(systems, 'client-a').ref, BASE.clients['client-a'].ref)
})

test('newProblems: only what the edit brought, a problem already there is not one', () => {
  const was = [{ at: 'time.clients.a.billing[0].round', why: 'round' as const, value: 'upp' }]
  assert.deepEqual(newProblems(was, was), [])
  const more = [...was, { at: 'time.zone', why: 'zone' as const, value: 'X' }]
  assert.deepEqual(newProblems(was, more), [more[1]])
})

test('a project’s systems: set apart from the client’s, back to them, carried by a rename, a system taken off taken off it too', () => {
  const two = {
    ...BASE,
    clients: { ...BASE.clients, 'client-a': { ...BASE.clients['client-a'], systems: ['erp', 'tracker'] } },
  }
  const own = edited(two, { op: 'projectSystems', client: 'client-a', project: 'migration', systems: ['tracker'] })
  // under the name the list has, in the client's order
  assert.deepEqual(client(own, 'client-a').projectSystems, { Migration: ['tracker'] })
  assert.deepEqual(timeConfig(own)?.problems, [])
  const none = edited(own, { op: 'projectSystems', client: 'client-a', project: 'Support', systems: [] })
  assert.deepEqual(client(none, 'client-a').projectSystems, { Migration: ['tracker'], Support: [] })
  // all of the client's, or null: no list of its own
  const all = edited(own, {
    op: 'projectSystems',
    client: 'client-a',
    project: 'Migration',
    systems: ['tracker', 'erp'],
  })
  assert.equal('projectSystems' in client(all, 'client-a'), false)
  const back = edited(own, { op: 'projectSystems', client: 'client-a', project: 'Migration', systems: null })
  assert.equal('projectSystems' in client(back, 'client-a'), false)
  assert.equal(
    refusal(two, { op: 'projectSystems', client: 'client-a', project: 'Nope', systems: ['erp'] }),
    'time.set.err.noSuch',
  )
  assert.equal(
    refusal(two, { op: 'projectSystems', client: 'client-a', project: 'Support', systems: ['wiki'] }),
    'time.set.err.system',
  )
  // a rename takes its systems along
  const renamed = edited(own, { op: 'rename', client: 'client-a', from: 'Migration', to: 'Move' })
  assert.deepEqual(client(renamed, 'client-a').projectSystems, { Move: ['tracker'] })
  // a system taken off the client: off the projects' lists too (only there: entered nowhere)
  const fewer = edited(none, { op: 'systems', client: 'client-a', systems: [{ id: 'erp', title: 'erp' }] })
  assert.deepEqual(client(fewer, 'client-a').projectSystems, { Migration: [], Support: [] })
  assert.deepEqual(timeConfig(fewer)?.problems, [])
  // ids as config.json may hold them, spaces around: read as timeConfig reads them
  const spaced = {
    ...two,
    clients: {
      ...two.clients,
      'client-a': {
        ...two.clients['client-a'],
        systems: [' erp', 'tracker '],
        projectSystems: { Migration: [' tracker'] },
      },
    },
  }
  const kept = edited(spaced, { op: 'systems', client: 'client-a', systems: [{ id: 'tracker', title: '' }] })
  assert.deepEqual(client(kept, 'client-a').projectSystems, { Migration: ['tracker'] })
  const set = edited(spaced, { op: 'projectSystems', client: 'client-a', project: 'Support', systems: [' erp '] })
  assert.deepEqual(client(set, 'client-a').projectSystems, { Migration: [' tracker'], Support: ['erp'] })
  const gone = edited(none, { op: 'systems', client: 'client-a', systems: [] })
  assert.equal('projectSystems' in client(gone, 'client-a'), false)
})
