// What web/app.js draws in #sched-body for one board, for the expected side of the schedule panel's
// markup parity: renderSchedule with entryHTML, logHTML, pendingText, modeButton and cancelButton
// picked out of web/app.js as it was at upstream's call-report merge (#45: the parity baseline's,
// a call's results by their title; support/old-app.ts), with the baseline's when.js and #45's
// notice-model.js, against a fixed clock. By hand: syncAvailability's part for the panel's buttons
// (app.js:183).
import { translator } from '../../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { Translator } from '../../../src/core/types.ts'
import { addButtonTypes, findAll, hasClass, type Node, parseHtml, toggleAttr } from './markup.ts'
import { OLD_WHEN, oldCode, oldFunction, oldModule } from './old-app.ts'

/** Upstream's merge of MokuPilot call results (PR #45). */
const CALL_REPORT = 'bde9cfd'
const OLD_CALL = await oldModule('web/notice-model.js', CALL_REPORT)

/** A function of the baseline's when.js. */
const when = (name: string) => oldFunction(OLD_WHEN, name)

export interface OldScheduleScene {
  lang?: string
  data: BoardPayload
  /** The board's clock. */
  now: number
  /** state.moved: cards the user dropped in another lane. */
  moved?: Map<string, string>
  /** The entry whose cancel button asks "Cancel?". */
  armed?: string | null
  canEdit?: boolean
}

const PICKED = [
  'ICON',
  'esc',
  'itemOf',
  'catOf',
  'catInfo',
  'overdue',
  'entryText',
  'cancelButton',
  'pendingText',
  'entryHTML',
  'logHTML',
  'renderSchedule',
  'modeButton',
]

/** The children of #sched-body as renderSchedule left them, buttons typed as React types them. */
export function oldScheduleBody(scene: OldScheduleScene): Node[] {
  const t: Translator = translator(scene.lang ?? 'en')
  const { now } = scene
  const body = { _html: '', _fresh: true, innerHTML: '', querySelectorAll: () => [] }
  class Clock extends Date {
    static override now() {
      return now
    }
  }
  const code = oldCode(
    'web/app.js',
    PICKED,
    {
      t,
      callTitle: OLD_CALL.get('callTitle'),
      state: { data: scene.data, moved: scene.moved ?? new Map() },
      schedPanel: { isOpen: true },
      collapsing: 0,
      schedBody: body,
      armed: scene.armed ? { id: scene.armed } : null,
      appear() {},
      Date: Clock,
      capital: OLD_WHEN.get('capital'),
      timeOf: OLD_WHEN.get('timeOf'),
      span: OLD_WHEN.get('span'),
      dayLabel: (ms: number, tr: Translator) => when('dayLabel')(ms, tr, now),
      shortWhen: (ms: number, tr: Translator) => when('shortWhen')(ms, tr, now),
      longWhen: (ms: number, tr: Translator) => when('longWhen')(ms, tr, now),
    },
    CALL_REPORT,
  )
  oldFunction(code, 'renderSchedule')()
  const nodes = parseHtml(body.innerHTML)
  if (scene.canEdit === false)
    for (const el of findAll(nodes, el => hasClass(el, 'sched-x') || hasClass(el, 'sched-mode')))
      toggleAttr(el, 'disabled', true)
  addButtonTypes(nodes)
  return nodes
}
