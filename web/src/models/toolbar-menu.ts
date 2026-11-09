// What the toolbar's More lists for each action that can leave the row (#347), without a page: its
// words as the action's own button says them, its count where it has one, and whether it needs a
// look (More's button then carries a dot). The ids are those of the buttons (models/toolbar-fit.ts).
import type { Translator } from '../../../src/core/types.ts'
import type { PresenceSwitchView } from './presence.ts'
import type { ToolbarEntry } from './toolbar-fit.ts'

export interface EntryInput {
  /** The board can start and change things now (not read-only, not offline). */
  canMutate: boolean
  /** The schedule's count and whether a reminder is due. */
  schedule: { count: number; due: boolean }
  /** Tasks the user has open and those proposed to confirm; null: tasks are off. */
  tasks: { open: number; proposed: number } | null
  /** Cards on show that need the user. */
  next: number
  /** The usage pill's own text. */
  usage: string
  presence: PresenceSwitchView | null
}

/** Every action's entry; More lists those that left the row (moreEntries). */
export function toolbarEntries(input: EntryInput, t: Translator): ToolbarEntry[] {
  const { canMutate, schedule, tasks, next, usage, presence } = input
  const proposed = tasks?.proposed ?? 0
  return [
    ...(presence
      ? [
          { id: 'presence-switch', label: presence.label, hint: `→ ${t(`presence.${presence.next}`)}` },
          ...(presence.offer ? [{ id: 'presence-offer', label: presence.offer.text }] : []),
          ...(presence.call ? [{ id: 'presence-call', label: t('presence.call') }] : []),
        ]
      : []),
    {
      id: 'todos-open',
      label: t('todo.open'),
      ...(tasks && tasks.open > 0 && { count: tasks.open }),
      ...(proposed > 0 && { hint: t('todo.toConfirm', { n: proposed }), alert: true }),
    },
    {
      id: 'new-session',
      label: t('launch.toolbar'),
      ...(!canMutate && { disabled: true, reason: t('mobile.readOnly') }),
    },
    {
      id: 'sched-open',
      label: t('tb.sched'),
      ...(schedule.count > 0 && { count: schedule.count }),
      ...(schedule.due && { tint: 'var(--orange)', alert: true }),
    },
    {
      id: 'next-attention',
      label: t('attention.next'),
      count: next,
      ...(next === 0 && { disabled: true, reason: t('attention.none') }),
    },
    { id: 'cal-tb', label: t('cal.open') },
    { id: 'time-open', label: t('time.open') },
    { id: 'limits', label: usage || t('limits.title') },
    { id: 'archive-open', label: t('archive.open') },
    { id: 'cats-open', label: t('tb.cats') },
    { id: 'setup-note', label: t('setup.incomplete'), alert: true },
    { id: 'backup-note', label: t('backup.noteLabel'), alert: true },
    { id: 'wake-note', label: t('wake.stopped'), alert: true },
  ]
}
