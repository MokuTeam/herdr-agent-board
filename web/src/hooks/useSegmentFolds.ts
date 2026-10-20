// The toolbar's segmented controls (the lanes control, the profile switch) fold into a pill each
// when the row has no room for all of their segments, and unfold once it has again
// (models/segment-fold.ts decides; the pill is components/SegmentPick.tsx). A folded control's
// segments stay in the row, hidden: to know whether they fit again they are tried in the pill's
// place and put back at once, within one task, so nothing flickers. Fitted again, and drawn
// before the frame shows, when the row or a control in it changes size, or a control's
// segments change (their lanes or profiles, counts, the one picked, the language).
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { FOLD_SLACK, foldsNow, nextFold, type SegmentsRoom, withFold } from '../models/segment-fold.ts'

/** No control folded: the page as it starts, and as the server draws it. */
const NONE: ReadonlySet<string> = new Set()

interface Control {
  /** Its segments (`.segmented`, named by its id), hidden while it is folded. */
  seg: HTMLElement
  /** Its pill (`#<id>-pick`), there while it is folded. */
  pick: HTMLElement | null
}

/** The segmented controls of the toolbar row `row`, in its order. */
const controlsIn = (row: HTMLElement): Control[] =>
  Array.from(row.querySelectorAll<HTMLElement>('.segmented'))
    .filter(seg => seg.id)
    .map(seg => ({ seg, pick: row.querySelector<HTMLElement>(`#${seg.id}-pick`) }))

/** Drawn segments: all of their width, and the room they were given. */
const drawnRoom = (seg: HTMLElement): SegmentsRoom => ({ natural: seg.scrollWidth, room: seg.clientWidth })

/**
 * A folded control's segments tried in its pill's place, then put back: their width at full size,
 * and the room they get asking for `slack` more; null when that cuts another control's segments
 * (`others`, drawn).
 */
function tried({ seg, pick }: Control, others: readonly HTMLElement[], slack: number): SegmentsRoom | null {
  const { style } = seg
  const own = seg.getAttribute('style')
  seg.hidden = false
  if (pick) pick.hidden = true
  style.flex = 'none'
  style.maxWidth = 'none'
  style.width = 'max-content'
  const natural = seg.getBoundingClientRect().width
  style.flex = ''
  style.maxWidth = ''
  style.width = `${natural + slack}px`
  const room = seg.getBoundingClientRect().width
  const whole = others.every(other => !foldsNow(false, drawnRoom(other)))
  style.width = ''
  if (own === null) seg.removeAttribute('style')
  seg.hidden = true
  if (pick) pick.hidden = false
  return whole ? { natural, room } : null
}

/** The next control of `row` to fold or unfold (models/segment-fold.ts nextFold); null: they stay as they are. */
export function segmentFoldIn(row: HTMLElement, slack = FOLD_SLACK): { id: string; folded: boolean } | null {
  const controls = controlsIn(row)
  const drawn = controls.filter(c => !c.seg.hidden).map(c => c.seg)
  const i = nextFold(
    controls.map(c => ({
      folded: !!c.seg.hidden,
      room: () => (c.seg.hidden ? tried(c, drawn, slack) : drawnRoom(c.seg)),
    })),
    slack,
  )
  const change = controls[i]
  return change ? { id: change.seg.id, folded: !change.seg.hidden } : null
}

/**
 * The controls of the toolbar row `row` folded now, by id; `drawn` changes whenever their
 * segments do.
 */
export function useSegmentFolds(row: RefObject<HTMLElement | null>, drawn: string): ReadonlySet<string> {
  const [folded, setFolded] = useState(NONE)
  const fitted = useRef('')
  const ids = [...folded].join(' ')

  // On every draw: fitted again when the segments or the folds changed, a change at a time, each
  // drawn before the frame shows.
  useLayoutEffect(() => {
    const el = row.current
    const now = `${drawn}\n${ids}`
    if (!el || now === fitted.current) return
    fitted.current = now
    const change = segmentFoldIn(el)
    if (change) setFolded(was => withFold(was, change.id, change.folded))
  })

  // The room: the row's width, the controls beside them (the row's own width on a wide toolbar),
  // the controls' own; fitted again and drawn at once, in the frame that changed it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: observed anew as controls and their pills come and go
  useLayoutEffect(() => {
    const el = row.current
    if (!el || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      const change = segmentFoldIn(el)
      if (change) flushSync(() => setFolded(was => withFold(was, change.id, change.folded)))
    })
    observer.observe(el)
    const controls = el.querySelector('.controls')
    if (controls) observer.observe(controls)
    for (const { seg, pick } of controlsIn(el)) {
      observer.observe(seg)
      if (pick) observer.observe(pick)
    }
    return () => observer.disconnect()
  }, [row, drawn, ids])

  return folded
}
