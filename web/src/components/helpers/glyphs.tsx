// The helpers' icons (the old page's helpers.js HELPER_ICONS, hidden from screen readers) and the
// links' between sessions (app.js ICON: from, spawned, out, peer, not hidden, as the cards' are).
import type { ReactNode } from 'react'

function HelperSvg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      {children}
    </svg>
  )
}

export type HelperIconName =
  | 'agent'
  | 'fork'
  | 'workflow'
  | 'teammate'
  | 'stack'
  | 'back'
  | 'close'
  | 'check'
  | 'cross'
  | 'stop'
  | 'idle'
  | 'spin'

const PATHS: Record<Exclude<HelperIconName, 'spin'>, ReactNode> = {
  agent: (
    <>
      <circle cx="10" cy="6.8" r="3" />
      <path d="M4.5 16.5a5.5 5.5 0 0 1 11 0" />
    </>
  ),
  fork: (
    <>
      <path d="M10 17v-5.5L5.2 6.7M10 11.5l4.8-4.8" />
      <path d="M4.2 3.5h3.3v3.3M15.8 3.5h-3.3v3.3" />
    </>
  ),
  workflow: (
    <>
      <rect x="3" y="3.5" width="5.5" height="5.5" rx="1.4" />
      <rect x="11.5" y="11" width="5.5" height="5.5" rx="1.4" />
      <path d="M8.5 6.2h3.2a1.8 1.8 0 0 1 1.8 1.8v3" />
    </>
  ),
  teammate: (
    <>
      <circle cx="7.5" cy="7.2" r="2.6" />
      <path d="M2.8 16a4.7 4.7 0 0 1 9.4 0" />
      <path d="M12.4 4.9a2.6 2.6 0 1 1 .9 4.9M14.2 11.6A4.7 4.7 0 0 1 17.2 16" />
    </>
  ),
  stack: (
    <>
      <rect x="3" y="7" width="9.5" height="9.5" rx="2.2" />
      <path d="M7 4.5h7a2.5 2.5 0 0 1 2.5 2.5v7" />
    </>
  ),
  back: <path d="m12 4.5-5.5 5.5 5.5 5.5" />,
  close: <path d="m5.5 5.5 9 9m0-9-9 9" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  cross: <path d="m6 6 8 8M14 6l-8 8" />,
  stop: <rect x="6" y="6" width="8" height="8" rx="1.5" />,
  idle: <path d="M6 10h.01M10 10h.01M14 10h.01" strokeWidth="2.6" />,
}

const isKnown = (name: string): name is HelperIconName => name === 'spin' || name in PATHS

/** One of the helpers' icons by name; an unknown kind draws the subagent's. */
export function HelperIcon({ name }: { name: string }) {
  const known = isKnown(name) ? name : 'agent'
  if (known === 'spin')
    return (
      <HelperSvg className="spin">
        <path d="M10 3a7 7 0 1 1-7 7" />
      </HelperSvg>
    )
  return <HelperSvg>{PATHS[known]}</HelperSvg>
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the page's markup as it was; the line's text or the button's title names it
    <svg viewBox="0 0 20 20">{children}</svg>
  )
}

// Sessions working together: who started it, whom it started, a message out and in.
export const FromGlyph = () => (
  <Glyph>
    <path d="M8 4.5 4.5 8 8 11.5" />
    <path d="M4.5 8H12a3.5 3.5 0 0 1 3.5 3.5v4" />
  </Glyph>
)

export const SpawnedGlyph = () => (
  <Glyph>
    <path d="M4.5 4v5.5A3.5 3.5 0 0 0 8 13h7.5" />
    <path d="M12 9.5 15.5 13 12 16.5" />
  </Glyph>
)

export const OutGlyph = () => (
  <Glyph>
    <path d="M3.5 10.5 16.5 4l-4 12.5-2.6-5.3Z" />
    <path d="m9.9 11.2 2.6-2.6" />
  </Glyph>
)

export const PeerGlyph = () => (
  <Glyph>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9.2L6 16v-3h-.5A1.5 1.5 0 0 1 4 11.5Z" />
  </Glyph>
)
