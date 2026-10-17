// What web/app.js draws in #sched-body for one board, for the expected side of the schedule panel's
// markup parity: renderSchedule with entryHTML, logHTML, pendingText, modeButton and cancelButton
// picked out of web/app.js as it was at the parity baseline (support/old-app.ts), against a fixed
// clock. By hand: syncAvailability's part for the panel's buttons (app.js:183).
import { translator } from '../../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { Translator } from '../../../src/core/types.ts'
import { capital, dayLabel, longWhen, shortWhen, span, timeOf } from '../../../src/core/when-format.ts'
import { addButtonTypes, findAll, hasClass, type Node, parseHtml, toggleAttr } from './markup.ts'
import { oldCode, oldFunction } from './old-app.ts'

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
      state: { data: scene.data, moved: scene.moved ?? new Map() },
      schedPanel: { isOpen: true },
      collapsing: 0,
      schedBody: body,
      armed: scene.armed ? { id: scene.armed } : null,
      appear() {},
      Date: Clock,
      capital,
      timeOf,
      span,
      dayLabel: (ms: number, tr: Translator) => dayLabel(ms, tr, now),
      shortWhen: (ms: number, tr: Translator) => shortWhen(ms, tr, now),
      longWhen: (ms: number, tr: Translator) => longWhen(ms, tr, now),
    },
    { baseline: true },
  )
  oldFunction(code, 'renderSchedule')()
  const nodes = parseHtml(body.innerHTML)
  if (scene.canEdit === false)
    for (const el of findAll(nodes, el => hasClass(el, 'sched-x') || hasClass(el, 'sched-mode')))
      toggleAttr(el, 'disabled', true)
  addButtonTypes(nodes)
  return nodes
}
