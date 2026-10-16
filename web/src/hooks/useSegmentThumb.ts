// The lanes control's thumb under the picked lane: it springs to a newly picked one and jumps
// when the lanes change or the window resizes.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Spring } from '../../spring.js'

type Springs = { x: Spring; w: Spring }

/** `lanes` changes whenever the set of lanes, their titles or counts do. */
export function useSegmentThumb(
  control: RefObject<HTMLElement | null>,
  thumb: RefObject<HTMLElement | null>,
  picked: string,
  lanes: string,
): void {
  const springs = useRef<Springs | null>(null)
  const drawn = useRef<string | null>(null)

  const place = useCallback(
    (jump: boolean) => {
      const buttons = [...(control.current?.querySelectorAll('button') ?? [])]
      const button = buttons.find(b => b.dataset.id === picked) ?? buttons[0]
      if (!button) return
      if (!springs.current) springs.current = springsFor(thumb)
      const { x, w } = springs.current
      const left = button.offsetLeft
      const width = button.offsetWidth
      if (jump || !w.value) {
        x.set(left)
        w.set(width)
      } else if (x.target !== left || w.target !== width) {
        x.to(left)
        w.to(width)
      }
    },
    [control, thumb, picked],
  )

  // After every render, as the toolbar did on every board: the picked lane may have moved.
  useLayoutEffect(() => {
    const jump = drawn.current !== lanes
    drawn.current = lanes
    place(jump)
  })

  useEffect(() => {
    const onResize = () => place(true)
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [place])

  useEffect(
    () => () => {
      springs.current?.x.stop()
      springs.current?.w.stop()
    },
    [],
  )
}

function springsFor(thumb: RefObject<HTMLElement | null>): Springs {
  const apply = () => {
    const el = thumb.current
    if (!el) return
    el.style.transform = `translateX(${x.value}px)`
    el.style.width = `${w.value}px`
  }
  const x: Spring = new Spring({ damping: 1, response: 0.32, onUpdate: apply })
  const w: Spring = new Spring({ damping: 1, response: 0.32, onUpdate: apply })
  return { x, w }
}
