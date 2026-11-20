// Verified done's pure parts (#492): the config, the checklist per lane, the fold of a verification
// (also in the shared order, where a peer's board folds the same feed), and the verifier's brief.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { foldShared } from '../../src/core/work-share.ts'
import {
  applyEntry,
  briefFor,
  type Party,
  type ThreadEntry,
  type ThreadHead,
  threadsConfig,
  verifyConfig,
} from '../../src/core/work-threads.ts'
import { heldEntry, verifyBrief } from '../../src/core/work-verify.ts'

const ben: Party = { kind: 'session', key: 'ben-key', name: 'ben' }
const vf: Party = { kind: 'session', key: 'vf-key', name: 'verify-atlas-1' }
const base: ThreadHead = {
  id: 't1',
  key: 'atlas-1',
  lane: 'atlas',
  title: 'Map the price columns',
  summary: '',
  status: 'next',
  waitingOn: '',
  proposed: null,
  assignee: null,
  parent: null,
  scope: 'local',
  createdBy: { kind: 'owner' },
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  rev: 0,
}
let n = 0
const entry = (author: Party, set: ThreadEntry['set'], text = ''): ThreadEntry => {
  n++
  return { id: `e${n}`, thread: 't1', n, seq: n, at: n * 1000, author, type: 'note', text, ...(set && { set }) }
}

test('threads.verify: absent is off and leaves the config as it was; true or an object is on with defaults and checks', () => {
  assert.equal('verify' in (threadsConfig(true) ?? {}), false)
  assert.equal('verify' in (threadsConfig({ agents: true }) ?? {}), false)
  assert.equal(threadsConfig({ verify: false })?.verify, null)
  assert.deepEqual(verifyConfig(true), { model: null, lanes: [], brief: null, profile: null, limitMin: 30, max: 2 })
  assert.deepEqual(
    verifyConfig({
      model: 'opus',
      lanes: ['Atlas', 'no lane', 'ops'],
      brief: { atlas: 'a.md', '*': 'b.md', 'x y': 'c.md' },
      limitMin: 0,
      max: 99,
    }),
    {
      model: 'opus',
      lanes: ['atlas', 'ops'],
      brief: { atlas: 'a.md', '*': 'b.md' },
      profile: null,
      limitMin: 30,
      max: 10,
    },
  )
  const c = verifyConfig({ brief: { atlas: 'a.md', '*': 'b.md' } }) as NonNullable<ReturnType<typeof verifyConfig>>
  assert.equal(briefFor(c, 'atlas'), 'a.md')
  assert.equal(briefFor(c, 'ops'), 'b.md')
  assert.equal(briefFor({ brief: 'one.md' }, 'ops'), 'one.md')
  assert.equal(briefFor({ brief: null }, 'ops'), null)
})

test('the fold: on, acceptance lines, a held done, a verifier, a fail, a pass; a head without it has no verify field', () => {
  n = 0
  assert.equal('verify' in applyEntry(base, entry(ben, { status: 'doing' })), false)
  const feed = [
    entry({ kind: 'owner' }, { title: base.title, status: 'doing', lane: 'atlas', verify: true }),
    entry({ kind: 'owner' }, { accept: 'every row mapped' }),
    entry(ben, { status: 'done', hold: true, summary: 'mapped' }, 'all 217 rows'),
    entry(vf, { verifier: { key: 'vf-key', name: 'verify-atlas-1', at: 4000, until: 99_000 } }),
    entry(vf, { verdict: 'fail', status: 'doing' }, 'rows missing'),
    entry(ben, { status: 'done', hold: true, summary: 'mapped again' }),
    entry(vf, { verifier: { key: 'vf2', name: 'verify-atlas-1', at: 7000, until: 99_000 } }),
  ]
  let h = base
  const heads = feed.map(e => {
    h = applyEntry(h, e)
    return h
  })
  expect(heads[2]).toMatchObject({ status: 'doing', summary: '', proposed: { by: ben, why: 'mapped', verify: true } })
  expect(heads[3]?.verify).toMatchObject({ on: true, accept: ['every row mapped'], run: { key: 'vf-key' }, fails: 0 })
  expect(heads[4]).toMatchObject({ status: 'doing', proposed: null, verify: { run: null, fails: 1, last: 'fail' } })
  expect(heads[6]?.verify).toMatchObject({ run: { key: 'vf2' }, fails: 1 })
  const pass = applyEntry(h, entry(vf, { verdict: 'pass', status: 'done', summary: 'mapped again' }, 'checked'))
  expect(pass).toMatchObject({
    status: 'done',
    summary: 'mapped again',
    proposed: null,
    verify: { run: null, fails: 0, last: 'pass' },
  })
  // The owner keeps it open: the run ends, the verifier's word no longer counts.
  const kept = applyEntry(h, entry({ kind: 'owner' }, { status: 'doing' }))
  expect(kept).toMatchObject({ proposed: null, verify: { run: null, fails: 1 } })
  // Folded in the shared order from a head that already holds a verification: the same head, no line twice.
  const again = foldShared({ ...h }, feed, 'me')
  assert.deepEqual(again.verify, h.verify)
})

test('the brief: the rule, the thread, the checklist, cut to 12,000 characters with the checklist going first', () => {
  n = 0
  const feed = [
    entry({ kind: 'owner' }, { title: base.title, status: 'doing', verify: true }),
    entry(ben, { status: 'done', hold: true, summary: 'mapped' }, 'all 217 rows, report attached'),
  ]
  let h = base
  for (const e of feed) h = applyEntry(h, e)
  h = { ...h, verify: { ...(h.verify as NonNullable<ThreadHead['verify']>), accept: ['every row mapped'] } }
  assert.equal(heldEntry(feed)?.id, 'e2')
  const o = {
    head: h,
    entries: feed,
    folder: '/work/atlas',
    until: Date.parse('2026-11-12T14:30:00'),
    now: Date.parse('2026-11-12T14:00:00'),
    limitMin: 30,
    fileAt: () => '',
  }
  const brief = verifyBrief({ ...o, checklist: '# Checklist\n- look yourself' })
  assert.match(brief, /^\[board verify\] You are the verifier of thread atlas-1, started by the board/)
  assert.match(brief, /Time limit: 14:30 \(30 min\)/)
  assert.match(brief, /Lane atlas · done proposed by ben · folder \/work\/atlas/)
  assert.match(brief, /Acceptance lines:\n- every row mapped/)
  assert.match(brief, /The done it proposed \(#2, [^)]+\): mapped\nall 217 rows, report attached/)
  assert.match(brief, /Checklist:\n# Checklist\n- look yourself$/)
  const long = verifyBrief({ ...o, checklist: `# Checklist\n${'- a point to check\n'.repeat(2000)}` })
  assert.ok(long.length <= 12_000)
  assert.match(long, /board thread verdict atlas-1 unsure/)
  assert.match(long, /Acceptance lines:\n- every row mapped/)
})
