// Settings → Secrets… (components/secrets/SecretsPanel.tsx): what the page reads of GET
// /api/secrets, where a secret applies and when a session last got it in words, the profiles and
// the Claude sessions one can be set for, and what the form may send. Never a value: the view has
// none, and the form's own goes only into the POST that sets it (hooks/useSecrets.ts). Pure.
import type { BoardProfile } from '../../../src/core/payload.ts'
import {
  nameProblem,
  SECRET_MOST,
  SECRET_SCOPES,
  SECRET_USES,
  type SecretMeta,
  type SecretScope,
  type SecretsView,
  type SecretUse,
} from '../../../src/core/secret-store.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { longWhen } from '../../../src/core/when-format.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optional = (v: unknown, is: (x: unknown) => boolean): boolean => v === undefined || is(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const isSecretMeta = (v: unknown): v is SecretMeta =>
  isRecord(v) &&
  isText(v.id) &&
  isText(v.name) &&
  SECRET_SCOPES.includes(v.scope as SecretScope) &&
  (v.target === null || isText(v.target)) &&
  isTime(v.setAt) &&
  optional(v.targetName, isText) &&
  optional(v.usedAt, isTime) &&
  optional(v.usedBy, isText) &&
  optional(v.usedHow, h => SECRET_USES.includes(h as SecretUse))

/** GET /api/secrets's answer. */
export const isSecretsView = (v: unknown): v is SecretsView =>
  isRecord(v) && Array.isArray(v.secrets) && v.secrets.every(isSecretMeta)

/** A Claude session's id, the key the board has for one (a pi session's is its file's path). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A session's key as short as it reads: a Claude session id's first 8, a path's last part. */
export function shortKey(key: string): string {
  if (SESSION_ID.test(key)) return key.slice(0, 8)
  return key.split(/[\\/]/).filter(Boolean).at(-1) ?? key
}

/** A session by its key: the board's name for it now, else `kept` (its name when set), else its short key. */
export function sessionName(key: string, items: readonly Item[], kept?: string): string {
  return items.find(i => i.key === key)?.name || kept || shortKey(key)
}

/** Where it applies: "Everywhere", "Profile: Work" (the id while the board has no such profile), "Session: Alpha". */
export function scopeLabel(
  s: SecretMeta,
  profiles: readonly BoardProfile[] | undefined,
  items: readonly Item[],
  t: Translator,
): string {
  const target = s.target ?? ''
  if (s.scope === 'profile')
    return t('secrets.scope.profile', { title: profiles?.find(p => p.id === target)?.title ?? target })
  if (s.scope === 'session') return t('secrets.scope.session', { name: sessionName(target, items, s.targetName) })
  return t('secrets.scope.global')
}

/** When it was set. */
export const setLine = (s: SecretMeta, t: Translator, now: number): string =>
  t('secrets.set', { when: longWhen(s.setAt, t, now) })

/** When a session last got it, which one and how; or that none has yet. */
export function usedLine(s: SecretMeta, items: readonly Item[], t: Translator, now: number): string {
  if (s.usedAt === undefined) return t('secrets.unused')
  const when = longWhen(s.usedAt, t, now)
  if (!s.usedBy || !s.usedHow) return t('secrets.usedAt', { when })
  return t('secrets.used', { when, name: sessionName(s.usedBy, items), how: t(`secrets.how.${s.usedHow}`) })
}

/** One option of the form's profile or session select. */
export interface Choice {
  id: string
  label: string
}

/** The profiles a secret can be for: the board's, a hidden one said so; `keep`, the one replaced, though the board has it no more. */
export function profileChoices(
  profiles: readonly BoardProfile[] | undefined,
  t: Translator,
  keep?: string | null,
): Choice[] {
  const list = profiles ?? []
  const choices = [...list.filter(p => !p.hidden), ...list.filter(p => p.hidden)].map(p => ({
    id: p.id,
    label: p.hidden ? t('secrets.hidden', { title: p.title }) : p.title,
  }))
  return keep && !choices.some(c => c.id === keep) ? [...choices, { id: keep, label: keep }] : choices
}

/**
 * The Claude sessions a secret can be for: the board's items keyed by a Claude session id, asleep
 * ones too (said so), by name; `keep`, the one replaced, though gone from the board.
 */
export function sessionChoices(items: readonly Item[], t: Translator, keep?: { id: string; name?: string }): Choice[] {
  const byKey = new Map(items.filter(i => SESSION_ID.test(i.key)).map(i => [i.key, i]))
  const choices = [...byKey.values()]
    .sort((a, b) => a.name.localeCompare(b.name, t.lang))
    .map(i => ({ id: i.key, label: i.sleeping ? t('secrets.asleep', { name: i.name }) : i.name }))
  return keep && !byKey.has(keep.id) ? [...choices, { id: keep.id, label: keep.name || shortKey(keep.id) }] : choices
}

/** What is typed into the form. The value lives here only until the board answered its POST. */
export interface SecretForm {
  name: string
  scope: SecretScope
  /** The profile's or session's id; null for everywhere, or until one is picked. */
  target: string | null
  /** The session's name when the secret replaced was set (a session gone from the board). */
  targetName?: string
  value: string
}

export const EMPTY_FORM: SecretForm = { name: '', scope: 'global', target: null, value: '' }

/** The form for replacing a secret: its name and place, never its value. */
export const formOf = (s: SecretMeta): SecretForm => ({
  name: s.name,
  scope: s.scope,
  target: s.target,
  ...(s.targetName !== undefined && { targetName: s.targetName }),
  value: '',
})

/** What is wrong with a name typed, in the board's words; null while none is typed. */
export function nameError(name: string, t: Translator): string | null {
  const typed = name.trim()
  if (!typed) return null
  const problem = nameProblem(typed)
  return problem ? t(`secrets.err.${problem}`, { name: typed }) : null
}

/** A value's length as the board counts it (UTF-8 bytes). */
const bytes = (value: string): number => new TextEncoder().encode(value).length

/** What is wrong with a value typed, in the board's words; null while none is typed. */
export function valueError(value: string, t: Translator): string | null {
  if (value.includes('\0')) return t('secrets.err.nul')
  return bytes(value) > SECRET_MOST ? t('secrets.err.long', { most: SECRET_MOST / 1024 }) : null
}

/** POST /api/secrets setting a secret. */
export interface SetBody {
  op: 'set'
  name: string
  scope: SecretScope
  target: string | null
  targetName?: string
  value: string
}

/** What Save sends, or null while the form cannot be sent (a name the board refuses, no place picked, no value). */
export function setBody(form: SecretForm, items: readonly Item[]): SetBody | null {
  const name = form.name.trim()
  if (nameProblem(name) || form.value === '' || form.value.includes('\0') || bytes(form.value) > SECRET_MOST)
    return null
  if (form.scope === 'global') return { op: 'set', name, scope: 'global', target: null, value: form.value }
  if (!form.target) return null
  if (form.scope === 'profile') return { op: 'set', name, scope: 'profile', target: form.target, value: form.value }
  const targetName = items.find(i => i.key === form.target)?.name || form.targetName
  return {
    op: 'set',
    name,
    scope: 'session',
    target: form.target,
    ...(targetName && { targetName }),
    value: form.value,
  }
}

/** The secret the form would replace: the same name and place. */
export function replaced(form: SecretForm, secrets: readonly SecretMeta[]): SecretMeta | undefined {
  if (form.scope !== 'global' && !form.target) return undefined
  const name = form.name.trim()
  const target = form.scope === 'global' ? null : form.target
  return secrets.find(s => s.name === name && s.scope === form.scope && s.target === target)
}
