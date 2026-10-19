import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { BRIEF_VERSION, brief, herdrLine, waitReminder } from '../../src/core/brief.ts'
import { t, useLanguage } from '../../src/core/lang.ts'
import type { Config } from '../../src/core/types.ts'
import { oldCode, oldFunction } from '../web/support/old-app.ts'

// The board's texts follow the system language by default: the tests pin English.
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const cfg = {
  categories: [
    { id: 'acme', title: 'Acme', color: 'blue', paths: ['C:\\Clients'] },
    { id: 'beta', title: 'Beta', color: 'blue', paths: ['C:\\Beta'] },
    { id: 'globex', title: 'Globex', color: 'blue', paths: ['C:\\Clients\\Globex'] },
    { id: 'personal', title: 'Personal', color: 'blue', paths: ['C:\\Home'] },
    { id: 'other', title: 'Other', color: 'gray', paths: [] },
  ],
} as unknown as Config

test('brief names the guessed lane and the known ids; reminder quotes the wait', () => {
  const text = brief(cfg, null, 'C:\\Clients\\Globex')
  assert.match(text, /Now: globex \(guessed/)
  assert.match(text, /acme \(Acme\), beta \(Beta\)/)
  assert.match(text, /Card texts in English/)
  assert.match(brief(cfg, { category: 'beta', wait: 'CI' }, 'C:\\X'), /Now: beta\..*Card now: waiting "CI"/s)
  assert.match(brief(cfg, null, 'C:\\X'), /not set, set it now/)
  assert.match(waitReminder({ wait: 'client reply' }), /"client reply"/)
})

test('brief: a session in herdr hears its pane and the skill; one outside herdr hears nothing of it', () => {
  const inside = brief(cfg, null, 'C:\\X', {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w1:p3',
    HERDR_TAB_ID: 'w1:t2',
    HERDR_WORKSPACE_ID: 'w1',
  })
  assert.match(inside, /runs in herdr, in pane w1:p3 \(tab w1:t2, workspace w1\)\..*herdr-agents skill/)
  assert.match(
    inside,
    /restarting itself \(a dropped MCP server, changed settings, hooks or skills\), a pane for a server or a login: see the herdr-agents skill\./,
  )
  assert.equal(
    inside.split('\n').at(-1),
    inside.split('\n').find(l => l.includes('herdr-agents')),
  )
  const outside = brief(cfg, null, 'C:\\X', {})
  assert.doesNotMatch(outside, /herdr-agents|runs in herdr/)
  // A pane id alone (a variable left over from a parent shell) is not herdr.
  assert.doesNotMatch(brief(cfg, null, 'C:\\X', { HERDR_PANE_ID: 'w1:p3' }), /runs in herdr/)
})

test('the line about herdr is upstream’s at #51, word for word', () => {
  const theirs = oldFunction(oldCode('src/brief.mjs', ['herdrLine'], {}, '513e441'), 'herdrLine')
  for (const env of [
    { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p3', HERDR_TAB_ID: 'w1:t2', HERDR_WORKSPACE_ID: 'w1' },
    { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p3' },
    { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p3', HERDR_WORKSPACE_ID: 'w1' },
    { HERDR_PANE_ID: 'w1:p3' },
    {},
  ])
    assert.equal(herdrLine(env), theirs(env), JSON.stringify(env))
})

test('the board switches language in place: the brief follows', () => {
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
    useLanguage('ru')
    assert.match(brief(cfg, null, 'C:\\X'), /Card texts in Russian/)
    assert.equal(t('lane.other'), 'Прочее')
  } finally {
    useLanguage('en')
  }
})

test('the brief tells agents about the schedule', () => {
  const text = brief(
    { categories: [{ id: 'other', title: 'Other', color: 'gray', paths: [] }] } as unknown as Config,
    null,
    'C:\\X',
  )
  assert.match(text, /board remind <when> "<text>"/)
  assert.match(text, /board every "<cron, 5 fields>"/)
  assert.match(text, /CronCreate or ScheduleWakeup/)
  // #51 told sessions in herdr they can restart themselves: every running one hears it again.
  assert.ok(BRIEF_VERSION >= 5)
})
