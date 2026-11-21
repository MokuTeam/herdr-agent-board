// "Add a server" on the page (#509, components/devices/AddServer.tsx): what the form reads of the
// board's view (GET /api/nodes/setup, core/node-setup.ts NodeSetupView), the words of a step and its
// state, and the command that logs Claude in on a node. The board says it all as data; the words
// are here.
import type { MasterState, NodeSetupView } from '../../../src/core/node-setup.ts'
import { NODE_USER } from '../../../src/core/node-texts.ts'
import type { Text } from '../../../src/core/server-plan.ts'
import type { Translator } from '../../../src/core/types.ts'

export type { NodeSetupView } from '../../../src/core/node-setup.ts'

/** The phases in which the board is at work: the form asks for the view again every second. */
export const SETUP_BUSY: readonly NodeSetupView['phase'][] = ['looking', 'applying', 'finishing', 'undoing']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The board's view, as far as the form reads it. */
export const isSetupView = (v: unknown): v is NodeSetupView =>
  isObject(v) && typeof v.phase === 'string' && Array.isArray(v.master) && Array.isArray(v.refusals)

/** A text of the board's in the page's words; '' for none. */
export const textOf = (x: Text | null | undefined, t: Translator): string => (x ? t(x.key, x.params) : '')

/** A step's state in words: a server step's (start, skip, ok, fail) or one of this computer's. */
export const stateWord = (state: MasterState | 'start', t: Translator): string =>
  state === 'wait' ? '' : t(`node.add.state.${state === 'start' ? 'run' : state}`)

/** What the form fails on that Continue picks up here: the master's half, or the end of an Undo. */
const CONTINUES = new Set([
  'node.setup.next.config',
  'node.setup.next.link',
  'node.setup.next.bundle',
  'node.setup.next.finish',
  'node.setup.next.undoConfig',
])
export const continues = (v: NodeSetupView): boolean => v.phase === 'failed' && !!v.next && CONTINUES.has(v.next.key)

/**
 * The command that logs Claude in on a node: a terminal on the server as the node user, where
 * Claude's own first start asks for the login (its link and code, design 10 item 1). `user`: the
 * admin's login when the form knows it; else ssh's own (~/.ssh/config, the agent).
 */
/** A host and a login that may go into a shell line as they are; anything else gets no command. */
const PLAIN_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/
const PLAIN_USER = /^[A-Za-z0-9._-]+$/
const PLAIN_KEY = /^[A-Za-z0-9 ._:/\\~-]+$/

/**
 * The command that logs Claude in on a node: a terminal on the server as the node user, where
 * Claude's own first start asks for the login (its link and code, design 10 item 1). `user`: the
 * admin's login when the form knows it, else `<admin>` for the owner to put in; `key`: the
 * admin's key file the form was given. null for a host or a login that is not plain (config.json
 * is the owner's, but a shell line is no place for `;` or `$(`).
 */
export function loginCommand(s: {
  host: string
  sshPort: number
  user?: string | undefined
  key?: string | undefined
}): string | null {
  if (!PLAIN_HOST.test(s.host) || (s.user && !PLAIN_USER.test(s.user)) || (s.key && !PLAIN_KEY.test(s.key))) return null
  const key = s.key ? `-i "${s.key}" ` : ''
  const port = s.sshPort !== 22 ? `-p ${s.sshPort} ` : ''
  return `ssh -t ${key}${port}${s.user || '<admin>'}@${s.host} sudo -iu ${NODE_USER} claude`
}

/**
 * The node's profiles that are not logged in to Claude. A device row counts only a folder that
 * says so; the form's last step, as the service's (services/nodes/setup.ts), every profile not yet
 * known to be logged in (`known: false`), so the two never disagree there.
 */
export const loggedOut = (profiles: readonly { id: string; loggedIn: boolean | null }[], known = true): string[] =>
  profiles.filter(p => (known ? p.loggedIn === false : p.loggedIn !== true)).map(p => p.id)

/** What Look found, in one line. */
export function foundLine(f: NonNullable<NodeSetupView['found']>, t: Translator): string {
  const gb = (mb: number): string => (Math.round(mb / 102.4) / 10).toString()
  return t('node.add.found', {
    os: f.os || '?',
    cpus: String(f.cpus),
    mem: gb(f.memTotalMb),
    disk: f.homeFreeMb === null ? '?' : gb(f.homeFreeMb),
  })
}

/** What the owner typed in the form. */
export interface SetupFields {
  host: string
  sshPort: string
  user: string
  key: string
  id: string
  port: string
  password: string
  sudoPassword: string
}

/** The login the form gives the board when the owner leaves it empty, as "Set up the server" does. */
export const DEFAULT_LOGIN = 'root'

/** POST /api/nodes/setup for Look (or Undo's Look): what was typed, trimmed; the empty ones left out. */
export function lookBody(op: 'look' | 'undo-look', f: SetupFields): Record<string, unknown> {
  const n = (s: string): number | string => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : s.trim())
  return {
    op,
    host: f.host.trim(),
    user: f.user.trim() || DEFAULT_LOGIN,
    ...(f.sshPort.trim() && { sshPort: n(f.sshPort) }),
    ...(f.key.trim() && { key: f.key.trim() }),
    ...(f.id.trim() && { id: f.id.trim() }),
    ...(f.port.trim() && { port: n(f.port) }),
    ...passwordsOf(f),
  }
}

/** The passwords typed, for a request that logs in; none typed: none sent (the keys alone). */
export const passwordsOf = (f: Pick<SetupFields, 'password' | 'sudoPassword'>): Record<string, string> => ({
  ...(f.password && { password: f.password }),
  ...(f.sudoPassword && { sudoPassword: f.sudoPassword }),
})
