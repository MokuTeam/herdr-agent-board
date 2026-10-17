// The quick look's motion, focus and keys (hooks/useQuickLook.ts quickLookEngine) in a fake DOM
// (support/fake-dom.ts): it grows out of the chip it was opened from, takes the focus, steps in
// and back, shrinks away on Esc or Back from its first step, and gives the focus back; open, reveal
// and copy act on what it shows. Springs share one frame loop: every world settles before it goes.
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

const press = (key: string, altKey = false) => {
  const e = {
    key,
    altKey,
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
