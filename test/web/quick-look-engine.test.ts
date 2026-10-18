// The quick look's motion, focus and keys (hooks/useQuickLook.ts quickLookEngine) in a fake DOM
// (support/fake-dom.ts): it grows out of the chip it was opened from, takes the focus, steps in
// and back, shrinks away on Esc or Back from its first step, and gives the focus back; open, reveal
// and copy act on what it shows; an image on show zooms, by its keys too, until the next step. Springs share one frame loop: every world settles before it goes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { FilesApi } from '../../web/src/api/files.ts'
import { type LookKey, type LookRefs, quickLookEngine } from '../../web/src/hooks/useQuickLook.ts'
import type { Preview } from '../../web/src/models/files.ts'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'

const en = translator('en')

let world: FakeWorld
beforeEach(() => {
  world = new FakeWorld({ viewport: { w: 1200, h: 800 } })
  world.install()
})
afterEach(async () => {
  try {
    await world.settle()
  } finally {
    world.uninstall()
  }
})

/** A fake element as the page's (the world is installed: its HTMLElement is the fake one). */
function mount(html: string): HTMLElement {
  const [node] = parseHtml(html)
  if (node?.kind !== 'element') throw new Error('no element')
  const el: FakeElement = world.mount(node)
  if (el instanceof HTMLElement) return el
  throw new Error('the world is not installed')
}

const ref = <T>(current: T) => ({ current })

function setup({ canEdit = true } = {}) {
  const layer = mount('<div class="ql"><div class="ql-scrim"></div><section class="ql-win"></section></div>')
  const win = layer.querySelector<HTMLElement>('.ql-win')
  const scrim = layer.querySelector<HTMLDivElement>('.ql-scrim')
  if (!win || !scrim) throw new Error('no window')
  const chip = mount('<code class="fs-chip" data-fs="file">a.md</code>')
  const focus = { opened: [] as unknown[], closed: 0, top: true }
  const opened: [string, string][] = []
  const toasts: [string, boolean][] = []
  const previews: Record<string, Preview> = {
    '/a.md': { path: '/a.md', name: 'a.md', kind: 'markdown', text: '# A', lines: 1 },
    '/b.txt': { path: '/b.txt', name: 'b.txt', kind: 'text', text: 'b', lines: 1 },
    '/shot.png': { path: '/shot.png', name: 'shot.png', kind: 'image', size: 9000 },
    '/logo.SVG': { path: '/logo.SVG', name: 'logo.SVG', kind: 'image', size: 300 },
  }
  const api = {
    preview: async (path: string) => previews[path] ?? { path, error: 'missing' },
    changes: async () => ({ available: false }),
    history: async () => ({ results: [] }),
    open: async (path: string, how: string) => {
      opened.push([how, path])
      return null
    },
  } as unknown as FilesApi
  const refs: LookRefs = { layer: ref(layer as HTMLDivElement), win: ref(win), scrim: ref(scrim), body: ref(null) }
  const look = quickLookEngine({
    refs,
    focus: () => ({
      open: origin => void focus.opened.push(origin),
      close: () => void focus.closed++,
      isTop: () => focus.top,
    }),
    api,
    t: () => en,
    canEdit: () => canEdit,
    toast: (text, error = false) => void toasts.push([text, error]),
    upgrade() {},
  })
  return { look, win, scrim, chip, focus, opened, toasts }
}

const press = (key: string, altKey = false, { ctrlKey = false, metaKey = false, shiftKey = false } = {}) => {
  const e = {
    key,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    prevented: false,
    preventDefault() {
      e.prevented = true
    },
    stopImmediatePropagation() {},
  }
  return e satisfies LookKey
}

describe('the quick look opens and closes', () => {
  test('it grows out of the chip, takes the focus, and shrinks away on Esc, giving it back', async () => {
    const { look, win, scrim, chip, focus } = setup()
    look.look({ path: '/a.md' }, chip)
    expect(look.isOpen()).toBe(true)
    // Drawn, then it grows: from a chip with no size, a small drop.
    look.engine.grow()
    expect(focus.opened).toEqual([chip])
    expect(String(win.style.opacity)).toBe('0')
    await world.settle()
    expect(win.style.transform).toBe('translate(0px, 0px) scale(1)')
    expect(win.style.opacity).toBe('1')
    expect(scrim.style.opacity).toBe('1')
    await world.flush()
    expect(look.engine.view.get().data?.path).toBe('/a.md')
    // Only once: a draw after it grew changes nothing.
    look.engine.grow()
    expect(focus.opened.length).toBe(1)
    const esc = press('Escape')
    look.engine.keydown(esc)
    expect(esc.prevented).toBe(true)
    expect(look.isOpen()).toBe(false)
    expect(look.engine.view.get().hidden).toBe(false)
    await world.settle()
    expect(look.engine.view.get()).toMatchObject({ hidden: true, data: null })
    expect(focus.closed).toBe(1)
    expect(win.style.opacity).toBe('0')
  })

  test('Backspace walks back a step, from the first it closes; a dialog above it keeps its keys', async () => {
    const { look, chip, focus } = setup()
    look.look({ path: '/a.md' }, chip)
    look.engine.grow()
    await world.settle()
    look.look({ path: '/b.txt' }, chip)
    await world.flush()
    expect(look.engine.view.get()).toMatchObject({ depth: 2, data: { path: '/b.txt' } })
    look.engine.keydown(press('Backspace'))
    await world.flush()
    expect(look.engine.view.get()).toMatchObject({ depth: 1, data: { path: '/a.md' } })
    focus.top = false
    const held = press('ArrowLeft', true)
    look.engine.keydown(held)
    expect(held.prevented).toBe(false)
    focus.top = true
    look.engine.keydown(press('ArrowLeft', true))
    expect(look.isOpen()).toBe(false)
    await world.settle()
    expect(look.engine.view.get().hidden).toBe(true)
  })

  test('caught while it shrinks, it turns around and opens on the new step', async () => {
    const { look, chip } = setup()
    look.lookChanges('k1', chip)
    look.engine.grow()
    await world.settle()
    look.close()
    await world.tick()
    look.lookHistory('k1', '/work', chip)
    look.engine.grow()
    await world.settle()
    expect(look.engine.view.get()).toMatchObject({ hidden: false, closing: false, depth: 1, top: { kind: 'history' } })
    // A step without what to show is no step.
    look.look({ path: '' }, chip)
    look.lookChanges('', chip)
    expect(look.engine.view.get().depth).toBe(1)
  })
})

describe('what it shows', () => {
  test('opens with the system, shows in its folder, copies the path at its line', async () => {
    const { look, chip, opened, toasts } = setup()
    const copied: string[] = []
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
      configurable: true,
    })
    look.look({ path: '/b.txt', line: 4 }, chip)
    look.engine.grow()
    await world.flush()
    look.engine.act('open')
    look.engine.act('reveal')
    look.engine.act('copy')
    await world.flush()
    expect(opened).toEqual([
      ['open', '/b.txt'],
      ['reveal', '/b.txt'],
    ])
    expect(copied).toEqual(['/b.txt:4'])
    expect(toasts).toEqual([[en('ql.copied'), false]])
  })

  test('without the board, open and reveal say why not', async () => {
    const { look, chip, opened, toasts } = setup({ canEdit: false })
    look.look({ path: '/b.txt' }, chip)
    await world.flush()
    look.engine.act('open')
    await world.flush()
    expect(opened).toEqual([])
    expect(toasts).toEqual([[en('mobile.readOnly'), true]])
  })
})

/** An image as drawn on its stage, `natural` its own size once loaded (none: an SVG without one). */
function image(natural: { w: number; h: number } | null, shown = { w: 400, h: 300 }) {
  const stage = mount('<div class="ql-media ql-stage" style="width: 1000px; height: 700px"><img class="checker"></div>')
  const img = stage.querySelector<HTMLImageElement>('img')
  if (!img) throw new Error('no image')
  img.style.width = `${shown.w}px`
  img.style.height = `${shown.h}px`
  Object.defineProperty(img, 'naturalWidth', { value: natural?.w ?? 0 })
  Object.defineProperty(img, 'naturalHeight', { value: natural?.h ?? 0 })
  return { stage, img }
}

/** What the quick look shows now, as a file. */
function shown(look: ReturnType<typeof setup>['look']) {
  const data = look.engine.view.get().data
  if (!data || !('line' in data)) throw new Error('no file on show')
  return data
}

describe('an image on show zooms', () => {
  test('loaded, it zooms and gives the footer its size; + − 0 are its own, not while typing; a step drops it', async () => {
    const { look, chip } = setup()
    look.look({ path: '/shot.png' }, chip)
    look.engine.grow()
    await world.settle()
    const { stage, img } = image({ w: 1900, h: 993 })
    expect(look.engine.imageLoaded(img, shown(look))).toEqual({ width: 1900, height: 993 })
    expect(stage.dataset.zoom).toBe('fit')
    expect(look.engine.zoom.get()).toMatchObject({ fit: true, to: 1 })
    const plus = press('+')
    look.engine.keydown(plus)
    expect(plus.prevented).toBe(true)
    await world.settle()
    expect(look.engine.zoom.get()).toMatchObject({ fit: false })
    // Typing in a field: the key is the field's.
    const field = mount('<input>')
    field.focus()
    const typed = press('0')
    look.engine.keydown(typed)
    expect(typed.prevented).toBe(false)
    field.blur()
    // Not a zoom key: the page's.
    const other = press('a')
    look.engine.keydown(other)
    expect(other.prevented).toBe(false)
    // The footer's button: back to fit, and in again.
    look.engine.toggleZoom()
    await world.settle()
    expect(look.engine.zoom.get()).toMatchObject({ fit: true })
    // Another image gone is not this one's zoom.
    look.engine.imageGone(image({ w: 10, h: 10 }).img)
    expect(look.engine.zoom.get()).not.toBeNull()
    // A step: the zoom goes, and its keys with it.
    look.look({ path: '/b.txt' }, chip)
    expect(look.engine.zoom.get()).toBeNull()
    const after = press('+')
    look.engine.keydown(after)
    expect(after.prevented).toBe(false)
  })

  test('an SVG without a size zooms from the size it was fitted at, smooth; walked away, nothing; not an image, no zoom', async () => {
    const { look, chip } = setup()
    look.look({ path: '/logo.SVG' }, chip)
    look.engine.grow()
    await world.settle()
    const svg = image(null, { w: 500, h: 250 })
    expect(look.engine.imageLoaded(svg.img, shown(look))).toBeNull()
    expect(look.engine.zoom.get()).toMatchObject({ fit: true })
    for (let i = 0; i < 6; i++) look.engine.keydown(press('+'))
    await world.settle()
    expect(svg.img.classList.contains('pixelated')).toBe(false)
    // Six steps up from 100% (it fits at its own size): the largest zoom, eight times.
    expect(Number.parseFloat(String(svg.img.style.width))).toBeCloseTo(500 * 8, 3)
    // Gone from the page before it loaded: the footer and the zoom are someone else's.
    const gone = image({ w: 64, h: 64 })
    gone.stage.remove()
    expect(look.engine.imageLoaded(gone.img, shown(look))).toBeNull()
    expect(gone.stage.classList.contains('zoomable')).toBe(false)
    // Not an image (a text file's picture, say): its size, no zoom.
    look.look({ path: '/b.txt' }, chip)
    await world.flush()
    const text = image({ w: 30, h: 20 })
    expect(look.engine.imageLoaded(text.img, shown(look))).toEqual({ width: 30, height: 20 })
    expect(look.engine.zoom.get()).toBeNull()
  })

  test('drawn no more, or the quick look closed: the zoom goes', async () => {
    const { look, chip } = setup()
    look.look({ path: '/shot.png' }, chip)
    look.engine.grow()
    await world.settle()
    const first = image({ w: 1900, h: 993 })
    look.engine.imageLoaded(first.img, shown(look))
    look.engine.imageGone(first.img)
    expect(look.engine.zoom.get()).toBeNull()
    const second = image({ w: 1900, h: 993 })
    look.engine.imageLoaded(second.img, shown(look))
    expect(look.engine.zoom.get()).not.toBeNull()
    look.engine.keydown(press('Escape'))
    await world.settle()
    expect(look.engine.zoom.get()).toBeNull()
  })
})
