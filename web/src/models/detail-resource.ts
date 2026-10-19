// A selected session's read-only detail request. Old replies never replace a
// new selection or resurrect a session removed by a newer board snapshot.

export type DetailStatus = 'idle' | 'loading' | 'ready' | 'error' | 'missing'

export interface DetailValue<T> {
  key: string | null
  data: T | null
  status: DetailStatus
  error: string
  /** When the last read came in. */
  at: number | null
}

export interface DetailOptions<T> {
  /** Reads one session's detail; an error with `missing: true` says the session is gone. */
  read(key: string, signal: AbortSignal): Promise<T>
  changed(value: DetailValue<T>): void
  now?: () => number
  timeoutMs?: number
}

export interface DetailResource<T> {
  snapshot(): DetailValue<T>
  reset(key: string | null): void
  cancel(): void
  missing(): void
  load(key: string): Promise<void>
}

interface Pending {
  controller: AbortController
  promise: Promise<void>
  timer: ReturnType<typeof setTimeout> | undefined
}

const fresh = <T>(key: string | null): DetailValue<T> => ({ key, data: null, status: 'idle', error: '', at: null })

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'missing' in error && !!error.missing

const messageOf = (error: unknown): string =>
  (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : '') || String(error)

export function detailResource<T>({
  read,
  changed,
  now = Date.now,
  timeoutMs = 15_000,
}: DetailOptions<T>): DetailResource<T> {
  let value: DetailValue<T> = fresh(null)
  let epoch = 0
  let pending: Pending | null = null
  const notify = () => changed({ ...value })
  function cancel() {
    ++epoch
    pending?.controller.abort()
    clearTimeout(pending?.timer)
    pending = null
  }
  return {
    snapshot: () => ({ ...value }),
    reset(key) {
      cancel()
      value = fresh(key)
    },
    cancel,
    missing() {
      if (value.status === 'missing') return
      cancel()
      value = { ...value, status: 'missing', error: '' }
      notify()
    },
    load(key) {
      if (value.key !== key) {
        cancel()
        value = fresh(key)
      }
      if (pending) return pending.promise
      const id = ++epoch
      const controller = new AbortController()
      value = { ...value, status: 'loading', error: '' }
      notify()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Request timed out'))
        }, timeoutMs)
      })
      const promise = Promise.race([Promise.resolve().then(() => read(key, controller.signal)), timeout])
        .then(
          data => {
            if (id !== epoch) return
            value = { key, data, status: 'ready', error: '', at: now() }
          },
          error => {
            if (id !== epoch) return
            value = { ...value, status: isMissing(error) ? 'missing' : 'error', error: messageOf(error) }
          },
        )
        .finally(() => {
          clearTimeout(timer)
          if (id === epoch) {
            pending = null
            notify()
          }
        })
      pending = { controller, promise, timer }
      return promise
    },
  }
}
