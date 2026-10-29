// One file in one of the quick look's viewers (components/files/viewers.ts openViewer) for as long
// as `key` (the file) stays the same: the element it draws into, and where it is (loading, shown,
// failed, no viewer). A new file, or the look gone, lets go of the viewer.
import { type RefObject, useEffect, useRef, useState } from 'react'
import { openViewer, type ViewerReport, type ViewerState } from '../components/files/viewers.ts'
import { useLatest } from './useLatest.ts'

export function useViewer<M, V extends { destroy(): void }>(
  key: string,
  load: () => Promise<M>,
  mount: (module: M, host: HTMLElement, report: ViewerReport) => V,
): { host: RefObject<HTMLDivElement | null>; state: ViewerState } {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ViewerState>({ at: 'loading' })
  const latest = useLatest({ load, mount })
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file (`key`) is when to open it anew
  useEffect(() => {
    const el = host.current
    if (!el) return
    return openViewer(
      () => latest.current.load(),
      (module, report) => latest.current.mount(module, el, report),
      setState,
    )
  }, [key, latest])
  return { host, state }
}
