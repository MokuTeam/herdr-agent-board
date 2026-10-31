// A message with pictures typed into Claude Code on the board's own server (services/paste.ts):
// the board waits for the paste to be over and gives the message its Enter, once, again only if the
// box still holds it a while later, never while the pictures are still being read and never for
// another text in the box. Screens are Claude Code 2.1.308's, captured in herdr.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ENTER_AGAIN_MS,
  holdsItsLine,
  holdsMessage,
  PASTE_POLL_MS,
  PASTE_WAIT_MS,
  settlePaste,
} from '../../src/services/paste.ts'

const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8')
const rule = '─'.repeat(40)
const box = (text: string): string => [rule, `❯ ${text}`, rule, '  ⏵⏵ bypass permissions on'].join('\n')

const PASTING = screen('claude-pasting')
const HELD = screen('claude-picture-in-box')
const EMPTY = box('')
/** What the board typed: the text, then the line naming the file and its path. */
const TYPED =
  'the browser icon looks broken on the tablet\n\nФайл:\n/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/054431-screenshot-074431.png'

/**
 * A pane whose screen is `screens` in turn, one per read (the last from then on), and, once an
 * Enter is given, `afterEnter` in turn. A clock that the sleeps move on.
 */
function pane(screens: (string | null)[], afterEnter: (string | null)[] = screens.slice(-1)) {
  let clock = 0
  let reads = 0
  const log: string[] = []
  let shown = screens
  return {
    log,
    io: {
      screen: async () => {
        const s = shown[Math.min(reads++, shown.length - 1)] ?? null
        log.push(s === PASTING ? 'read:pasting' : s === null ? 'read:none' : `read:${s === EMPTY ? 'empty' : 'box'}`)
        return s
      },
      enter: async () => {
        log.push(`enter@${clock}`)
        shown = afterEnter
        reads = 0
      },
      sleep: async (ms: number) => {
        clock += ms
      },
      now: () => clock,
    },
  }
}

test('the pictures read slowly: no Enter while it pastes, one once the box shows them, then it is taken', async () => {
  const p = pane([PASTING, PASTING, PASTING, HELD], [EMPTY])
  expect(await settlePaste(p.io, TYPED)).toBe('taken')
  expect(p.log).toEqual([
    'read:pasting',
    'read:pasting',
    'read:pasting',
    'read:box',
    `enter@${4 * PASTE_POLL_MS}`,
    'read:empty',
    'read:empty',
  ])
})

test('a paste over before the first look (its Enter went with it): taken, no Enter', async () => {
  const p = pane([EMPTY])
  expect(await settlePaste(p.io, TYPED)).toBe('taken')
  expect(p.log).toEqual(['read:empty', 'read:empty'])
})

test('a first look before "Pasting…" shows does not count the message as taken', async () => {
  const p = pane([EMPTY, PASTING, HELD], [EMPTY])
  expect(await settlePaste(p.io, TYPED)).toBe('taken')
  expect(p.log.filter(l => l.startsWith('enter'))).toHaveLength(1)
})

test('a dialog that comes with the turn (no input box) is the message taken', async () => {
  const p = pane(
    [PASTING, HELD],
    [readFileSync(new URL('../support/screens/permission-bash.txt', import.meta.url), 'utf8')],
  )
  expect(await settlePaste(p.io, TYPED)).toBe('taken')
  expect(p.log.filter(l => l.startsWith('enter'))).toHaveLength(1)
})

test('the box still holding it after its Enter: one more, a while later, then it says so', async () => {
  const p = pane([PASTING, HELD], [HELD])
  expect(await settlePaste(p.io, TYPED, { waitMs: 10_000 })).toBe('inBox')
  const enters = p.log.filter(l => l.startsWith('enter'))
  expect(enters).toHaveLength(2)
  const [first = 0, second = 0] = enters.map(e => Number(e.split('@')[1]))
  expect(second - first).toBeGreaterThanOrEqual(ENTER_AGAIN_MS)
})

test('still reading the pictures when the wait is over: no Enter, it says so', async () => {
  const p = pane([PASTING])
  expect(await settlePaste(p.io, TYPED, { waitMs: 3_000 })).toBe('pasting')
  expect(p.log.some(l => l.startsWith('enter'))).toBe(false)
  expect(PASTE_WAIT_MS).toBeGreaterThanOrEqual(30_000)
})

test('another text in the box is not the message: no Enter for it', async () => {
  const p = pane([PASTING, box('something the user typed in the terminal')])
  expect(await settlePaste(p.io, TYPED)).toBe('taken')
  expect(p.log.some(l => l.startsWith('enter'))).toBe(false)
})

test('the box holds the message: its picture mark, its first line, a long paste’s chip; with files alone the line naming them', () => {
  expect(holdsMessage('[Image #3]the browser icon looks broken on the tablet\n  Файл:', TYPED)).toBe(true)
  expect(holdsMessage('the browser icon looks broken on the tablet\n  Файл:\n  /uploads/a.png', TYPED)).toBe(true)
  expect(holdsMessage('[Image #1][Pasted text #1 +12 lines]', 'a\nb')).toBe(true)
  expect(holdsMessage('[Image #7]Файл:', 'Файл:\nC:\\Users\\Team Work\\uploads\\2026-10-31\\снимок 100%.png')).toBe(
    true,
  )
  expect(holdsMessage('', TYPED)).toBe(false)
  expect(holdsMessage('something else', TYPED)).toBe(false)
})

test('the message typed before is its own first line in the box, not a picture mark alone', () => {
  expect(holdsItsLine('[Image #3]the browser icon looks broken on the tablet\n  Файл:', TYPED)).toBe(true)
  expect(holdsItsLine('[Image #7]Файл:', 'Файл:\nC:\\Users\\Team Work\\uploads\\снимок 100%.png')).toBe(true)
  expect(holdsItsLine('[Image #2]my own words in the terminal', TYPED)).toBe(false)
  expect(holdsItsLine('[Pasted text #1 +12 lines]', TYPED)).toBe(false)
  expect(holdsItsLine('', TYPED)).toBe(false)
})
