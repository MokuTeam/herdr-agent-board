// The side-panel shell the session sheet, the categories and the schedule share: an aside with a
// grip, the head and the panel's content, and the edges that resize it. Where it sits, how it
// moves and the one-open-at-a-time rule are the shared place's (components/panel/place.ts and
// motion.ts); `open` asks for it, `onClose` hears when it closed itself or gave way to another.
import type { ReactNode, Ref } from 'react'
import { usePanel } from '../../hooks/usePanel.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { Edge } from '../../models/panel-layout.ts'
import { EDGES, edgeChrome, type PanelChrome } from '../../models/panel-motion.ts'
import { PanelHead } from './PanelHead.tsx'

export type PanelKind = 'session' | 'categories' | 'schedule'

/** Each panel's name for screen readers, and the session sheet's close button id. */
const KINDS: Record<PanelKind, { label: string; closeId?: string }> = {
  session: { label: 'sheet.label', closeId: 'sheet-close' },
  categories: { label: 'cats.title' },
  schedule: { label: 'sched.title' },
}

interface ShellProps {
  id: string
  kind: PanelKind
  /** What goes in the head's `.sheet-title`. */
  title: ReactNode
  /** Buttons of the panel's own in the head, before the place button. */
  tools?: ReactNode
  children?: ReactNode
}

export interface PanelProps extends ShellProps {
  open: boolean
  onClose(): void
  /** The element the panel is about (the session's card): kept in its place on screen while the board makes room. */
  about?: () => Element | null
}

export function Panel({ open, onClose, about, ...shell }: PanelProps) {
  const panel = usePanel({ open, onClose, about })
  return (
    <PanelView
      {...shell}
      shown={panel.shown}
      chrome={panel.chrome}
      menuOpen={panel.menuOpen}
      asideRef={panel.ref}
      onPlace={panel.togglePlaceMenu}
      onClose={panel.close}
    />
  )
}

export interface PanelViewProps extends ShellProps {
  /** In the page: from opening until it has left. */
  shown: boolean
  chrome: PanelChrome
  menuOpen: boolean
  asideRef?: Ref<HTMLElement>
  onPlace?: (button: HTMLElement) => void
  onClose?: () => void
}

/** The panel as drawn for a state of its motion. */
export function PanelView(props: PanelViewProps) {
  const { id, kind, title, tools, children, shown, chrome, menuOpen, asideRef, onPlace, onClose } = props
  const t = useT()
  const { label, closeId } = KINDS[kind]
  return (
    <aside
      className={shown ? 'sheet open' : 'sheet'}
      id={id}
      aria-hidden={!shown}
      aria-label={t(label)}
      data-dock={chrome.mode}
      ref={asideRef}
    >
      <div className="sheet-grip" aria-hidden="true" />
      <div className="sheet-inner">
        <PanelHead
          title={title}
          tools={tools}
          glyph={chrome.glyph}
          menuOpen={menuOpen}
          closeId={closeId}
          onPlace={onPlace}
          onClose={onClose}
        />
        {children}
      </div>
      {EDGES.map(edge => (
        <PanelEdge key={edge} edge={edge} chrome={chrome} />
      ))}
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
