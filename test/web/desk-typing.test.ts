// Text to an agent's display (web/src/models/desk-input.ts DeskTyping) against a fake one: what its
// keyboard has as keys at once; the rest by its clipboard (announced, Ctrl+V, the text as its server
// asks, the next only after the server's turn), keys and the pointer waiting behind it in their
// order; long text as one paste; the clipboard emptied after; a display without one, keys only.
import { expect, test } from 'bun:test'
import {
  CLEAR_MS,
  DeskTyping,
  LONG_TEXT,
  PASTE_SETTLE_MS,
  PASTE_WAIT_MS,
  textKeysyms,
} from '../../web/src/models/desk-input.ts'

const CTRL = 0xffe3
const V = 0x76
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A display: what it got, in order; its server's turn (`turn()`) when the test says. */
function display(clipboard = true) {
  const got: string[] = []
  let turns: (() => void)[] = []
  const typing = new DeskTyping({
    key: (keysym, down) => got.push(`${down ? 'down' : 'up'} ${keysym.toString(16)}`),
    clipboard,
    announce: has => got.push(`announce ${has}`),
    provide: text => got.push(`provide ${text}`),
    settled: fn => {
      got.push('fence')
      turns.push(fn)
    },
  })
  /** The server's turn came: then the settle, then what waited. */
  const turn = async () => {
    const now = turns
    turns = []
    for (const fn of now) fn()
    await wait(PASTE_SETTLE_MS + 20)
  }
  return { typing, got, turn }
}
const keys = (text: string) => textKeysyms(text).flatMap(k => [`down ${k.toString(16)}`, `up ${k.toString(16)}`])
const ctrlV = [`down ${CTRL.toString(16)}`, `down ${V.toString(16)}`, `up ${V.toString(16)}`, `up ${CTRL.toString(16)}`]

test('what the display’s keyboard has goes as its keys at once: US ASCII, a line’s end, a tab, the letters and marks the board gives it (Cyrillic, accents, «»—№€); nothing by its clipboard', () => {
  const d = display()
  const text = 'Привет, мир!\nЁё\tІї Ґґ Ўў «café» — № 5 €, ẞß https://example.com/?a=1#Z'
  d.typing.text(text)
  expect(d.got).toEqual(keys(text))
})

test('what it has no key for (Greek, an emoji) goes by its clipboard: announced, Ctrl+V, the text as the server asks; what comes after waits for the server’s turn, then the clipboard is emptied', async () => {
  const d = display()
  let pointed = 0
  d.typing.text('a λ b')
  d.typing.later(() => pointed++)
  expect(d.got).toEqual([...keys('a '), 'announce true', ...ctrlV])
  expect(pointed).toBe(0)
  // a program there pastes: the server asks
  d.typing.wanted()
  expect(d.got.slice(-2)).toEqual(['provide λ', 'fence'])
  // asked again (a second request of the same paste): nothing more
  d.typing.wanted()
  expect(d.got.filter(g => g.startsWith('provide'))).toHaveLength(1)
  await d.turn()
  expect(d.got.slice(-4)).toEqual(keys(' b'))
  expect(pointed).toBe(1)
  // nothing more to paste: emptied a while later
  expect(d.got).not.toContain('announce false')
  await wait(CLEAR_MS + 50)
  expect(d.got.at(-1)).toBe('announce false')
  // with nothing in flight, the pointer goes at once
  d.typing.later(() => pointed++)
  expect(pointed).toBe(2)
})

test('a run of such characters up to a line’s end is one paste; text that comes meanwhile joins the next', async () => {
  const d = display()
  d.typing.text('λ π!\nω')
  expect(d.got).toEqual(['announce true', ...ctrlV])
  d.typing.text('😀')
  d.typing.text('x')
  d.typing.wanted()
  expect(d.got.at(-2)).toBe('provide λ π')
  d.got.length = 0
  await d.turn()
  // '!' and Return as keys, then 'ω😀' as one paste (the 'x' after it waits)
  expect(d.got).toEqual([...keys('!\n'), 'announce true', ...ctrlV])
  d.typing.wanted()
  expect(d.got.at(-2)).toBe('provide ω😀')
  d.got.length = 0
  await d.turn()
  expect(d.got).toEqual(keys('x'))
})

test(`text longer than ${LONG_TEXT} characters is one paste, even all of it keyed; ${LONG_TEXT} is typed`, async () => {
  const d = display()
  d.typing.text('a'.repeat(LONG_TEXT))
  expect(d.got).toEqual(keys('a'.repeat(LONG_TEXT)))
  d.got.length = 0
  const long = 'b'.repeat(LONG_TEXT) + '\nc'
  d.typing.text(long)
  expect(d.got).toEqual(['announce true', ...ctrlV])
  d.typing.wanted()
  expect(d.got.at(-2)).toBe(`provide ${long}`)
})

test('a paste nothing there asked for (no field had the keys): what waits goes on after a while', async () => {
  const d = display()
  d.typing.text('λ!')
  expect(d.got).toEqual(['announce true', ...ctrlV])
  await wait(PASTE_WAIT_MS + 50)
  expect(d.got.slice(-2)).toEqual(keys('!'))
})

test('stopped (control given back): what waits goes, the clipboard is emptied at once', () => {
  const d = display()
  let pointed = 0
  d.typing.text('λ tail')
  d.typing.later(() => pointed++)
  d.typing.stop()
  expect(d.got.at(-1)).toBe('announce false')
  d.typing.wanted()
  expect(d.got.some(g => g.startsWith('provide'))).toBe(false)
  expect(pointed).toBe(0)
  // and goes on as new
  d.typing.text('ok')
  expect(d.got.slice(-4)).toEqual(keys('ok'))
})

test('a display without the extended clipboard: everything as keys, as before', () => {
  const d = display(false)
  const text = 'λ π — 😀 é ok'
  d.typing.text(text)
  d.typing.text('x'.repeat(LONG_TEXT + 1))
  expect(d.got).toEqual([...keys(text), ...keys('x'.repeat(LONG_TEXT + 1))])
})
