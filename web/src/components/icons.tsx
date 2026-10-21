// The board's line icons (20 × 20, stroked by the stylesheet).
import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {children}
    </svg>
  )
}

export const SearchIcon = () => (
  <Icon>
    <circle cx="8.5" cy="8.5" r="5.5" />
    <path d="m13 13 4 4" />
  </Icon>
)

export const MoonIcon = () => (
  <Icon>
    <path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7Z" />
  </Icon>
)

export const TagIcon = () => (
  <Icon>
    <path d="M3.5 4.5h6l7 7-5 5-7-7Z" />
    <circle cx="7" cy="8" r="1.1" />
  </Icon>
)

export const AlarmIcon = () => (
  <Icon>
    <circle cx="10" cy="11" r="6" />
    <path d="M10 8v3.2l2 1.3M3.6 5.4 6 3.3M16.4 5.4 14 3.3" />
  </Icon>
)

export const GearIcon = () => (
  <Icon>
    <path d="M8.6 2.8h2.8l.5 2.1 1.4.8 2.1-.6 1.4 2.4-1.5 1.6v1.8l1.5 1.6-1.4 2.4-2.1-.6-1.4.8-.5 2.1H8.6l-.5-2.1-1.4-.8-2.1.6-1.4-2.4 1.5-1.6V9.1L3.2 7.5l1.4-2.4 2.1.6 1.4-.8Z" />
    <circle cx="10" cy="10" r="2.4" />
  </Icon>
)

export const PhoneIcon = () => (
  <Icon>
    <path d="M6.6 3.5H4.8A1.8 1.8 0 0 0 3 5.4c.3 6 5.6 11.3 11.6 11.6a1.8 1.8 0 0 0 1.9-1.8v-1.8a1 1 0 0 0-.8-1l-2.6-.6a1 1 0 0 0-1 .3l-1 1.2a10 10 0 0 1-4.8-4.8l1.2-1a1 1 0 0 0 .3-1l-.6-2.6a1 1 0 0 0-1-.8Z" />
  </Icon>
)

export const ArrowIcon = () => (
  <Icon>
    <path d="M4 10h11.5m-4.5-4.5 4.5 4.5-4.5 4.5" />
  </Icon>
)

// The session sheet's buttons.

export const FocusIcon = () => (
  <Icon>
    <path d="M7 4.5h8.5V13M15 5 5 15" />
  </Icon>
)

/** The sheet's Restart: two arrows going round. */
export const RestartIcon = () => (
  <Icon>
    <path d="M4.6 8.6a5.6 5.6 0 0 1 10.3-1.4M15.4 11.4a5.6 5.6 0 0 1-10.3 1.4" />
    <path d="M15.4 3.7v3.6h-3.6M4.6 16.3v-3.6h3.6" />
  </Icon>
)

export const SunIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="3.5" />
    <path d="M10 2.5v2m0 11v2m7.5-7.5h-2m-11 0h-2m12.8-5.3-1.4 1.4M6.1 13.9l-1.4 1.4m0-10.6 1.4 1.4m7.8 7.8 1.4 1.4" />
  </Icon>
)

export const BranchIcon = () => (
  <Icon>
    <circle cx="6" cy="4.8" r="1.8" />
    <circle cx="6" cy="15.2" r="1.8" />
    <circle cx="14" cy="7.6" r="1.8" />
    <path d="M6 6.6v6.8M14 9.4c0 3-2.6 3.6-6.4 4.6" />
  </Icon>
)

export const HistoryIcon = () => (
  <Icon>
    <path d="M3.6 10a6.4 6.4 0 1 0 1.9-4.5M3.5 3.5v3h3" />
    <path d="M10 6.5V10l2.4 1.6" />
  </Icon>
)

/** The archive: a box with its lid (the toolbar's button, the sheet's). */
export const ArchiveIcon = () => (
  <Icon>
    <rect x="3" y="4" width="14" height="4" rx="1.3" />
    <path d="M4.5 8v6.2A1.8 1.8 0 0 0 6.3 16h7.4a1.8 1.8 0 0 0 1.8-1.8V8M8.3 11h3.4" />
  </Icon>
)

/** The session panel's More: three dots. */
export const MoreIcon = () => (
  <Icon>
    <circle cx="4.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
)

export const ClipIcon = () => (
  <Icon>
    <path d="m15.5 9.5-5.6 5.6a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7L12 6.2" />
  </Icon>
)

/** A photo: pick a picture. */
export const PhotoIcon = () => (
  <Icon>
    <rect x="3.5" y="4.5" width="13" height="11" rx="2" />
    <circle cx="8" cy="8.5" r="1.3" />
    <path d="m4 14 4-4 3 3 2-2 3 3" />
  </Icon>
)

/** A clipboard with a picture on it: paste a picture. */
export const PastePictureIcon = () => (
  <Icon>
    <path d="M7.2 4.5H6A1.5 1.5 0 0 0 4.5 6v10A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 14 4.5h-1.2" />
    <rect x="7.2" y="3" width="5.6" height="3" rx="1" />
    <path d="m7 14.5 2.4-2.7 1.7 1.8 1.1-1.1 1.8 2" />
  </Icon>
)

export const CrossIcon = () => (
  <Icon>
    <path d="m6.5 6.5 7 7m0-7-7 7" />
  </Icon>
)

export const SendIcon = () => (
  <Icon>
    <path d="M10 16V4m-5 5 5-5 5 5" />
  </Icon>
)

/** The categories panel's "New category". */
export const NewIcon = () => (
  <Icon>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
)

/** A menu item's check. */
export const CheckIcon = () => (
  <Icon>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Icon>
)

/** A menu item that opens a submenu; a folder that opens a next column. */
export const ChevIcon = () => (
  <Icon>
    <path d="m8 5 5 5-5 5" />
  </Icon>
)

/** A folded toolbar control's pill (SegmentPick.tsx): its choices open in a menu under it. */
export const DownIcon = () => (
  <Icon>
    <path d="m6 8 4 4 4-4" />
  </Icon>
)

// The new-session window's and the cards of sessions on their way.

export const FolderIcon = () => (
  <Icon>
    <path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.7 1.8H16A1.5 1.5 0 0 1 17.5 7.8v7.7A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z" />
  </Icon>
)

export const DriveIcon = () => (
  <Icon>
    <rect x="3" y="6" width="14" height="8" rx="2" />
    <path d="M13.5 10h.01" />
  </Icon>
)

export const HomeIcon = () => (
  <Icon>
    <path d="M3.5 9.5 10 4l6.5 5.5M5.5 8v8h9V8" />
  </Icon>
)

/** The folder is there. */
export const OkIcon = () => (
  <Icon>
    <path d="m5 10.5 3.2 3.2L15 7" />
  </Icon>
)

/** The folder is not there, or not a folder. */
export const BadIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6.5v4.2M10 13.4h.01" />
  </Icon>
)

/** Being checked, or starting. */
export const WaitIcon = () => (
  <Icon>
    <path className="spin-path" d="M10 3a7 7 0 1 1-7 7" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon>
    <path d="m5.5 5.5 9 9m0-9-9 9" />
  </Icon>
)

export const WarnIcon = () => (
  <Icon>
    <path d="M10 3.5 17.5 16h-15Z" />
    <path d="M10 8.5v3.2M10 13.8h.01" />
  </Icon>
)

/**
 * The icons the old page drew from its ICON strings (the "new session" plus, the cards' icons):
 * unlike the toolbar's they are not hidden from screen readers, as before.
 */
function Glyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the page's markup as it was; the button's title or the card's text names it
    <svg className={className} viewBox="0 0 20 20">
      {children}
    </svg>
  )
}

export const PlusIcon = () => (
  <Glyph>
    <path d="M10 4.5v11M4.5 10h11" />
  </Glyph>
)

export const FocusGlyph = () => (
  <Glyph>
    <path d="M7 4.5h8.5V13M15 5 5 15" />
  </Glyph>
)

export const WriteGlyph = () => (
  <Glyph>
    <path d="M12.5 4.5l3 3L8 15H5v-3l7.5-7.5Z" />
  </Glyph>
)

export const ChevronGlyph = () => (
  <Glyph className="chevron">
    <path d="m6 8 4 4 4-4" />
  </Glyph>
)

export const MoonGlyph = () => (
  <Glyph className="moon">
    <path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7Z" />
  </Glyph>
)

export const StarGlyph = () => (
  <Glyph className="star">
    <path d="M10 3.4l1.76 4.77 5.09.21-4 3.15 1.38 4.89L10 13.6l-4.23 2.82 1.38-4.89-4-3.15 5.09-.21Z" />
  </Glyph>
)

export const ClockGlyph = () => (
  <Glyph>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4l2.5 2" />
  </Glyph>
)

/**
 * A glyph that turns, in a box that does the turning (web/styles/motion.css): Chromium animates an
 * SVG element on the main thread, the page styled and committed again on every frame, where an HTML
 * box turns on the compositor (#109). `spinning`: all the time; else while the sheet says so.
 */
export function Turn({ spinning, children }: { spinning?: boolean; children: ReactNode }) {
  return <span className={spinning ? 'turn spinning' : 'turn'}>{children}</span>
}

export const SpinGlyph = () => (
  <Turn spinning>
    <Glyph className="spin">
      <path d="M10 3a7 7 0 1 1-7 7" />
    </Glyph>
  </Turn>
)

export const CheckGlyph = () => (
  <Glyph>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Glyph>
)

export const CrossGlyph = () => (
  <Glyph>
    <path d="m6 6 8 8M14 6l-8 8" />
  </Glyph>
)

export const StopGlyph = () => (
  <Glyph>
    <rect x="6" y="6" width="8" height="8" rx="1.5" />
  </Glyph>
)

export const PinGlyph = () => (
  <Glyph>
    <circle cx="10" cy="7" r="3.5" />
    <path d="M10 10.5V17" />
  </Glyph>
)

export const AlarmGlyph = () => (
  <Glyph>
    <circle cx="10" cy="11" r="6" />
    <path d="M10 8v3.2l2 1.3M3.6 5.4 6 3.3M16.4 5.4 14 3.3" />
  </Glyph>
)

export const RepeatGlyph = () => (
  <Glyph>
    <path d="M4 9.5V8a3 3 0 0 1 3-3h8.5m-2.5-2.5L15.5 5 13 7.5M16 10.5V12a3 3 0 0 1-3 3H4.5M7 12.5 4.5 15 7 17.5" />
  </Glyph>
)

export const ChevGlyph = () => (
  <Glyph className="chev">
    <path d="m8 5 5 5-5 5" />
  </Glyph>
)

/** A pop-up button's mark: its choices open in a menu. */
export const UpDownGlyph = () => (
  <Glyph className="updown">
    <path d="m6.5 8 3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5" />
  </Glyph>
)

export const TrashGlyph = () => (
  <Glyph>
    <path d="M4.5 6h11M8 6V4.5h4V6m-6 0 .7 9.5h6.6L14 6" />
  </Glyph>
)

export const BoltGlyph = () => (
  <Glyph>
    <path d="M11 2.5 4.5 11H10l-1 6.5L15.5 9H10Z" />
  </Glyph>
)

export const PhoneGlyph = () => (
  <Glyph>
    <path d="M6.6 3.5H4.8A1.8 1.8 0 0 0 3 5.4c.3 6 5.6 11.3 11.6 11.6a1.8 1.8 0 0 0 1.9-1.8v-1.8a1 1 0 0 0-.8-1l-2.6-.6a1 1 0 0 0-1 .3l-1 1.2a10 10 0 0 1-4.8-4.8l1.2-1a1 1 0 0 0 .3-1l-.6-2.6a1 1 0 0 0-1-.8Z" />
  </Glyph>
)

/** A restart on its way (a card's line, the sheet's and the schedule's rows). */
export const RestartGlyph = () => (
  <Glyph>
    <path d="M4.6 8.6a5.6 5.6 0 0 1 10.3-1.4M15.4 11.4a5.6 5.6 0 0 1-10.3 1.4" />
    <path d="M15.4 3.7v3.6h-3.6M4.6 16.3v-3.6h3.6" />
  </Glyph>
)

/** The archive, in its panel (empty). */
export const ArchiveGlyph = () => (
  <Glyph>
    <rect x="3" y="4" width="14" height="4" rx="1.3" />
    <path d="M4.5 8v6.2A1.8 1.8 0 0 0 6.3 16h7.4a1.8 1.8 0 0 0 1.8-1.8V8M8.3 11h3.4" />
  </Glyph>
)

/** Return from the archive: an arrow back. */
export const BackGlyph = () => (
  <Glyph>
    <path d="M8 5.5 4.5 9 8 12.5" />
    <path d="M4.5 9h7.5a3.5 3.5 0 0 1 0 7H10" />
  </Glyph>
)

export const HourglassGlyph = () => (
  <Glyph>
    <path d="M6 3h8M6 17h8M7 3v2.6c0 1.2.6 2.1 1.6 2.8L10 9.4l1.4-1c1-.7 1.6-1.6 1.6-2.8V3M7 17v-2.6c0-1.2.6-2.1 1.6-2.8l1.4-1 1.4 1c1 .7 1.6 1.6 1.6 2.8V17" />
  </Glyph>
)

// The categories editor's.

/** A row's handle: six dots. */
export const GripGlyph = () => (
  <Glyph>
    <path d="M7.5 5h0M12.5 5h0M7.5 10h0M12.5 10h0M7.5 15h0M12.5 15h0" strokeWidth="2.6" />
  </Glyph>
)

export const CloseGlyph = () => (
  <Glyph>
    <path d="m5.5 5.5 9 9m0-9-9 9" />
  </Glyph>
)

/** A file in the message box that is not a picture. */
export const FileGlyph = () => (
  <Glyph>
    <path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5Z" />
    <path d="M11.5 2.5V6H15" />
  </Glyph>
)

export const ForkIcon = () => (
  <Icon>
    <circle cx="6" cy="4.5" r="1.8" />
    <circle cx="14" cy="4.5" r="1.8" />
    <circle cx="10" cy="15.5" r="1.8" />
    <path d="M6 6.3v.9a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3v-.9M10 10.2v3.5" />
  </Icon>
)
