// The quick look's zoom (components/files/zoom.ts) against upstream's web/zoom.js at the zoom's
// merge, step by step: each runs in a fake DOM of its own (support/fake-dom.ts) on the same stage
// and image and takes the same pointer, wheel, click, gesture and key events and frames; after
// every step the image (its size, place and pixels), the stage (zoomed or fitted, dragging), what
// the footer heard and whether the page's own default was kept must read the same.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ImageZoom, type ZoomKey, zoomImage } from '../../web/src/components/files/zoom.ts'
import { reducedMotion } from '../../web/src/models/spring.ts'
import { box, type EventFields, type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { oldSource } from './support/old-app.ts'
import { ZOOM_MERGE } from './support/old-files.tsx'

interface ZoomOptions {
  size: { w: number; h: number }
  vector?: boolean
  onChange?: (state: unknown) => void
}
type ZoomImage = (stage: unknown, img: unknown, options: ZoomOptions) => ImageZoom
type MotionPreference = { matches: boolean }

/** Upstream's zoom.js with its own zoom-model.js and spring.js, loaded once from a temp folder. */
const OLD = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-zoom-'))
  try {
    for (const file of ['spring.js', 'zoom-model.js', 'zoom.js'])
      writeFileSync(join(dir, file), oldSource(`web/${file}`, ZOOM_MERGE))
    const spring: Record<string, unknown> = await import(pathToFileURL(join(dir, 'spring.js')).href)
    const zoom: Record<string, unknown> = await import(pathToFileURL(join(dir, 'zoom.js')).href)
    const motion = spring.reducedMotion
    if (typeof zoom.zoomImage !== 'function' || typeof motion !== 'object' || motion === null)
      throw new Error('upstream zoom.js did not load')
    return { zoomImage: zoom.zoomImage as ZoomImage, reducedMotion: motion as MotionPreference }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** The port, on the fake elements (the world installed: its HTMLElement is the fake one). */
const OWN: ZoomImage = (stage, img, options) => {
  const isImage = (el: unknown): el is HTMLImageElement => el instanceof HTMLElement
  if (!(stage instanceof HTMLElement) || !isImage(img)) throw new Error('the world is not installed')
  return zoomImage(stage, img, options)
}

const OWN_MOTION: MotionPreference = reducedMotion
function setReduced(on: boolean): void {
  OWN_MOTION.matches = on
  OLD.reducedMotion.matches = on
}
afterAll(() => setReduced(false))

// ---------------------------------------------------------------- one side

/** Where the stage is on screen; a step may resize it. */
const STAGE = { left: 100, top: 50 }
const SHOT = { w: 1900, h: 993 }

interface Scene {
  size?: { w: number; h: number }
  vector?: boolean
  dpr?: number
  stage?: { w: number; h: number }
}

class ZoomSide {
  readonly world: FakeWorld
  readonly stage: FakeElement
  readonly img: FakeElement
  readonly zoom: ImageZoom
  readonly room: { w: number; h: number }
  readonly heard: string[] = []
  readonly log: string[] = []
  private readonly observers: (() => void)[] = []

  constructor(make: ZoomImage, scene: Scene) {
    const room = { w: 1032, h: 780, ...scene.stage }
    this.room = room
    this.world = new FakeWorld({
      viewport: { w: 1400, h: 900 },
      dpr: scene.dpr ?? 1,
      rects: el =>
        el.node.attrs.get('class')?.includes('ql-stage') ? box(STAGE.left, STAGE.top, room.w, room.h) : null,
      computed: el => (el.node.attrs.get('class')?.includes('ql-stage') ? { paddingLeft: '24px' } : {}),
    })
    this.world.install()
    const observers = this.observers
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: class {
        constructor(fn: () => void) {
          observers.push(fn)
        }
        observe() {}
        disconnect() {}
      },
      configurable: true,
      writable: true,
    })
    const [node] = parseHtml('<div class="ql-media ql-stage"><img class="checker" src="/raw" alt="shot.png"></div>')
    if (node?.kind !== 'element') throw new Error('no stage')
    this.stage = this.world.mount(node)
    const img = this.stage.querySelector('img')
    if (!img) throw new Error('no image')
    this.img = img
    this.zoom = make(this.stage, this.img, {
      size: scene.size ?? SHOT,
      vector: scene.vector ?? false,
      onChange: state => this.heard.push(JSON.stringify(state)),
    })
  }

  /** The window resized the stage: what the ResizeObserver hears. */
  resize(w: number, h: number): void {
    this.room.w = w
    this.room.h = h
    for (const fn of this.observers) fn()
  }

  snapshot(): string {
    const { img, stage } = this
    return [
      `img: ${img.node.attrs.get('style') ?? ''} | ${img.node.attrs.get('class') ?? ''} | draggable ${String(Reflect.get(img, 'draggable'))}`,
      `stage: ${stage.node.attrs.get('class') ?? ''} | ${stage.node.attrs.get('data-zoom') ?? ''}`,
      `heard: ${this.heard.at(-1) ?? ''} (${this.heard.length})`,
      `log: ${this.log.join(' ')}`,
      `moving: ${this.world.animating}`,
    ].join('\n')
  }

  async dispose(): Promise<void> {
    try {
      await this.world.settle()
    } finally {
      this.world.uninstall()
    }
  }
}

type Step = (side: ZoomSide) => Promise<unknown> | unknown

async function run(make: ZoomImage, scene: Scene, steps: Step[]): Promise<string[]> {
  const side = new ZoomSide(make, scene)
  try {
    const shots = [side.snapshot()]
    for (const step of steps) {
      await step(side)
      shots.push(side.snapshot())
    }
    await side.world.settle()
    shots.push(side.snapshot())
    return shots
  } finally {
    await side.dispose()
  }
}

/** Both sides read the same after every step; returns upstream's snapshots, to say what happened. */
async function compare(steps: Step[], scene: Scene = {}): Promise<string[]> {
  const old = await run(OLD.zoomImage, scene, steps)
  const react = await run(OWN, scene, steps)
  expect(react.length).toBe(old.length)
  for (const [i, shot] of old.entries()) expect(`step ${i}\n${react[i]}`).toBe(`step ${i}\n${shot}`)
  return old
}

const lineOf = (shot: string | undefined, name: string) =>
  (shot?.split('\n').find(l => l.startsWith(`${name}: `)) ?? '').slice(name.length + 2)
const scaleOf = (shot: string | undefined) => Number(/"s":([\d.e-]+)/.exec(lineOf(shot, 'heard'))?.[1] ?? Number.NaN)

// ---------------------------------------------------------------- steps

const at = (x: number, y: number) => ({ clientX: STAGE.left + x, clientY: STAGE.top + y })
const ticks =
  (n: number, ms = 16): Step =>
  async s => {
    for (let i = 0; i < n; i++) await s.world.tick(ms)
  }
const settle: Step = s => s.world.settle()
const pointer =
  (type: string, x: number, y: number, fields: EventFields = {}): Step =>
  async s => {
    const e = await s.world.pointer(type, s.stage, { ...at(x, y), ...fields })
    if (e.defaultPrevented) s.log.push(`${type}:prevented`)
  }
const click =
  (x: number, y: number, detail: number): Step =>
  s =>
    s.world.fire(s.stage, 'click', { ...at(x, y), extra: { detail } })
/** A mouse click: down, up and the click with its count. */
const mouseClick = (x: number, y: number, detail = 1): Step[] => [
  pointer('pointerdown', x, y),
  pointer('pointerup', x, y),
  click(x, y, detail),
]
/** Press at `from`, move through `path` `ms` apart, hold still `hold` frames, let go at the last point. */
function drag(from: [number, number], path: [number, number][], fields: EventFields = {}, ms = 16, hold = 0): Step[] {
  const end = path.at(-1) ?? from
  return [
    pointer('pointerdown', from[0], from[1], fields),
    ...path.flatMap(([x, y]) => [ticks(1, ms), pointer('pointermove', x, y, fields)]),
    ...(hold ? [ticks(hold, ms)] : []),
    pointer('pointerup', end[0], end[1], fields),
  ]
}
const line = (from: [number, number], to: [number, number], n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [
    from[0] + ((to[0] - from[0]) * (i + 1)) / n,
    from[1] + ((to[1] - from[1]) * (i + 1)) / n,
  ])
const wheel =
  (
    x: number,
    y: number,
    delta: { deltaX?: number; deltaY?: number; deltaMode?: number },
    fields: EventFields = {},
  ): Step =>
  async s => {
    const e = await s.world.fire(s.stage, 'wheel', {
      ...at(x, y),
      ...fields,
      extra: { deltaX: 0, deltaY: 0, deltaMode: 0, ...delta },
    })
    s.log.push(`wheel:${e.defaultPrevented ? 'prevented' : 'page'}`)
  }
const key =
  (k: string, mods: Partial<Omit<ZoomKey, 'key'>> = {}): Step =>
  s => {
    const taken = s.zoom.key({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })
    s.log.push(`${k}:${taken}`)
  }
const toggle: Step = s => s.zoom.toggle()
const gesture =
  (type: string, x: number, y: number, scale = 1): Step =>
  async s => {
    const e = await s.world.fire(s.stage, type, { ...at(x, y), extra: { scale } })
    if (e.defaultPrevented) s.log.push(`${type}:prevented`)
  }
const touch = (id: number) => ({ pointerType: 'touch', pointerId: id })

// ---------------------------------------------------------------- scenes

describe('the mouse', () => {
  test('a click zooms in to 100% at the spot; the second click of that pair does no more; a double-click goes back to fit', async () => {
    const shots = await compare([
      ...mouseClick(600, 400, 1),
      ticks(3),
      ...mouseClick(600, 400, 2),
      settle,
      // Zoomed: a single click does nothing, a double-click goes back to fit.
      ...mouseClick(300, 300, 1),
      ...mouseClick(300, 300, 2),
      ticks(4),
      settle,
    ])
    expect(lineOf(shots[0], 'stage')).toBe('ql-media ql-stage zoomable | fit')
    expect(shots.some(s => scaleOf(s) === 1)).toBe(true)
    expect(lineOf(shots.at(-1), 'stage')).toBe('ql-media ql-stage zoomable | fit')
  })

  test('zoomed, a drag follows 1:1 and glides on after a flick; past an edge it gives, and bounces back', async () => {
    await compare([
      toggle,
      settle,
      ...drag([500, 400], line([500, 400], [640, 380], 6)),
      ticks(5),
      settle,
      // Slowly far past the left edge, held still, let go: back to the edge.
      ...drag([500, 400], line([500, 400], [1400, 420], 12), {}, 32, 3),
      ticks(6),
      settle,
      // A flick that runs into an edge turns there into a bounce.
      ...drag([600, 400], line([600, 400], [200, 400], 3), {}, 8),
      ticks(20),
      settle,
    ])
  })

  test('a press catches a glide but not a zoom; a drag takes the zoom over midway', async () => {
    await compare([
      toggle,
      settle,
      ...drag([500, 400], line([500, 400], [700, 400], 3), {}, 8),
      ticks(2),
      // Down on a gliding image: it stops; up without a move is a click, which (zoomed) does nothing.
      ...mouseClick(500, 400, 1),
      ticks(2),
      // The footer's button heads back to fit; a press does not stop that, a drag does.
      toggle,
      ticks(2),
      pointer('pointerdown', 400, 300),
      ticks(2),
      pointer('pointermove', 401, 301),
      ticks(1),
      pointer('pointermove', 450, 320),
      ticks(1),
      pointer('pointerup', 450, 320),
      settle,
    ])
  })

  test('a right button or a cancelled drag: no zoom, no glide', async () => {
    await compare([
      pointer('pointerdown', 500, 400, { button: 2 }),
      pointer('pointerup', 500, 400, { button: 2 }),
      toggle,
      settle,
      pointer('pointerdown', 500, 400),
      ticks(1),
      pointer('pointermove', 560, 400),
      ticks(1),
      pointer('pointermove', 640, 400),
      pointer('pointercancel', 640, 400),
      settle,
      pointer('pointerdown', 500, 400),
      ticks(1),
      pointer('pointermove', 600, 400),
      s => s.world.fire(s.stage, 'lostpointercapture', { ...at(600, 400) }),
      settle,
    ])
  })
})

describe('the wheel', () => {
  test('Ctrl+wheel: a mouse notch animates, a trackpad pinch follows at once, a mix loses nothing', async () => {
    await compare([
      wheel(300, 300, { deltaY: -100 }, { ctrlKey: true }),
      ticks(2),
      wheel(300, 300, { deltaY: -6 }, { ctrlKey: true }),
      wheel(310, 300, { deltaY: -8 }, { ctrlKey: true }),
      ticks(1),
      wheel(310, 300, { deltaY: -100 }, { ctrlKey: true }),
      wheel(320, 300, { deltaY: -3 }, { ctrlKey: true }),
      settle,
      // Lines and pages count as notches; out past fit stops at fit.
      wheel(500, 400, { deltaY: 3, deltaMode: 1 }, { ctrlKey: true }),
      ticks(3),
      wheel(500, 400, { deltaY: 2, deltaMode: 2 }, { ctrlKey: true }),
      settle,
      wheel(500, 400, { deltaY: 400 }, { ctrlKey: true }),
      settle,
    ])
  })

  test('a plain wheel moves a zoomed image, Shift sideways; fitted, or with nothing turned, it does nothing', async () => {
    await compare([
      wheel(500, 400, { deltaY: 40 }),
      wheel(500, 400, { deltaX: 0, deltaY: 0 }, { ctrlKey: true }),
      toggle,
      settle,
      wheel(500, 400, { deltaY: 12 }),
      wheel(500, 400, { deltaX: -7, deltaY: 4 }),
      wheel(500, 400, { deltaY: 120 }),
      ticks(3),
      wheel(500, 400, { deltaY: 9 }),
      settle,
      wheel(500, 400, { deltaY: 100 }, { shiftKey: true }),
      ticks(2),
      wheel(500, 400, { deltaY: 3, deltaMode: 1 }),
      ticks(2),
      wheel(500, 400, { deltaY: 1, deltaMode: 2 }),
      settle,
    ])
  })

  test('a wheel during a drag is the drag’s', async () => {
    await compare([
      toggle,
      settle,
      pointer('pointerdown', 500, 400),
      pointer('pointermove', 540, 400),
      wheel(540, 400, { deltaY: -100 }, { ctrlKey: true }),
      wheel(540, 400, { deltaY: 40 }),
      pointer('pointerup', 540, 400),
      settle,
    ])
  })
})

describe('the keys', () => {
  test('+ and − step through round scales, 0 fits, the arrows move a zoomed image; others are not the zoom’s', async () => {
    const shots = await compare([
      key('ArrowLeft'),
      key('+'),
      ticks(3),
      key('='),
      settle,
      key('+', { ctrlKey: true }),
      settle,
      key('ArrowLeft'),
      ticks(2),
      key('ArrowDown'),
      settle,
      key('ArrowUp', { shiftKey: true }),
      key('ArrowRight', { ctrlKey: true }),
      key('ArrowRight', { metaKey: true }),
      key('+', { altKey: true }),
      key('a'),
      key('-'),
      ticks(2),
      key('_'),
      settle,
      key('0'),
      settle,
    ])
    expect(lineOf(shots.at(-1), 'log')).toContain('a:false')
  })

  test('the keys wait while a finger is down, and once the image is gone', async () => {
    await compare([
      pointer('pointerdown', 500, 400, touch(1)),
      key('+'),
      pointer('pointerup', 500, 400, touch(1)),
      settle,
      s => s.stage.remove(),
      key('+'),
    ])
  })
})

describe('fingers', () => {
  test('two fingers pinch around their middle; one lifted, the other moves it; let go, it glides', async () => {
    await compare([
      pointer('pointerdown', 400, 300, touch(1)),
      ticks(1),
      pointer('pointerdown', 600, 300, touch(2)),
      ...line([600, 300], [800, 320], 5).flatMap(([x, y]): Step[] => [
        ticks(1),
        pointer('pointermove', x, y, touch(2)),
      ]),
      ...line([400, 300], [300, 280], 3).flatMap(([x, y]): Step[] => [
        ticks(1),
        pointer('pointermove', x, y, touch(1)),
      ]),
      ticks(1),
      pointer('pointerup', 800, 320, touch(2)),
      ...line([300, 280], [420, 300], 4).flatMap(([x, y]): Step[] => [
        ticks(1),
        pointer('pointermove', x, y, touch(1)),
      ]),
      pointer('pointerup', 420, 300, touch(1)),
      ticks(4),
      settle,
    ])
  })

  test('pinched past the largest zoom or below fit it follows less and less, and goes back on letting go', async () => {
    await compare([
      pointer('pointerdown', 480, 390, touch(1)),
      pointer('pointerdown', 520, 390, touch(2)),
      ...line([520, 390], [1000, 390], 8).flatMap(([x, y]): Step[] => [
        ticks(1),
        pointer('pointermove', x, y, touch(2)),
      ]),
      ...line([480, 390], [20, 390], 8).flatMap(([x, y]): Step[] => [ticks(1), pointer('pointermove', x, y, touch(1))]),
      pointer('pointerup', 20, 390, touch(1)),
      pointer('pointerup', 1000, 390, touch(2)),
      ticks(5),
      settle,
      // From fit, pinched in: smaller than fit, softly; back to fit.
      key('0'),
      settle,
      pointer('pointerdown', 300, 390, touch(3)),
      pointer('pointerdown', 700, 390, touch(4)),
      ...line([700, 390], [420, 390], 6).flatMap(([x, y]): Step[] => [
        ticks(1),
        pointer('pointermove', x, y, touch(4)),
      ]),
      pointer('pointercancel', 420, 390, touch(4)),
      pointer('pointerup', 300, 390, touch(3)),
      settle,
    ])
  })

  test('a double-tap zooms in at the spot and back; taps too slow or too far apart do not', async () => {
    await compare([
      pointer('pointerdown', 500, 400, touch(1)),
      ticks(1, 40),
      pointer('pointerup', 500, 400, touch(1)),
      ticks(1, 120),
      pointer('pointerdown', 505, 398, touch(1)),
      ticks(1, 40),
      pointer('pointerup', 505, 398, touch(1)),
      settle,
      pointer('pointerdown', 300, 300, touch(1)),
      pointer('pointerup', 300, 300, touch(1)),
      ticks(1, 120),
      pointer('pointerdown', 302, 300, touch(1)),
      pointer('pointerup', 302, 300, touch(1)),
      settle,
      // Too slow, then too far: no toggle.
      pointer('pointerdown', 300, 300, touch(1)),
      pointer('pointerup', 300, 300, touch(1)),
      ticks(1, 400),
      pointer('pointerdown', 300, 300, touch(1)),
      pointer('pointerup', 300, 300, touch(1)),
      ticks(1, 100),
      pointer('pointerdown', 380, 300, touch(1)),
      pointer('pointerup', 380, 300, touch(1)),
      // A long press is no tap.
      pointer('pointerdown', 380, 300, touch(1)),
      ticks(30),
      pointer('pointerup', 380, 300, touch(1)),
      settle,
    ])
  })

  test('Safari’s trackpad pinch (gesture events) zooms around where it is; with a finger down it is only kept from the page', async () => {
    await compare([
      gesture('gesturestart', 500, 400),
      gesture('gesturechange', 500, 400, 1.6),
      gesture('gesturechange', 500, 400, 2.4),
      gesture('gestureend', 500, 400, 2.4),
      gesture('gesturechange', 500, 400, 4),
      pointer('pointerdown', 500, 400, touch(1)),
      gesture('gesturestart', 500, 400),
      gesture('gesturechange', 500, 400, 0.5),
      pointer('pointerup', 500, 400, touch(1)),
      settle,
    ])
  })
})

describe('around it', () => {
  test('a new window size keeps a fitted image fitted, and a zoomed one on the same spot', async () => {
    await compare([
      s => s.resize(800, 600),
      s => s.resize(800, 600),
      ...mouseClick(300, 200, 1),
      settle,
      s => s.resize(1200, 700),
      s => s.resize(0, 700),
      ...drag([500, 400], line([500, 400], [560, 400], 3)),
      ticks(2),
      s => s.resize(900, 650),
      settle,
    ])
  })

  test('reduced motion: every change at once, no glide and no soft edges', async () => {
    setReduced(true)
    try {
      await compare([
        ...mouseClick(600, 400, 1),
        ...drag([500, 400], line([500, 400], [1500, 400], 6)),
        key('+'),
        wheel(500, 400, { deltaY: -100 }, { ctrlKey: true }),
        pointer('pointerdown', 480, 390, touch(1)),
        pointer('pointerdown', 520, 390, touch(2)),
        pointer('pointermove', 900, 390, touch(2)),
        pointer('pointerup', 900, 390, touch(2)),
        pointer('pointerup', 480, 390, touch(1)),
        key('0'),
      ])
    } finally {
      setReduced(false)
    }
  })

  test('a raster image’s pixels turn crisp from three device pixels each; an SVG stays smooth', async () => {
    const small = { w: 64, h: 48 }
    for (const scene of [
      { size: small, dpr: 2 },
      { size: small, dpr: 1 },
      { size: small, dpr: 2, vector: true },
    ]) {
      const shots = await compare([key('+'), settle, key('+'), settle, key('+'), settle, toggle, settle], scene)
      expect(shots.some(s => lineOf(s, 'img').includes('pixelated'))).toBe(!scene.vector)
    }
  })

  test('a small image fits at its own size and zooms in to twice that; destroyed, its motion stops', async () => {
    await compare([...mouseClick(500, 400, 1), ticks(3), s => s.zoom.destroy(), ticks(2), key('-'), settle], {
      size: { w: 300, h: 200 },
    })
  })
})
