// The line a notice gets in the conversation (web/src/models/notice.ts, upstream's
// web/notice-model.js), and its texts as upstream wrote them.
import { expect, test } from 'bun:test'
import { STRINGS } from '../../src/core/i18n/strings.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { callNotice, type Notice, reminderNotice, taskNotice } from '../../src/core/notices.ts'
import { promptOf } from '../../src/core/schedule-rules.ts'
import { noticeLine } from '../../web/src/models/notice.ts'
import { type NotificationParts, notification } from '../support/task-notification.ts'
import { oldSource } from './support/old-app.ts'

/** The merge of upstream's call-report PR (#45), the newest that added a notice text ("MokuPilot call results"). */
const CALL_REPORT = 'bde9cfd'

function task(summary: string, more?: NotificationParts): Notice {
  const n = taskNotice(notification(summary, more))
  if (!n) throw new Error(`not a task notice: ${summary}`)
  return n
}

test("a notice line: its words and the tone of its mark, in the board's language", () => {
  const en = translator('en')
  const ru = translator('ru')
  const done = task('Background command "Wait for the event" completed (exit code 0)')
  expect(noticeLine(done, en)).toEqual({ text: 'Background command “Wait for the event”: done', sub: '', tone: 'ok' })
  expect(noticeLine(done, ru).text).toBe('Фоновая команда «Wait for the event»: готово')
  const failed = task('Background command "Run tests" failed with exit code 2', { status: 'failed' })
  expect(noticeLine(failed, ru)).toEqual({ text: 'Фоновая команда «Run tests»: ошибка, код 2', sub: '', tone: 'fail' })
  expect(
    noticeLine(
      task('Background command "Build" was stopped because the system is running low on memory', { status: 'killed' }),
      en,
    ).tone,
  ).toBe('stop')
  expect(noticeLine(task('Monitor event: "log"', { status: null, tail: '<event>x</event>' }), en).text).toBe(
    'Monitor “log”: new event',
  )
  const broke = task('Agent "Log in" failed: Agent terminated early due to an API error', { status: 'failed' })
  expect(noticeLine(broke, ru)).toEqual({
    text: 'Агент «Log in»: ошибка',
    sub: 'Agent terminated early due to an API error',
    tone: 'fail',
  })
  // No name of its own: the summary as Claude Code wrote it.
  expect(
    noticeLine(
      task("Background shell command didn't finish before the previous session ended", { status: 'stopped' }),
      en,
    ).text,
  ).toBe("Background shell command didn't finish before the previous session ended")
  const reminder = reminderNotice(
    '[board schedule 42 from Master: 0 9 * * 1-5; 3 runs since 9:00, sent once] stand-up notes',
  )
  if (!reminder) throw new Error('not a reminder')
  expect(noticeLine(reminder, ru)).toEqual({
    text: 'По расписанию: stand-up notes',
    sub: 'от Master · 0 9 * * 1-5 · 3 runs since 9:00, sent once',
    tone: 'info',
  })
})

test('the notice texts are upstream’s, in English and Russian', () => {
  // web/i18n.js at the merge: the English block first, then the Russian one.
  const upstream = [...oldSource('web/i18n.js', CALL_REPORT).matchAll(/^\s+'(notice\.[^']+)': '([^']*)',$/gm)]
  const half = upstream.length / 2
  expect(half).toBe(18)
  const ours = (lang: 'en' | 'ru') => Object.entries(STRINGS[lang]).filter(([key]) => key.startsWith('notice.'))
  expect(ours('en')).toEqual(upstream.slice(0, half).map(m => [m[1] ?? '', m[2] ?? '']))
  expect(ours('ru')).toEqual(upstream.slice(half).map(m => [m[1] ?? '', m[2] ?? '']))
})

test("a MokuPilot call's results: their title, in the board's language; late, the note quietly", () => {
  const report =
    '# Release 2.4 call · Oct 17 · 32 min\n\n- Decided: ship on Monday\n\nFull protocol: /tmp/meeting_1.summary.md'
  const n = callNotice(promptOf({ id: 'c1', key: 's1', kind: 'call', text: report, next: Date.now() }, Date.now()))
  if (!n) throw new Error('not a call notice')
  const en = translator('en')
  const ru = translator('ru')
  expect(noticeLine(n, en)).toEqual({
    text: 'MokuPilot call results: Release 2.4 call · Oct 17 · 32 min',
    sub: '',
    tone: 'info',
  })
  expect(noticeLine(n, ru).text).toBe('Итоги звонка в MokuPilot: Release 2.4 call · Oct 17 · 32 min')
  expect(noticeLine({ ...n, name: '', note: 'late' }, en)).toEqual({
    text: 'MokuPilot call results',
    sub: 'late',
    tone: 'info',
  })
})
