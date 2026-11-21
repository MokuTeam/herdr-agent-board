// readHidden (#507, `board nodes secret`): lines typed with nothing shown, against a stand-in for
// the terminal. Enter ends a line, Backspace takes one back, a key that is no character is left out,
// Ctrl+C, Ctrl+D and a paste with a line break inside refuse it all, and raw mode is off again on
// every way out.
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readHidden } from '../../src/adapters/stdin.ts'

/** A terminal: what raw mode was set to, in order, and whether it reads. */
function terminal() {
  const em = new EventEmitter()
  const raw: boolean[] = []
  let reading = false
  const said: string[] = []
  return {
    stdin: {
      setRawMode: (on: boolean) => raw.push(on),
      resume: () => {
        reading = true
      },
      pause: () => {
        reading = false
      },
      on: (e: 'data', fn: (c: Buffer | string) => void) => em.on(e, fn),
      off: (e: 'data', fn: (c: Buffer | string) => void) => em.off(e, fn),
    },
    say: (text: string) => void said.push(text),
    type: (...chunks: string[]) => {
      for (const c of chunks) em.emit('data', Buffer.from(c))
    },
    raw,
    said,
    reading: () => reading,
    listeners: () => em.listenerCount('data'),
  }
}

describe('readHidden', () => {
  test('a line per prompt, typed key by key or pasted; Backspace, arrows and other control keys never in the value', async () => {
    const t = terminal()
    const read = readHidden(['user: ', 'token: '], t.stdin, t.say)
    t.type('m', 'x', '\u007f', 'e', '\r')
    t.type('s3\u001b[D\u001b[3~cr', '\u0001', 'et!\r\n')
    expect(await read).toEqual(['me', 's3cret!'])
    expect([t.raw, t.reading(), t.listeners()]).toEqual([[true, false], false, 0])
    // The prompts, and nothing typed.
    expect(t.said.join('')).toBe('user: \ntoken: \n')
  })

  test('Ctrl+C, Ctrl+D and a paste with a line break inside refuse it, the terminal as it was', async () => {
    for (const keys of [['ab', '\u0003'], ['\u0004'], ['first\nsecond\r']]) {
      const t = terminal()
      const read = readHidden(['token: ', 'more: '], t.stdin, t.say)
      t.type(...keys)
      await expect(read).rejects.toThrow('nothing sent')
      expect([keys, t.raw, t.reading(), t.listeners()]).toEqual([keys, [true, false], false, 0])
      expect(t.said.join('')).not.toContain('first')
    }
  })
})
