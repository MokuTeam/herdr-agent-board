// The board's columns share its width by whether they have cards on show (models/toolbar.ts
// columnShares): an empty one keeps only its head's width (--col-min) and the others take its room.
// The shares move on springs, so cards glide to their new width when a column fills or empties
// instead of the board jumping; the grid reads them from --cols on <html>.
import { useEffect, useLayoutEffect, useState } from 'react'
import { Spring } from '../models/spring.ts'
import { type ColumnHead, columnShares, columnTracks } from '../models/toolbar.ts'

export interface ColumnWidths {
  /** The columns in their order, and the share each heads for. */
  fit(ids: string[], shares: number[]): void
  stop(): void
}

/** `write` gets the grid's columns (--cols) once per frame the shares moved in. */
export function columnWidths(write: (tracks: string) => void): ColumnWidths {
  const shares = new Map<string, Spring>()
  let ids: string[] = []
  let queued = false
  const queue = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      write(columnTracks(ids.map(id => shares.get(id)?.value ?? 0)))
    })
  }
  return {
    fit(next, wants) {
      ids = next
      next.forEach((id, k) => {
        const want = wants[k] ?? 1
        const share = shares.get(id)
        if (!share)
          shares.set(id, new Spring({ value: want, damping: 1, response: 0.4, precision: 0.002, onUpdate: queue }))
        else if (share.target !== want) share.to(want)
      })
      queue()
    },
    stop() {
      for (const share of shares.values()) share.stop()
    },
  }
}

/** After every draw of the toolbar, as the old page's renderToolbar did. */
export function useColumnWidths(heads: ColumnHead[]): void {
  const [widths] = useState(() => columnWidths(tracks => document.documentElement.style.setProperty('--cols', tracks)))
  useLayoutEffect(() => {
    widths.fit(
      heads.map(h => h.id),
      columnShares(heads),
    )
  })
  useEffect(() => () => widths.stop(), [widths])
}
