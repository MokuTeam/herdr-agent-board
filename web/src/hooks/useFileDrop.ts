// Files dropped anywhere on the session panel go with the message; while they are dragged over
// it, the panel lights up (`dropping`).
import { type DragEvent, useRef, useState } from 'react'
import { type DragStep, nextDropDepth } from '../models/composer.ts'
import { useLatest } from './useLatest.ts'

export interface DropHandlers {
  onDragEnter(e: DragEvent<HTMLElement>): void
  onDragOver(e: DragEvent<HTMLElement>): void
  onDragLeave(e: DragEvent<HTMLElement>): void
  onDrop(e: DragEvent<HTMLElement>): void
}

const hasFiles = (e: DragEvent<HTMLElement>) => [...(e.dataTransfer?.types ?? [])].includes('Files')

export function useFileDrop(onFiles: (files: File[]) => void): { dropping: boolean; handlers: DropHandlers } {
  const latest = useLatest(onFiles)
  const [dropping, setDropping] = useState(false)
  const depth = useRef(0)
  const [handlers] = useState<DropHandlers>(() => {
    const step = (e: DragEvent<HTMLElement>, kind: DragStep) => {
      depth.current = nextDropDepth(depth.current, kind, hasFiles(e))
      setDropping(depth.current > 0)
    }
    return {
      onDragEnter: e => step(e, 'enter'),
      onDragOver(e) {
        if (hasFiles(e)) e.preventDefault()
      },
      onDragLeave: e => step(e, 'leave'),
      onDrop(e) {
        if (!hasFiles(e)) return
        e.preventDefault()
        step(e, 'drop')
        latest.current([...e.dataTransfer.files])
      },
    }
  })
  return { dropping, handlers }
}
