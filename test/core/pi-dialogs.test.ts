// pi's menu and text input (core/dialogs/pi-dialogs.ts), read from screens of pi 1.3 with the git
// guard's approval waiting, and answered with keys (services/answer.ts driveSelect, driveInput).
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { piEditor } from '../../src/core/dialogs/pi-dialogs.ts'
import {
  type Dialog,
  type InputDialog,
  parseDialog,
  publicDialog,
  type SelectDialog,
} from '../../src/core/dialogs/questions.ts'
import { driveInput, driveSelect } from '../../src/services/answer.ts'
import { FakePi, inputScreen, PI_IDLE, PI_INPUT, PI_SELECT, selectScreen } from '../support/fake-pi.ts'

const screens = new URL('../support/screens/', import.meta.url)
const screen = (name: string) => readFileSync(new URL(`${name}.txt`, screens), 'utf8').replace(/\r\n/g, '\n')
const fast = { timeout: 200, every: 1 }
const pi = (s: string) => parseDialog(s, 'pi')
const asSelect = (d: Dialog | null): SelectDialog => {
  assert.equal(d?.kind, 'select')
  return d as SelectDialog
}
const asInput = (d: Dialog | null): InputDialog => {
  assert.equal(d?.kind, 'input')
  return d as InputDialog
}
const MENU = asSelect(pi(PI_SELECT))
/** The menu with its command line (the last on the screen, under the same words in the conversation) changed. */
const COMMAND = ' git commit -m "throwaway test commit for the approval menu"\n'
const withCommand = (c: string): string => {
  const at = PI_SELECT.lastIndexOf(COMMAND)
  return `${PI_SELECT.slice(0, at)} ${c}\n${PI_SELECT.slice(at + COMMAND.length)}`
}

test("pi's menu: the title, the text under it, the options and where the cursor is", () => {
  assert.equal(MENU.title, 'Git approval needed: git commit')
  assert.equal(MENU.cut, false)
  assert.deepEqual(MENU.body, [
    '',
    'Why (from Lobster):',
    'Throwaway test of the git approval menu so the board and the phone',
    'app can learn to answer it.',
    'This repository is a scratch folder under /tmp; nothing here is',
    'real work and nothing is pushed.',
    'The commit records notes.txt, which was staged a moment ago, so',
    'the menu has a real command to show.',
    'A long explanation on purpose: the phone showed such a menu cut',
    'off, and this reproduces that.',
    'Expected outcome: whoever tests it rejects it, and the repository',
    'stays without commits.',
    '',
    'Command:',
    'git commit -m "throwaway test commit for the approval menu"',
  ])
  assert.deepEqual(
    MENU.options.map(o => [o.n, o.label, o.cursor]),
    [
      [1, 'Approve', true],
      [2, 'Reject', false],
      [3, 'Reject with a note', false],
    ],
  )
  assert.equal(MENU.cursor, 1)
})

test("pi's menu: the fingerprint is of everything drawn but the cursor and a countdown", () => {
  for (const n of [2, 3]) {
    const moved = asSelect(pi(selectScreen(n)))
    assert.equal(moved.cursor, n)
    assert.equal(moved.fingerprint, MENU.fingerprint)
  }
  // The screens read with the cursor moved in the terminal: the same rows as selectScreen draws.
  const command = (c: string) => asSelect(pi(withCommand(c)))
  for (const [a = '', b = ''] of [
    ['git push origin feature/x', 'git push origin feature/y'],
    ['rm -rf build_*', 'rm -rf build'],
    ['echo "a  b"', 'echo "a b"'],
  ]) {
    assert.notEqual(command(a).fingerprint, command(b).fingerprint, `${a} / ${b}`)
    assert.equal(command(a).body.at(-1), a)
  }
  // Another option, or the options in another order, is another menu.
  assert.notEqual(asSelect(pi(PI_SELECT.replace('   Reject\n', '   Refuse\n'))).fingerprint, MENU.fingerprint)
  // A timed menu counts down in its title: the same menu from second to second.
  const timed = (s: number) =>
    asSelect(pi(PI_SELECT.replace(' Git approval needed: git commit\n', ` Git approval needed: git commit (${s}s)\n`)))
  assert.equal(timed(12).fingerprint, timed(11).fingerprint)
  assert.equal(timed(12).fingerprint, MENU.fingerprint)
  assert.equal(timed(12).title, 'Git approval needed: git commit (12s)') // shown as drawn
})

test("pi's menu: a long option wraps onto the margin; a menu taller than the pane is read from its end", () => {
  const long = PI_SELECT.replace(
    '   Reject with a note\n',
    '   Reject with a note and tell Lobster what to change before it tries\n again\n',
  )
  const wrapped = asSelect(pi(long))
  assert.equal(wrapped.options[2]?.text, 'Reject with a note and tell Lobster what to change before it tries\nagain')
  assert.notEqual(wrapped.fingerprint, MENU.fingerprint)
  // The opening rule above the screen: the options and the hint are there, the title is not.
  const lines = PI_SELECT.split('\n')
  const opening = lines.findIndex(
    (l, i) => i > 0 && /^─{8,}$/.test(l) && /Git approval needed/.test(lines[i + 2] ?? ''),
  )
  assert.ok(opening > 0)
  const tall = asSelect(pi(lines.slice(opening + 6).join('\n')))
  assert.equal(tall.cut, true)
  assert.equal(tall.title, '')
  assert.equal(tall.body.at(-1), 'git commit -m "throwaway test commit for the approval menu"')
  assert.deepEqual(
    tall.options.map(o => o.label),
    ['Approve', 'Reject', 'Reject with a note'],
  )
})

test("pi's text input: its title and what the field holds, the same input whatever is typed", () => {
  const empty = asInput(pi(PI_INPUT))
  assert.equal(empty.title, 'Note for Lobster')
  assert.deepEqual(empty.body, [])
  assert.equal(empty.value, '')
  const typed = asInput(pi(screen('pi-input-typed')))
  assert.equal(typed.value, 'throwaway test, rejected on purpose')
  assert.equal(typed.fingerprint, empty.fingerprint)
  assert.notEqual(empty.fingerprint, MENU.fingerprint)
  assert.equal(asInput(pi(inputScreen('x'.repeat(200)))).value, 'x'.repeat(65))
})

test("pi's dialogs only where the pane runs pi, and only the frame at the bottom of the screen", () => {
  assert.equal(pi(PI_IDLE), null)
  assert.equal(pi(''), null)
  // The menu's words in the conversation above pi's input box are not a menu.
  const lines = PI_SELECT.split('\n')
  const frame = lines.slice(lines.indexOf(' Git approval needed: git commit') - 2, -4).join('\n')
  assert.match(frame, /^─{8,}\n\n Git approval needed[\s\S]*escape\/ctrl\+c cancel\n\n─{8,}$/)
  const scrolled = PI_IDLE.replace('\n rejected\n', `\n${frame}\n`)
  assert.match(scrolled, /↑↓ navigate/)
  assert.equal(pi(scrolled), null)
  // A Claude pane is read as before: pi's screens are no dialog of Claude's.
  for (const s of [PI_SELECT, PI_INPUT, PI_IDLE]) {
    assert.equal(parseDialog(s), null)
    assert.equal(parseDialog(s, 'claude'), null)
  }
  // And Claude's screens are no dialog of pi's.
  const claude = readdirSync(screens).filter(f => f.endsWith('.txt') && !f.startsWith('pi-'))
  assert.ok(claude.length >= 10)
  for (const f of claude) {
    const s = screen(f.replace(/\.txt$/, ''))
    assert.equal(pi(s), null, f)
    assert.deepEqual(parseDialog(s, 'claude'), parseDialog(s), f)
  }
})

test("piEditor: pi's input box with no dialog in its place", () => {
  assert.equal(piEditor(PI_IDLE), true)
  assert.equal(piEditor(PI_SELECT), false)
  assert.equal(piEditor(PI_INPUT), false)
  assert.equal(piEditor(''), false)
  assert.equal(piEditor('\n\n   \n'), false)
})

test("publicDialog: pi's menu and input as the page gets them, long text cut with a mark", () => {
  assert.deepEqual(publicDialog(MENU), {
    kind: 'select',
    title: MENU.title,
    body: MENU.body,
    more: 0,
    cut: false,
    options: [
      { n: 1, label: 'Approve' },
      { n: 2, label: 'Reject' },
      { n: 3, label: 'Reject with a note' },
    ],
    fingerprint: MENU.fingerprint,
  })
  const long = publicDialog({ ...MENU, body: Array.from({ length: 95 }, (_, i) => `line ${i}`) })
  assert.equal(long?.kind, 'select')
  if (long?.kind !== 'select') return
  assert.equal(long.body.length, 80)
  assert.equal(long.more, 15)
  assert.equal(long.fingerprint, MENU.fingerprint)
  const input = asInput(pi(screen('pi-input-typed')))
  assert.deepEqual(publicDialog(input), {
    kind: 'input',
    title: 'Note for Lobster',
    body: [],
    more: 0,
    cut: false,
    value: 'throwaway test, rejected on purpose',
    fingerprint: input.fingerprint,
  })
})

test('driveSelect: one row per key, each after the screen shows the cursor there; Enter only on the option', async () => {
  for (const [from, n, keys] of [
    [1, 1, ['enter']],
    [1, 2, ['down', 'enter']],
    [1, 3, ['down', 'down', 'enter']],
    [3, 1, ['up', 'up', 'enter']],
    [2, 2, ['enter']],
  ] as const) {
    const fake = new FakePi({ cursor: from, lag: 2 })
    const r = await driveSelect({ fingerprint: MENU.fingerprint, n, io: fake.io(), timing: fast })
    assert.deepEqual(r, { ok: true }, `${from} -> ${n}`)
    assert.deepEqual(fake.keysLog, keys)
    assert.equal(fake.picked, ['Approve', 'Reject', 'Reject with a note'][n - 1])
  }
})

test('driveSelect: nothing pressed into another menu, and no Enter when the cursor does not follow', async () => {
  const other = new FakePi()
  const fingerprint = asSelect(pi(withCommand('git push -f origin feature/x'))).fingerprint
  const changed = await driveSelect({ fingerprint, n: 2, io: other.io(), timing: fast })
  assert.ok(!changed.ok)
  assert.equal(changed.reason, 'changed')
  assert.deepEqual(other.keysLog, [])
  const beyond = await driveSelect({ fingerprint: MENU.fingerprint, n: 4, io: other.io(), timing: fast })
  assert.ok(!beyond.ok)
  assert.equal(beyond.reason, 'changed')
  // A terminal that takes no keys: one arrow, then it stops; Enter never goes in.
  const deaf = new FakePi({ ignore: true })
  const stuck = await driveSelect({ fingerprint: MENU.fingerprint, n: 2, io: deaf.io(), timing: fast })
  assert.ok(!stuck.ok)
  assert.equal(stuck.reason, 'stuck')
  assert.deepEqual(deaf.keysLog, ['down'])
  // The menu turns into another one under the cursor: no Enter into it.
  const swapped = new FakePi()
  const io = swapped.io()
  const keys = io.keys
  io.keys = async (...k: string[]) => {
    await keys(...k)
    swapped.render = () => selectScreen(swapped.cursor, withCommand('git push -f origin feature/x'))
  }
  const moved = await driveSelect({ fingerprint: MENU.fingerprint, n: 3, io, timing: fast })
  assert.ok(!moved.ok)
  assert.equal(moved.reason, 'stuck')
  assert.deepEqual(swapped.keysLog, ['down'])
  assert.equal(swapped.picked, null)
})

test("driveSelect: done needs proof, pi's input box twice or another dialog; a blank screen is not it", async () => {
  // The note's input after "Reject with a note" is another dialog: proof enough.
  const note = new FakePi()
  assert.deepEqual(await driveSelect({ fingerprint: MENU.fingerprint, n: 3, io: note.io(), timing: fast }), {
    ok: true,
  })
  assert.equal(note.state, 'input')
  for (const after of ['', '\n\n   \n', PI_SELECT.split('\n').slice(0, 60).join('\n')]) {
    const fake = new FakePi()
    fake.render = () => (fake.picked ? after : selectScreen(fake.cursor))
    const r = await driveSelect({ fingerprint: MENU.fingerprint, n: 1, io: fake.io(), timing: fast })
    assert.ok(!r.ok)
    assert.equal(r.reason, 'unconfirmed', JSON.stringify(after.slice(0, 40)))
    assert.equal(r.sent, 1)
  }
})

test('driveInput: clears the field, types the note, Enter once the field shows it', async () => {
  const input = asInput(pi(PI_INPUT))
  const fake = new FakePi({ state: 'input' })
  const r = await driveInput({ fingerprint: input.fingerprint, text: 'use a branch', io: fake.io(), timing: fast })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(fake.texts, ['use a branch'])
  assert.deepEqual(fake.keysLog, ['enter'])
  assert.equal(fake.submitted, 'use a branch')
  // Begun in the terminal: what the field held goes first.
  const begun = new FakePi({ state: 'input', value: 'half a thought', lag: 1 })
  assert.deepEqual(
    await driveInput({ fingerprint: input.fingerprint, text: 'use a branch', io: begun.io(), timing: fast }),
    { ok: true },
  )
  assert.deepEqual(begun.keysLog, ['end', 'ctrl+u', 'enter'])
  assert.equal(begun.submitted, 'use a branch')
  // Longer than the field: its end is enough.
  const long = `${'a long note '.repeat(12)}the end`
  const scrolled = new FakePi({ state: 'input' })
  assert.deepEqual(await driveInput({ fingerprint: input.fingerprint, text: long, io: scrolled.io(), timing: fast }), {
    ok: true,
  })
  assert.equal(scrolled.submitted, long)
})

test('driveInput: not into the menu or another input; no Enter when the field shows other text', async () => {
  const input = asInput(pi(PI_INPUT))
  const menu = new FakePi()
  const r = await driveInput({ fingerprint: input.fingerprint, text: 'x', io: menu.io(), timing: fast })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'changed')
  assert.deepEqual([...menu.keysLog, ...menu.texts], [])
  const garbled = new FakePi({ state: 'input' })
  const io = garbled.io()
  io.text = async (t: string) => {
    garbled.texts.push(t)
    garbled.value += t.toUpperCase()
  }
  const g = await driveInput({ fingerprint: input.fingerprint, text: 'use a branch', io, timing: fast })
  assert.ok(!g.ok)
  assert.equal(g.reason, 'stuck')
  assert.deepEqual(garbled.keysLog, [])
  assert.equal(garbled.submitted, null)
})
