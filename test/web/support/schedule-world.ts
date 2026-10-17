// What the two sides of the reminders' parity tests share: a clock the steps move, the server's
// answers waiting to be given (through one fetch), the entries' rows on the page, and what went out
// (posted, toasted, folded away, unfolded).
import { spyOn } from 'bun:test'

export type Reply = { status: number; body: unknown } | 'offline'

/** A moment, a server answer, or the folding rows done; the tests add their own clicks. */
export type WorldStep = { wait: number } | { reply: Reply } | 'folded'

const isWorldStep = (step: unknown): step is WorldStep =>
  step === 'folded' || (typeof step === 'object' && step !== null && ('wait' in step || 'reply' in step))

/** A row on the page, as far as the buttons touch it. */
export type Row = { name: string; removeAttribute(attr: string): void }

/** Timers on a clock the steps move. */
export class Clock {
  now = 0
  private next = 1
  private timers = new Map<number, { at: number; fn: () => void }>()
  set = (fn: () => void, ms: number): number => {
    const id = this.next++
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }
  clear = (id: number): void => void this.timers.delete(id)
  advance(ms: number): void {
    this.now += ms
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.now) continue
      this.timers.delete(id)
      timer.fn()
    }
  }
}

export class World {
  readonly clock = new Clock()
  readonly posts: string[] = []
  readonly toasts: [string, boolean][] = []
  readonly folded: string[] = []
  readonly unfolded: string[] = []
  private replies: ((reply: Reply) => void)[] = []
  private folds: (() => void)[] = []
  private readonly spy

  constructor() {
    const fake = (url: string | URL | Request, init?: RequestInit) => {
      const headers = JSON.stringify(init?.headers)
      this.posts.push(`${init?.method} ${String(url)} ${headers} ${String(init?.body)}`)
      return new Promise<Response>((resolve, reject) =>
        this.replies.push(reply =>
          reply === 'offline'
            ? reject(new TypeError('Failed to fetch'))
            : resolve(new Response(JSON.stringify(reply.body), { status: reply.status })),
        ),
      )
    }
    this.spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fake, { preconnect: fetch.preconnect }))
  }

  /** The entry's two rows: in the schedule panel and in the sheet. */
  rows = (id: string): Row[] =>
    ['sched-entry', 'sched-mini'].map(kind => ({
      name: `${kind} ${id}`,
      removeAttribute: (attr: string) => void this.unfolded.push(`${kind} ${id} ${attr}`),
    }))
  collapse = (row: Row): Promise<void> => {
    this.folded.push(row.name)
    return new Promise(resolve => this.folds.push(resolve))
  }
  toast = (text: string, error = false) => void this.toasts.push([text, error])

  /** One step (a test's own ones go to `act`), then the promises it set going run. */
  async step<S>(step: S | WorldStep, act: (step: Exclude<S, WorldStep>) => unknown): Promise<void> {
    if (!isWorldStep(step)) void act(step as Exclude<S, WorldStep>)
    else if (step === 'folded') for (const f of this.folds.splice(0)) f()
    else if ('wait' in step) this.clock.advance(step.wait)
    else for (const r of this.replies.splice(0)) r(step.reply)
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }

  /** What went out so far. */
  sent() {
    return { posts: [...this.posts], toasts: [...this.toasts], folded: [...this.folded], unfolded: [...this.unfolded] }
  }

  dispose(): void {
    this.spy.mockRestore()
  }
}

/** The ids an old selector names (`.sched-entry[data-id="x"], .sched-mini[data-id="x"]`). */
export const selectorIds = (selector: string): string[] =>
  [...selector.matchAll(/data-id="([^"]+)"/g)].map(m => m[1] ?? '')
