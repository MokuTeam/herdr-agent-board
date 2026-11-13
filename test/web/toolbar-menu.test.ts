// What the toolbar's More lists for each action (#347), without a page: the words, the counts, what is
// gray and why, and what needs a look.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { presenceSwitch } from '../../web/src/models/presence.ts'
import { TOOLBAR_PRIORITY } from '../../web/src/models/toolbar-fit.ts'
import { type EntryInput, toolbarEntries } from '../../web/src/models/toolbar-menu.ts'

const t = translator('en')
const base: EntryInput = {
  canMutate: true,
  schedule: { count: 0, due: false },
  tasks: null,
  next: 0,
  usage: '',
  presence: null,
}
const entry = (input: Partial<EntryInput>, id: string) =>
  toolbarEntries({ ...base, ...input }, t).find(e => e.id === id)

describe('the entries of More', () => {
  test('every action that can leave the row has its entry, and no entry is for anything else', () => {
    const full = toolbarEntries(
      {
        ...base,
        tasks: { open: 1, proposed: 0 },
        presence: presenceSwitch(
          {
            state: 'here',
            since: 1,
            by: 'user',
            mode: 'suggest',
            idleMinutes: 5,
            hint: 'away',
            detects: true,
            calls: true,
          },
          t,
        ),
      },
      t,
    )
    expect(full.map(e => e.id).sort()).toEqual([...TOOLBAR_PRIORITY].sort())
  })

  test('Tasks: its open count, and a dot of a look for what waits for a confirmation', () => {
    expect(entry({ tasks: { open: 3, proposed: 0 } }, 'todos-open')).toEqual({
      id: 'todos-open',
      label: 'Tasks',
      count: 3,
    })
    expect(entry({ tasks: { open: 0, proposed: 0 } }, 'todos-open')).toEqual({ id: 'todos-open', label: 'Tasks' })
    expect(entry({ tasks: { open: 3, proposed: 2 } }, 'todos-open')).toEqual({
      id: 'todos-open',
      label: 'Tasks',
      count: 3,
      hint: '2 to confirm',
      alert: true,
    })
  })

  test('Schedule: its count, orange and a look once a reminder is due', () => {
    expect(entry({ schedule: { count: 2, due: false } }, 'sched-open')).toEqual({
      id: 'sched-open',
      label: 'Schedule',
      count: 2,
    })
    expect(entry({ schedule: { count: 2, due: true } }, 'sched-open')).toEqual({
      id: 'sched-open',
      label: 'Schedule',
      count: 2,
      tint: 'var(--orange)',
      alert: true,
    })
    expect(entry({}, 'sched-open')).toEqual({ id: 'sched-open', label: 'Schedule' })
  })

  test('Next: the cards that need the user; gray, and why, when there are none', () => {
    expect(entry({ next: 18 }, 'next-attention')).toEqual({ id: 'next-attention', label: 'Next', count: 18 })
    expect(entry({ next: 0 }, 'next-attention')).toMatchObject({
      count: 0,
      disabled: true,
      reason: t('attention.none'),
    })
  })

  test('New session is gray, and says why, while the board is read-only or offline', () => {
    expect(entry({}, 'new-session')).toEqual({ id: 'new-session', label: 'New session' })
    expect(entry({ canMutate: false }, 'new-session')).toMatchObject({ disabled: true, reason: t('mobile.readOnly') })
  })

  test('presence: the state it says and the one a press switches to; the offer and the call in short words', () => {
    const view = presenceSwitch(
      {
        state: 'here',
        since: 1,
        by: 'user',
        mode: 'suggest',
        idleMinutes: 5,
        hint: 'away',
        detects: true,
        calls: true,
      },
      t,
    )
    expect(entry({ presence: view }, 'presence-switch')).toEqual({
      id: 'presence-switch',
      label: 'At the computer',
      hint: '→ Away',
    })
    expect(entry({ presence: view }, 'presence-offer')?.label).toBe(t('presence.suggestAway'))
    // The call is named as the state it puts the user in, not by the long hint on its button.
    expect(entry({ presence: view }, 'presence-call')?.label).toBe('On a call')
    expect(entry({ presence: null }, 'presence-switch')).toBeUndefined()
  })

  test('the usage pill is its own words; Usage before the first reading', () => {
    expect(entry({ usage: 'Default 5h 34% 7d 12%' }, 'limits')?.label).toBe('Default 5h 34% 7d 12%')
    expect(entry({ usage: '' }, 'limits')?.label).toBe('Claude usage')
  })

  test('the quiet notes are alerts: More carries a dot for each', () => {
    for (const id of ['setup-note', 'backup-note', 'wake-note']) expect(entry({}, id)?.alert).toBe(true)
  })

  test('in Russian, with the board’s own words', () => {
    const ru = toolbarEntries({ ...base, tasks: { open: 1, proposed: 1 } }, translator('ru'))
    expect(ru.find(e => e.id === 'cats-open')?.label).toBe('Категории')
    expect(ru.find(e => e.id === 'todos-open')?.hint).toBe('1 на подтверждение')
  })
})
