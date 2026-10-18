// The board's live connection and the Back button over open dialogs, without the DOM: the page
// hands in the event source, the snapshot request and the history object.

/** What `boardConnection` needs of an EventSource. */
export interface BoardStream {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  close(): void
}

/** A board as it came over the wire: only `items` is checked here. */
export type BoardMessage = { items: unknown[]; [key: string]: unknown }

export interface ConnectionOptions {
  source: () => BoardStream
  snapshot: (signal: AbortSignal) => Promise<unknown>
  /**
   * Whether the page can read this board (api/client.ts isBoardPayload); every board by default.
   * One it cannot read is not taken, and the page is not connected until a board it can read comes.
   */
  readable?: (value: BoardMessage) => boolean
  data: (value: BoardMessage) => void
  connected: (value: boolean) => void
}

const isBoard = (value: unknown): value is BoardMessage =>
  typeof value === 'object' && value !== null && 'items' in value && Array.isArray(value.items)

// Resume always opens a new transport and fetches an uncached snapshot. Epochs
// and the first SSE event keep delayed replies from restoring an older board.
export function boardConnection({ source, snapshot, readable = () => true, data, connected }: ConnectionOptions) {
  let epoch = 0
  let stream: BoardStream | null = null
  let controller: AbortController | null = null
  function suspend(): void {
    ++epoch
    stream?.close()
    controller?.abort()
    connected(false)
  }
  function resume(): void {
    suspend()
    const current = epoch
    controller = new AbortController()
    let eventReceived = false
    let transportReady = false
    let hasSnapshot = false
    stream = source()
    stream.onopen = () => {
      if (current === epoch) {
        transportReady = true
        if (hasSnapshot) connected(true)
      }
    }
    stream.onerror = () => {
      if (current === epoch) {
        transportReady = false
        connected(false)
      }
    }
    stream.onmessage = event => {
      if (current !== epoch) return
      try {
        const value: unknown = JSON.parse(event.data)
        if (!isBoard(value)) return
        if (!readable(value)) return connected(false)
        eventReceived = true
        hasSnapshot = true
        transportReady = true
        data(value)
        connected(true)
      } catch {}
    }
    snapshot(controller.signal)
      .then(value => {
        if (current !== epoch || eventReceived || !isBoard(value)) return
        if (!readable(value)) return connected(false)
        hasSnapshot = true
        data(value)
        connected(transportReady)
      })
      .catch(() => {
        if (current === epoch && !eventReceived) connected(false)
      })
  }
  return { resume, suspend }
}

/** What `dialogHistory` needs of `window.history`. */
export interface HistoryLike {
  readonly state: unknown
  pushState(state: Record<string, unknown>, unused: string): void
  replaceState(state: Record<string, unknown>, unused: string): void
  back(): void
}

export interface DialogHistoryOptions {
  history: HistoryLike
  mobile: () => boolean
  isOpen: () => boolean
  closeTop: () => void
}

const MARKER = 'agentBoardDialog'
const entry = (state: unknown): Record<string, unknown> => (typeof state === 'object' ? { ...state } : {})
const marked = (state: unknown): boolean => !!entry(state)[MARKER]

// A single sentinel protects all open layers. Back closes only the top layer;
// manual close consumes the sentinel only when the last dialog is gone.
export function dialogHistory({ history, mobile, isOpen, closeTop }: DialogHistoryOptions) {
  let armed = false
  let pending = false
  function sync(): void {
    if (pending) return
    if (isOpen() && (mobile() || armed) && !armed) {
      history.pushState({ ...entry(history.state), [MARKER]: true }, '')
      armed = true
    } else if (!isOpen() && armed) {
      armed = false
      pending = true
      history.back()
    }
  }
  function pop(): void {
    if (pending) {
      pending = false
      sync()
      return
    }
    if (armed) {
      armed = false
      closeTop()
      sync()
    } else if (marked(history.state)) {
      const next = entry(history.state)
      delete next[MARKER]
      history.replaceState(next, '')
    }
  }
  // A reload closes dialogs but may leave our sentinel in the current entry.
  if (marked(history.state) && !isOpen()) {
    pending = true
    history.back()
  }
  return { sync, pop }
}

/**
 * A layer above the board that Back can close: a menu, the launch window, the quick look, the
 * terminal window, the helpers window, the usage popover, the setup list, a panel.
 */
export interface DialogLayer {
  open: boolean
  close(): void
}

/** The page lists its layers topmost first. */
export const anyLayerOpen = (layers: readonly DialogLayer[]): boolean => layers.some(layer => layer.open)
export const topLayer = (layers: readonly DialogLayer[]): DialogLayer | undefined => layers.find(layer => layer.open)

/** The page's layers, topmost first: the order Back closes them in (the old page's dialogBack). */
export const PAGE_LAYERS = ['menu', 'launch', 'files', 'terminal', 'helpers', 'limits', 'setup', 'panels'] as const
export type PageLayer = (typeof PAGE_LAYERS)[number]

/** The page's layers in that order. */
export const pageLayers = (layers: Record<PageLayer, DialogLayer>): DialogLayer[] =>
  PAGE_LAYERS.map(name => layers[name])
