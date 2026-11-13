// The threads panel (#392, docs/design/threads 10.3, 10.5): a side panel in the board's glass sheet,
// built like the Team panel and from its parts. Wide (720 px and more of the sheet), the list on
// the left and one thread on the right; narrow and on the phone, the list is a screen and a thread
// is a screen pushed over it from the right, which leaves the same way. The push is a spring
// (damping 1, response 0.34) that starts from where the screen is, so a tap mid-flight reverses
// it, and on a touch screen the thread follows the finger from the left edge and is thrown back
// by its speed. With reduced motion the two cross-fade.
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useThreadsContext, useThreadView } from '../../hooks/useThreads.tsx'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type PointerSample, project, reducedMotion, Spring, velocityOf } from '../../models/spring.ts'
import {
  type ListFilter,
  laneMenu,
  lanePicked,
  lanesOf,
  sectionsOf,
  type ThreadRow,
} from '../../models/work-threads.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { SearchIcon } from '../icons.tsx'
import type { MenuEngine } from '../menu/menu-engine.ts'
import { Panel } from '../panel/Panel.tsx'
import { StatusDot, WhoChip } from './bits.tsx'
import { ThreadPane } from './ThreadPane.tsx'

/** The sheet's width from which the list and the thread stand side by side (the Team panel's). */
export const WIDE_PX = 720
/** The push between the list and a thread (10.6). */
export const PUSH = { damping: 1, response: 0.34 }
/** How far from the thread's left edge a finger takes it back (px). */
const EDGE_PX = 28

/** The board's one menu (hooks/useContextMenus.ts), as far as the lane filter opens it. */
export type LaneMenuEngine = Pick<MenuEngine, 'open' | 'openNow' | 'isOpen'>

export interface ThreadsPanelProps {
  open: boolean
  onClose(): void
  /** The lane filter's menu (#412): the board's own, in its look, not the browser's list. */
  menu: LaneMenuEngine
}

/**
 * The lane filter (#412): a button that opens the board's menu of lanes under it, as the toolbar's
 * pills do; the browser's own list would be drawn in its light scheme. Arrows, Enter and Space
 * open it from the keyboard with the first item lit; Escape and a click outside close it (the
 * menu's own), and the focus comes back here.
 */
function LaneFilter({
  lanes,
  lane,
  titleOf,
  menu,
  onPick,
}: {
  lanes: readonly string[]
  lane: string | null
  titleOf(lane: string): string
  menu: LaneMenuEngine
  onPick(lane: string | null): void
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  useEffect(
    () =>
      menu.openNow.subscribe(() => {
        if (!menu.isOpen()) setExpanded(false)
      }),
    [menu],
  )
  const open = (button: HTMLElement, keyboard: boolean) => {
    const rect = button.getBoundingClientRect()
    menu.open(laneMenu(lanes, lane, titleOf, t('wt.allLanes')), {
      x: rect.left,
      y: rect.bottom + 4,
      source: keyboard ? 'keyboard' : matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse',
      origin: button,
      label: t('wt.lane'),
      onPick: id => {
        const picked = lanePicked(id)
        if (picked !== undefined) onPick(picked)
      },
    })
    // After it is up: a menu it replaced said none was, closing first.
    setExpanded(true)
  }
  const text = lane === null ? t('wt.allLanes') : titleOf(lane)
  return (
    <button
      type="button"
      className="wt-lane"
      // The lane shown in the name too, as a select says its value.
      aria-label={`${t('wt.lane')}: ${text}`}
      aria-haspopup="menu"
      aria-expanded={expanded}
      onClick={e => open(e.currentTarget, e.detail === 0)}
      onKeyDown={e => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        open(e.currentTarget, true)
      }}
    >
      <span className="wt-lane-text">{text}</span>
      <svg className="wt-lane-chev" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 4.5 6 7.5 9 4.5" />
      </svg>
    </button>
  )
}

const timeOf = (at: number, now: number, lang: string): string => {
  const d = new Date(at)
  return new Date(now).toDateString() === d.toDateString()
    ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(lang, { month: 'short', day: 'numeric' })
}

function Row({ row, active, onOpen }: { row: ThreadRow; active: boolean; onOpen(key: string): void }) {
  const t = useT()
  const { now } = useBoardContext()
  const last = row.proposed ? t('wt.saysDone', { why: row.proposed.why }) : row.waitingOn || row.summary
  return (
    <button
      type="button"
      className={classNames(
        'wt-row',
        active && 'active',
        (row.status === 'done' || row.status === 'dropped') && 'done',
      )}
      aria-current={active || undefined}
      data-thread={row.key}
      onClick={() => onOpen(row.key)}
    >
      <StatusDot status={row.status} />
      <span className="wt-row-main">
        <span className="wt-row-top">
          <code className="wt-key">{row.key}</code>
          <span className="wt-row-title">{row.title}</span>
          {row.children.all > 0 && (
            <span className="wt-rollup">{t('wt.rollup', { done: row.children.done, all: row.children.all })}</span>
          )}
          <span className="wt-row-when">{timeOf(row.updatedAt, now, t.lang)}</span>
        </span>
        {(row.assignee || last || row.parentKey) && (
          <span className="wt-row-bottom">
            {row.assignee && <WhoChip party={row.assignee} plain />}
            <span className="wt-row-last">
              {row.parentKey && t('wt.inParent', { key: row.parentKey })}
              {row.parentKey && last && ' · '}
              {last}
            </span>
          </span>
        )}
      </span>
    </button>
  )
}

/** Done folds after a few; every other section shows whole. */
const DONE_SHOWN = 3

/** The list beside a thread: the lane filter, the search, the sections (exported for its DOM test). */
export function ThreadList({
  rows,
  selected,
  onOpen,
  menu,
}: {
  rows: readonly ThreadRow[]
  selected: string | null
  onOpen(key: string): void
  menu: LaneMenuEngine
}) {
  const t = useT()
  const { data } = useBoardContext()
  const [filter, setFilter] = useState<ListFilter>({ lane: null, query: '' })
  const [doneOpen, setDoneOpen] = useState(false)
  const lanes = lanesOf(rows)
  const titleOf = (lane: string) => data?.categories?.find(c => c.id === lane)?.title ?? lane
  const sections = sectionsOf(rows, filter)
  return (
    <nav className="wt-side" aria-label={t('wt.title')}>
      <div className="wt-filter">
        {lanes.length > 1 && (
          <LaneFilter
            lanes={lanes}
            lane={filter.lane}
            titleOf={titleOf}
            menu={menu}
            onPick={lane => setFilter(f => ({ ...f, lane }))}
          />
        )}
        <label className="wt-search">
          <SearchIcon />
          <input
            type="search"
            value={filter.query}
            placeholder={t('wt.search')}
            aria-label={t('wt.search')}
            onChange={e => setFilter({ ...filter, query: e.target.value })}
          />
        </label>
      </div>
      {!sections.length && <p className="hint wt-empty-list">{rows.length ? t('wt.noMatch') : t('wt.empty')}</p>}
      {sections.map(s => {
        const folded = s.id === 'done' && !doneOpen && !filter.query
        const shown = folded ? s.rows.slice(0, DONE_SHOWN) : s.rows
        return (
          <section key={s.id} className={classNames('wt-section', `wt-section-${s.id}`)}>
            <h3>
              {t(`wt.section.${s.id}`)}
              <span className="n">{s.rows.length}</span>
            </h3>
            {shown.map(r => (
              <Row key={r.id} row={r} active={r.key === selected} onOpen={onOpen} />
            ))}
            {s.rows.length > shown.length && (
              <button type="button" className="wt-fold" onClick={() => setDoneOpen(true)}>
                {t('wt.andMore', { n: s.rows.length - shown.length })}
              </button>
            )}
          </section>
        )
      })}
    </nav>
  )
}

/**
 * The push on a narrow panel: `x` is how far the thread is off to the right (0: on show, the
 * body's width: gone). A spring from the value on screen, so a new target reverses it mid-flight.
 */
function usePush(body: React.RefObject<HTMLDivElement | null>, pane: 'list' | 'thread', wide: boolean) {
  const [settled, setSettled] = useState<'list' | 'thread' | 'moving'>(pane)
  const first = useRef(true)
  /** The next pane is simply there: asked while the panel was closed, it opens on it. */
  const skip = useRef(false)
  /** A finger holds the thread: the spring is set to it on every move, which is no rest. */
  const held = useRef(false)
  const width = () => body.current?.clientWidth || 360
  const paint = (x: number) => {
    const el = body.current
    if (!el) return
    el.style.setProperty('--wt-x', `${x}px`)
    el.style.setProperty('--wt-p', String(Math.min(1, Math.max(0, x / width()))))
  }
  const spring = useRef<Spring | null>(null)
  spring.current ??= new Spring({ ...PUSH, onUpdate: paint })
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pane and the width are when to move; the spring reads the rest live
  useLayoutEffect(() => {
    const s = spring.current as Spring
    const target = pane === 'thread' ? 0 : width()
    s.onRest = v => {
      if (!held.current) setSettled(v <= 0.5 ? 'thread' : 'list')
    }
    // The panel arriving (a link opens it on a thread), two columns, or no motion: the screen is
    // simply there (a cross-fade in CSS).
    if (first.current || skip.current || wide || reducedMotion.matches) {
      first.current = false
      skip.current = false
      s.set(target)
      paint(target)
      setSettled(pane)
      return
    }
    setSettled('moving')
    s.to(target)
  }, [pane, wide])
  useEffect(() => () => void spring.current?.stop(), [])
  return {
    spring,
    settled,
    setSettled,
    width,
    paint,
    jump: () => {
      skip.current = true
    },
    hold: (on: boolean) => {
      held.current = on
    },
  }
}

export function ThreadsPanel({ open, onClose, menu }: ThreadsPanelProps) {
  const t = useT()
  const threads = useThreadsContext()
  const { data } = useBoardContext()
  const [selected, setSelected] = useState<string | null>(null)
  const [pane, setPane] = useState<'list' | 'thread'>('list')
  const [wide, setWide] = useState(true)
  const body = useRef<HTMLDivElement | null>(null)
  const push = usePush(body, pane, wide)
  const samples = useRef<PointerSample[]>([])
  const drag = useRef<{ id: number; x0: number } | null>(null)

  // Asked from outside (a chip, a link, `board thread open`): that thread, or the list.
  const asked = threads?.asked
  // Whether the panel was open before this commit: an ask that opens it lands without the push.
  const wasOpen = useRef(open)
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once; push and open are read as they are
  useEffect(() => {
    if (!asked) return
    // Only a pane that changes moves; one asked while the panel was closed is simply there.
    if (!wasOpen.current && pane !== (asked.key ? 'thread' : 'list')) push.jump()
    if (asked.key) {
      setSelected(asked.key)
      setPane('thread')
    } else setPane('list')
  }, [asked])
  useEffect(() => {
    wasOpen.current = open
  }, [open])

  useLayoutEffect(() => {
    const el = body.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= WIDE_PX))
    ro.observe(el)
    setWide(el.clientWidth >= WIDE_PX)
    return () => ro.disconnect()
  }, [])

  const rows = threads?.rows ?? []
  const rev = threads?.rev ?? 0
  // A shared entry's way to the hub moving (#394, `threads.out`) reads the thread again too.
  const { view, gone } = useThreadView(
    open ? selected : null,
    `${data?.threads?.rev ?? rev}:${data?.threads?.out ?? 0}`,
  )
  const openKey = (key: string) => {
    setSelected(key)
    setPane('thread')
  }

  // The finger takes the thread back from its left edge, 1:1, and its speed decides.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (wide || pane !== 'thread' || e.pointerType === 'mouse') return
    const left = e.currentTarget.getBoundingClientRect().left
    if (e.clientX - left > EDGE_PX) return
    e.currentTarget.setPointerCapture(e.pointerId)
    push.spring.current?.stop()
    push.hold(true)
    push.setSettled('moving')
    drag.current = { id: e.pointerId, x0: e.clientX - (push.spring.current?.value ?? 0) }
    samples.current = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }]
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const x = Math.max(0, e.clientX - d.x0)
    push.spring.current?.set(x)
    push.paint(x)
    samples.current = [...samples.current.slice(-8), { x: e.clientX, y: e.clientY, t: e.timeStamp }]
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    // The speed at the release: a finger that rested before it lifted throws nothing.
    const v = velocityOf([...samples.current, { x: e.clientX, y: e.clientY, t: e.timeStamp }]).x
    const s = push.spring.current as Spring
    const back = s.value + project(v) > push.width() / 2
    push.hold(false)
    s.to(back ? push.width() : 0, { velocity: v })
    if (back) setPane('list')
  }

  const needs = data?.threads?.needsOwner ?? 0
  const live = rows.filter(r => r.status !== 'done' && r.status !== 'dropped').length
  return (
    <Panel
      id="threads-sheet"
      kind="threads"
      open={open}
      onClose={onClose}
      measure="full"
      title={
        <>
          <h2>{t('wt.title')}</h2>
          <p className="sheet-meta">{t('wt.meta', { open: live, needs })}</p>
        </>
      }
    >
      <div
        ref={body}
        className="sheet-body wt-body"
        data-pane={pane}
        data-settled={push.settled}
        data-wide={wide ? '' : undefined}
      >
        <ThreadList rows={rows} selected={pane === 'thread' || wide ? selected : null} onOpen={openKey} menu={menu} />
        <div
          className="wt-main"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {selected && view ? (
            <ThreadPane view={view} onOpen={openKey} onBack={() => setPane('list')} />
          ) : (
            <p className="hint wt-pick">
              {gone ? t('wt.gone', { key: selected ?? '' }) : selected ? '' : t('wt.pick')}
            </p>
          )}
        </div>
      </div>
    </Panel>
  )
}
