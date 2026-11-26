// Addressing a peer's agent directly (#832), the pure rules: handles, the directory a board sends
// each peer, and the `@Name.handle` mention a person or an agent writes. Nothing here imports node:
// the page (web/src/models/team.ts) uses the mention rules for the composer's autocomplete.
//
// Exposure follows the lanes the owner already shares in the Team panel: with Agents on for a
// person, every session in a lane shared with them is listed for them by its handle (its name,
// lowercase, spaces to dashes; kept for the session), and nothing else is. On the wire a handle is
// the directory entry's `code` and the addressed copy's `at`.
import { sharesLane } from './team-agents.ts'
import { type DirectoryEntry, GENERAL, MAX_CODE, MAX_DIRECTORY, MAX_TITLE } from './team-wire.ts'

const CODE = new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_CODE - 1}}$`)
const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u

const ALIAS = new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_CODE - 1}}$`, 'i')
export const validAlias = (v: unknown): v is string => typeof v === 'string' && ALIAS.test(v)

/** A handle (a code on the wire): lowercase letters, digits and `-`, starting with a letter or digit, MAX_CODE at most. */
export const validCode = (v: unknown): v is string => typeof v === 'string' && CODE.test(v)

/** The owner's line about an agent: trimmed, printable, 1 to MAX_TITLE characters. */
export const validAbout = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= MAX_TITLE && !UNPRINTABLE.test(v)

/** The text a directory message carries, which a board without #832 never shows (it drops the message). */
export const DIRECTORY_TEXT = 'agent directory'

// The signed directory text was reserved for metadata. Keep the agent entries on the wire in
// the #832 format so older boards still read and acknowledge the same canonical handles.
const ALIAS_PREFIX = `${DIRECTORY_TEXT} aliases/1 `

export function directoryBody(list: DirectoryEntry[]) {
  const agents = list.map(({ alias: _alias, ...entry }) => entry)
  const aliases = list.map(entry => entry.alias ?? null)
  return {
    text: aliases.some(Boolean) ? ALIAS_PREFIX + JSON.stringify(aliases) : DIRECTORY_TEXT,
    agents,
  }
}

export function directoryAliases(text: string, list: DirectoryEntry[]): DirectoryEntry[] {
  if (!text.startsWith(ALIAS_PREFIX)) return list
  let aliases: unknown
  try {
    aliases = JSON.parse(text.slice(ALIAS_PREFIX.length))
  } catch {
    return list
  }
  if (!Array.isArray(aliases) || aliases.length !== list.length || !aliases.every(a => a === null || validAlias(a)))
    return list
  return list.map((entry, i) => {
    const alias: unknown = aliases[i]
    return validAlias(alias) ? { ...entry, alias } : entry
  })
}

/**
 * A directory as a board accepts it from a peer: a list of at most MAX_DIRECTORY entries, each
 * exactly `code` and an optional `about`, every code once. Null for anything else.
 */
export function readDirectory(v: unknown, stored = false): DirectoryEntry[] | null {
  if (!Array.isArray(v) || v.length > MAX_DIRECTORY) return null
  const out: DirectoryEntry[] = []
  const seen = new Set<string>()
  for (const e of v) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return null
    const r = e as Record<string, unknown>
    if (!Object.keys(r).every(k => k === 'code' || k === 'about' || (stored && k === 'alias'))) return null
    if (!validCode(r.code) || seen.has(r.code)) return null
    if (Object.hasOwn(r, 'about') && !validAbout(r.about)) return null
    if (Object.hasOwn(r, 'alias') && !validAlias(r.alias)) return null
    seen.add(r.code)
    out.push({
      code: r.code,
      ...(typeof r.about === 'string' && { about: r.about }),
      ...(validAlias(r.alias) && { alias: r.alias }),
    })
  }
  return out
}

/** A directory as compared with the one sent last: its entries by code, as JSON. */
export const directoryMark = (list: DirectoryEntry[]): string =>
  JSON.stringify([...list].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)))

/** A session as the directory sees it: its key, its name, its lane. */
export interface HandleSession {
  key: string
  name: string
  lane: string
}

/** Cyrillic letters in Latin (Russian and Ukrainian), so a handle stays typable on any keyboard. */
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/**
 * A session's handle from its name (#832): lowercase, spaces to dashes, Cyrillic in Latin, ASCII
 * letters, digits and dashes only (accents dropped), at most MAX_CODE long; null when nothing is
 * left of it (a name in another script), and the caller gives it `agent`.
 */
export function handleOf(name: string): string | null {
  const s = [...name.toLowerCase()]
    .map(c => CYRILLIC[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_CODE)
    .replace(/-+$/, '')
  return validCode(s) ? s : null
}

/** Handles kept at most: past this, those of sessions no longer on the board go first. */
export const MAX_HANDLES = 500

/**
 * The board's handles after a look at its sessions (#832): a session keeps the handle it has (across
 * restarts and renames: a stable address); a new one gets its name's, or the name's with `-2`,
 * `-3`... when a session on the board holds it. A handle whose session is no longer on the board
 * (archived, replaced) passes to a new session with that name: the board's mapping, never the old
 * key. `live`: every session on the board (by default those asking), so one in a lane shared with
 * nobody now keeps its handle. `have` is not changed.
 */
export function assignHandles(
  sessions: readonly { key: string; name: string }[],
  have: Record<string, string>,
  live: ReadonlySet<string> = new Set(sessions.map(s => s.key)),
) {
  const out: Record<string, string> = { ...have }
  const holder = (h: string): string | undefined => Object.keys(out).find(k => out[k] === h)
  for (const s of sessions) {
    if (out[s.key]) continue
    const base = handleOf(s.name) ?? 'agent'
    let h = base
    for (let n = 2; ; n++) {
      const k = holder(h)
      if (k === undefined) break
      if (!live.has(k)) {
        delete out[k]
        break
      }
      const tail = `-${n}`
      h = `${base.slice(0, MAX_CODE - tail.length).replace(/-+$/, '')}${tail}`
    }
    out[s.key] = h
  }
  const keys = Object.keys(out)
  if (keys.length > MAX_HANDLES)
    for (const k of keys.filter(k => !live.has(k)).slice(0, keys.length - MAX_HANDLES)) delete out[k]
  return out
}

/** What the directory and the router ask about the board now. */
export interface ReachWorld {
  /** Each session's handle, by its key. */
  handles: Record<string, string>
  aliases?: Record<string, string>
  /** The owner's global off. */
  off: boolean
  /** The switches by key: a peer's, the team's, a channel's. */
  peers: Record<string, { on: boolean; lanes?: readonly string[]; allLanes?: unknown } | undefined>
  /** The sessions on the board now, none archived or being archived. */
  sessions: readonly HandleSession[]
}

/**
 * The session a handle reaches for a message from `peer`, or null (#832): exposure follows the
 * lanes shared with that person. Agents on for them, the session on the board (not archived or
 * being archived) and its lane shared with them. Never a guess: the board's mapping or nothing.
 */
export function reach(code: string, peer: string, w: ReachWorld): HandleSession | null {
  const sw = w.peers[peer]
  if (w.off || !sw?.on) return null
  const key = Object.keys(w.handles).find(k => w.handles[k] === code)
  const s = key === undefined ? undefined : w.sessions.find(x => x.key === key)
  return s && sharesLane(sw, s.lane) ? s : null
}

/**
 * The directory for one peer: every session a message from them could reach now, by handle, the
 * first MAX_DIRECTORY in order (what one message carries).
 */
export function directoryFor(peer: string, w: ReachWorld): DirectoryEntry[] {
  return w.sessions
    .flatMap(s => {
      const code = w.handles[s.key]
      const alias = w.aliases?.[s.key]
      return code && reach(code, peer, w) ? [{ code, ...(alias && { alias }) }] : []
    })
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .slice(0, MAX_DIRECTORY)
}

/** A peer's name as written after `@`: without its spaces, dots and `@`, which a mention cannot hold. */
export const mentionWord = (name: string): string => name.replace(/[\s.@]+/g, '')

const MENTION = new RegExp(`^\\s*@([^\\s.@]{1,43})\\.([a-z0-9][a-z0-9-]{0,${MAX_CODE - 1}})(?=$|[\\s,:;!?])`, 'u')

/** A leading `@Name.code` in a text: the name as written, the code, and the text after it. */
export function leadingMention(text: string): { who: string; code: string; rest: string } | null {
  const m = MENTION.exec(text)
  if (!m) return null
  return { who: m[1] as string, code: m[2] as string, rest: text.slice(m[0].length).replace(/^[\s,:;]+/, '') }
}

/** The peer a mention's name stands for: by its name without spaces (any case), or its id; null when none or several. */
export function peerOfWord<T extends { peer: string; name: string }>(word: string, roster: readonly T[]): T | null {
  const byId = roster.filter(p => p.peer === word)
  if (byId.length === 1) return byId[0] as T
  const w = word.toLowerCase()
  const hits = roster.filter(p => mentionWord(p.name).toLowerCase() === w)
  return hits.length === 1 ? (hits[0] as T) : null
}

type MentionPeer = { peer: string; name: string }
type AliasDirectory = { peer: string; agents: readonly DirectoryEntry[] }

/** Only aliases unique across the roster and all visible directories can be offered or expanded. */
export function publishedAliases(roster: readonly MentionPeer[], directories: readonly AliasDirectory[]) {
  const names = new Set(roster.flatMap(p => [mentionWord(p.name).toLowerCase(), p.peer.toLowerCase()]))
  const aliases = new Map<string, { alias: string; canonical: string; peer: string; code: string }>()
  const seen = new Set<string>()
  for (const d of directories) {
    const owner = roster.find(p => p.peer === d.peer)
    if (!owner) continue
    const word = mentionWord(owner.name)
    const who = word && peerOfWord(word, roster)?.peer === owner.peer ? word : owner.peer
    for (const e of d.agents) {
      if (!validAlias(e.alias)) continue
      const key = e.alias.toLowerCase()
      if (names.has(key) || seen.has(key)) {
        aliases.delete(key)
      } else {
        aliases.set(key, { alias: e.alias, canonical: `@${who}.${e.code}`, peer: d.peer, code: e.code })
      }
      seen.add(key)
    }
  }
  return aliases
}

const ALIAS_MENTION = new RegExp(`^(\\s*)@([a-z0-9][a-z0-9-]{0,${MAX_CODE - 1}})(?=$|[\\s,:;!?])`, 'i')

export function expandAlias(text: string, aliases: () => ReadonlyMap<string, { canonical: string }>): string {
  const m = ALIAS_MENTION.exec(text)
  const hit = m?.[2] && aliases().get(m[2].toLowerCase())
  return m && hit ? `${m[1]}${hit.canonical}${text.slice(m[0].length)}` : text
}

/**
 * What the composer completes at the caret: `@Na` (a name being written) or `@Name.co` (a code
 * name of that peer's), with where the mention starts. Null when the caret is in no mention.
 */
export function mentionAt(text: string, caret: number): { start: number; who: string; code: string | null } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s.@]{0,40})(?:\.([a-z0-9-]{0,40}))?$/u.exec(before)
  if (!m) return null
  const start = before.length - m[0].length + (m[1] as string).length
  return { start, who: m[2] as string, code: m[3] ?? null }
}

/** The topic an addressed message opens from a general thread: the handle and the text's start. */
export function mentionTitle(code: string, rest: string): string {
  const head = `@${code}`
  const words = rest.replace(new RegExp(UNPRINTABLE, 'gu'), '').replace(/\s+/g, ' ').trim()
  if (!words) return head
  const t = `${head}: ${words}`
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1).trimEnd()}…`
}

/** A post's target as the routes take it: a peer or `team`, and a thread by id, or a new one by title. */
export interface AddressTarget {
  to: string
  thread?: { id?: string; title?: string; link?: string; members?: string[] }
  replyTo?: string
}

/**
 * Where a post that starts with `@Name.handle` goes (#832). A topic with that peer (or a new one)
 * keeps it, with the agent named on the copy; from anywhere else (a general thread, the team chat,
 * a channel, a topic with someone else) it opens a topic of its own with that peer, titled by the
 * handle and the text. A text with no mention, or one naming nobody on the roster or a peer that
 * sent no directory, goes where it was going, as before #832. A handle not in that peer's directory
 * is refused (`agent`): never sent to a guessed agent.
 */
export function addressTarget(
  text: string,
  target: AddressTarget,
  w: {
    roster: readonly { peer: string; name: string }[]
    /** A peer's directory's handles, null when it sent none. */
    listed: (peer: string) => readonly string[] | null
  },
): ({ ok: true; at?: { peer: string; code: string } } & AddressTarget) | { ok: false; error: 'agent' } {
  const m = leadingMention(text)
  const p = m ? peerOfWord(m.who, w.roster) : null
  const codes = p ? w.listed(p.peer) : null
  if (!m || !p || !codes) return { ok: true, ...target }
  if (!codes.includes(m.code)) return { ok: false, error: 'agent' }
  const at = { peer: p.peer, code: m.code }
  // A topic with that peer keeps it; anything else opens one of its own with them. Addressing is
  // always a pair's: their board weighs it by the switches it keeps for this board.
  const t = target.thread
  const topic = !!t && (t.title !== undefined || (t.id !== undefined && t.id !== GENERAL))
  if (topic && target.to === p.peer) return { ok: true, ...target, at }
  return { ok: true, to: p.peer, thread: { title: mentionTitle(m.code, m.rest) }, at }
}
