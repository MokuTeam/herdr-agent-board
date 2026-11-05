// A card's head gives way to its name (#324). The name is what tells one card from another, so it
// is the last thing in the row to be cut: what stands beside it keeps its whole width until the name
// would be cut, then gives way one step at a time, and only as far as the name needs
// (hooks/head-fitter.ts fits every card's row; styles/cards.css draws each step). Past every step
// the name is cut, in the middle when its end is what tells it apart, and whole in its tooltip.
import type { ProfileTag } from '../../../src/core/profile-tag.ts'
import type { BoardProfile } from '../api/client.ts'

/**
 * What gives way, in this order: the state word first (the dot's color and the column it stands in
 * say it already), then the profile tag, down to its mark (its color and initial), then the
 * schedule's time, down to the clock glyph (the time in its tooltip, as on a narrow card).
 */
export const HEAD_STEPS = ['status', 'profile', 'alarm'] as const
export type HeadStep = (typeof HEAD_STEPS)[number]

/** Where a name's parts meet: "Client-Case-Templates", "repo/branch", "notes.md". */
const JOINS = ['-', '_', '/', '.', ':']

/**
 * A name cut in the middle, its end kept: for "<Client>-<Case>-Templates" the end is what differs
 * from the next card, so a cut name reads "<Client>-<Ca…-Templates". The end: the last part after a
 * join, one word of 2 to 15 characters after it, with at least three characters before it. Null: a
 * name cut at its end, as before (prose, one word, a long last part).
 */
export function nameParts(name: string): { head: string; tail: string } | null {
  const at = Math.max(...JOINS.map(j => name.lastIndexOf(j)))
  if (at < 3) return null
  const head = name.slice(0, at)
  const tail = name.slice(at)
  if (tail.length < 3 || tail.length > 16 || /\s/.test(tail) || /\s$/.test(head)) return null
  return { head, tail }
}

/**
 * A profile tag as one mark, when the name needs the room: the profile's initial, or as many of its
 * first letters (up to three) as tell it from the other profiles shown; "?" for a folder no profile
 * has, "!" for a session in another profile than its start asked for (red, as the whole tag).
 */
export function profileMark(tag: ProfileTag<BoardProfile>, profiles: readonly BoardProfile[]): string {
  if (tag.kind === 'unknown') return '?'
  if (tag.kind === 'wrong') return '!'
  const letters = Array.from(tag.profile.title.trim())
  if (!letters.length) return '?'
  const others = profiles
    .filter(p => p.id !== tag.profile.id && !p.hidden)
    .map(p => Array.from(p.title.trim().toLocaleLowerCase()))
  let n = 1
  while (n < Math.min(3, letters.length) && others.some(o => same(o, letters, n))) n++
  const mark = letters.slice(0, n)
  return [mark[0]?.toLocaleUpperCase() ?? '', ...mark.slice(1)].join('')
}

const same = (other: string[], letters: string[], n: number): boolean =>
  other.slice(0, n).join('') === letters.slice(0, n).join('').toLocaleLowerCase()
