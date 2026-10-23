// "Do it myself (one command)" in the Remote access panel (components/access/OneCommand.tsx): the
// one command the board makes for the owner to paste on the server, what is inside it, its Undo
// command, and the flag Test connection carries in this mode (the simple-setup spec's call 11).
// Every name the page shares with the board for it is here, in one place: the route and the flag
// are provisional until the board's side (core/server-oneshot.ts, its route) lands, and are
// aligned here then.
import type { AccessView } from '../../../src/core/access.ts'
import type { TunnelConfig } from '../../../src/core/tunnel.ts'
import type { Translator } from '../../../src/core/types.ts'
import { api, errorText } from '../api/client.ts'

/** The board's local-only route that answers with the one command (provisional name). */
export const ONESHOT_PATH = '/api/access/oneshot'

/** What the route answers: the command to paste, the script inside it (readable), and the Undo command. */
export interface Oneshot {
  command: string
  script: string
  undoCommand: string
}

export const isOneshot = (v: unknown): v is Oneshot => {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.command === 'string' && typeof o.script === 'string' && typeof o.undoCommand === 'string'
}

/** The command as the panel has it: not asked yet, on its way, made (for these settings), or why not (for these). */
export type OneshotGot =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; oneshot: Oneshot; stamp: string }
  | { state: 'error'; error: string; stamp: string }

export const ONESHOT_IDLE: OneshotGot = { state: 'idle' }

/**
 * What the command is made of on the board's side (its address, its login on the server, the
 * socket, the public port, the board's key): a command made for other values is made again.
 */
export const oneshotStamp = (settings: TunnelConfig, publicKey: string | null): string =>
  JSON.stringify([settings.domain, settings.user, settings.socket, settings.publicPort, publicKey])

/** The command from the board, or the words it was refused in. */
export async function loadOneshot(t: Translator, stamp: string): Promise<OneshotGot> {
  try {
    const oneshot = await api.get(ONESHOT_PATH, isOneshot, { cache: 'no-store' })
    return { state: 'ok', oneshot, stamp }
  } catch (err) {
    return { state: 'error', error: errorText(err, t), stamp }
  }
}

/**
 * Test connection's body in "Do it myself": with no setup on record, the board finds the public
 * port the command set up (443, else 8443) and keeps it (call 11, provisional flag name); with one,
 * today's Test connection.
 */
export const oneshotTest = (view: AccessView): Record<string, unknown> => (view.server?.setup ? {} : { findPort: true })
