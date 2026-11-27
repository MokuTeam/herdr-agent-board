// The side-panel shell the session sheet, the categories, the schedule, the archive and the profiles share: an
// aside with a grip, the head and the panel's content, and the edges that resize it. Where it sits,
// how it moves and which panels can share the screen are the shared place's (components/panel/place.ts
// and motion.ts); `open` asks for it, `onClose` hears when it closed itself or gave way to another.
import { type ReactNode, type Ref, useLayoutEffect } from 'react'
import { useCardWindow } from '../../hooks/useCardWindow.ts'
import type { DropHandlers } from '../../hooks/useFileDrop.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useModalFocus } from '../../hooks/useModalFocus.ts'
import { usePanel } from '../../hooks/usePanel.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { CardWindowKind } from '../../models/card-window.ts'
import type { Edge } from '../../models/panel-layout.ts'
import { EDGES, edgeChrome, type PanelChrome } from '../../models/panel-motion.ts'
import { classNames } from '../class-names.ts'
import { CardWindowSwitch } from './CardWindowSwitch.tsx'
import { type PanelBack, PanelHead } from './PanelHead.tsx'

export type { PanelBack }

export type PanelKind =
  | 'session'
  | 'categories'
  | 'schedule'
  | 'archive'
  | 'profiles'
  | 'wake'
  | 'phones'
  | 'mokupilot'
  | 'access'
  | 'todos'
  | 'threads'
  | 'decisions'
  | 'backup'
  | 'updates'
  | 'housekeeping'
  | 'time'
  | 'spend'
  | 'timeSettings'
  | 'calendar'
  | 'calendarSettings'
  | 'paths'
  | 'team'
  | 'devices'
  | 'settings'

/** Each panel's name for screen readers, and the session sheet's close button id. */
const KINDS: Record<PanelKind, { label: string; closeId?: string }> = {
  session: { label: 'sheet.label', closeId: 'sheet-close' },
  categories: { label: 'cats.title' },
  schedule: { label: 'sched.title' },
  archive: { label: 'archive.title' },
  profiles: { label: 'prof.title' },
  wake: { label: 'wake.title' },
  phones: { label: 'phones.title' },
  mokupilot: { label: 'mokupilot.title' },
  access: { label: 'access.title' },
  todos: { label: 'todo.title' },
  threads: { label: 'wt.title' },
  decisions: { label: 'dec.title' },
  backup: { label: 'backup.title' },
  updates: { label: 'selfUpdate.title' },
  housekeeping: { label: 'hk.title' },
  time: { label: 'time.title' },
  spend: { label: 'spend.title' },
  timeSettings: { label: 'time.set.title' },
  calendar: { label: 'cal.title' },
  calendarSettings: { label: 'cal.set.title' },
  paths: { label: 'paths.title' },
  team: { label: 'team.title' },
  devices: { label: 'node.dev.title' },
  settings: { label: 'set.title' },
}

interface ShellProps {
  id: string
  kind: PanelKind
  /** Back control left of the title (#679). */
  back?: PanelBack | undefined
  /** What goes in the head's `.sheet-title`. */
  title: ReactNode
  /** Buttons of the panel's own in the head, before the place button. */
  tools?: ReactNode
  /** A class of the panel's own on the aside (the session sheet's `dropping`). */
  className?: string | undefined
  /** Files dragged onto the panel (the session sheet takes them anywhere on it). */
  drop?: DropHandlers | undefined
  /**
   * How wide its content runs in a wide panel (#339, styles/panels.css): `reading` (the default)
   * keeps lists and forms to one column of reading width, centred, the title over it; `full` takes
   * the panel's width (the calendar's grid). The session sheet lays itself out (session-head.css).
   */
  measure?: 'reading' | 'full'
  children?: ReactNode
}

export interface PanelProps extends ShellProps {
  open: boolean
  cardWindow?: CardWindowKind
  onClose(): void
  /** The element the panel is about (the session's card): kept in its place on screen while the board makes room. */
  about?: () => Element | null
}

export function Panel({ open, onClose, about, cardWindow, ...shell }: PanelProps) {
  const t = useT()
  const choice = useCardWindow(cardWindow)
  const modal = choice?.view === 'modal'
  const panel = usePanel({ open, modal, chat: shell.kind === 'session', onClose, about })
  const { ref, shown } = panel
  const focus = useModalFocus(ref)
  const origin = useLatest(about)
  useLayoutEffect(() => {
    if (!open || !modal || !shown) return
    const active = document.activeElement
    focus.open(ref.current?.contains(active) ? active : (origin.current?.() ?? active))
    return () => focus.close()
  }, [focus, open, modal, shown, origin, ref])

  return (
    <>
      {modal && open && (
        <button
          type="button"
          className="card-window-scrim"
          tabIndex={-1}
          aria-label={t('sheet.closeLabel')}
          onClick={panel.close}
        />
      )}
      <PanelView
        {...shell}
        tools={
          <>
            {shell.tools}
            {(open || panel.shown) && choice?.toggle && (
              <CardWindowSwitch view={choice.view} onToggle={choice.toggle} />
            )}
          </>
        }
        modal={modal}
        shown={panel.shown && (!modal || open)}
        chrome={panel.chrome}
        over={panel.over}
        menuOpen={panel.menuOpen}
        asideRef={panel.ref}
        onPlace={modal ? undefined : panel.togglePlaceMenu}
        onClose={panel.close}
      />
    </>
  )
}

export interface PanelViewProps extends ShellProps {
  /** In the page: from opening until it has left. */
  shown: boolean
  modal?: boolean
  chrome: PanelChrome
  /** Docked at a side, it lies over the board: a deeper shadow, a drawer over the cards. */
  over?: boolean
  menuOpen: boolean
  asideRef?: Ref<HTMLElement>
  onPlace?: ((button: HTMLElement) => void) | undefined
  onClose?: () => void
}

/** The panel as drawn for a state of its motion. */
export function PanelView(props: PanelViewProps) {
  const {
    id,
    kind,
    back,
    title,
    tools,
    className,
    drop,
    measure = 'reading',
    children,
    shown,
    modal = false,
    chrome,
    over = false,
    menuOpen,
    asideRef,
    onPlace,
    onClose,
  } = props
  const t = useT()
  const { label, closeId } = KINDS[kind]
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the modal branch has role=dialog and the side panel has no aria-modal.
    <aside
      className={classNames('sheet', shown && 'open', over && 'over', className)}
      id={id}
      aria-hidden={!shown}
      aria-label={t(label)}
      role={modal ? 'dialog' : undefined}
      aria-modal={modal || undefined}
      tabIndex={modal ? -1 : undefined}
      data-dock={modal ? 'modal' : chrome.mode}
      data-measure={measure === 'full' ? 'full' : undefined}
      ref={asideRef}
      {...drop}
    >
      <div className="sheet-grip" aria-hidden="true" />
      <div className="sheet-inner">
        <PanelHead
          back={back}
          title={title}
          tools={tools}
          glyph={chrome.glyph}
          menuOpen={menuOpen}
          hidePlace={modal}
          closeId={kind === 'session' && id !== 'sheet' ? 'sidebar-sheet-close' : closeId}
          onPlace={onPlace}
          onClose={onClose}
        />
        {children}
      </div>
      {!modal && EDGES.map(edge => <PanelEdge key={edge} edge={edge} chrome={chrome} />)}
    </aside>
  )
}

/** An edge that resizes: the one towards the board when docked, all of them when floating (the stylesheet shows which). */
function PanelEdge({ edge, chrome }: { edge: Edge; chrome: PanelChrome }) {
  const t = useT()
  const { on, separator } = edgeChrome(edge, chrome)
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a floating panel's corner is named without being a separator, as before
    <div
      className="sheet-edge"
      data-edge={edge}
      title={t('panel.resize')}
      tabIndex={on ? 0 : undefined}
      aria-label={on ? t('panel.resizeLabel') : undefined}
      role={separator ? 'separator' : undefined}
      aria-orientation={separator?.orientation}
      aria-valuemin={separator?.min}
      aria-valuemax={separator?.max}
      aria-valuenow={separator?.now}
      aria-hidden={!on}
    />
  )
}
