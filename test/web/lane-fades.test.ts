// The lanes control's fading edges kept up (hooks/useLaneFades.ts followLaneFades) in a fake DOM
// (support/fake-dom.ts): as the strip scrolls and as the window resizes, and no more once stopped.
import { expect, test } from 'bun:test'
import { followLaneFades } from '../../web/src/hooks/useLaneFades.ts'
import { FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { asDom } from './support/react-commit.ts'

test('scrolled, the strip fades where more lanes are past its edge; the window resized, again; stopped, no more', async () => {
  const world = new FakeWorld({ viewport: { w: 1200, h: 800 } })
  world.install()
  try {
    const [node] = parseHtml('<div class="segmented" id="lanes"></div>')
    if (node?.kind !== 'element') throw new Error('no strip')
    const seg = world.mount(node)
    // What layout gives the strip: its lanes' width, its own, how far it is scrolled.
    const box = { scrollWidth: 600, clientWidth: 300, scrollLeft: 0 }
    for (const key of ['scrollWidth', 'clientWidth', 'scrollLeft'] as const)
      Object.defineProperty(seg, key, { get: () => box[key], configurable: true })
    const fades = () => ['fade-start', 'fade-end'].filter(name => seg.classList.contains(name))

    const stop = followLaneFades(asDom(seg))
    expect(fades()).toEqual([])
    await world.fire(seg, 'scroll')
    expect(fades()).toEqual(['fade-end'])
    box.scrollLeft = 150
    await world.fire(seg, 'scroll')
    expect(fades()).toEqual(['fade-start', 'fade-end'])
    box.scrollLeft = 300
    await world.fire(seg, 'scroll')
    expect(fades()).toEqual(['fade-start'])
    // A wider window: every lane shows, nothing fades.
    box.clientWidth = 600
    box.scrollLeft = 0
    await world.fire(world.window, 'resize')
    expect(fades()).toEqual([])

    stop()
    box.clientWidth = 300
    await world.fire(seg, 'scroll')
    await world.fire(world.window, 'resize')
    expect(fades()).toEqual([])
  } finally {
    world.uninstall()
  }
})
