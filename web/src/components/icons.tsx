// The toolbar's line icons (20 × 20, stroked by the stylesheet).
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

/** The "new session" plus; unlike the others it is not hidden from screen readers (as before). */
export const PlusIcon = () => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: the page's markup as it was; the button's text names it
  <svg viewBox="0 0 20 20">
    <path d="M10 4.5v11M4.5 10h11" />
  </svg>
)
