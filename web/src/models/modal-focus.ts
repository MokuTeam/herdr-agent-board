// Shared focus ownership for quick look and launch dialogs. The stack lets a
// dialog temporarily cover another dialog without making its background reachable.

/** What the manager reads of an element: the DOM's, or a stand-in in the tests. */
export interface FocusElement {
  inert?: boolean | undefined
  tabIndex?: number | undefined
  disabled?: boolean | undefined
  isConnected?: boolean | undefined
  closest(selector: string): unknown
  contains(node: unknown): boolean
  getClientRects(): { length: number }
  checkVisibility?(): boolean
  querySelectorAll(selector: string): Iterable<unknown>
  focus(options?: FocusOptions): void
}

/** What the manager's listeners read of a focusin or keydown event. */
export interface FocusPress {
  target: unknown
  key?: string
  shiftKey?: boolean
  preventDefault?(): void
}

export interface FocusDocument {
  readonly body: { readonly children: Iterable<unknown> }
  readonly activeElement: unknown
  addEventListener(type: string, listener: (event: FocusPress) => void, capture: boolean): void
}

export interface FocusScope {
  /** Takes the focus into `win`; `origin` gets it back on close. */
  open(origin?: unknown): void
  close(): void
  isTop(): boolean
}

interface Scope {
  layer: FocusElement
  win: FocusElement
  origin: unknown
}

const isElement = (node: unknown): node is FocusElement =>
  typeof node === 'object' &&
  node !== null &&
  'closest' in node &&
  typeof node.closest === 'function' &&
  'focus' in node &&
  typeof node.focus === 'function'

export function modalFocusManager(doc: FocusDocument): (layer: FocusElement, win: FocusElement) => FocusScope {
  const stack: Scope[] = []
  const saved = new Map<FocusElement, boolean | undefined>()
  const top = (): Scope | undefined => stack.at(-1)
  const auxiliary = (node: unknown) =>
    typeof node === 'object' &&
    node !== null &&
    'closest' in node &&
    typeof node.closest === 'function' &&
    !!node.closest('.menu, .rename, .toasts')
  const visible = (el: FocusElement) => !!el.getClientRects().length && (el.checkVisibility?.() ?? true)
  const controls = (scope: Scope): FocusElement[] =>
    [...scope.win.querySelectorAll('button, input, textarea, select, a[href], [tabindex], summary')]
      .filter(isElement)
      .filter(el => !el.disabled && (el.tabIndex ?? -1) >= 0 && !el.closest('[hidden], [inert]') && visible(el))
  function sync(): void {
    for (const [el, inert] of saved) el.inert = inert
    saved.clear()
    const scope = top()
    if (!scope) return
    for (const el of doc.body.children) {
      if (el === scope.layer || auxiliary(el) || !isElement(el)) continue
      saved.set(el, el.inert)
      el.inert = true
    }
  }
  const focusFirst = (scope: Scope) => (controls(scope)[0] ?? scope.win).focus({ preventScroll: true })
  doc.addEventListener(
    'focusin',
    e => {
      const scope = top()
      if (scope && !scope.layer.contains(e.target) && !auxiliary(e.target)) focusFirst(scope)
    },
    true,
  )
  doc.addEventListener(
    'keydown',
    e => {
      const scope = top()
      if (!scope || e.key !== 'Tab' || auxiliary(e.target)) return
      const all = controls(scope)
      const active = doc.activeElement
      const at = isElement(active) ? all.indexOf(active) : -1
      if (!all.length || (e.shiftKey ? at <= 0 : at < 0 || at === all.length - 1)) {
        e.preventDefault?.()
        ;(e.shiftKey ? all.at(-1) : all[0])?.focus({ preventScroll: true })
        if (!all.length) scope.win.focus({ preventScroll: true })
      }
    },
    true,
  )
  return (layer, win) => {
    const scope: Scope = { layer, win, origin: null }
    return {
      open(origin = doc.activeElement) {
        if (!stack.includes(scope)) {
          scope.origin = origin
          stack.push(scope)
        }
        sync()
        win.focus({ preventScroll: true })
      },
      close() {
        const index = stack.indexOf(scope)
        if (index < 0) return
        const wasTop = top() === scope
        stack.splice(index, 1)
        sync()
        if (!wasTop) return
        const origin = scope.origin
        const next = top()
        if (isElement(origin) && origin.isConnected && !origin.closest('[inert], [hidden]') && visible(origin))
          origin.focus({ preventScroll: true })
        else if (next) focusFirst(next)
      },
      isTop: () => top() === scope,
    }
  }
}

let manager: ((layer: FocusElement, win: FocusElement) => FocusScope) | undefined
/** A dialog's scope in the one stack of this document (every dialog of the page shares it). */
export function modalFocus(layer: FocusElement, win: FocusElement): FocusScope {
  manager ??= modalFocusManager(document)
  return manager(layer, win)
}
