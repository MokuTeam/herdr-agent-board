// A stand-in for pi's git guard in a terminal, for services/answer.ts: its menu (Approve, Reject,
// Reject with a note), the note's text input that the last option opens, and pi's input box once
// it is answered. It draws the screens read from pi 1.3 (screens/pi-*.txt) and takes keys the way
// pi does: up and down stop at either end, no digit picks, Enter picks; in the field End goes to
// the end, Ctrl+U clears it. `lag` keeps the old screen for that many reads after each key, as a
// slow redraw would.
import { readFileSync } from 'node:fs'

const screen = (name: string): string =>
  readFileSync(new URL(`./screens/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

export const PI_SELECT = screen('pi-select')
export const PI_INPUT = screen('pi-input')
export const PI_IDLE = screen('pi-idle')
export const PI_OPTIONS = ['Approve', 'Reject', 'Reject with a note']

/** The menu with the cursor on option `n` (from 1). */
export function selectScreen(n: number, base = PI_SELECT): string {
  return PI_OPTIONS.reduce(
    (s, label, i) => s.replace(new RegExp(`^ (?:→ | {2})${label}$`, 'm'), i + 1 === n ? ` → ${label}` : `   ${label}`),
    base,
  )
}

/** The note's field holding `value` (the end of it when it is longer than the field). */
export function inputScreen(value: string, width = 66): string {
  const shown = value.length > width ? value.slice(value.length - width + 1) : value
  return PI_INPUT.replace(/^>$/m, `> ${shown}`)
}

export class FakePi {
  state: 'select' | 'input' | 'idle' = 'select'
  cursor: number
  value = ''
  picked: string | null = null
  submitted: string | null = null
  keysLog: string[] = []
  texts: string[] = []
  lag: number
  ignore: boolean
  stale = 0
  shown: string

  constructor({ cursor = 1, value = '', state = 'select', lag = 0, ignore = false } = {}) {
    this.cursor = cursor
    this.value = value
    this.state = state as FakePi['state']
    this.lag = lag
    this.ignore = ignore
    this.shown = this.render()
  }

  render(): string {
    if (this.state === 'select') return selectScreen(this.cursor)
    if (this.state === 'input') return inputScreen(this.value)
    return PI_IDLE
  }

  key(k: string): void {
    if (this.state === 'select') {
      if (k === 'up' || k === 'k') this.cursor = Math.max(1, this.cursor - 1)
      else if (k === 'down' || k === 'j') this.cursor = Math.min(PI_OPTIONS.length, this.cursor + 1)
      else if (k === 'enter') {
        this.picked = PI_OPTIONS[this.cursor - 1] ?? null
        this.state = this.cursor === PI_OPTIONS.length ? 'input' : 'idle'
      } else if (k === 'esc') this.state = 'idle'
      return
    }
    if (this.state === 'input') {
      if (k === 'ctrl+u') this.value = ''
      else if (k === 'enter') {
        this.submitted = this.value
        this.state = 'idle'
      } else if (k === 'esc') this.state = 'idle'
    }
  }

  io() {
    return {
      read: async () => {
        if (this.stale > 0) {
          this.stale--
          return this.shown
        }
        this.shown = this.render()
        return this.shown
      },
      keys: async (...keys: string[]) => {
        for (const k of keys) {
          this.keysLog.push(k)
          if (!this.ignore) this.key(k)
        }
        this.stale = this.lag
      },
      text: async (text: string) => {
        this.texts.push(text)
        if (!this.ignore && this.state === 'input') this.value += text
        this.stale = this.lag
      },
    }
  }
}
