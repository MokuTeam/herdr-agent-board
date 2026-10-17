// The React question forms against today's: every scene is stepped through on both sides — the
// old page's questions.js on a fake #sheet-question and the desk drawn by <QuestionForm> or
// <PermissionPrompt> (support/old-questions.tsx) — with the same clicks, typing, digits and server
// answers; after each step the two forms must read the same, and so must what each posted and
// toasted. Then the form in its place in the sheet.
import { describe, expect, test } from 'bun:test'
import type { FormQuestion } from '../../src/core/dialogs/question-form.ts'
import type { PublicDialog } from '../../src/core/dialogs/questions.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import type { SessionDetail } from '../../web/src/api/client.ts'
import { item } from './support/board.tsx'
import { serializeNodes } from './support/markup.ts'
import { BothQuestions, NewQuestions, OldQuestions } from './support/old-questions.tsx'
import { bothSheets } from './support/sheet-scene.tsx'

const ONE: FormQuestion[] = [
  {
    question: 'Which size?',
    header: 'Size',
    multiSelect: false,
    preview: false,
    options: [
      { label: 'Small', description: 'For one' },
      { label: 'Large', description: '' },
    ],
  },
]

const THREE: FormQuestion[] = [
  ...ONE,
  {
    question: 'Which toppings?',
    header: 'Toppings',
    multiSelect: true,
    preview: false,
    options: [
      { label: 'Cheese', description: '' },
      { label: 'Olives', description: 'Black <ones>' },
      { label: 'Basil', description: '' },
    ],
  },
  {
    question: 'Which layout?',
    header: '',
    multiSelect: false,
    preview: true,
    options: [
      { label: 'Sidebar', description: '', preview: '| nav | main |' },
      { label: 'Tabs', description: 'On top', preview: '[a] [b]' },
    ],
  },
]

const asking = (questions: FormQuestion[], fields: Partial<Item> = {}): Item =>
  item({
    key: 'k1',
    name: 'Pizza',
    status: 'blocked',
    column: 'me',
    attention: 'question',
    tool: { id: 'toolu_1', name: 'AskUserQuestion', pending: true, questions },
    ...fields,
  })

const PERMISSION: PublicDialog = {
  kind: 'permission',
  title: 'Bash command',
  body: ['  npm test', '  Run the tests', ''],
  more: 2,
  prompt: 'Do you want to proceed?',
  options: [
    { n: 1, label: 'Yes' },
    { n: 2, label: "Yes, and don't ask again for npm test" },
    { n: 3, label: 'No, and tell Claude what to do differently (esc)' },
  ],
  fingerprint: 'fp1',
}
const held = item({ key: 'k2', name: 'Build', status: 'blocked', column: 'me' })
const onScreen = (dialog: PublicDialog | null, it: Item = held) => ({ item: { key: it.key }, dialog })

/** The forms read the same, and every side posted and toasted the same. */
function same(b: BothQuestions) {
  const { old, now, react } = b.forms()
  expect(react).toBe(old)
  expect(now).toBe(old)
  for (const side of [b.now, b.react]) {
    expect(side.posted).toEqual(b.old.posted)
    expect(side.toasts).toEqual(b.old.toasts)
  }
}

const QS = '.qa-opt[data-q="0"]'

describe('a question form', () => {
  test('one single-select question: one click answers it; on its way, then through, then gone', async () => {
    const b = new BothQuestions({ pointerFine: true })
    expect(b.mount(asking(ONE))).toEqual([true, true])
    same(b)
    b.later(600)
    await b.click(`${QS}[data-n="2"]`)
    same(b)
    expect(b.react.posted).toEqual([
      {
        key: 'k1',
        action: 'answer',
        body: { session: 'k1', toolUseId: 'toolu_1', answers: [{ options: ['Large'], other: '' }] },
      },
    ])
    expect(b.forms().react).toContain('qa-status')
    await b.answer({ ok: true })
    same(b)
    expect(b.react.toasts).toEqual([[translator('en')('qa.done', { name: 'Pizza' }), false]])
    // The transcript knows at once, herdr a refresh later: the finished form stays meanwhile.
    expect(b.mount(asking(ONE, { tool: { id: 'toolu_1', name: 'AskUserQuestion', pending: false } }))).toEqual([
      true,
      true,
    ])
    same(b)
    expect(b.mount(asking(ONE, { status: 'idle', column: 'idle', tool: null }))).toEqual([false, false])
  })

  test('several questions: picks, toggles, an own answer, the preview under the pointer, what is left', async () => {
    const b = new BothQuestions({ pointerFine: true })
    b.mount(asking(THREE))
    same(b)
    // Right after it came up a click was meant for the dialog before.
    await b.click(`${QS}[data-n="1"]`)
    same(b)
    b.later(600)
    await b.click(`${QS}[data-n="1"]`)
    same(b)
    await b.click('.qa-opt[data-q="1"][data-n="3"]')
    await b.click('.qa-opt[data-q="1"][data-n="1"]')
    same(b)
    await b.type(1, 'Ham')
    same(b)
    await b.over('.qa-opt[data-q="2"][data-n="2"]')
    same(b)
    expect(b.forms().react).toContain('[a] [b]')
    await b.leave()
    same(b)
    await b.click('.qa-opt[data-q="2"][data-n="2"]')
    same(b)
    await b.click('[data-qa-send]')
    same(b)
    expect(b.react.posted.at(-1)?.body).toEqual({
      session: 'k1',
      toolUseId: 'toolu_1',
      answers: [
        { options: ['Small'], other: '' },
        { options: ['Cheese', 'Basil'], other: 'Ham' },
        { options: ['Tabs'], other: '' },
      ],
    })
    await b.answer({ ok: false, error: 'The form moved on', stopped: true, screen: '❯ 1. Small\n  2. Large' })
    same(b)
    expect(b.forms().react).toContain('qa-screen')
  })

  test('the own answer of a lone question: picked beside its field, typed into, Enter sends', async () => {
    const b = new BothQuestions()
    b.mount(asking(ONE))
    b.later(600)
    await b.click(`${QS}[data-n="other"]`)
    same(b)
    await b.type(0, 'Medium')
    same(b)
    await b.type(0, '  ')
    same(b)
    await b.type(0, 'Medium')
    await b.enter(0)
    same(b)
    expect(b.react.posted.at(-1)?.body).toEqual({
      session: 'k1',
      toolUseId: 'toolu_1',
      answers: [{ options: [], other: 'Medium' }],
    })
  })

  test('a click into the own answer types; with text in it and another option picked, it picks it', async () => {
    const b = new BothQuestions()
    b.mount(asking(THREE.slice(0, 2)))
    b.later(600)
    await b.click(`${QS}[data-n="1"]`)
    await b.type(0, 'Medium')
    same(b)
    await b.click(`${QS}[data-n="1"]`)
    same(b)
    await b.click(`${QS}[data-n="other"]`, '.qa-input')
    same(b)
    // Toggled off and on again beside a multiSelect's options.
    await b.click('.qa-opt[data-q="1"][data-n="other"]')
    same(b)
    await b.click('.qa-opt[data-q="1"][data-n="other"]')
    same(b)
  })

  test('digits: the question in focus, else the first open one; the own answer after the options', async () => {
    const b = new BothQuestions({ pointerFine: true })
    b.mount(asking(THREE))
    // A dialog that just came up takes the key, and nothing is picked.
    expect(await b.key('1')).toEqual([true, true])
    same(b)
    b.later(600)
    expect(await b.key('2')).toEqual([true, true])
    same(b)
    // A single select moves on to the next question.
    expect(b.react.focusedId).toBe('1.1')
    expect(b.old.focused()).toBe('1.1')
    expect(await b.key('4', '.qa-opt[data-q="1"][data-n="1"]')).toEqual([true, true])
    same(b)
    expect(b.react.focusedId).toBe('1.other')
    expect(b.old.focused()).toBe('1.other')
    expect(await b.key('5', '.qa-opt[data-q="1"][data-n="1"]')).toEqual([false, false])
    expect(await b.key('3', '.qa-input[data-q="1"]')).toEqual([false, false])
    expect(await b.key('1', null, true)).toEqual([true, true])
    same(b)
    b.canMutate = false
    expect(await b.key('1')).toEqual([false, false])
    same(b)
  })

  test('read only: every control off, and the hint and the button say why', async () => {
    const b = new BothQuestions({ canMutate: false })
    b.mount(asking(THREE))
    same(b)
    b.later(600)
    await b.click(`${QS}[data-n="1"]`)
    same(b)
    b.canMutate = true
    same(b)
  })

  test('in Russian', async () => {
    const b = new BothQuestions({ lang: 'ru', pointerFine: true })
    b.mount(asking(THREE))
    same(b)
    b.later(600)
    await b.click(`${QS}[data-n="2"]`)
    same(b)
  })

  test('a finished form gives way once herdr sees the session move on, or 10 s after', async () => {
    const b = new BothQuestions()
    b.mount(asking(ONE))
    b.later(600)
    await b.click(`${QS}[data-n="1"]`)
    await b.answer({ ok: true })
    const answeredHeld = asking(ONE, { tool: { id: 'toolu_1', name: 'AskUserQuestion', pending: false } })
    b.later(9000)
    expect(b.mount(answeredHeld)).toEqual([true, true])
    same(b)
    b.later(2000)
    expect(b.mount(answeredHeld)).toEqual([false, false])
  })

  test('picks stay with each form while others show; only the last twelve forms are kept', async () => {
    const b = new BothQuestions()
    const first = asking(THREE)
    const tool = (id: string) => ({ id, name: 'AskUserQuestion', pending: true, questions: THREE })
    b.mount(first)
    b.later(600)
    await b.click(`${QS}[data-n="2"]`)
    const others = Array.from({ length: 11 }, (_, n) => asking(THREE, { key: `o${n}`, tool: tool(`t${n}`) }))
    for (const other of others) b.mount(other)
    b.mount(first)
    same(b)
    expect(b.forms().react).toContain('aria-checked="true"')
    b.mount(asking(THREE, { key: 'o11', tool: tool('t11') }))
    for (const other of others) b.mount(other)
    b.mount(first)
    same(b)
    expect(b.forms().react).not.toContain('aria-checked="true"')
  })
})

describe('a permission prompt', () => {
  test('its words, the choices by their tone, more lines; a choice on its way; gone meanwhile', async () => {
    const b = new BothQuestions({ pointerFine: true })
    expect(b.mount(held, onScreen(PERMISSION))).toEqual([true, true])
    same(b)
    b.later(600)
    await b.click('[data-perm="2"]')
    same(b)
    expect(b.react.posted).toEqual([
      { key: 'k2', action: 'permit', body: { session: 'k2', fingerprint: 'fp1', option: 2 } },
    ])
    await b.answer({ ok: false, gone: true, error: 'Nothing left to answer' })
    same(b)
    b.mount(held, onScreen(PERMISSION))
    same(b)
    expect(await b.key('3')).toEqual([true, true])
    same(b)
    await b.answer({ ok: true })
    same(b)
    // Answered, a new prompt on the screen takes over; the same one stays answered.
    expect(b.mount(held, onScreen(PERMISSION))).toEqual([true, true])
    same(b)
    expect(b.mount(held, onScreen({ ...PERMISSION, fingerprint: 'fp2', title: 'Edit file' }))).toEqual([true, true])
    same(b)
    b.later(600)
    expect(await b.key('9')).toEqual([false, false])
  })

  test('a failed choice says why and offers the terminal; the detail of another session is not this one', async () => {
    const b = new BothQuestions()
    b.mount(held, onScreen(PERMISSION))
    b.later(600)
    await b.click('[data-perm="1"]')
    await b.answer({ ok: false, error: 'The prompt changed' })
    same(b)
    await b.click('[data-qa-focus]')
    same(b)
    const other = item({ key: 'k3', status: 'blocked', column: 'me' })
    expect(b.mount(other, onScreen(PERMISSION))).toEqual([false, false])
    // Not blocked: no prompt, whatever the screen said.
    expect(b.mount({ ...held, status: 'working' }, onScreen(PERMISSION))).toEqual([false, false])
  })
})

test('the form in the sheet, with the terminal screen folded away under it', () => {
  const it = asking(THREE)
  const old = new OldQuestions({ pointerFine: false })
  old.mount(it)
  const react = new NewQuestions({ pointerFine: false })
  react.mount(it)
  const detail = {
    key: it.key,
    status: 'ready' as const,
    error: '',
    at: Date.now() - 60_000,
    data: { item: it, conversation: [], screen: '? Which size?\n❯ 1. Small', dialog: null, checkout: false },
  } satisfies { data: SessionDetail } & Record<string, unknown>
  const { old: oldSheet, react: reactSheet } = bothSheets({
    items: [it],
    open: it.key,
    detail,
    formHtml: serializeNodes(old.markup()),
    formNode: react.node(),
  })
  expect(reactSheet).toBe(oldSheet)
})
