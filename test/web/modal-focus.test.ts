import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { scopeOfElements } from '../../web/src/hooks/useModalFocus.ts'
import { type FocusPress, modalFocusManager } from '../../web/src/models/modal-focus.ts'

interface FakeNode {
  id: string
  parent: FakeNode | null
  tabIndex: number
  disabled: boolean
  hidden: boolean
  inert: boolean
  isConnected: boolean
  children: FakeNode[]
  contains(child: unknown): boolean
  closest(selector: string): FakeNode | null
  getClientRects(): object[]
  querySelectorAll(): FakeNode[]
  focus(): void
}

interface NodeOptions {
  tabIndex?: number
  disabled?: boolean
  hidden?: boolean
  inert?: boolean
}

function fixture() {
  const handlers: Record<string, (e: FocusPress) => void> = {}
  const body: { children: FakeNode[] } = { children: [] }
  const doc = {
    body,
    activeElement: null as unknown,
    addEventListener: (name: string, fn: (e: FocusPress) => void) => {
      handlers[name] = fn
    },
  }
  function node(id: string, parent: FakeNode | null, options: NodeOptions = {}): FakeNode {
    const { tabIndex = -1, disabled = false, hidden = false, inert = false } = options
    const el: FakeNode = {
      id,
      parent,
      tabIndex,
      disabled,
      hidden,
      inert,
      isConnected: true,
      children: [],
      contains(child) {
        return child === this || this.children.some(x => x.contains(child))
      },
      closest(selector) {
        for (let x: FakeNode | null = this; x; x = x.parent) {
          if ((selector.includes('[inert]') && x.inert) || (selector.includes('[hidden]') && x.hidden)) return x
        }
        return null
      },
      getClientRects() {
        return this.hidden ? [] : [{}]
      },
      querySelectorAll() {
        return this.children.flatMap(x => [x, ...x.querySelectorAll()])
      },
      focus() {
        doc.activeElement = this
      },
    }
    if (parent) parent.children.push(el)
    else body.children.push(el)
    return el
  }
  const make = modalFocusManager(doc)
  const fire = (name: string, e: FocusPress) => {
    const handler = handlers[name]
    if (!handler) throw new Error(`no ${name} listener`)
    handler(e)
  }
  const key = (shiftKey = false) => {
    let prevented = false
    fire('keydown', {
      key: 'Tab',
      target: doc.activeElement,
      shiftKey,
      preventDefault: () => {
        prevented = true
      },
    })
    return prevented
  }
  return { doc, fire, node, make, key }
}

test('modal Tab wraps over visible enabled controls; background focus is brought back and origin restored', () => {
  const f = fixture()
  const page = f.node('page', null)
  const origin = f.node('origin', page, { tabIndex: 0 })
  const layer = f.node('dialog', null)
  const win = f.node('window', layer)
  const first = f.node('first', win, { tabIndex: 0 })
  f.node('disabled', win, { tabIndex: 0, disabled: true })
  f.node('hidden', win, { tabIndex: 0, hidden: true })
  const last = f.node('last', win, { tabIndex: 0 })
  const scope = f.make(layer, win)
  scope.open(origin)
  assert.equal(page.inert, true)
  assert.equal(f.key(), true)
  assert.equal(f.doc.activeElement, first)
  first.focus()
  f.key(true)
  assert.equal(f.doc.activeElement, last)
  assert.equal(f.key(), true)
  assert.equal(f.doc.activeElement, first)
  origin.focus()
  f.fire('focusin', { target: origin })
  assert.equal(f.doc.activeElement, first)
  scope.close()
  assert.equal(page.inert, false)
  assert.equal(f.doc.activeElement, origin)
})

test('nested dialogs restore the lower scope and preserve pre-existing inert state', () => {
  const f = fixture()
  const background = f.node('background', null, { inert: true })
  const a = f.node('a', null)
  const aw = f.node('aw', a)
  const button = f.node('button', aw, { tabIndex: 0 })
  const b = f.node('b', null)
  const bw = f.node('bw', b)
  const lower = f.make(a, aw)
  const upper = f.make(b, bw)
  lower.open()
  upper.open(button)
  assert.equal(a.inert, true)
  assert.equal(lower.isTop(), false)
  assert.equal(upper.isTop(), true)
  upper.close()
  assert.equal(a.inert, false)
  assert.equal(f.doc.activeElement, button)
  lower.close()
  assert.equal(background.inert, true)
})

test('useModalFocus: a dialog not drawn yet takes nothing; drawn anew it takes a new scope; close gives the focus back', () => {
  const f = fixture()
  const page = f.node('page', null)
  const origin = f.node('origin', page, { tabIndex: 0 })
  let layer: FakeNode | null = null
  let win: FakeNode | null = null
  const scope = scopeOfElements(
    f.make,
    () => layer,
    () => win,
  )
  scope.open(origin)
  assert.equal(page.inert, false)
  assert.equal(scope.isTop(), false)
  const first = f.node('dialog', null)
  layer = first
  win = f.node('window', first)
  scope.open(origin)
  assert.equal(page.inert, true)
  assert.equal(f.doc.activeElement, win)
  assert.equal(scope.isTop(), true)
  const again = f.node('dialog again', null)
  layer = again
  win = f.node('window again', again)
  scope.open(origin)
  assert.equal(first.inert, true) // the old one is background now, not a layer of its own
  assert.equal(again.inert, false)
  assert.equal(f.doc.activeElement, win)
  scope.close()
  assert.equal(page.inert, false)
  assert.equal(first.inert, false)
  assert.equal(f.doc.activeElement, origin)
  assert.equal(scope.isTop(), false)
})
