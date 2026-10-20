// A side question to a session from the board (core/aside.ts says what it is): Claude run once,
// on its own, in the folder the session's conversation was recorded in (Claude resumes a session
// only from there) and with the Claude profile that holds it, the question on stdin. Nothing is
// typed into the session and nothing is written to its conversation; the page shows the answer.
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { cwdOf } from '../adapters/claude-home.ts'
import { runTree } from '../adapters/process.ts'
import { ASIDE_MAX, type AsideAnswer, asideArgs, parseAside } from '../core/aside.ts'
import { t } from '../core/lang.ts'
import { callable } from '../core/mokupilot.ts'
import { configDirFor } from '../core/profiles.ts'
import type { Item } from '../core/types.ts'
import type { Deps } from './deps.ts'

/**
 * Claude Code's program on PATH, run without a shell: claude.exe on Windows (an npm install's
 * claude.cmd would need cmd.exe, which the board never runs), else claude; null when there is none.
 */
export function claudeOnPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  isFile: (path: string) => boolean = path => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
): string | null {
  const win = platform === 'win32'
  const path = win ? win32 : posix
  const name = win ? 'claude.exe' : 'claude'
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const file = path.join(dir.replace(/^"|"$/g, ''), name)
    if (isFile(file)) return file
  }
  return null
}

/** Whether the board can ask side questions here, for the page: looked up again once a minute. */
export function asideCheck({ now = Date.now, find = () => claudeOnPath() } = {}): () => boolean {
  let seen = { at: -Infinity, on: false }
  return () => {
    if (now() - seen.at > 60_000) seen = { at: now(), on: find() !== null }
    return seen.on
  }
}

export type AsideReply = ({ ok: true } & AsideAnswer) | { ok: false; error: string }

export interface AsideOptions {
  /** The page went away or cancelled: Claude is ended. */
  signal?: AbortSignal
  /** How long an answer may take. */
  timeoutMs?: number
  run?: typeof runTree
  env?: Record<string, string | undefined>
  /** Claude Code's program (claudeOnPath). */
  claude?: string | null
}

const tail = (s: string): string =>
  s
    .trim()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(-1)[0] ?? ''

/**
 * Ask `item` a side question: { ok, text, costUsd, tokens, ms } with the answer, or { ok: false,
 * error }. Only a Claude session with an id and a conversation on disk can be asked.
 */
export async function askAside(
  deps: Pick<Deps, 'profiles' | 'log'>,
  item: Pick<Item, 'agent' | 'session' | 'name' | 'cwd' | 'transcript' | 'claudeRoot'>,
  question: unknown,
  { signal, timeoutMs = 180_000, run = runTree, env = process.env, claude = claudeOnPath(env) }: AsideOptions = {},
): Promise<AsideReply> {
  const q = String(question ?? '').trim()
  if (!q) return { ok: false, error: t('aside.err.empty') }
  if (q.length > ASIDE_MAX) return { ok: false, error: t('aside.err.long', { n: ASIDE_MAX }) }
  if (!callable(item) || !item.session) return { ok: false, error: t('aside.err.notClaude', { name: item.name }) }
  if (!item.transcript) return { ok: false, error: t('aside.err.noTranscript', { name: item.name }) }
  if (!claude) return { ok: false, error: t('aside.err.noClaude') }
  const cwd = (await cwdOf(item.transcript)) || item.cwd
  // The profile that holds the conversation; the board's own keeps the env as it is.
  const configDir = item.claudeRoot ? configDirFor({ dir: item.claudeRoot }, deps.profiles().inheritedDir) : null
  // Not one of the board's panes, nor a session inside another one.
  const childEnv: Record<string, string | undefined> = { ...env, ...(configDir && { CLAUDE_CONFIG_DIR: configDir }) }
  for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) delete childEnv[key]
  const started = Date.now()
  const r = await run(claude, asideArgs(item.session), { cwd, env: childEnv, input: q, signal, timeout: timeoutMs })
  if (signal?.aborted) return { ok: false, error: t('aside.err.cancelled') }
  if (r.error?.code === 'ENOENT') return { ok: false, error: t('aside.err.noClaude') }
  if (r.killed) return { ok: false, error: t('aside.err.timeout', { s: Math.round(timeoutMs / 1000) }) }
  const parsed = parseAside(r.stdout, tail(r.stderr) || t('aside.err.none'))
  deps.log(
    `aside ${item.name}: ${parsed.ok ? `answered, $${parsed.answer.costUsd ?? '?'}` : parsed.error} in ${Date.now() - started} ms`,
  )
  return parsed.ok ? { ok: true, ...parsed.answer } : { ok: false, error: parsed.error }
}
