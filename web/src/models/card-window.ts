import { storage } from '../state/storage.ts'

export type CardWindowKind = 'thread' | 'team' | 'terminal'
export type CardWindowView = 'panel' | 'modal'

export function readCardWindow(kind: CardWindowKind, fallback?: CardWindowView): CardWindowView {
  const saved = storage.read(`board.cardWindow.${kind}`)
  return saved === 'panel' || saved === 'modal' ? saved : (fallback ?? (kind === 'terminal' ? 'modal' : 'panel'))
}

export function saveCardWindow(kind: CardWindowKind, view: CardWindowView): void {
  storage.set(`board.cardWindow.${kind}`, view)
}
