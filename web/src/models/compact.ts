// Auto-compact on the sheet (#378, src/core/compact.ts): whether a session's card offers it, what
// its limit field shows when empty (Settings' default, or off), and the board's last /compact in
// words: "14:05: 612k → 48k".
import type { CompactRun, CompactView } from '../../../src/core/compact.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { shortWhen } from '../../../src/core/when-format.ts'
import { tokens } from './helper-model.ts'

/** A Claude session in a pane of its own offers it: while its card is open, or once anything is set or in force. */
export const offersCompact = (item: Pick<Item, 'agent' | 'day' | 'call' | 'compact'>, open: boolean): boolean =>
  item.agent === 'claude' && !item.day && !item.call && (open || !!item.compact)

export const compactLabel = (t: Translator): string => t('compact.label')

/** The limit field empty: Settings' default it follows, else off and what can be typed. */
export function compactPlaceholder(view: CompactView | undefined, def: string, t: Translator): string {
  const limit = view?.source === 'default' ? view.limit : def
  return limit ? t('compact.byDefault', { limit }) : t('compact.offHint')
}

export const compactNotePlaceholder = (_view: CompactView | undefined, t: Translator): string => t('compact.notePh')

/** The board's last /compact in words; `held`: no other until the context is below the limit or the limit changes. */
export function compactRunText(
  run: CompactRun,
  t: Translator,
  now = Date.now(),
): { text: string; held: boolean; hint: string } {
  const when = shortWhen(run.state === 'done' ? (run.doneAt ?? run.at) : run.at, t, now)
  const from = tokens(run.from)
  const limit = tokens(run.limit)
  const held = !!run.hold
  if (run.state === 'sent') return { text: t('compact.run.sent', { when, from }), held: false, hint: '' }
  if (run.state === 'failed')
    return { text: t('compact.run.failed', { when, from }), held, hint: t('compact.held', { limit }) }
  const to = run.to === undefined ? '?' : tokens(run.to)
  if (held) return { text: t('compact.run.high', { when, from, to, limit }), held, hint: t('compact.held', { limit }) }
  return { text: t('compact.run.done', { when, from, to }), held: false, hint: '' }
}
