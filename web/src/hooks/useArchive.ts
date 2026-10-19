// The archive on the page (upstream's app.js "the archive" and "archive panel"). A session taken
// off the board flies into the Archive button and comes back out of it. Its card goes at once
// (the page's `archiving`, models/board-view.ts visibleItems); its tab in herdr closes a few
// seconds later (the server's), so "Return" in the toast — or Ctrl+Z while it shows — puts it back
// as it was. Later, Return in the archive's panel resumes it in a new tab: its launch card says
// "back" and comes out of the button (the page's `flyBack`). A tidy-up takes the sleeping sessions
// in "Idle" at once. The panel is read from the server when it opens and again whenever the board
// changes while it is open; a close the server called off is said once (models/archive-view.ts).
import { useEffect, useMemo, useRef, useState } from 'react'
import { archiveBlock, type PublicArchiveRecord, tidyList } from '../../../src/core/archive.ts'
import type { Item } from '../../../src/core/types.ts'
import { type ArchiveReply, archiveApi } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import {
  archivedManyText,
  archiveNotes,
  lowerFirst,
  returnedText,
  returnToastMs,
  UNDO_MS,
} from '../models/archive-view.ts'
import { catOf, laneShown } from '../models/board-view.ts'
import { pickedProfile, profileShown } from '../models/profiles.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { nextToastToken } from '../state/board-ui.ts'
import { appear } from './useFlip.ts'
import { useLatest } from './useLatest.ts'
import { collapse } from './useSchedule.ts'
import { useSessionActions } from './useSessionActions.ts'

// ---------------------------------------------------------------- the flights

const archiveButton = (): HTMLElement | null => document.getElementById('archive-open')

/** The button nods when something lands in it, a little bounce: the card arrived with momentum. */
export function bumpArchive(): void {
  const b = archiveButton()
  if (!b || reducedMotion.matches) return
  const s = new Spring({
    value: 0,
    damping: 0.55,
    response: 0.3,
    precision: 0.002,
    onUpdate: v => {
      b.style.scale = String(1 + 0.16 * v)
    },
    onRest: () => {
      b.style.scale = ''
    },
  })
  s.to(0, { velocity: 9 })
}

/** The board's card of a session. */
const cardEl = (key: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#board .card[data-key="${CSS.escape(key)}"]`)

/**
 * Cards fly into the Archive button, shrinking and fading on the way, the button nodding as they
 * land. Many go with a short stagger; with reduced motion, or the button out of sight, they just go.
 */
export function flyToArchive(els: readonly (HTMLElement | null)[]): void {
  const to = archiveButton()?.getBoundingClientRect()
  const list = els.filter((el): el is HTMLElement => !!el?.isConnected && !!el.offsetParent)
  if (!list.length) return
  if (reducedMotion.matches || !to?.width) return
  list.slice(0, 12).forEach((el, i) => {
    const from = el.getBoundingClientRect()
    const ghost = el.cloneNode(true)
    if (!(ghost instanceof HTMLElement)) return
    ghost.classList.remove('selected', 'moving', 'placeholder', 'busy')
    ghost.classList.add('ghost', 'to-archive')
    Object.assign(ghost.style, {
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
      transform: '',
      translate: '',
      scale: '',
      opacity: '',
    })
    document.body.append(ghost)
    const dx = to.left + to.width / 2 - (from.left + from.width / 2)
    const dy = to.top + to.height / 2 - (from.top + from.height / 2)
    const s = new Spring({
      value: 0,
      damping: 1,
      response: 0.46,
      precision: 0.002,
      onUpdate: v => {
        // A gentle arc: up and over toward the toolbar, not a straight cut across the board.
        const lift = Math.sin(Math.PI * v) * Math.min(80, Math.abs(dy) * 0.15)
        ghost.style.transform = `translate3d(${dx * v}px, ${dy * v - lift}px, 0) scale(${1 - 0.9 * v})`
        ghost.style.opacity = String(1 - v ** 3)
      },
      onRest: () => {
        ghost.remove()
        if (i === 0) bumpArchive()
      },
    })
    setTimeout(() => s.to(1), i * 35)
  })
}

/** A card back from the archive comes out of the button and settles into its place. */
export function flyFromArchive(el: HTMLElement): void {
  const from = archiveButton()?.getBoundingClientRect()
  if (reducedMotion.matches || !from?.width || !el.offsetParent) {
    appear(el)
    return
  }
  const to = el.getBoundingClientRect()
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)
  bumpArchive()
  const s = new Spring({
    value: 1,
    damping: 1,
    response: 0.46,
    precision: 0.002,
    onUpdate: v => {
      el.style.translate = `${dx * v}px ${dy * v}px`
      el.style.scale = String(1 - 0.9 * v)
      el.style.opacity = String(1 - v ** 3)
    },
    onRest: () => {
      el.style.translate = ''
      el.style.scale = ''
      el.style.opacity = ''
    },
  })
  s.to(0)
}

// ---------------------------------------------------------------- the page's archive

/** The archive's panel, as the page has it. */
export interface ArchivePanelState {
  open: boolean
  /** What the archive holds, as the server last said (GET /api/archive). */
  records: readonly PublicArchiveRecord[]
  /** Keys whose Return is on its way from this page. */
  returning: ReadonlySet<string>
  /** The row whose trash can asks "Remove?". */
  armed: string | null
  query: string
  /** Counts the openings: rows that come in after one materialize, those it opened with do not. */
  opened: number
}

export interface Archive {
  /**
   * Off the board until Return: its card flies into the button, its tab closes a few seconds later.
   * `fly`: false for a card dropped on the archive's place, which went into it on its own.
   */
  archiveSession(key: string, opts?: { fly?: boolean }): Promise<void>
  /** Several at once (a tidy-up): one request, one toast, one Return for all. */
  archiveMany(keys: readonly string[]): Promise<void>
  /** Bring sessions back: put back as they were while their tab has not closed yet, else resumed in a new tab. */
  returnSessions(keys: readonly string[]): Promise<void>
  /** Sleeping sessions in "Idle" a tidy-up takes: in lane `lane`, or in the lanes (and profiles) on show. */
  tidyItems(days: number, lane?: string | null): Item[]
  /** An archive's toast still offers Return (Ctrl+Z). */
  canUndo(): boolean
  /** Ctrl+Z: what went last comes back, as its toast's Return does. */
  undo(): void
  panel: ArchivePanelState
  openPanel(): void
  closePanel(): void
  togglePanel(): void
  setQuery(text: string): void
  /** The trash can: the first click arms it ("Remove?"), a second one within four seconds removes the record. */
  remove(key: string, row: HTMLElement | null): Promise<void>
  disarm(): void
}

/** The archive's toast whose Return Ctrl+Z also takes, until it goes. */
interface LastArchived {
  keys: readonly string[]
  until: number
  hide(): void
}

const ARMED_MS = 4000

/** What the page keeps of the archive outside React's state. */
interface Own {
  lastArchived: LastArchived | null
  /** How long the server keeps a pane for Return (GET /api/archive's undoMs). */
  undoMs: number
  /** Keys asked to go from this page, until the answer: a double click sends one. */
  going: Set<string>
  armTimer: ReturnType<typeof setTimeout> | undefined
  /** Rows on their way out: the panel reads the archive again once they are gone. */
  collapsing: number
  /** A read on its way, and whether another is wanted after it. */
  loading: boolean
  again: boolean
  /** The archive log's lines seen; null before the first board. */
  seen: Set<string> | null
}

export function useArchive(): Archive {
  const t = useT()
  const board = useBoardContext()
  const actions = useSessionActions()
  const [panel, setPanel] = useState<ArchivePanelState>({
    open: false,
    records: [],
    returning: new Set(),
    armed: null,
    query: '',
    opened: 0,
  })
  const latest = useLatest({ t, board, actions, panel })
  const own = useRef<Own>({
    lastArchived: null,
    undoMs: UNDO_MS,
    going: new Set(),
    armTimer: undefined,
    collapsing: 0,
    loading: false,
    again: false,
    seen: null,
  })

  const api = useMemo(() => {
    const page = () => latest.current
    const itemOf = (key: string): Item | undefined => page().board.data?.items.find(i => i.key === key)
    const toast = (text: string, error = false) => page().board.toast(text, error)
    const dispatch: typeof board.dispatch = action => page().board.dispatch(action)
    const refused = () => toast(page().t(page().board.canEdit ? 'mobile.readOnly' : 'live.off'), true)
    const isArchiving = (key: string) => own.current.going.has(key) || page().board.ui.archiving.has(key)
    // The session panel shows it: it closes as the card goes.
    const closeSheet = (keys: readonly string[]) => {
      const open = page().board.ui.open
      if (open && keys.includes(open)) dispatch({ type: 'open', key: null })
    }

    async function load(): Promise<void> {
      const o = own.current
      if (o.loading || o.collapsing) {
        o.again = true
        return
      }
      o.loading = true
      try {
        const r = await archiveApi.list()
        o.undoMs = r.undoMs ?? o.undoMs
        setPanel(p => ({ ...p, records: r.records }))
      } catch {
        // The next board reads it again.
      } finally {
        o.loading = false
        if (o.again) {
          o.again = false
          void load()
        }
      }
    }

    function offerReturn(keys: readonly string[], text: string, closeAt: number | null | undefined): void {
      const now = Date.now()
      const ms = returnToastMs(closeAt, own.current.undoMs, now)
      const token = nextToastToken()
      page().board.toast(text, false, {
        action: { label: page().t('archive.return'), run: () => void returnSessions(keys) },
        ms,
        token,
      })
      own.current.lastArchived = { keys, until: now + ms, hide: () => dispatch({ type: 'toastHide', token }) }
    }

    async function archiveSession(key: string, { fly = true }: { fly?: boolean } = {}): Promise<void> {
      const it = itemOf(key)
      // On its way already (a double click): one is enough.
      if (!it || isArchiving(key)) return
      const { t, board } = page()
      const why = archiveBlock(it, board.data?.schedules ?? [])
      if (why) return toast(t(why), true)
      if (!board.canMutate) return refused()
      closeSheet([key])
      if (fly) flyToArchive([cardEl(key)])
      own.current.going.add(key)
      dispatch({ type: 'archiving', keys: [key], at: Date.now() })
      const r = await page().actions.act(key, 'archive')
      own.current.going.delete(key)
      if (!r.ok) {
        dispatch({ type: 'unarchiving', keys: [key] })
        dispatch({ type: 'flyBack', keys: [key], at: Date.now() })
        return toast(r.error, true)
      }
      const held = typeof r.held === 'number' ? r.held : 0
      const closeAt = typeof r.closeAt === 'number' ? r.closeAt : null
      offerReturn([key], page().t(held ? 'archive.doneHeld' : 'archive.done', { name: it.name, n: held }), closeAt)
    }

    async function archiveMany(asked: readonly string[]): Promise<void> {
      const keys = asked.filter(k => itemOf(k) && !isArchiving(k))
      if (!keys.length) return
      if (!page().board.canMutate) return refused()
      closeSheet(keys)
      flyToArchive(keys.map(cardEl))
      for (const k of keys) own.current.going.add(k)
      dispatch({ type: 'archiving', keys, at: Date.now() })
      const r = await archiveApi.post('archive', keys, page().t)
      for (const k of keys) own.current.going.delete(k)
      const failed = r.failed.map(f => f.key)
      if (failed.length) {
        dispatch({ type: 'unarchiving', keys: failed })
        dispatch({ type: 'flyBack', keys: failed, at: Date.now() })
      }
      const done = r.done
      if (!done.length) return toast(r.error, true)
      const t = page().t
      const now = Date.now()
      offerReturn(
        done.map(d => d.key),
        archivedManyText(done, t),
        Math.min(...done.map(d => d.closeAt ?? now + own.current.undoMs)),
      )
      const first = r.failed[0]
      if (first)
        setTimeout(() => toast(t('archive.stayed', { n: r.failed.length, why: lowerFirst(first.error, t) }), true), 400)
    }

    async function returnSessions(keys: readonly string[]): Promise<void> {
      if (!page().board.canMutate) return refused()
      // Its toast's Return has nothing left to do.
      const last = own.current.lastArchived
      if (last?.keys.some(k => keys.includes(k))) last.hide()
      own.current.lastArchived = null
      // Back on the board as soon as the server has it there again, not after the archiving wait.
      dispatch({ type: 'unarchiving', keys })
      dispatch({ type: 'flyBack', keys, at: Date.now() })
      setPanel(p => ({ ...p, returning: new Set([...p.returning, ...keys]) }))
      const r = await archiveApi.post('return', keys, page().t)
      const launches = r.done.flatMap(d => (d.launch ? [`launch:${d.launch}`] : []))
      if (launches.length) dispatch({ type: 'flyBack', keys: launches, at: Date.now() })
      setPanel(p => ({ ...p, returning: new Set([...p.returning].filter(k => !keys.includes(k))) }))
      void load()
      const done = r.done
      const first = r.failed[0]
      if (!done.length) return toast(r.error, true)
      toast(returnedText(done, k => itemOf(k)?.name, page().t))
      if (first) setTimeout(() => toast(first.error, true), 400)
    }

    function tidyItems(days: number, lane: string | null = null): Item[] {
      const { board } = page()
      const { data, ui } = board
      if (!data) return []
      const profile = pickedProfile(ui.profile, data.profiles)
      const items = data.items.filter(
        it =>
          !isArchiving(it.key) &&
          (lane ? catOf(ui.moves, it) === lane : laneShown(ui.filter, catOf(ui.moves, it))) &&
          profileShown(profile, it),
      )
      return tidyList(items, days, data.schedules ?? [])
    }

    function disarm(): void {
      clearTimeout(own.current.armTimer)
      own.current.armTimer = undefined
      setPanel(p => (p.armed === null ? p : { ...p, armed: null }))
    }

    async function remove(key: string, row: HTMLElement | null): Promise<void> {
      if (page().panel.armed !== key) {
        disarm()
        own.current.armTimer = setTimeout(disarm, ARMED_MS)
        return void setPanel(p => ({ ...p, armed: key }))
      }
      disarm()
      const rec = page().panel.records.find(r => r.key === key)
      own.current.collapsing++
      let r: ArchiveReply<'remove'>
      try {
        ;[r] = await Promise.all([archiveApi.post('remove', [key], page().t), row ? collapse(row) : undefined])
      } finally {
        own.current.collapsing--
      }
      if (r.done.length) {
        setPanel(p => ({ ...p, records: p.records.filter(x => x.key !== key) }))
        toast(page().t('archive.removed', { name: rec?.name ?? '' }))
      } else {
        row?.removeAttribute('style')
        toast(r.error, true)
      }
      void load()
    }

    function openPanel(): void {
      setPanel(p => ({ ...p, open: true, opened: p.opened + 1 }))
      void load()
      if (!matchMedia('(pointer: coarse)').matches)
        setTimeout(() => document.getElementById('archive-search')?.focus({ preventScroll: true }), 60)
    }

    function closePanel(): void {
      disarm()
      setPanel(p => (p.open ? { ...p, open: false } : p))
    }

    return {
      archiveSession,
      archiveMany,
      returnSessions,
      tidyItems,
      canUndo: () => {
        const last = own.current.lastArchived
        return !!last && Date.now() < last.until
      },
      undo: () => {
        const last = own.current.lastArchived
        if (!last) return
        last.hide()
        void returnSessions(last.keys)
      },
      openPanel,
      closePanel,
      togglePanel: () => (page().panel.open ? closePanel() : openPanel()),
      setQuery: (text: string) => setPanel(p => ({ ...p, query: text })),
      remove,
      disarm,
      load,
    }
  }, [latest])

  // How the archive went for this page: a close called off, said once; the first board's log is old news.
  const hasBoard = !!board.data
  const log = board.data?.archive?.log
  useEffect(() => {
    if (!hasBoard) return
    const { board, t } = latest.current
    const r = archiveNotes(log ?? [], own.current.seen, key => board.data?.items.find(i => i.key === key)?.name, t)
    own.current.seen = r.seen
    for (const text of r.toasts) board.toast(text, true)
  }, [log, hasBoard, latest])

  // Read on opening, and again whenever the board changes while it is open.
  const { open } = panel
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new board is when to read it again, not what it reads
  useEffect(() => {
    if (open) void api.load()
  }, [open, board.data, api])

  useEffect(() => () => clearTimeout(own.current.armTimer), [])

  const { load: _load, ...rest } = api
  return { ...rest, panel }
}
