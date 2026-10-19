// Where a thrown panel will dock: a rectangle grown out of the panel, on springs. React draws the
// element (DockPreview.tsx); this moves it.
import { type Dock, type PanelLayout, type Rect, rectFor, type Viewport } from '../../models/panel-layout.ts'
import { Spring } from '../../models/spring.ts'

export class DockPreviewMotion {
  private el: HTMLElement | null = null
  private dock: Dock | null = null
  private readonly x: Spring
  private readonly y: Spring
  private readonly w: Spring
  private readonly h: Spring
  private readonly o: Spring

  constructor(
    private readonly layout: () => PanelLayout,
    private readonly viewport: () => Viewport,
  ) {
    const spring = (precision: number) =>
      new Spring({ damping: 1, response: 0.28, precision, onUpdate: () => this.paint() })
    this.x = spring(0.3)
    this.y = spring(0.3)
    this.w = spring(0.3)
    this.h = spring(0.3)
    this.o = new Spring({
      damping: 1,
      response: 0.2,
      precision: 0.01,
      onUpdate: () => this.paint(),
      onRest: v => {
        if (v === 0 && this.el) this.el.hidden = true
      },
    })
  }

  attach(el: HTMLElement): () => void {
    this.el = el
    return () => {
      for (const s of [this.x, this.y, this.w, this.h, this.o]) s.stop()
      if (this.el === el) this.el = null
    }
  }

  private paint(): void {
    const el = this.el
    if (!el) return
    el.style.transform = `translate3d(${this.x.value}px, ${this.y.value}px, 0)`
    el.style.width = `${this.w.value}px`
    el.style.height = `${this.h.value}px`
    el.style.opacity = String(Math.max(0, Math.min(1, this.o.value)))
  }

  /** Show where `next` would put the panel, grown out of the panel's rectangle `from`. Null hides it. */
  show(next: Dock | null, from: Rect): void {
    if (next === this.dock) return
    this.dock = next
    if (!next) {
      this.o.to(0)
      return
    }
    const r = rectFor({ ...this.layout(), dock: next }, this.viewport())
    if (this.el?.hidden || this.o.value < 0.05) {
      if (this.el) this.el.hidden = false
      this.x.set(from.x)
      this.y.set(from.y)
      this.w.set(from.w)
      this.h.set(from.h)
    }
    this.x.to(r.x)
    this.y.to(r.y)
    this.w.to(r.w)
    this.h.to(r.h)
    this.o.to(1)
  }

  hide(): void {
    this.dock = null
    this.o.to(0)
  }
}
