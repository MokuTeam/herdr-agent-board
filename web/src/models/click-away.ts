// Classify the press before a click handler can replace its DOM subtree.

/** What the classification reads of a pointer event (a DOM event, or a stand-in in the tests). */
export interface PressEvent {
  button?: number
  clientX: number
  clientY: number
  target: unknown
  composedPath?: () => unknown[]
}

export interface Press {
  x: number
  y: number
  /** The press was inside the kept area. */
  kept: boolean
  /** It only put a menu away. */
  menu: boolean
}

type Matcher = { matches: (selector: string) => unknown }
type Closer = { closest: (selector: string) => unknown }

function isMatcher(node: unknown): node is Matcher {
  return typeof node === 'object' && node !== null && 'matches' in node && typeof node.matches === 'function'
}

function isCloser(node: unknown): node is Closer {
  return typeof node === 'object' && node !== null && 'closest' in node && typeof node.closest === 'function'
}

export function eventWithin(event: Pick<PressEvent, 'target' | 'composedPath'>, selector: string): boolean {
  return (
    !!event.composedPath?.().some(node => isMatcher(node) && node.matches(selector)) ||
    (isCloser(event.target) && !!event.target.closest(selector))
  )
}

export function panelPress(event: PressEvent, selector: string, menu = false): Press | null {
  return event.button === 0 ? { x: event.clientX, y: event.clientY, kept: eventWithin(event, selector), menu } : null
}

export function outsidePanelPress(down: Press | null, click: PressEvent, selector: string): boolean {
  return (
    !!down &&
    !down.menu &&
    !down.kept &&
    Math.hypot(click.clientX - down.x, click.clientY - down.y) <= 6 &&
    !eventWithin(click, selector)
  )
}
