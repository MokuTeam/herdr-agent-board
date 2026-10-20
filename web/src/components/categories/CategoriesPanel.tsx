// The categories panel: the board's lanes, edited where they are seen — rename, recolor, the
// folders that sort sessions in, the usual profile (with two profiles or more shown), delete, add
// a lane an agent made to the settings, and drag to reorder. Every change goes to config.json at
// once (POST /api/categories) and comes back over the live stream, to this page, the terminal
// board and the agents' next brief alike. A new lane is made in the form at the end of the list.
// Opened at a lane, its row scrolls into view and lights up. Opening it asks the server for the
// folders of recent sessions, which a lane's "+ folder" offers.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Swatch } from '../../../../src/core/payload.ts'
import { api, errorText } from '../../api/client.ts'
import { launchApi } from '../../api/launch.ts'
import { useHeld } from '../../hooks/useHeld.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useRowReorder } from '../../hooks/useRowReorder.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { catOf } from '../../models/board-view.ts'
import {
  categoryCounts,
  draftColor,
  type FolderSources,
  paletteAfter,
  profileChoices,
} from '../../models/categories.ts'
import { reducedMotion } from '../../models/spring.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { NewIcon } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { CategoryDraft } from './CategoryDraft.tsx'
import { type CategoryEdit, CategoryRow } from './CategoryRow.tsx'

export interface CategoriesPanelProps {
  open: boolean
  /** Opened at a lane (its head on the board, a lane just made): a new object for each opening. */
  focus: { id: string } | null
  onClose(): void
  /** Open the panel at lane `id`. */
  onOpen(id: string): void
}

/** After a lane is made: the live stream brings it, then the panel goes to it. */
const NEW_LANE_MS = 300

export function CategoriesPanel({ open, focus, onClose, onOpen }: CategoriesPanelProps) {
  const t = useT()
  const { data, ui, canEdit, toast, dispatch } = useBoardContext()
  const list = useRef<HTMLDivElement>(null)
  // The "new category" form, with the color it picked when it opened.
  const [draft, setDraft] = useState<{ color: Swatch } | null>(null)
  // The row whose swatches are open; one at a time.
  const [palette, setPalette] = useState<string | null>(null)
  // Folders of recent sessions (GET /api/launch/options), asked for at each opening.
  const [recent, setRecent] = useState<string[]>([])
  const latest = useLatest({ canEdit, t, toast })

  useEffect(() => {
    if (!open) return
    let here = true
    void launchApi.options().then(options => {
      if (here && options) setRecent(options.recent)
    })
    return () => {
      here = false
    }
  }, [open])

  const edit: CategoryEdit = useCallback(
    async body => {
      const { canEdit, t, toast } = latest.current
      // The panel's controls are off while the board cannot edit.
      if (!canEdit) return false
      try {
        await api.post('/api/categories', body)
        return true
      } catch (err) {
        toast(errorText(err, t), true)
        return false
      }
    },
    [latest],
  )

  const reorder = useRowReorder(list, '.handle', {
    onLift: () => setPalette(null),
    onDrop(order, from, to) {
      if (to === from) return
      // Lanes take the new order right away; the live stream confirms it.
      const ids = order.map(row => row.dataset.id ?? '')
      dispatch({ type: 'edit', edit: { type: 'order', ids } })
      void edit({ op: 'order', ids })
    },
  })
  // A row being dragged: the list stays as it was picked up until it is let go.
  const shown = useHeld(data, reorder.dragging)
  const moves = useHeld(ui.moves, reorder.dragging)
  const counts = categoryCounts(shown?.items ?? [], it => catOf(moves, it))
  const profiles = profileChoices(shown?.profiles)
  const folders: FolderSources = {
    sessions: (shown?.items ?? []).map(it => ({ ...it, category: catOf(moves, it) })),
    recent,
  }

  useLayoutEffect(() => {
    if (!focus) return
    const rows = list.current?.querySelectorAll<HTMLElement>('.cat-row') ?? []
    const row = [...rows].find(r => r.dataset.id === focus.id)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    if (!reducedMotion.matches)
      row.animate([{ boxShadow: '0 0 0 3px var(--lane)' }, { boxShadow: 'var(--shadow-card)' }], {
        duration: 1200,
        easing: 'ease-out',
      })
  }, [focus])

  return (
    <Panel
      id="cats-sheet"
      kind="categories"
      open={open}
      onClose={() => {
        setDraft(null)
        onClose()
      }}
      title={
        <>
          <h2>{t('cats.title')}</h2>
          <p className="sheet-meta">{t('cats.about')}</p>
        </>
      }
    >
      <div className="sheet-body cats-body">
        <div className="cats-list" id="cats-list" ref={list}>
          {(shown?.categories ?? []).map(c => (
            <CategoryRow
              key={c.id}
              category={c}
              count={counts.get(c.id) ?? 0}
              swatches={shown?.swatches ?? []}
              disabled={!canEdit}
              paletteOpen={palette === c.id}
              onSwatch={() => setPalette(was => paletteAfter(was, c))}
              onPicked={() => setPalette(null)}
              edit={edit}
              profiles={profiles}
              folders={folders}
            />
          ))}
        </div>
        <div id="cat-draft">
          {draft && (
            <CategoryDraft
              color={draft.color}
              disabled={!canEdit}
              edit={edit}
              onCreated={made => {
                setDraft(null)
                toast(t('cat.created', { title: t('q', { s: made.title }) }))
                setTimeout(() => onOpen(made.id), NEW_LANE_MS)
              }}
              onCancel={() => setDraft(null)}
            />
          )}
        </div>
      </div>
      <footer className="composer">
        <button
          type="button"
          className="button primary"
          id="cat-new"
          hidden={!!draft}
          disabled={!canEdit}
          onClick={() => setDraft({ color: draftColor(data?.categories ?? [], data?.swatches ?? []) })}
        >
          <NewIcon />
          <span>{t('cats.new')}</span>
        </button>
      </footer>
    </Panel>
  )
}
