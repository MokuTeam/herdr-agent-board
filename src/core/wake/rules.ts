// The rules wake gains in the board, beside what it ports from herdr-wake: whether a session may
// be put to sleep (only one that can be woken again), the one line typed into a pane to wake it
// (`board resume`, which sets the session's profile and folder itself, so the line has no `cd`, no
// path and no quotes, and every shell runs it), the key that clears the pane's prompt line first
// (by the pane's shell), and the sleepers a session's hooks see and wake (its own profile's only;
// the board sees every profile's).
//
// Pure: the adapters find the shell, the folders and the transcripts, and hand them in.
import { sameDir } from '../launch/names.ts'
import { absoluteProfileDir, defaultProfileDir, resolveProfileDir } from '../profiles.ts'
import { SESSION_ID } from '../resume.ts'

/** A sleeping session's profile, as wake's answers carry it: its folder, and its id when listed. */
export interface WakeProfile {
  dir: string
  id?: string
}

/** What keeps a session from being woken again. */
export type CannotWake = 'board' | 'profile' | 'transcript'

/** English, for the API and the reaper's reasons. */
export const CANNOT_WAKE: Record<CannotWake, string> = {
  board: 'board is not on PATH',
  profile: 'its profile folder is not known',
  transcript: 'no transcript in its profile folder',
}

/**
 * Call 9: what keeps a session from being put to sleep, or null when it could be woken again:
 * `board` on PATH (the wake line runs it), the session's profile folder known, its transcript in it.
 */
export function canWake(f: {
  boardOnPath: boolean
  profileDir: string | null | undefined
  transcript: string | null | undefined
}): CannotWake | null {
  if (!f.boardOnPath) return 'board'
  if (!f.profileDir) return 'profile'
  if (!f.transcript) return 'transcript'
  return null
}

const PLAIN = /^[A-Za-z0-9_.-]+$/

/** A profile id the wake line may carry as it is (herdr and every shell take it without quotes); '' is not one. */
export function plainProfile(id: string): boolean {
  return PLAIN.test(id)
}

/**
 * The one line typed into a pane to wake a session; null for what is not a session id (pi's and
 * Codex's keys, `pane-<id>`). `--profile <id>` only for a plain id; without it `board resume`
 * finds the folder from the session's card.
 */
export function wakeLine(session: string, profile?: string | null): string | null {
  if (!SESSION_ID.test(session)) return null
  return `board resume ${session}${profile && plainProfile(profile) ? ` --profile ${profile}` : ''}`
}

/** The key that clears the prompt line before the wake line is typed. */
export type ClearKey = 'esc' | 'ctrl+u'

const ESC_SHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell', 'cmd'])
const CTRL_U_SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'])

/**
 * Call 18: by the pane's shell (its process name, any case, `.exe` or not): Esc for PowerShell and
 * cmd, Ctrl+U for POSIX shells; an unknown one by the OS, as today.
 */
export function clearKeyFor(shell: string | null | undefined, platform: string = process.platform): ClearKey {
  const name = String(shell ?? '')
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (ESC_SHELLS.has(name)) return 'esc'
  if (CTRL_U_SHELLS.has(name)) return 'ctrl+u'
  return platform === 'win32' ? 'esc' : 'ctrl+u'
}

/**
 * Decision 9: the entries of the caller's own profile (CLAUDE_CONFIG_DIR; unset: the default
 * folder), the folder spelled any way. An entry without a profile is the default folder's; one
 * whose profile names no absolute folder is no caller's.
 */
export function ownSleepers<T extends { profile?: WakeProfile | undefined }>(
  list: readonly T[],
  o: { configDir: string | undefined; home: string; platform?: string },
): T[] {
  const platform = o.platform ?? process.platform
  const own = resolveProfileDir(o.configDir, o.home, platform)
  const fallback = defaultProfileDir(o.home, platform)
  return list.filter(e =>
    sameDir(e.profile === undefined ? fallback : absoluteProfileDir(e.profile.dir, o.home, platform), own),
  )
}
