// The place menu out of a panel's head: right, left, bottom, floating, and the default size. React
// draws it (LayoutMenu.tsx) and the state it shows; this opens, places and closes it, and takes its
// keys and clicks.

import { DOCKS, type Dock, type PanelLayout, type Viewport } from '../../models/panel-layout.ts'
import { menuPlacement, menuStep } from '../../models/panel-motion.ts'
import { Spring } from '../../models/spring.ts'

/** The panel whose button opened the menu: what a pick does to it. */
export interface MenuOwner {
  setDock(dock: Dock): void
  resetSize(): void
}

/** What the menu shows: which panel's button has it up, and the dock checked (null before it first opened). */
export interface MenuView {
  expanded: MenuOwner | null
  checked: Dock | null
}

const isDock = (value: string | undefined): value is Dock => DOCKS.some(dock => dock === value)

export class LayoutMenuMotion {
  private el: HTMLElement | null = null
  private owner: MenuOwner | null = null
  private button: HTMLElement | null = null
  /** The dock checked when it opened: it stays so while the menu fades. */
  private checked: Dock | null = null
  // Grows out of the button that opened it; critically damped, nothing bounces in a menu.
  private readonly s: Spring

  constructor(
    private readonly layout: () => PanelLayout,
    private readonly viewport: () => Viewport,
    private readonly view: (state: MenuView) => void,
  ) {
    this.s = new Spring({
      damping: 1,
      response: 0.22,
      precision: 0.002,
      onUpdate: v => {
        if (!this.el) return
        this.el.style.opacity = String(Math.max(0, Math.min(1, v * 1.5)))
        this.el.style.transform = `scale(${0.92 + 0.08 * v})`
      },
      onRest: v => {
        if (v === 0 && this.el) this.el.hidden = true
      },
    })
  }

  attach(el: HTMLElement): () => void {
    this.el = el
    const click = (e: MouseEvent) => this.click(e)
    const key = (e: KeyboardEvent) => this.key(e)
    el.addEventListener('click', click)
    el.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('click', click)
      el.removeEventListener('keydown', key)
      document.removeEventListener('pointerdown', this.outside, true)
      this.s.stop()
      if (this.el === el) this.el = null
    }
  }

  isOpen(): boolean {
    return this.s.target === 1
  }

  toggle(owner: MenuOwner, button: HTMLElement): void {
    if (this.isOpen()) this.close()
    else this.open(owner, button)
  }

  private items(): HTMLElement[] {
    return [...(this.el?.querySelectorAll<HTMLElement>('button') ?? [])]
  }

  // On the document, so the page's own listener on the window sees the press first (usePanelClickAway).
  private readonly outside = (e: PointerEvent): void => {
    const target = e.target instanceof Node ? e.target : null
    if (!this.el?.contains(target) && !this.button?.contains(target)) this.close()
  }

  open(owner: MenuOwner, button: HTMLElement): void {
    const el = this.el
    if (!el) return
    this.owner = owner
    this.button = button
    const dock = this.layout().dock
    this.checked = dock
    this.view({ expanded: owner, checked: dock })
    el.hidden = false
    el.style.transform = 'none'
    const place = menuPlacement(button.getBoundingClientRect(), el.getBoundingClientRect(), this.viewport())
    el.style.left = `${place.left}px`
    el.style.top = `${place.top}px`
    el.style.transformOrigin = place.origin
    const s = this.s
    if (s.value < 0.01) {
      // From folded, without set(): its rest would put the menu away again.
      s.stop()
      s.value = s.velocity = 0
      s.onUpdate(0)
    }
    s.to(1)
    ;(el.querySelector<HTMLElement>(`[data-dock="${dock}"]`) ?? this.items()[0])?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', this.outside, true)
  }

  close(refocus = false): void {
    if (this.s.target === 0) return
    this.s.to(0)
    document.removeEventListener('pointerdown', this.outside, true)
    this.view({ expanded: null, checked: this.checked })
    if (refocus) this.button?.focus({ preventScroll: true })
  }

  private click(e: MouseEvent): void {
    const b = e.target instanceof Element ? e.target.closest<HTMLElement>('button') : null
    const owner = this.owner
    if (!b || !owner) return
    this.close(true)
    const dock = b.dataset.dock
    if (isDock(dock)) owner.setDock(dock)
    else owner.resetSize()
  }

  private key(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      this.close()
      return
    }
    // The menu's keys stay in the menu: Esc must not close the panel too, letters must not reach the board.
    e.stopPropagation()
    const list = this.items()
    const active = document.activeElement
    const go = menuStep(e.key, active instanceof HTMLElement ? list.indexOf(active) : -1, list.length)
    if (go !== null) {
      e.preventDefault()
      list[go]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.close(true)
    }
  }
}
