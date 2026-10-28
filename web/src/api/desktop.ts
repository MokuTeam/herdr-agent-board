// An agent's own browser through the board (the board's desktop routes): its display as raw RFB
// bytes over a WebSocket, the per-run token in the query as the terminal's stream has it (a
// WebSocket sends no headers), and who clicks and types in it.
import type { ItemDesktop } from '../../../src/core/types.ts'
import { api } from './client.ts'

export type DesktopControl = ItemDesktop['control']

export const desktopPath = (key: string, op: string): string => `/api/desktop/${encodeURIComponent(key)}/${op}`

/** The display's WebSocket on the page's own host: wss: under https. */
export function desktopSocketUrl(
  key: string,
  token: string,
  at: { protocol: string; host: string } = location,
): string {
  const scheme = at.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${at.host}${desktopPath(key, 'vnc')}?t=${encodeURIComponent(token)}`
}

/** Control to the owner or back to the agent; resolves who has it now, as the board says. */
export async function setDesktopControl(key: string, to: DesktopControl): Promise<DesktopControl> {
  const reply = await api.post(desktopPath(key, 'control'), { to })
  return reply.control === 'owner' || reply.control === 'agent' ? reply.control : to
}
