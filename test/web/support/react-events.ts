// React's own handlers in a fake DOM (support/fake-dom.ts): a view's element tree (its function
// components called, so they must use no hooks) gives its host elements in document order, the
// order react-dom/server writes them in, so each element of the drawn markup has the props React
// would have given it. A listener on the layer's container then does what React's root listener
// does: an event bubbles along its target's ancestors through their `on…` props, with React's
// mapping of native events (`input` is a field's onChange, a checkbox's is its click, a select's
// its change; focusin and focusout are onFocus and onBlur).
import { Fragment, isValidElement } from 'react'
import { FakeElement, type FakeEvent, type FakeTarget } from './fake-dom.ts'
import type { Element as MElement } from './markup.ts'

export interface Host {
  tag: string
  props: Record<string, unknown>
}

const propsOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {}

/** The host elements of a React tree, in document order. */
export function hostElements(node: unknown): Host[] {
  const out: Host[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child)
      return
    }
    if (!isValidElement(n)) return
    const { type } = n
    const props = propsOf(n.props)
    if (type === Fragment) walk(props.children)
    else if (typeof type === 'function') walk(Reflect.apply(type, undefined, [props]))
    else if (typeof type !== 'string') throw new Error('only host elements, fragments and function components')
    else {
      out.push({ tag: type, props })
      // A textarea's value is its text, not elements.
      if (type !== 'textarea') walk(props.children)
    }
  }
  walk(node)
  return out
}

/** The elements under `root` (itself first), in document order. */
function preorder(root: MElement): MElement[] {
  const out: MElement[] = []
  const walk = (el: MElement) => {
    out.push(el)
    for (const child of el.children) if (child.kind === 'element') walk(child)
  }
  walk(root)
  return out
}

const isCheckbox = (el: FakeElement) => el.node.tag === 'input' && el.getAttribute('type') === 'checkbox'
const isTextField = (el: FakeElement) => (el.node.tag === 'input' && !isCheckbox(el)) || el.node.tag === 'textarea'

/** The props React calls for native `type` on `el`. */
function handlersFor(type: string, el: FakeElement): string[] {
  switch (type) {
    case 'click':
      return isCheckbox(el) ? ['onClick', 'onChange'] : ['onClick']
    case 'dblclick':
      return ['onDoubleClick']
    case 'keydown':
      return ['onKeyDown']
    case 'input':
      return isTextField(el) ? ['onChange'] : []
    case 'change':
      return el.node.tag === 'select' ? ['onChange'] : []
    case 'focusin':
      return ['onFocus']
    case 'focusout':
      return ['onBlur']
    case 'pointerdown':
      return ['onPointerDown']
    case 'submit':
      return ['onSubmit']
    case 'toggle':
      return el.node.tag === 'details' ? ['onToggle'] : []
    default:
      return []
  }
}

const REACT_EVENTS = [
  'click',
  'dblclick',
  'keydown',
  'input',
  'change',
  'focusin',
  'focusout',
  'pointerdown',
  'submit',
  'toggle',
]

/** A synthetic event as React hands it to a handler. */
function synthetic(native: FakeEvent, currentTarget: FakeElement, stop: () => void) {
  return {
    type: native.type,
    nativeEvent: native,
    target: native.target,
    currentTarget,
    key: native.key,
    keyCode: native.keyCode,
    ctrlKey: native.ctrlKey,
    metaKey: native.metaKey,
    shiftKey: native.shiftKey,
    altKey: native.altKey,
    button: native.button,
    pointerType: native.pointerType,
    clientX: native.clientX,
    clientY: native.clientY,
    detail: 1,
    get defaultPrevented() {
      return native.defaultPrevented
    },
    preventDefault: () => native.preventDefault(),
    stopPropagation: () => {
      stop()
      native.stopPropagation()
    },
  }
}

/**
 * React's root listener for the tree drawn at `root()` (`hosts()`: its host elements as last
 * drawn), on `container` (where React listens: a portal's <body>). Returns how to stop.
 */
export function listenLikeReact(
  container: FakeTarget,
  root: () => FakeElement | null,
  hosts: () => Host[],
): () => void {
  const onEvent = (e: FakeEvent) => {
    const top = root()
    if (!top || !(e.target instanceof FakeElement)) return
    const nodes = preorder(top.node)
    const drawn = hosts()
    if (nodes.length !== drawn.length) throw new Error(`drawn ${nodes.length} elements, React has ${drawn.length}`)
    const chain: FakeElement[] = []
    for (let el: FakeElement | null = e.target; el; el = el.parentElement) {
      chain.push(el)
      if (el === top) break
    }
    if (chain.at(-1) !== top) return
    let stopped = false
    for (const el of chain) {
      const host = drawn[nodes.indexOf(el.node)]
      for (const name of handlersFor(e.type, el)) {
        const handler = host?.props[name]
        if (typeof handler === 'function')
          Reflect.apply(handler, undefined, [
            synthetic(e, el, () => {
              stopped = true
            }),
          ])
      }
      if (stopped) break
    }
  }
  for (const type of REACT_EVENTS) container.addEventListener(type, onEvent)
  return () => {
    for (const type of REACT_EVENTS) container.removeEventListener(type, onEvent)
  }
}
