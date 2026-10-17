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

export const GlobeIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="7" />
    <path d="M3 10h14M10 3c1.9 2.1 2.8 4.4 2.8 7s-.9 4.9-2.8 7c-1.9-2.1-2.8-4.4-2.8-7s.9-4.9 2.8-7Z" />
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

export const ClipIcon = () => (
  <Icon>
    <path d="m15.5 9.5-5.6 5.6a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7L12 6.2" />
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

export const MoonGlyph = () => (
  <Glyph className="moon">
    <path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7Z" />
  </Glyph>
)

export const ClockGlyph = () => (
  <Glyph>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4l2.5 2" />
  </Glyph>
)

export const SpinGlyph = () => (
  <Glyph className="spin">
    <path d="M10 3a7 7 0 1 1-7 7" />
  </Glyph>
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
