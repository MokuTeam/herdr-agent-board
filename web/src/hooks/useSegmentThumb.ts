// The lanes control's thumb under the picked lane: it springs to a newly picked one and jumps
// when the lanes change or the window resizes.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useSpring } from './useSpring.ts'

/** `lanes` changes whenever the set of lanes, their titles or counts do. */
export function useSegmentThumb(
  control: RefObject<HTMLElement | null>,
  thumb: RefObject<HTMLElement | null>,
  picked: string,
  lanes: string,
): void {
  const drawn = useRef<string | null>(null)
  const x = useSpring({
    damping: 1,
    response: 0.32,
    onUpdate: value => {
      if (thumb.current) thumb.current.style.transform = `translateX(${value}px)`
    },
  })
  const w = useSpring({
    damping: 1,
    response: 0.32,
    onUpdate: value => {
      if (thumb.current) thumb.current.style.width = `${value}px`
    },
  })

  const place = useCallback(
    (jump: boolean) => {
      const buttons = [...(control.current?.querySelectorAll('button') ?? [])]
      const button = buttons.find(b => b.dataset.id === picked) ?? buttons[0]
      if (!button) return
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
    [control, picked, x, w],
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
}
