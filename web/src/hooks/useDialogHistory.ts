// The Back button on a phone closes the layer on top, one at a time (models/lifecycle.ts
// dialogHistory). The page lists its layers topmost first (PAGE_LAYERS): a menu, the launch
// window, the quick look, the terminal window, the helpers window, the usage popover, the setup
// list, a side panel.
import { useEffect, useRef } from 'react'
import { anyLayerOpen, type DialogLayer, dialogHistory, topLayer } from '../models/lifecycle.ts'
import { PHONE_QUERY } from '../models/panel-motion.ts'
import { useLatest } from './useLatest.ts'

export function useDialogHistory(
  layers: readonly DialogLayer[],
  opts?: { always?: boolean; isAlways?: () => boolean },
): void {
  const isAlways = opts?.isAlways ?? (() => opts?.always ?? false)
  const latest = useLatest({ layers, isAlways })
  const back = useRef<ReturnType<typeof dialogHistory> | null>(null)

  useEffect(() => {
    // Made once for the page: after a reload it steps back over the sentinel it may have left.
    back.current ??= dialogHistory({
      history,
      mobile: () => matchMedia(PHONE_QUERY).matches,
      always: () => latest.current.isAlways(),
      isOpen: () => anyLayerOpen(latest.current.layers),
      closeTop: () => topLayer(latest.current.layers)?.close(),
    })
    const controller = back.current
    const onPop = () => controller.pop()
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [latest])

  const shown = `${layers.map(layer => (layer.open ? '1' : '0')).join('')}:${opts?.always ? '1' : '0'}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: a layer opening or closing is when to sync, not something it reads
  useEffect(() => back.current?.sync(), [shown])
}
