// The owner's team actions that need a passkey (#224), as pure rules. An agent runs as the same OS
// user as the board, so a header, a token in a file or a socket would not tell it from the owner;
// a passkey does, through the board's routes (not against a program that edits the board's files,
// which nothing on one machine stops). What sends as the owner, or widens what agents may do,
// waits for one: sending (the panel's Send, a held draft), trusting a changed key, Agents on, a
// lane added, a listener set. What narrows is never held back. A confirmed send unlocks sending for
// 30 minutes in the page that asked (services/team-confirm.ts keeps that in memory only).
//
// WebAuthn takes no IP as its RP ID, and the board is opened on 127.0.0.1, so a confirmation
// happens in a window of its own on `http://localhost:<port>`; its passkeys are for `localhost`,
// which a change of port keeps (the port is in the origin, not in the RP ID).

/** A pending action waits this long for its confirmation, and a challenge for its one use. */
export const CONFIRM_MS = 2 * 60_000
/** How long a confirmed send unlocks the owner's sending in that page. */
export const UNLOCK_MS = 30 * 60_000
/** Pending actions kept at once at most; the oldest goes first. */
export const MAX_PENDING = 20
/** The RP ID of the owner's passkeys. */
export const RP_ID = 'localhost'

/** The thread of a send, as POST /api/team/send takes it: { id } or { title, link? }. */
export interface SendThread {
  id?: string
  title?: string
  link?: string
}

export type OwnerAction =
  | { kind: 'send'; to: string; text: string; thread?: SendThread }
  | { kind: 'draft'; id: string }
  | { kind: 'trust'; peer: string }
  | { kind: 'agents'; change: Record<string, unknown> }
  | { kind: 'passkey-add' }
  | { kind: 'passkey-remove'; id: string }

/** The actions whose confirmation unlocks the owner's sending for a while. */
export const unlocks = (a: OwnerAction): boolean => a.kind === 'send' || a.kind === 'draft'

/** The origin of the confirmation window. */
export const confirmOrigin = (port: number): string => `http://localhost:${port}`

/** Where the panel opens the confirmation of `id`: the board's own page, on localhost. */
export const confirmUrl = (port: number, id: string): string => `${confirmOrigin(port)}/?confirm=${id}`

/** What the agents' switches are now, as far as widening goes. */
export interface AgentsNow {
  off: boolean
  peers: Record<string, { on: boolean; lanes: string[] } | undefined>
}

/**
 * Whether a change to the agents' switches (the body of POST /api/team/agents) gives agents more
 * than they have: the global switch back on, a listener set, a member's Agents on, a lane added,
 * a loop pause changed (#360). Turning things off, clearing the listener, removing lanes and
 * muting are free.
 */
export function widens(now: AgentsNow, change: Record<string, unknown>): boolean {
  if (change.listener !== undefined) return change.listener !== null
  if (change.off !== undefined) return change.off === false && now.off
  // A person's loop pause (#360): any change of it lets agents trade a different number of
  // messages, so the owner confirms it either way.
  if (change.loop !== undefined) return true
  const peer = typeof change.peer === 'string' ? now.peers[change.peer] : undefined
  if (change.on === true && !peer?.on) return true
  if (Array.isArray(change.lanes)) {
    const had = new Set(peer?.lanes ?? [])
    if (change.lanes.some(l => !had.has(l as string))) return true
  }
  return false
}
