// A session that comes back after herdr restarts, in its own Claude profile. herdr restores each
// pane with a new shell in its folder and types the session's resume command into it: by default
// its own `claude --resume <id>`, which runs in the shell's profile. The env the board gave a
// profile's tab (CLAUDE_CONFIG_DIR through herdr's --env) is not restored, nor is the folder an
// alias set for one Claude (cld-work), so a session in another profile than the default one is not
// found there. Such a session reports `board resume <id> --profile <id>` to herdr instead (the
// SessionStart hook, entrypoints/resume-report.ts): a command on PATH, which every shell runs, that
// sets the profile's folder and resumes the session with what the board starts sessions with. So
// does one in the default profile while wake's Telegram router is on and the board starts sessions
// through a launcher (claude-tg), which herdr's own resume would leave out.
//
// What herdr 0.9.5 takes (`herdr pane report-agent-session … -- <command>`): a plain command name
// first (letters, digits, `_`, `-`, `.`; no path), no apostrophe or control character in any
// word, at most 64 words; it quotes the words POSIX-style when it types them. A report from the
// same source with a newer --seq and no command leaves the command as it is.
//
// Pure: the hook and `board resume` read the env, the card and the files, and hand them in.
import { commandsOf } from './install-plan.ts'
import { sameDir } from './launch/names.ts'
import { choosesSession, claudeCommand } from './launch/spawn-args.ts'
import { absoluteProfileDir, defaultProfileDir, type Profile, profileForDir, resolveProfileDir } from './profiles.ts'
import type { Card, LaunchSpec } from './types.ts'

type Env = Record<string, string | undefined>

/** A Claude session id. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A word herdr takes as a command's first word, and types as it is.
const PLAIN = /^[A-Za-z0-9_.-]+$/

/** herdr's own Claude integration: the board's report stands in for it, with the command added. */
export const RESUME_SOURCE = 'herdr:claude'
export const RESUME_AGENT = 'claude'

/**
 * When the reporter tries, after the hook started it (ms, one after the other): herdr takes the
 * command only once it holds the session (its own hook reported it, it sees Claude in the pane).
 */
export const REPORT_DELAYS_MS: readonly number[] = [1000, 2000, 3000, 5000, 8000]

export const RESUME_USAGE = 'board resume <session id> [--profile <id>]'

/** What the SessionStart hook knows of the session that starts. */
export interface ResumeFacts {
  event: string | undefined
  session: string
  /** A subagent's SessionStart: not the pane's session. */
  agentId?: unknown
  /** The folder the session runs in: its CLAUDE_CONFIG_DIR, read by resolveProfileDir. */
  dir: string
  home: string
  platform?: string
  profiles: readonly Profile[]
  env: Env
  /** Wake is on and its Telegram router is `auto` (config.json's `wake` section). */
  wakeTelegram?: boolean
  /** The program the board starts Claude with (claudeProgram of `launch.claude`); unset: `claude`. */
  launchProgram?: string
}

/**
 * Whether `program` is a launcher of its own, as herdr-wake took one for its wakeCommand: a
 * command name (no path, no shell syntax) other than `claude` (`claude.exe` on Windows too).
 */
const isLauncher = (program: string): boolean =>
  PLAIN.test(program) && program.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() !== 'claude'

/**
 * The command herdr is to resume the session with after it restarts, or null where herdr's own
 * `claude --resume <id>` stays: a SessionStart of a pane's own Claude session (no subagent) in
 * herdr (HERDR_ENV=1), not a pi session through its bridge (pi reports its own), in a folder named
 * in full that is not the default one (`~/.claude`, the profile a restored shell is taken to have,
 * as for the board's starts). `--profile <id>` when a profile has the folder and its id is a plain
 * word; `board resume` takes the folder from the card first anyway. In the default folder only
 * while wake's Telegram router is on and the board starts Claude through a launcher (claude-tg):
 * `board resume <id>`, which runs it, as herdr-wake's own hook reported its wakeCommand (call 21).
 */
export function resumeCommand(f: ResumeFacts): string[] | null {
  if (f.event !== 'SessionStart' || f.agentId || f.env.HERDR_ENV !== '1' || f.env.PI_CODING_AGENT) return null
  if (!SESSION_ID.test(f.session)) return null
  const platform = f.platform ?? process.platform
  const dir = absoluteProfileDir(f.dir, f.home, platform)
  if (!dir) return null
  if (sameDir(dir, defaultProfileDir(f.home, platform)))
    return f.wakeTelegram && isLauncher(f.launchProgram ?? 'claude') ? ['board', 'resume', f.session] : null
  const id = profileForDir(f.profiles, dir)?.id
  return ['board', 'resume', f.session, ...(id && PLAIN.test(id) ? ['--profile', id] : [])]
}

/** The herdr command that reports `command` as the pane's resume command for the session. */
export function reportArgs(pane: string, session: string, seq: number, command: readonly string[]): string[] {
  return [
    'pane',
    'report-agent-session',
    pane,
    '--source',
    RESUME_SOURCE,
    '--agent',
    RESUME_AGENT,
    '--seq',
    String(seq),
    '--agent-session-id',
    session,
    '--',
    ...command,
  ]
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
// herdr-wake's SessionStart hook (herdr-wake/src/install-hooks.mjs), and the wakeCommand it reports
// (herdr-wake/src/hook.mjs resumeArgs).
const WAKE_HOOK = /herdr-wake.*hook\.mjs"?\s+session-start\s*$/
const WAKE_COMMAND = /^[\w.-]+(\s+[\w./\\:+={}-]+)*$/

/**
 * Whether herdr-wake reports a resume command of its own for the sessions of this profile: its
 * SessionStart hook is in the profile's settings.json and its config.json has a wakeCommand other
 * than `claude --resume {session}` that it reports. The board then leaves the report to it, so
 * herdr keeps herdr-wake's command, as before.
 */
export function herdrWakeResumes(settings: unknown, wakeConfig: unknown): boolean {
  if (!commandsOf(settings, 'SessionStart').some(c => WAKE_HOOK.test(c.command))) return false
  const command =
    isRecord(wakeConfig) && typeof wakeConfig.wakeCommand === 'string' ? wakeConfig.wakeCommand.trim() : ''
  return !!command && command !== 'claude --resume {session}' && WAKE_COMMAND.test(command)
}

/** `board resume`'s arguments; throws with the usage. */
export function parseResume(args: readonly string[]): { session: string; profile?: string } {
  let session: string | undefined
  let profile: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i])
    if (arg === '--profile') {
      const value = args[++i]
      if (value === undefined) throw new Error(`--profile needs a profile id. ${RESUME_USAGE}`)
      profile = value
    } else if (arg.startsWith('-') || session !== undefined) throw new Error(`unexpected "${arg}". ${RESUME_USAGE}`)
    else session = arg
  }
  if (!session) throw new Error(`which session? ${RESUME_USAGE}`)
  if (!SESSION_ID.test(session)) throw new Error(`"${session}" is not a session id. ${RESUME_USAGE}`)
  return { session, ...(profile !== undefined && { profile }) }
}

/** What `board resume` is asked, and what it finds. */
export interface ResumeInput {
  session: string
  /** The profile the report named. */
  profile?: string
  /** The session's card: the folder its hooks reported decides. */
  card: Pick<Card, 'profileDir'> | null
  profiles: readonly Profile[]
  launch: LaunchSpec | undefined
  /** The env `board resume` runs in: the restored pane's shell's. */
  env: Env
  home: string
  platform?: string
}

/**
 * How `board resume` runs Claude: `argv`, and the env, with CLAUDE_CONFIG_DIR for the session's
 * folder. The folder is the one the card says the session ran in, else the folder of the profile
 * named; neither (no card, no such profile): the env as it is, as herdr's own resume. A folder the
 * env points to already leaves it as it is (`~/.claude` as the owner's shell spells it); the
 * default folder otherwise unsets it, any other sets it, spelled as its profile has it. Claude is
 * what the board starts sessions with (`launch.claude`, default `claude`) and the profile's `args`,
 * then `--resume <id>`; the profile's own start command is not run, as it may be an alias that
 * only a shell knows, and its folder is the one set here. Throws when `launch.claude` is not valid
 * or picks its own session.
 */
export function resumePlan(o: ResumeInput): { argv: string[]; env: Env; dir: string | null } {
  const platform = o.platform ?? process.platform
  const carded = absoluteProfileDir(o.card?.profileDir, o.home, platform)
  const named = o.profile === undefined ? null : (o.profiles.find(p => p.id === o.profile) ?? null)
  const profile = carded ? profileForDir(o.profiles, carded) : named
  const dir = profile?.dir ?? carded
  const program = [...claudeCommand(o.launch?.claude, o.launch?.args), ...(profile?.args ?? [])]
  if (choosesSession(program))
    throw new Error(`launch.claude picks its own session (${program.join(' ')}), so it cannot resume ${o.session}`)
  const argv = [...program, '--resume', o.session]
  if (!dir || sameDir(resolveProfileDir(o.env.CLAUDE_CONFIG_DIR, o.home, platform), dir))
    return { argv, env: o.env, dir }
  const env: Env = { ...o.env }
  if (sameDir(dir, defaultProfileDir(o.home, platform))) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = dir
  return { argv, env, dir }
}

/**
 * The folder Claude keeps a project's transcripts in under projects/: the cwd without trailing
 * separators, every other character than A-Z a-z 0-9 a dash.
 */
export const projectFolderName = (cwd: string): string => cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-')

/** Where `board resume` looks for the project folder to resume the session in. */
export interface ResumeDirFacts {
  /** The pane's current folder: herdr restores it. */
  cwd: string
  /** The session's transcript is under the profile's projects/ folder for `cwd`. */
  transcriptHere: boolean
  /** The cwd recorded in the session's transcript (`<id>.jsonl`), if one was found. */
  recorded: string | null
  recordedExists: boolean
}

/**
 * Call 29: null stays in `cwd` (its transcript is there, or nothing better is found); else the
 * folder the transcript recorded, when it still exists and is another folder than `cwd`.
 */
export function resumeDir(f: ResumeDirFacts): string | null {
  if (f.transcriptHere) return null
  return f.recorded && f.recordedExists && !sameDir(f.recorded, f.cwd) ? f.recorded : null
}
