import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { BRIEF_VERSION, brief, waitReminder } from '../../src/core/brief.ts'
import { t, useLanguage } from '../../src/core/lang.ts'
import type { Config } from '../../src/core/types.ts'

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
  assert.ok(BRIEF_VERSION >= 3)
})
