// Notices in the conversation, markup parity: the React <Thread> against upstream's own thread()
// and notice() of web/app.js at the merge of its task-events PR (#35), with its own
// notice-model.js and the baseline's markdown.js, for the same turns.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { callNotice, type Notice, reminderNotice, taskNotice } from '../../src/core/notices.ts'
import { promptOf } from '../../src/core/schedule-rules.ts'
import type { ConversationTurn, NoticeTurn } from '../../src/core/transcript.ts'
import type { Item } from '../../src/core/types.ts'
import { Thread } from '../../web/src/components/sheet/Thread.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { type NotificationParts, notification } from '../support/task-notification.ts'
import { canonical, findAll, hasClass, parseHtml, reactMarkup } from './support/markup.ts'
import { OLD_MARKDOWN, oldCode, oldFunction, oldModule } from './support/old-app.ts'

const TASK_EVENTS = '26d64ea'
const OLD_NOTICE = await oldModule('web/notice-model.js', TASK_EVENTS)

const AT = Date.parse('2026-10-16T14:01:00Z')
const MIN = 60_000

const noticeTurn = (n: Notice | null, at: number): NoticeTurn => {
  if (!n) throw new Error('not a notice')
  return { role: 'notice', ...n, at }
}
const task = (summary: string, at: number, more?: NotificationParts) =>
  noticeTurn(taskNotice(notification(summary, more)), at)
const reminder = (text: string, at: number) => noticeTurn(reminderNotice(text), at)

const CONVERSATION: ConversationTurn[] = [
  { role: 'user', text: 'watch the job', at: AT - 10 * MIN },
  { role: 'tool', label: 'Bash', detail: 'start the job', path: '', done: true, at: AT - 9 * MIN },
  task('Background command "Wait for the event" completed (exit code 0)', AT - 8 * MIN),
  task('Background command "Run tests" failed with exit code 2', AT - 7 * MIN, { status: 'failed' }),
  task('Background command "Build" was stopped because the system is running low on memory', AT - 6 * MIN, {
    status: 'killed',
  }),
  task('Agent "Review the <diff>" finished', AT - 5 * MIN, {
    id: 'a1',
    tail: '<result>## Verdict\nShip **it** &amp; `merge`.</result>',
  }),
  task('Monitor event: "log"', AT - 4 * MIN, {
    id: 'm1',
    status: null,
    file: null,
    tail: '<event>[18:51] line one\n[18:52] line &lt;two&gt;</event>',
  }),
  task('Agent "Log in" failed: Agent terminated early due to an API error', AT - 3 * MIN, { status: 'failed' }),
  task("Background shell command didn't finish before the previous session ended", AT - 2 * MIN, {
    status: 'stopped',
  }),
  task('MCP task ktvcasbNx (telegram/ask) failed.', AT - 2 * MIN, { status: 'failed', file: null }),
  { role: 'tool', label: 'Read', detail: 'a.ts', path: 'src/a.ts', done: true, at: AT - MIN },
  reminder('[board reminder from Master [prod]] check the job again', AT),
  reminder('[board schedule 42 from Master: 0 9 * * 1-5; 3 runs since 9:00, sent once] stand-up notes', AT),
  task('Dynamic workflow "review-changes" completed', AT, { id: 'w1', tail: '<result>- one\n- two</result>' }),
  { role: 'assistant', text: 'The job is done. Restore the rest?', at: AT },
]

const ITEM: Pick<Item, 'column' | 'status'> = { column: 'me', status: 'idle' }

/** upstream's thread(conv, it) of web/app.js at the merge, in a `.thread`. */
function oldThread(conv: readonly ConversationTurn[], lang: string): string {
  const t = translator(lang)
  const code = oldCode(
    'web/app.js',
    ['ICON', 'esc', 'UPLOAD_IMAGE', 'thumbs', 'clock', 'thread', 'notice'],
    {
      t,
      markdown: OLD_MARKDOWN.get('markdown'),
      noticeLine: OLD_NOTICE.get('noticeLine'),
      questionsUI: {
        threadHTML() {
          throw new Error('no question forms in these turns')
        },
      },
    },
    TASK_EVENTS,
  )
  return `<div class="thread">${String(oldFunction(code, 'thread')(conv, ITEM))}</div>`
}

function reactThread(conv: readonly ConversationTurn[], lang: string) {
  return reactMarkup(
    <I18nProvider lang={lang}>
      <div className="thread">
        <Thread conversation={conv} item={ITEM} />
      </div>
    </I18nProvider>,
  )
}

describe('notices in the conversation, markup parity with upstream', () => {
  for (const lang of ['en', 'ru'])
    test(`quiet lines with their marks, output file, opening reports and lines (${lang})`, () => {
      const old = parseHtml(oldThread(CONVERSATION, lang))
      const react = reactThread(CONVERSATION, lang)
      expect(canonical(react)).toBe(canonical(old))
      // Every notice drew as one: the ones with a report or lines open, the commands' output a click away.
      const notices = findAll(react, el => hasClass(el, 'notice'))
      expect(notices.length).toBe(11)
      expect(notices.filter(el => el.tag === 'details').length).toBe(3)
      expect(findAll(react, el => hasClass(el, 'notice-file')).length).toBe(5)
      // The space before a line's quieter part shows.
      expect(canonical(react, { spaces: true })).toBe(canonical(old, { spaces: true }))
    })

  test('a MokuPilot call’s results: the phone mark, the title, the report as Markdown under it; late, the note', async () => {
    const CALL_REPORT = 'bde9cfd'
    const model = await oldModule('web/notice-model.js', CALL_REPORT)
    const report =
      '# Release 2.4 call · Oct 17 · 32 min\n\n- Decided: **ship** on Monday\n\nFull protocol: `/tmp/meeting_1.summary.md`'
    const fresh = noticeTurn(
      callNotice(promptOf({ id: 'c1', key: 's1', kind: 'call', text: report, next: AT }, AT)),
      AT,
    )
    const late = noticeTurn(
      callNotice(promptOf({ id: 'c2', key: 's1', kind: 'call', text: report, next: AT - 3 * 3600_000 }, AT)),
      AT,
    )
    const bare = noticeTurn(callNotice('[mokupilot call report]'), AT)
    for (const lang of ['en', 'ru'])
      for (const m of [fresh, late, bare]) {
        const t = translator(lang)
        const code = oldCode(
          'web/app.js',
          ['ICON', 'esc', 'clock', 'notice'],
          {
            t,
            markdown: OLD_MARKDOWN.get('markdown'),
            noticeLine: model.get('noticeLine'),
            findHelper: () => null,
            state: { detail: null },
          },
          CALL_REPORT,
        )
        const old = parseHtml(`<div class="thread">${String(oldFunction(code, 'notice')(m, []))}</div>`)
        const react = reactThread([m], lang)
        expect(canonical(react)).toBe(canonical(old))
        expect(canonical(react, { spaces: true })).toBe(canonical(old, { spaces: true }))
      }
    expect(canonical(reactThread([fresh], 'en'))).toContain('MokuPilot call results: Release 2.4 call')
  })

  test('a task reporting twice at one time keeps both lines', () => {
    const twice = [
      task('Monitor event: "log"', AT, { id: 'm1', status: null, file: null, tail: '<event>one</event>' }),
      task('Monitor event: "log"', AT, { id: 'm1', status: null, file: null, tail: '<event>two</event>' }),
    ]
    expect(canonical(reactThread(twice, 'en'))).toBe(canonical(parseHtml(oldThread(twice, 'en'))))
  })
})
