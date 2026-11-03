// What fits every card's head to its name (#324; models/card-head.ts), all cards at once. A board
// of many cards must not lay the page out again for each card and each step: the rows that need a
// fit are fitted together, in rounds. In each round every unsettled row takes the step it tries
// next, the page is laid out once, and every name is read. A row starts from the steps it had (a
// width that moved a little needs one or two rounds), so a pass costs a few layouts whatever the
// number of cards.
//
// A row is fitted when its width changes (one ResizeObserver for all), when what styles or fills it
// changes (its card's classes, its words: `changed`, from every render), and when the page changes
// its type (the look, wrapped card text: `pageChanged`). A row with no box (a hidden lane) is not
// fitted; it is when it shows again. What the page says (widths, the name's measure, the
// observer, React's flushSync) is the environment's, so a test can stand in for it.
import { HEAD_STEPS, type HeadStep } from '../models/card-head.ts'

export interface HeadEnv<R> {
  /** What styles and fills the row; a change asks for a fit. */
  key(row: R): string
  /** The steps the row has something for (no clock, no clock step). */
  present(row: R): HeadStep[]
  /** Draws the row with `given` taken. */
  give(row: R, given: readonly HeadStep[]): void
  /** Whether the row's name is cut as the row is drawn now: a read of the page's layout. */
  cut(row: R): boolean
  /** Watches rows' widths: `resized` with each row whose width changed and its new width (0: no box). */
  observer(resized: (changes: { row: R; width: number }[]) => void): {
    observe(row: R): void
    unobserve(row: R): void
  }
  /** Runs the cut rows' updates at once, drawn before the frame is painted. */
  flushSync(update: () => void): void
  /** Runs `fit` after the current task (the render's commit), before the frame is painted. */
  later(fit: () => void): void
}

interface Row {
  key: string
  /** Its width as last observed: -1 before the first, 0 with no box. */
  width: number
  /** Steps taken. */
  /** Its steps to try, read again when what fills it changes; null: not read since. */
  present: HeadStep[] | null
  steps: number
  cut: boolean
  onCut(cut: boolean): void
}

export interface HeadFitter<R> {
  /** Starts fitting `row`; `onCut` hears whether its name is cut even so. Fitted at its first width. */
  add(row: R, onCut: (cut: boolean) => void): void
  remove(row: R): void
  /** The row was drawn again: fitted once the render is done, if what styles or fills it changed. */
  changed(row: R): void
  /** The page changed its type under every row: all are fitted now. */
  pageChanged(): void
}

export function createHeadFitter<R>(env: HeadEnv<R>): HeadFitter<R> {
  const rows = new Map<R, Row>()
  const pending = new Set<R>()
  let queued = false
  const watch = env.observer(changes => {
    for (const { row, width } of changes) {
      const state = rows.get(row)
      if (!state || state.width === width) continue
      state.width = width
      pending.add(row)
    }
    fit()
  })

  function fit() {
    queued = false
    const run = [...pending].flatMap(row => {
      const state = rows.get(row)
      if (!state) return []
      // No box: nothing to measure. The key is forgotten, so whatever changed meanwhile is fitted
      // when the row shows again.
      if (state.width <= 0) {
        state.key = ''
        state.present = null
        return []
      }
      // A row only resized keeps its key and its steps to try: no need to read its words again.
      if (!state.key) state.key = env.key(row)
      state.present ??= env.present(row)
      return [{ row, state, present: state.present }]
    })
    pending.clear()
    if (!run.length) return
    const settled = fitRows(run, env)
    const heard: (() => void)[] = []
    for (const { state, steps, cut } of settled) {
      state.steps = steps
      if (cut === state.cut) continue
      state.cut = cut
      heard.push(() => state.onCut(cut))
    }
    if (!heard.length) return
    env.flushSync(() => {
      for (const hear of heard) hear()
    })
  }

  return {
    add(row, onCut) {
      rows.set(row, { key: env.key(row), width: -1, present: null, steps: 0, cut: false, onCut })
      watch.observe(row)
    },
    remove(row) {
      rows.delete(row)
      pending.delete(row)
      watch.unobserve(row)
    },
    changed(row) {
      const state = rows.get(row)
      if (!state) return
      const key = env.key(row)
      if (key === state.key) return
      state.key = key
      state.present = null
      pending.add(row)
      if (queued) return
      queued = true
      env.later(fit)
    },
    pageChanged() {
      for (const row of rows.keys()) pending.add(row)
      fit()
    },
  }
}

/**
 * The fewest steps (in HEAD_STEPS order, of each row's `present`) that leave each name whole, all
 * rows together: each round draws every unsettled row at the step it tries, then reads them all
 * (one layout). A row starts at the steps it had and walks down while its name fits, or up while it
 * does not. With none enough, it takes all and its name is cut.
 */
export function fitRows<R, S extends { steps: number }>(
  run: { row: R; state: S; present: HeadStep[] }[],
  env: Pick<HeadEnv<R>, 'give' | 'cut'>,
): { row: R; state: S; steps: number; cut: boolean }[] {
  const search = run.map(({ row, state, present }) => {
    const order = HEAD_STEPS.filter(s => present.includes(s))
    const top = order.length
    // Known: `lo` steps cut the name, `hi` steps do not (top + 1: not even all of them, maybe).
    return { row, state, order, top, lo: -1, hi: top + 1, at: Math.min(Math.max(state.steps, 0), top) }
  })
  let open = search
  while (open.length) {
    for (const s of open) env.give(s.row, s.order.slice(0, s.at))
    for (const s of open) {
      if (env.cut(s.row)) s.lo = s.at
      else s.hi = s.at
      s.at = s.at === s.hi ? s.at - 1 : s.at + 1
    }
    open = open.filter(s => s.at > s.lo && s.at < s.hi && s.at <= s.top)
  }
  return search.map(s => {
    const steps = Math.min(s.hi, s.top)
    env.give(s.row, s.order.slice(0, steps))
    return { row: s.row, state: s.state, steps, cut: s.hi > s.top }
  })
}
