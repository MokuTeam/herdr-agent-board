// The board's keys (models/board-keys.ts says which action a key takes): N opens the next card
// that needs you, Shift+N starts a session, F2 renames, / goes to the search, Escape leaves a
// field, closes the panel or clears the search, digits answer the open question. The quick
// look, the menus, the launch window and rename come with later tasks: until they give their
// part, it does nothing.
import { useEffect } from 'react'
import { boardKey, type KeyScene, stopsNativeClear } from '../models/board-keys.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'
import { laneContext, type OpenLaunch } from './useNewSession.ts'

export interface BoardKeysOptions {
  openNextAttention(): void
  newSession: OpenLaunch
  /** A menu or the launch window is open: it takes its keys first (Task 27). */
  layerOpen?: () => boolean
  /** The quick look is open (Task 25). */
  quickLookOpen?: () => boolean
  /** A side panel is open (Tasks 25–26)… */
  panelOpen?: () => boolean
  /** …and Escape closes it. */
  closePanel?: () => void
  /** Rename where the name is: the card's (`where`), else the sheet's head (Task 27). */
  rename?: (key: string, where: HTMLElement | null) => void
  /** The session panel is open (Task 25). */
  sessionPanelOpen?: () => boolean
  /** A digit picks an option of the question the open session waits on; true when it did (Task 25). */
  pickOption?: (e: KeyboardEvent) => boolean
}

const cardOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('.card[data-key]') ?? null

export function useBoardKeys(opts: BoardKeysOptions): void {
  const board = useBoardContext()
  const latest = useLatest({ opts, board })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { opts: o, board: b } = latest.current
      if (o.layerOpen?.()) return // they take their keys first
      const active = document.activeElement
      const typing = /^(INPUT|TEXTAREA)$/.test(active?.tagName ?? '')
      const open = b.ui.open
      const sheetFocus = !!open && !!document.getElementById('sheet')?.contains(active)
      const digits =
        !!open &&
        !!o.sessionPanelOpen?.() &&
        (sheetFocus || active?.closest('.card')?.getAttribute('data-key') === open)
      const scene: KeyScene = {
        typing,
        inSearch: active instanceof HTMLInputElement && active.type === 'search',
        panelOpen: o.panelOpen?.() ?? false,
        query: b.ui.query,
        quickLook: o.quickLookOpen?.() ?? false,
        digits,
      }
      const action = boardKey(e, scene)
      switch (action) {
        case 'blur':
          // Leave the field, keep the filter: the second Escape clears the search.
          if (stopsNativeClear(action, scene)) e.preventDefault()
          if (active instanceof HTMLElement) active.blur()
          return
        case 'closePanel':
          o.closePanel?.()
          return
        case 'clearQuery':
          b.dispatch({ type: 'query', text: '' })
          return
        case 'newSession':
          // Shift+N: a new session, in the lane on show.
          e.preventDefault()
          o.newSession(laneContext(b.ui.filter), document.getElementById('new-session'))
          return
        case 'rename': {
          const card = cardOf(active)
          const own = card?.dataset.key
          const key = own && b.data?.items.some(i => i.key === own) ? own : open
          if (!key) return
          e.preventDefault()
          o.rename?.(
            key,
            card && own === key ? card.querySelector<HTMLElement>('.name') : document.getElementById('sheet-name'),
          )
          return
        }
        case 'next':
          e.preventDefault()
          o.openNextAttention()
          return
        case 'digit':
          if (o.pickOption?.(e)) e.preventDefault()
          return
        case 'search':
          e.preventDefault()
          document.getElementById('search')?.focus()
          return
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [latest])
}
