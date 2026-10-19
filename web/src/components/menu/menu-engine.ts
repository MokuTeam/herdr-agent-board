// The board's context menu, in the manner of macOS (the old page's menu.js): it grows out of the
// point it opened at, keeps on screen (models/menu-model.ts places it), nests submenus beside
// their item, and answers the keyboard: arrows, Enter or Space, Esc, Home and End, and typing a
// label's first letters. Gray items say why. A click outside only closes it; it does not also act
// on what is there.
//
// One menu is open at a time. React draws its levels from `view` (ContextMenu.tsx), each a direct
// child of <body>; this opens and closes them, lights their items, places each level once it is
// drawn (attach) and moves it with a spring, and takes the keys and the pointer.

import {
  firstIndex,
  isSeparator,
  lastIndex,
  type MenuEntry,
  type MenuItem,
  nextIndex,
  type Point,
  placeMenu,
  placeSubmenu,
  type Size,
  shareReasons,
  typeahead,
} from '../../models/menu-model.ts'
import { reducedMotion, Spring } from '../../models/spring.ts'
import { Store } from '../../state/store.ts'

export type MenuSource = 'mouse' | 'touch' | 'keyboard'

/** What the focus goes back to when the menu closes. */
export interface Focusable {
  readonly isConnected: boolean
  focus(options?: FocusOptions): void
}

export const isFocusable = (el: unknown): el is Focusable =>
  typeof el === 'object' && el !== null && 'focus' in el && typeof el.focus === 'function'

export interface MenuOpen {
  /** Client coordinates it opens at. */
  x: number
  y: number
  /** Above x, y when it fits there (a control low in its window). */
  up?: boolean
  /** Keyboard lights the first item; touch has bigger rows. */
  source?: MenuSource
  /** Where the focus goes back to; what has it now by default. */
  origin?: Focusable | null
  /** Runs after the menu closed, with the item picked. */
  onPick?: (id: string, item: MenuItem) => void
  /** Its name for screen readers. */
  label?: string
}

/** One level as drawn: the menu, an open submenu, or one fading away. */
export interface LayerView {
  /** `menu-<n>`; its items' ids are `menu-<n>-<index>`. */
  id: string
  items: MenuEntry[]
  /** The reason several gray items share, said once under the menu. */
  note: string
  /** Some item has a check: the menu has a check column. */
  checks: boolean
  touch: boolean
  label: string
  /** The lit item, -1 for none. */
  active: number
  /** The item whose submenu is open, -1 for none. */
  sub: number
}

export interface MenuView {
  /** In the order they were drawn. */
  layers: LayerView[]
}

type Placing = { at: Point; up: boolean } | { parent: Layer; index: number }

interface Layer {
  readonly id: string
  readonly items: MenuEntry[]
  readonly note: string
  readonly checks: boolean
  readonly depth: number
  touch: boolean
  label: string
  active: number
  sub: number
  el: HTMLElement | null
  spring: Spring | null
  /** Where it goes once it is drawn. */
  placing: Placing | null
  /** An item lit before it was drawn: scrolled into view once it is. */
  scrollOnDraw: boolean
}

export interface MenuEngineOptions {
  /** After every open and close (the Back button's layers, the button a menu came from). */
  onChange?: () => void
  /** The window without its scrollbar. */
  viewport?: () => Size
  /** performance.now(). */
  now?: () => number
}

const isElement = (node: unknown): node is Element =>
  typeof node === 'object' && node !== null && 'closest' in node && typeof node.closest === 'function'

/** The item an event is on: its index, or -1. */
function indexAt(e: Event): number {
  const item = isElement(e.target) ? e.target.closest<HTMLElement>('.menu-item') : null
  return Number(item?.dataset.i ?? -1)
}

const windowSize = (): Size => ({ width: document.documentElement.clientWidth, height: innerHeight })

export class MenuEngine {
  readonly view = new Store<MenuView>({ layers: [] })
  /** A menu is open (not fading away). */
  readonly openNow = new Store(false)
  /** The menu and its open submenus, outermost first. */
  private layers: Layer[] = []
  /** Drawn: those and the ones fading away, in the order they came. */
  private drawn: Layer[] = []
  private pick: (id: string, item: MenuItem) => void = () => {}
  private restore: Focusable | null = null
  private openedAt = 0
  private downInside = false
  private typed = ''
  private typedAt = 0
  /** A submenu opens (or closes) once the pointer rests. */
  private hover: ReturnType<typeof setTimeout> | undefined
  private seq = 0
  private swallowUntil = 0
  private readonly onChange: () => void
  private readonly viewport: () => Size
  private readonly now: () => number

  constructor(options: MenuEngineOptions = {}) {
    this.onChange = options.onChange ?? (() => {})
    this.viewport = options.viewport ?? windowSize
    this.now = options.now ?? (() => performance.now())
  }

  isOpen(): boolean {
    return this.layers.length > 0
  }

  /** Close every level and give the focus back. */
  close(): void {
    this.clear(true)
  }

  /** Open `items` at x, y; the one open before closes. */
  open(items: readonly MenuEntry[], options: MenuOpen): void {
    const { x, y, up = false, source = 'mouse', origin = null, onPick = () => {}, label = '' } = options
    if (!items.length) return
    this.clear(false)
    this.pick = onPick
    const active = document.activeElement
    this.restore = origin ?? (isFocusable(active) ? active : null)
    this.openedAt = this.now()
    this.downInside = false
    this.typed = ''
    const layer = this.build(items, 0, { at: { x, y }, up })
    layer.touch = source === 'touch'
    layer.label = label
    this.layers = [layer]
    if (source === 'keyboard') this.light(layer, firstIndex(layer.items))
    this.publish()
    this.onChange()
  }

  /** A level drawn (ContextMenu.tsx's layout effect): it goes in place, grows, and takes the pointer. */
  attach(id: string, el: HTMLElement): () => void {
    const layer = this.drawn.find(l => l.id === id)
    if (!layer) return () => {}
    layer.el = el
    const move = (e: PointerEvent) => this.onMove(layer, e)
    const leave = () => this.onLeave(layer)
    const down = (e: PointerEvent) => {
      this.downInside = true
      e.preventDefault() // keep the focus on the menu
    }
    const up = (e: PointerEvent) => this.onUp(layer, e)
    const context = (e: MouseEvent) => e.preventDefault()
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointerup', up)
    el.addEventListener('contextmenu', context)
    if (layer.placing) this.place(layer, el, layer.placing)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('contextmenu', context)
      if (layer.el === el) layer.el = null
    }
  }

  /** The page's listeners: keys first, a press outside, the window leaving, resizing or scrolling. */
  start(): () => void {
    const key = (e: KeyboardEvent) => this.onKey(e)
    // A press outside closes the menu and is spent on that; a right press opens the next menu.
    const down = (e: PointerEvent) => {
      if (!this.layers.length || this.inside(e.target)) return
      if (e.button === 0) this.swallowUntil = this.now() + 600
      this.clear(e.button !== 0)
    }
    const click = (e: MouseEvent) => {
      if (this.now() > this.swallowUntil) return
      this.swallowUntil = 0
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const away = () => this.clear(false)
    const scroll = (e: Event) => {
      if (this.layers.length && !this.inside(e.target)) this.clear(false)
    }
    addEventListener('keydown', key, true)
    addEventListener('pointerdown', down, true)
    addEventListener('click', click, true)
    addEventListener('blur', away)
    addEventListener('resize', away)
    addEventListener('scroll', scroll, true)
    return () => {
      removeEventListener('keydown', key, true)
      removeEventListener('pointerdown', down, true)
      removeEventListener('click', click, true)
      removeEventListener('blur', away)
      removeEventListener('resize', away)
      removeEventListener('scroll', scroll, true)
      clearTimeout(this.hover)
      for (const layer of this.drawn) layer.spring?.stop()
    }
  }

  private inside(target: EventTarget | null): boolean {
    return this.layers.some(l => !!l.el && l.el.contains(isElement(target) ? target : null))
  }

  private build(raw: readonly MenuEntry[], depth: number, placing: Placing): Layer {
    const { items, note } = shareReasons(raw)
    const layer: Layer = {
      id: `menu-${++this.seq}`,
      items,
      note,
      checks: items.some(it => !isSeparator(it) && it.checked !== undefined),
      depth,
      touch: false,
      label: '',
      active: -1,
      sub: -1,
      el: null,
      spring: null,
      placing,
      scrollOnDraw: false,
    }
    this.drawn.push(layer)
    return layer
  }

  private place(layer: Layer, el: HTMLElement, placing: Placing): void {
    layer.placing = null
    const r = el.getBoundingClientRect()
    const size = { width: r.width, height: r.height }
    if ('at' in placing) {
      const p = placeMenu(placing.at, size, this.viewport(), { up: placing.up })
      this.position(el, p)
      this.grow(layer, `${p.originX} ${p.originY}`)
    } else {
      const { parent, index } = placing
      const item = this.itemEl(parent, index)
      if (!parent.el || !item) return
      const p = placeSubmenu(item.getBoundingClientRect(), parent.el.getBoundingClientRect(), size, this.viewport())
      this.position(el, p)
      this.grow(layer, p.side === 'right' ? 'left top' : 'right top')
    }
    if (layer.scrollOnDraw) this.itemEl(layer, layer.active)?.scrollIntoView({ block: 'nearest' })
    layer.scrollOnDraw = false
    if (layer.depth === 0 && this.layers[0] === layer) el.focus({ preventScroll: true })
  }

  private position(el: HTMLElement, p: { x: number; y: number; maxHeight: number }): void {
    el.style.left = `${p.x}px`
    el.style.top = `${p.y}px`
    el.style.maxHeight = `${p.maxHeight}px`
  }

  /** It grows out of its corner (or the side of its parent item), critically damped and quick. */
  private grow(layer: Layer, origin: string): void {
    const el = layer.el
    if (!el) return
    el.style.transformOrigin = origin
    layer.spring = new Spring({
      value: 0,
      damping: 1,
      response: 0.2,
      precision: 0.003,
      onUpdate: v => {
        const now = layer.el
        if (!now) return
        now.style.opacity = String(Math.min(1, v * 1.4))
        now.style.transform = reducedMotion.matches ? '' : `scale(${0.94 + 0.06 * v})`
      },
      onRest: v => {
        if (v === 0) this.remove(layer)
        else if (layer.el) layer.el.style.transform = ''
      },
    })
    layer.spring.to(1)
  }

  private fade(layer: Layer): void {
    if (layer.el) layer.el.style.pointerEvents = 'none'
    if (!layer.spring || reducedMotion.matches) this.remove(layer)
    else layer.spring.to(0, { response: 0.14 })
  }

  /** Gone from the page (React takes its element away). */
  private remove(layer: Layer): void {
    layer.spring?.stop()
    this.drawn = this.drawn.filter(l => l !== layer)
    this.publish()
  }

  private itemEl(layer: Layer, i: number): HTMLElement | null {
    return layer.el?.querySelector<HTMLElement>(`[data-i="${i}"]`) ?? null
  }

  private light(layer: Layer, i: number): void {
    if (layer.active === i) return
    layer.active = i
    const el = this.itemEl(layer, i)
    if (el) el.scrollIntoView({ block: 'nearest' })
    else layer.scrollOnDraw = i >= 0 && !layer.el
    this.publish()
  }

  private onMove(layer: Layer, e: PointerEvent): void {
    const i = indexAt(e)
    const it = layer.items[i]
    const usable = !!it && !isSeparator(it) && !it.disabled
    if (usable) this.light(layer, i)
    else if (layer.sub < 0) this.light(layer, -1)
    // A submenu follows the pointer once it rests a moment, so a diagonal move toward an open
    // submenu across other items does not swap it.
    clearTimeout(this.hover)
    if (usable && !isSeparator(it) && it.submenu && layer.sub !== i)
      this.hover = setTimeout(() => this.openSub(layer, i, false), 140)
    else if (layer.sub >= 0 && layer.sub !== i) this.hover = setTimeout(() => this.closeFrom(layer.depth + 1), 260)
  }

  private onLeave(layer: Layer): void {
    clearTimeout(this.hover)
    if (layer.sub < 0) this.light(layer, -1)
    else this.light(layer, layer.sub)
  }

  private onUp(layer: Layer, e: PointerEvent): void {
    // The release of the press that opened the menu is not a choice (macOS opens on press).
    if (!this.downInside && this.now() - this.openedAt < 350) return
    this.downInside = false
    const i = indexAt(e)
    if (i >= 0) this.activate(layer, i)
  }

  private openSub(layer: Layer, i: number, focusFirst: boolean): void {
    const it = layer.items[i]
    if (!it || isSeparator(it) || !it.submenu?.length || it.disabled) return
    const open = this.layers[layer.depth + 1]
    if (layer.sub === i && open) {
      if (focusFirst) this.light(open, firstIndex(open.items))
      return
    }
    this.closeFrom(layer.depth + 1)
    const sub = this.build(it.submenu, layer.depth + 1, { parent: layer, index: i })
    sub.touch = this.layers[0]?.touch ?? false
    layer.sub = i
    this.layers.push(sub)
    if (focusFirst) this.light(sub, firstIndex(sub.items))
    this.publish()
  }

  private closeFrom(depth: number): void {
    while (this.layers.length > depth) {
      const gone = this.layers.pop()
      if (gone) this.fade(gone)
      const parent = this.layers.at(-1)
      if (parent) parent.sub = -1
    }
    this.publish()
  }

  private activate(layer: Layer, i: number): void {
    const it = layer.items[i]
    if (!it || isSeparator(it) || it.disabled) return
    if (it.submenu) {
      this.openSub(layer, i, true)
      return
    }
    const run = this.pick
    this.clear(true)
    run(it.id, it)
  }

  /** Close every level; `focus` gives the focus back to where it was. */
  private clear(focus = true): void {
    clearTimeout(this.hover)
    if (!this.layers.length) return
    this.closeFrom(0)
    if (focus && this.restore?.isConnected) this.restore.focus({ preventScroll: true })
    this.restore = null
    this.onChange()
  }

  private onKey(e: KeyboardEvent): void {
    const top = this.layers.at(-1)
    if (!top) return
    e.stopImmediatePropagation()
    const key = e.key
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault()
      this.light(top, nextIndex(top.items, top.active, key === 'ArrowDown' ? 1 : -1))
    } else if (key === 'Home' || key === 'End') {
      e.preventDefault()
      this.light(top, key === 'Home' ? firstIndex(top.items) : lastIndex(top.items))
    } else if (key === 'ArrowRight') {
      e.preventDefault()
      const it = top.items[top.active]
      if (it && !isSeparator(it) && it.submenu) this.openSub(top, top.active, true)
    } else if (key === 'ArrowLeft') {
      e.preventDefault()
      if (this.layers.length > 1) {
        this.closeFrom(this.layers.length - 1)
        this.layers.at(-1)?.el?.focus({ preventScroll: true })
      }
    } else if (key === 'Enter' || key === ' ') {
      e.preventDefault()
      if (top.active >= 0) this.activate(top, top.active)
    } else if (key === 'Escape') {
      e.preventDefault()
      if (this.layers.length > 1) this.closeFrom(this.layers.length - 1)
      else this.clear(true)
    } else if (key === 'Tab') {
      e.preventDefault()
      this.clear(true)
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const now = this.now()
      this.typed = now - this.typedAt > 700 ? key : this.typed + key
      this.typedAt = now
      this.light(top, typeahead(top.items, this.typed, top.active))
    }
  }

  private publish(): void {
    this.view.set({
      layers: this.drawn.map(l => ({
        id: l.id,
        items: l.items,
        note: l.note,
        checks: l.checks,
        touch: l.touch,
        label: l.label,
        active: l.active,
        sub: l.sub,
      })),
    })
    this.openNow.set(this.layers.length > 0)
  }
}
