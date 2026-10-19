// React's part in a fake DOM (support/fake-dom.ts): rendered markup becomes the live elements,
// and each new render writes only what changed into them, as React's commit would — so what code
// wrote into those elements itself (inline styles of springs) stays, as it does in the browser.
import type { FakeElement, FakeWorld } from './fake-dom.ts'
import type { Element, Node } from './markup.ts'

/** A deep copy of rendered markup, to be the live DOM. */
export function clone<T extends Node>(node: T): T {
  if (node.kind === 'text') return { ...node }
  return { ...node, attrs: new Map(node.attrs), children: node.children.map(clone) }
}

/** What React would write to `live` going from rendering `prev` to rendering `next`. */
export function commit(world: FakeWorld, live: Element, prev: Element, next: Element): void {
  for (const name of new Set([...prev.attrs.keys(), ...next.attrs.keys()])) {
    const value = next.attrs.get(name)
    if (prev.attrs.get(name) === value) continue
    if (value === undefined) live.attrs.delete(name)
    else live.attrs.set(name, value)
  }
  const same =
    prev.children.length === next.children.length &&
    prev.children.every((c, i) => {
      const n = next.children[i]
      return c.kind === n?.kind && (c.kind === 'text' || (n.kind === 'element' && c.tag === n.tag))
    })
  if (!same) {
    live.children = next.children.map(clone)
    world.index(live)
    return
  }
  next.children.forEach((n, i) => {
    const p = prev.children[i]
    const l = live.children[i]
    if (n.kind === 'text') {
      if (p?.kind === 'text' && p.text !== n.text) live.children[i] = { ...n }
    } else if (p?.kind === 'element' && l?.kind === 'element') commit(world, l, p, n)
  })
}

/** A fake element as the DOM element the code under test takes (the world must be installed). */
export const asDom = (el: FakeElement): HTMLElement => {
  if (el instanceof HTMLElement) return el
  throw new Error('the world is not installed')
}

/** The first element of rendered markup. */
export function first(nodes: Node[]): Element {
  const el = nodes.find((n): n is Element => n.kind === 'element')
  if (!el) throw new Error('nothing rendered')
  return el
}
