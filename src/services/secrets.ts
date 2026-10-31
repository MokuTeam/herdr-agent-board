// How the owner's secrets (core/secrets.ts, adapters/secret-store.ts) reach the sessions, and what
// the board's page and the `board secret` command change. Three ways in:
//   - Bash: Claude Code's SessionStart hook (entrypoints/hook.ts) writes the board's block in
//     $CLAUDE_ENV_FILE, which Claude Code runs before each Bash command. Where the session's
//     secrets can live in memory ($XDG_RUNTIME_DIR), the block only sources the session's env.sh
//     there, so Claude's folder (session-env/, which outlives the session by a month) holds a path
//     and no value; elsewhere (macOS, Windows) it holds the export lines themselves, the plain
//     assignments Claude Code's PowerShell reads too.
//   - Claude's own environment, which its MCP servers start with: `board resume`, spawn-agent's
//     start and `board launch` run Claude with them added to its env (never on a command line,
//     never typed into a pane).
//   - On demand: `board secret get NAME` prints one, `board secret file NAME` writes it to a file of
//     the session's own and prints the path; for the calling session's scopes only.
// Each way records when, to which session and how (last used). With no store nothing of this runs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isRecord } from '../adapters/json-store.ts'
import {
  type GivenSecret,
  listSecrets,
  markUsed,
  removeSecret,
  runDirInMemory,
  secretsFor,
  setSecret,
  writeSessionEnv,
} from '../adapters/secret-store.ts'
import { t } from '../core/lang.ts'
import { type Profile, profileForDir } from '../core/profiles.ts'
import {
  exportLines,
  nameProblem,
  placeOf,
  SECRET_MOST,
  type SecretCaller,
  type SecretMeta,
  type SecretsView,
  sourceLine,
  valueProblem,
  withBoardBlock,
} from '../core/secrets.ts'
import type { Translator } from '../core/types.ts'

type Env = Record<string, string | undefined>

/** The caller from its profile folder and its session: the board profile with that folder, if any. */
export const callerOf = (profiles: readonly Profile[], dir: string | null, session: string | null): SecretCaller => ({
  profile: profileForDir(profiles, dir)?.id ?? null,
  session,
})

/**
 * At SessionStart: the board's block in $CLAUDE_ENV_FILE for this session's secrets (none: the
 * block taken out, as a resumed session may have it from before). No env file (an older Claude
 * Code): nothing. Never throws; a value goes nowhere but env.sh (0600, in memory) or, where there
 * is no memory folder, the env file Claude Code made for the session.
 */
export function sessionStartSecrets(who: SecretCaller & { session: string }, env: Env = process.env): void {
  const envFile = env.CLAUDE_ENV_FILE
  if (!envFile) return
  try {
    const given = secretsFor(who)
    const before = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
    // None for this session, and none from before: nothing is written anywhere.
    if (!given.length && withBoardBlock(before, null) === before) return
    let body: string | null = null
    if (given.length && runDirInMemory(env) && process.platform !== 'win32')
      body = sourceLine(writeSessionEnv(who.session, given, env))
    else if (given.length) body = exportLines(given)
    const after = withBoardBlock(before, body)
    if (after !== before) writeFileSync(envFile, after, { mode: 0o600 })
    markUsed(
      given.map(s => s.id),
      who.session,
      'env',
    )
  } catch {}
}

/**
 * `env` with the caller's secrets added, for Claude's own start (MCP servers take its env); the
 * same `env` when it gets none. A secret's name the env has already is replaced: the owner's
 * value for this session wins. Records them as used at the start when the session is known.
 */
export function launchEnv(env: Env, who: SecretCaller): Env {
  let given: GivenSecret[] = []
  try {
    given = secretsFor(who)
  } catch {
    return env
  }
  if (!given.length) return env
  const out: Env = { ...env }
  for (const s of given) out[s.name] = s.value
  if (who.session)
    markUsed(
      given.map(s => s.id),
      who.session,
      'launch',
    )
  return out
}

/** The page's list (GET /api/secrets): never a value. */
export const secretsView = (): SecretsView => ({ secrets: listSecrets() })

/** What a set or a removal answers: the page shows `error` as it is. */
export type SecretOp = { status: number; body: { ok: true; secret?: SecretMeta } | { ok: false; error: string } }

const refused = (error: string): SecretOp => ({ status: 409, body: { ok: false, error } })

/** Why a name or value is refused, in the board's language or `tr`'s (never the value); null when fine. */
export function secretProblem(name: unknown, value: unknown, tr: Translator = t): string | null {
  const n = nameProblem(name)
  if (n === 'name') return tr('secrets.err.name')
  if (n === 'reserved') return tr('secrets.err.reserved', { name: String(name) })
  const v = valueProblem(value)
  if (v === 'long') return tr('secrets.err.long', { most: SECRET_MOST / 1024 })
  return v ? tr(`secrets.err.${v}`) : null
}

/** What can be set for: the board's profiles by id, the sessions it knows by key. */
export interface SecretTargets {
  profile(id: string): boolean
  session(key: string): boolean
}

/**
 * A change from the page or the command: { op: 'set', name, scope, target, targetName?, value }
 * or { op: 'rm', id }. The value is checked, sealed and dropped; no answer and no error holds it.
 * `log` gets what went wrong in the store (never a value), the page a plain refusal.
 */
export function secretOp(body: unknown, targets: SecretTargets, log: (line: string) => void): SecretOp {
  const b = isRecord(body) ? body : {}
  try {
    if (b.op === 'rm') {
      if (typeof b.id !== 'string' || !removeSecret(b.id)) return refused(t('secrets.err.gone'))
      return { status: 200, body: { ok: true } }
    }
    if (b.op !== 'set') return refused(t('secrets.err.scope'))
    const problem = secretProblem(b.name, b.value)
    if (problem) return refused(problem)
    const place = placeOf(b.scope, b.target)
    if (
      !place ||
      (place.scope === 'profile' && !targets.profile(place.target ?? '')) ||
      (place.scope === 'session' && !targets.session(place.target ?? ''))
    )
      return refused(t('secrets.err.scope'))
    const targetName = typeof b.targetName === 'string' ? b.targetName.trim().slice(0, 200) : ''
    const secret = setSecret(place, String(b.name), String(b.value), targetName ? { targetName } : {})
    return { status: 200, body: { ok: true, secret } }
  } catch (err) {
    // The store's own trouble (a lock, a folder): its message names files, never a value.
    log(`secrets: ${err instanceof Error ? err.message : String(err)}`)
    return { status: 500, body: { ok: false, error: t('secrets.err.store') } }
  }
}
