// A preview can share cards with its writers while keeping schedules and other state private.
// Only an explicit absolute folder overrides the existing LOCALAPPDATA-based layout.
import { posix, win32 } from 'node:path'

export const CARD_STORE_ENV = 'HERDR_BOARD_CARDS_DIR'

export interface CardStore {
  cards: string
  state: string
  schedule: string
  explicit: boolean
  /** On Unix, LOCALAPPDATA is an override of the ordinary ~/.local/state location. */
  customState: boolean
}

export function cardStore(env: Record<string, string | undefined>, home: string, platform: string): CardStore {
  const path = platform === 'win32' ? win32 : posix
  const normal = path.join(home, '.local', 'state')
  const local = env.LOCALAPPDATA || normal
  const state = path.join(local, 'herdr', 'plugins', 'agent-board')
  const chosen = env[CARD_STORE_ENV]
  // Windows's \cards is rooted on the current drive, which can differ between writers.
  if (
    chosen &&
    (!path.isAbsolute(chosen) ||
      (platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(chosen)))
  )
    throw new Error(`${CARD_STORE_ENV} must be an absolute directory path`)
  return {
    cards: chosen ? path.normalize(chosen) : path.join(state, 'cards'),
    state,
    schedule: path.join(state, 'schedule'),
    explicit: !!chosen,
    customState: platform !== 'win32' && path.normalize(local) !== normal,
  }
}
