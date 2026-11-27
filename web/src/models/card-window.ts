import { storage } from '../state/storage.ts'

export type CardWindowKind = 'session' | 'thread' | 'team' | 'terminal'
export type CardWindowView = 'panel' | 'modal'

export function readCardWindow(kind: CardWindowKind, fallback?: CardWindowView): CardWindowView {
  const saved = storage.read(`board.cardWindow.${kind}`)
  // The card choice supersedes the former split between master and ordinary sessions.
  const legacy = kind === 'session' && saved === null ? storage.read('board.cardWindow.master') : null
  const view = saved ?? legacy
  return view === 'panel' || view === 'modal' ? view : (fallback ?? (kind === 'terminal' ? 'modal' : 'panel'))
}

export function saveCardWindow(kind: CardWindowKind, view: CardWindowView): void {
  storage.set(`board.cardWindow.${kind}`, view)
}
