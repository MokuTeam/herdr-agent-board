// The agent's display drawn into its canvas (web/src/models/desk-screen.ts) in the order the VNC
// client hands it over: with no JPEG being decoded each is drawn at once, as before; what comes
// after a JPEG waits until it is drawn, however long its decoding takes and whatever is decoded
// after it first; a JPEG that does not decode is left out and the rest still drawn.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { canvasScreen, type Decoded } from '../../web/src/models/desk-screen.ts'

// Bun has no ImageData: a stand-in for these tests only.
const hadImageData = 'ImageData' in globalThis
beforeAll(() => {
  if (!hadImageData)
    (globalThis as Record<string, unknown>).ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
})
afterAll(() => {
  if (!hadImageData) delete (globalThis as Record<string, unknown>).ImageData
})

/** A canvas whose context says what was drawn, and JPEGs decoded when the test says. */
function scene() {
  const drawn: string[] = []
  const ctx = {
    fillStyle: '',
    putImageData: (img: ImageData, x: number, y: number) => drawn.push(`put ${x},${y} ${img.width}x${img.height}`),
    drawImage: (src: { name?: string }, ...at: number[]) => drawn.push(`draw ${src.name ?? 'canvas'} ${at.join(' ')}`),
    fillRect: (x: number, y: number, w: number, h: number) => drawn.push(`fill ${ctx.fillStyle} ${x},${y} ${w}x${h}`),
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement
  const decoding: { name: string; done: (ok: boolean) => void }[] = []
  const closed: string[] = []
  const screen = canvasScreen(canvas, data => {
    const name = `jpeg${data[0]}`
    return new Promise<Decoded>((resolve, reject) =>
      decoding.push({
        name,
        done: ok =>
          ok ? resolve({ name, close: () => closed.push(name) } as unknown as Decoded) : reject(new Error()),
      }),
    )
  })
  const decoded = async (name: string, ok = true) => {
    decoding.find(d => d.name === name)?.done(ok)
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { screen, canvas, drawn, closed, decoded }
}

const px = (w: number, h: number) => new Uint8ClampedArray(w * h * 4)

describe('the picture in its canvas', () => {
  test('with nothing being decoded each is drawn at once, as before', () => {
    const s = scene()
    s.screen.size(8, 6)
    s.screen.put(1, 2, 2, 1, px(2, 1))
    s.screen.copy(0, 0, 4, 4, 2, 2)
    s.screen.fill(0, 0, 3, 3, 10, 20, 30)
    expect([s.canvas.width, s.canvas.height]).toEqual([8, 6])
    expect(s.drawn).toEqual(['put 1,2 2x1', 'draw canvas 0 0 2 2 4 4 2 2', 'fill rgb(10,20,30) 0,0 3x3'])
  })

  test('what comes after a JPEG waits for it, then all in their order', async () => {
    const s = scene()
    s.screen.put(0, 0, 1, 1, px(1, 1))
    s.screen.jpeg(0, 0, 4, 4, Uint8Array.of(1))
    s.screen.put(1, 1, 1, 1, px(1, 1))
    s.screen.fill(2, 2, 1, 1, 0, 0, 0)
    s.screen.copy(0, 0, 3, 3, 1, 1)
    s.screen.size(10, 10)
    expect(s.drawn).toEqual(['put 0,0 1x1'])
    expect(s.canvas.width).toBe(0)
    await s.decoded('jpeg1')
    expect(s.drawn).toEqual([
      'put 0,0 1x1',
      'draw jpeg1 0 0 4 4',
      'put 1,1 1x1',
      'fill rgb(0,0,0) 2,2 1x1',
      'draw canvas 0 0 1 1 3 3 1 1',
    ])
    expect(s.canvas.width).toBe(10)
    expect(s.closed).toEqual(['jpeg1'])
  })

  test('a later JPEG decoded first is still drawn after the earlier one', async () => {
    const s = scene()
    s.screen.jpeg(0, 0, 2, 2, Uint8Array.of(1))
    s.screen.jpeg(0, 0, 2, 2, Uint8Array.of(2))
    s.screen.put(5, 5, 1, 1, px(1, 1))
    await s.decoded('jpeg2')
    expect(s.drawn).toEqual([])
    await s.decoded('jpeg1')
    expect(s.drawn).toEqual(['draw jpeg1 0 0 2 2', 'draw jpeg2 0 0 2 2', 'put 5,5 1x1'])
    // nothing waits any more: at once again
    s.screen.put(6, 6, 1, 1, px(1, 1))
    expect(s.drawn.at(-1)).toBe('put 6,6 1x1')
  })

  test('a JPEG that does not decode is left out; what follows is drawn', async () => {
    const s = scene()
    s.screen.jpeg(0, 0, 2, 2, Uint8Array.of(3))
    s.screen.put(1, 1, 1, 1, px(1, 1))
    await s.decoded('jpeg3', false)
    expect(s.drawn).toEqual(['put 1,1 1x1'])
  })
})
