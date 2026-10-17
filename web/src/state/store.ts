// A value kept outside React (by code that moves things imperatively, like the side panels) that
// components read with useStore: they draw again whenever it changes.
import { useSyncExternalStore } from 'react'

export class Store<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  readonly get = (): T => this.value

  set(next: T): void {
    if (Object.is(next, this.value)) return
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
