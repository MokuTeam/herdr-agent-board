// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief. The board starts new sessions with it when config.json sets no `launch.command` or
// `launch.agent` (launcher.ts), and agents start other sessions with it (entrypoints/spawn-agent.ts).
// The session starts in a Claude profile (core/profiles.ts spawnEnv): the one the board asks for,
// the one named with --profile, or the profile of the agent that runs it. When that cannot be
// sure, it refuses before herdr opens, renames or types anything; with --pane, herdr's `pane get`
// is asked first, as the terminal the pane holds decides whether it is in the profile.
//
// --resume brings back a session that ended (the board's archive, services/archive.ts): Claude
// resumes it by its id, in the folder it ran in, and it keeps the name it had, so no /rename is
// typed. An agent's resume runs in the profile whose folder holds its conversation, never in the
// agent's own (resumeProfile); the board's own starts say the profile, as for any start.
//
// --fork starts a new session with a copy of another one's conversation (`--resume <id>
// --fork-session`, with the new session's own --session-id): named and briefed as any start, in
// the profile that holds that conversation, as a resume is; the session it forks is not touched.
//
// The start command may start pi instead of Claude (a profile's `command` of `pi`, or an alias
// for it): herdr says which agent came up in the tab, and the session is named as that agent
// names one (core/pi.ts namingOf: Claude's /rename, pi's /name). pi's session is keyed by its
// file, which herdr reports once pi is up: the profile it is meant for goes on that card. A start
// asked for pi (--agent pi; the board's, when its request picks pi) types `launch.pi` instead.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { readCard, removeCard, writeCard } from '../../adapters/cards.ts'
import { createClaudeHome } from '../../adapters/claude-home.ts'
import { herdr, herdrText, tabCreateRoot } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import {
  forgetProfilePane,
  possibleProfilePanes,
  provenProfilePanes,
  recordProfilePane,
} from '../../adapters/profile-panes.ts'
import { type Env, inheritedProfileDir, loadProfiles } from '../../adapters/profiles.ts'
import { importsDialog, keyTowardYes, ownImports, sameFolder, trustDialog } from '../../core/dialogs/trust.ts'
import { t } from '../../core/lang.ts'
import { sameDir, slugName, uniqueSlug } from '../../core/launch/names.ts'
import {
  choosesSession,
  profileCommand,
  type SpawnOptions,
  shellLine,
  stillTyped,
} from '../../core/launch/spawn-args.ts'
import { forkCard } from '../../core/links.ts'
import { CLAUDE_NAMING, isPiSessionFile, type Naming, namingOf, PI_AGENT } from '../../core/pi.ts'
import { defaultProfileDir, envRejected, type Profile, type SpawnEnv, spawnEnv } from '../../core/profiles.ts'

/** A folder as given, absolute: ~ is the home folder, a relative one is from here. */
export function absoluteDir(p: string): string {
  const s = String(p)
    .trim()
    .replace(/^["']|["']$/g, '')
  return resolve(/^~([\\/]|$)/.test(s) ? homedir() + s.slice(1) : s)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
const stalled = (err: unknown): boolean => isRecord(err) && /agent_prompt_stalled/.test(`${err.code} ${err.message}`)
const screen = (pane: string): Promise<string> =>
  herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => '')
const stringAt = (value: unknown, key: string): string | null =>
  isRecord(value) && typeof value[key] === 'string' ? value[key] : null

/**
 * --trust: Yes on the dialog Claude stops at, when it is the trust dialog for `cwd` or the external
 * imports dialog for the user's own files. The cursor moves one key at a time as the screen shows it.
 * True when Enter went on Yes; false leaves the dialog to the user.
 */
async function answerStartup(pane: string, cwd: string, home: string, claudeDirs: readonly string[]): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const shown = await screen(pane)
    const trust = trustDialog(shown)
    const imports = importsDialog(shown)
    const d =
      trust && sameFolder(trust.folder, cwd, home) ? trust : ownImports(imports, claudeDirs, home) ? imports : null
    const key = keyTowardYes(d)
    if (key === null) return false
    if (key === '') {
      await herdr(['pane', 'send-keys', pane, 'enter'])
      await sleep(1500)
      return true
    }
    await herdr(['pane', 'send-keys', pane, key])
    await sleep(300)
  }
  return false
}

/** A pane as `herdr pane get` says: its agent, its status, its tab, the terminal it holds and its agent's session. */
async function paneInfo(pane: string, timeoutMs?: number) {
  const answer = await herdr(['pane', 'get', pane], timeoutMs)
  const p = isRecord(answer) ? answer.pane : null
  return {
    agent: stringAt(p, 'agent'),
    status: stringAt(p, 'agent_status'),
    tab: stringAt(p, 'tab_id'),
    terminal: stringAt(p, 'terminal_id'),
    session: stringAt(isRecord(p) ? p.agent_session : null, 'value'),
  }
}

/** Type a line into the agent's prompt; a leading dash would read as an option to herdr. */
const prompt = (pane: string, text: string) => herdr(['agent', 'prompt', pane, /^-/.test(text) ? ` ${text}` : text])

/** herdr's own name for targeting: [a-z][a-z0-9_-]{0,31}, not one another agent has. */
async function nameInHerdr(pane: string, name: string): Promise<string> {
  try {
    const answer = await herdr(['agent', 'list'])
    const agents = isRecord(answer) && Array.isArray(answer.agents) ? answer.agents : []
    const others = agents.filter(a => stringAt(a, 'pane_id') !== pane)
    const taken = others.map(a => stringAt(a, 'name')).filter((n): n is string => !!n)
    const agent = uniqueSlug(slugName(name), new Set(taken))
    await herdr(['agent', 'rename', pane, agent])
    return agent
  } catch {
    return pane
  }
}

/** Why spawn-agent does not start in the profile spawnEnv refused. */
function refusal(target: Extract<SpawnEnv, { ok: false }>): string {
  if (target.error === 'missing') return `no profile "${target.detail}": see the board's Settings → Profiles`
  if (target.error === 'hidden') return `the profile "${target.detail}" is hidden: show it on the board first`
  if (target.error === 'unlisted')
    return `--config-dir ${target.detail} is not the folder of a profile the board knows: see the board's Settings → Profiles`
  return `this session's Claude folder ${target.detail} is not a profile the board knows: pass --profile <id>`
}

type Start = { configDir: string | null; profile: Profile | null }

/** What the profile of a start is decided from: the board's profiles, the agent's env, the home and session folders. */
type StartFacts = { profiles: readonly Profile[]; env: Env; home: string; cwd: string }

/**
 * The profile an agent's resume (--resume without --config-dir or --keep-env) is in: the one whose
 * folder holds the session's conversation (Claude writes it only into the folder it runs with, and
 * resumes it only there). With --profile, that profile as spawnEnv takes it, and it must hold the
 * conversation; without, the one listed profile that does, hidden or not. Never the agent's own
 * folder nor herdr's env: none, or more than one, is refused (throws with the reason).
 */
function resumeProfile(o: SpawnOptions, session: string, { profiles, env, home, cwd }: StartFacts): SpawnEnv {
  const holds = (p: Profile): boolean => !!createClaudeHome(p.dir).transcriptPath(session, cwd)
  if (o.profile !== undefined) {
    const target = spawnEnv(o, inheritedProfileDir(env, home), profiles, home)
    if (target.ok && target.profile && !holds(target.profile))
      throw new Error(t('spawn.err.resumeProfile', { session, profile: target.profile.id }))
    return target
  }
  const holders = profiles.filter(holds)
  if (holders.length > 1)
    throw new Error(t('spawn.err.resumeMany', { session, profiles: holders.map(p => p.id).join(', ') }))
  const own = holders[0]
  if (!own)
    throw new Error(o.fork ? t('fork.err.noTranscript', { session }) : t('archive.err.noTranscript', { name: o.name }))
  // As for --profile: herdr's env is taken to be the default profile's, so that one leaves it alone.
  return { ok: true, configDir: sameDir(own.dir, defaultProfileDir(home)) ? null : own.dir, profile: own }
}

/**
 * The profile the start is in and CLAUDE_CONFIG_DIR for its tab (null: herdr's env); throws with
 * the reason it is refused. A folder to set must be there and named in full: a relative one would
 * be another folder in the tab. A --pane that needs the folder set and is not even recorded in
 * that profile is refused here too; the rest of its check needs herdr (paneCheck).
 */
function startProfile(o: SpawnOptions, facts: StartFacts): Start {
  const { profiles, env, home } = facts
  // The board's own starts (--config-dir, --keep-env) say the profile, of a resume too.
  const boards = o.keepEnv || o.configDir !== undefined
  // A resume and a fork go on from a conversation: in the profile that holds it.
  const from = o.resume ?? o.fork
  const target =
    from && !boards ? resumeProfile(o, from, facts) : spawnEnv(o, inheritedProfileDir(env, home), profiles, home)
  if (!target.ok) throw new Error(refusal(target))
  const start: Start = { configDir: target.configDir, profile: target.profile }
  const { configDir } = start
  if (configDir !== null && (!isAbsolute(configDir) || !isFolder(configDir)))
    throw new Error(`the profile folder ${configDir} is not there`)
  // A pane that could not even be in this profile is not proven in it once herdr says its terminal.
  if (o.pane && configDir !== null)
    paneCheck(o.pane, possibleProfilePanes(new Map([[o.pane, null]])).get(o.pane), start)
  return start
}

/**
 * A pane given with --pane keeps the env it was opened with (`opened`: the profile its record
 * gives, undefined when none does). A start that sets the folder takes only a pane opened in that
 * profile (`opened` from provenProfilePanes); one that leaves the env alone never takes a pane
 * that could have been opened in another profile (from possibleProfilePanes), where Claude would
 * run in that one. Throws with the reason.
 */
function paneCheck(pane: string, opened: string | undefined, { configDir, profile }: Start): void {
  const setsFolder = configDir !== null
  const fits = setsFolder ? !!profile && opened === profile.id : opened === undefined || opened === profile?.id
  if (fits) return
  const wanted = profile?.id ?? configDir
  throw new Error(
    wanted
      ? `--pane ${pane} was not opened in profile ${wanted}: leave out --pane to get a new tab`
      : `--pane ${pane} was opened in profile ${opened}: leave out --pane to get a new tab`,
  )
}

export interface SpawnResult {
  pane: string
  name: string
  agent: string
  /** The kind of agent that came up: 'claude', or 'pi' when the start command started pi. */
  kind: string
}

// A card the start wrote before it knew the agent, with nothing on it but what a start writes.
const START_ONLY = ['key', 'category', 'updatedAt', 'profileWant', 'forkOf', 'forkAt']

/**
 * pi's session is keyed by its file, not by the id the start gave it: the profile it is meant for
 * goes on that card, and the card written under the id before pi was up goes when it holds
 * nothing else.
 */
function movePiCard(carded: string, file: string, profile: string): void {
  writeCard(file, { profileWant: profile })
  if (Object.keys(readCard(carded) ?? {}).every(k => START_ONLY.includes(k))) removeCard(carded)
}

/**
 * Start Claude (`claude`, the command and its arguments) for the options: in a new tab of the
 * workspace (inside herdr the current one), or in `pane`; wait until herdr sees it ready, name it
 * in herdr and in Claude, then type the brief. Throws with the reason when it cannot. The profile
 * comes from the options, else from `env` (the agent's own); `profiles` are the board's (default:
 * config.json's merged with the folders found in `home`). A profile's start command (its
 * `command`) is typed in place of `claude`, the profile's arguments after it. With `agent` pi,
 * `pi` (`launch.pi`, default: pi) is typed instead, without them: they are Claude's.
 */
export async function spawnAgent(
  o: SpawnOptions,
  {
    claude = ['claude'],
    pi = ['pi'],
    log = () => {},
    profiles,
    env = process.env,
    home = homedir(),
  }: {
    claude?: string[]
    pi?: string[]
    log?: (text: string) => void
    profiles?: Profile[]
    env?: Env
    home?: string
  } = {},
): Promise<SpawnResult> {
  const cwd = absoluteDir(o.cwd)
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {}
  if (!isDir) throw new Error(`No such folder: ${cwd}`)
  const workspace = o.workspace || process.env.HERDR_WORKSPACE_ID
  if (!o.pane && !workspace) throw new Error('No herdr workspace: run it inside herdr or pass --workspace')
  const known = profiles ?? loadProfiles({ home })
  const start = startProfile(o, { profiles: known, env, home, cwd })
  const { configDir, profile } = start
  // The user's own Claude folders: the profile of the agent that runs it, the default one, and the board's.
  const claudeDirs = [...new Set([inheritedProfileDir(env, home), defaultProfileDir(home), ...known.map(p => p.dir)])]
  const label = o.label?.trim() || o.name
  const text =
    o.briefFile !== undefined
      ? readFileSync(o.briefFile, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
      : (o.brief ?? '').trim()
  // The profile's start command, else `claude`; a bad one throws here, before herdr is asked. pi's own when asked for.
  const program =
    o.agent === 'pi' ? [...pi] : [...(profileCommand(profile?.command) ?? claude), ...(profile?.args ?? [])]
  // A launch.claude that picks its own session (--resume, --continue) cannot resume another one.
  if (o.resume && choosesSession(program))
    throw new Error(`launch.claude picks its own session (${program.join(' ')}), so it cannot resume ${o.resume}`)
  if (o.fork && choosesSession(program))
    throw new Error(`launch.claude picks its own session (${program.join(' ')}), so it cannot fork ${o.fork}`)
  // A fork is a new session: its id is the one given, else one of its own, so its card is known.
  const sessionId = o.fork ? (o.sessionId ?? randomUUID()) : o.sessionId
  const argv = o.resume
    ? [...program, '--resume', o.resume]
    : o.fork
      ? [...program, '--resume', o.fork, '--fork-session', '--session-id', String(sessionId)]
      : sessionId && !choosesSession(program)
        ? [...program, '--session-id', sessionId]
        : program
  const command = shellLine(argv, process.platform === 'win32')

  // The tab is labelled before Claude runs: a launcher may name things after it (a Telegram topic).
  let pane = o.pane
  if (pane) {
    const p = await paneInfo(pane)
    // Typed into a running agent, the command would go to it as a prompt.
    if (p.agent) throw new Error(`${pane} already runs ${p.agent}: --pane takes a pane at a shell prompt`)
    // herdr gives a pane's id out again after it starts over. Setting the folder takes the pane
    // only when herdr proves it holds the terminal it was recorded with; leaving the env alone
    // refuses it unless herdr proves it holds another one.
    const live = new Map([[pane, p.terminal]])
    const opened = configDir !== null ? provenProfilePanes(live) : possibleProfilePanes(live)
    paneCheck(pane, opened.get(pane), start)
    if (p.tab) await herdr(['tab', 'rename', p.tab, label]).catch(() => {})
  } else {
    let opened: Awaited<ReturnType<typeof tabCreateRoot>>
    try {
      opened = await tabCreateRoot(
        workspace ?? '',
        cwd,
        label,
        configDir === null ? undefined : { CLAUDE_CONFIG_DIR: configDir },
      )
    } catch (err) {
      if (configDir !== null && envRejected(err))
        throw new Error(
          'herdr cannot set CLAUDE_CONFIG_DIR for the new tab (--env needs herdr 0.9.5 or newer): nothing was started',
        )
      throw err
    }
    pane = opened.pane
    // Before Claude runs: a pane the board cannot tell was opened in the profile is never woken
    // there, and the record of an earlier pane of this id (herdr started over) is not this one's.
    if (configDir !== null && profile) recordProfilePane(pane, profile.id, opened.terminal)
    else forgetProfilePane(pane)
  }
  // The profile it is meant to be in, for the board to check against the one its hooks report: a
  // start that leaves the env as herdr makes it too, as herdr's env may point elsewhere; a resume too.
  const carded = sessionId ?? o.resume
  // A fork's card says whose fork it is, and since when: its copied lines are older (core/links.ts).
  if (profile && carded) writeCard(carded, { profileWant: profile.id, ...(o.fork && forkCard(o.fork)) })
  await herdr(['pane', 'run', pane, command])

  const deadline = Date.now() + o.timeoutSec * 1000
  let ready = false
  let answered = 0
  // The agent that came up (herdr says): Claude, or pi for a start command that starts it.
  let naming: Naming = CLAUDE_NAMING
  let kind = 'claude'
  let session: string | null = null
  while (Date.now() < deadline) {
    await sleep(1500)
    let p: Awaited<ReturnType<typeof paneInfo>>
    try {
      p = await paneInfo(pane, 10_000)
    } catch (err) {
      if (/not.?found|no such/i.test(messageOf(err)))
        throw new Error(`The tab of ${pane} was closed before Claude got ready`)
      continue
    }
    const own = namingOf(p.agent)
    if (!own || !p.agent) continue
    naming = own
    kind = p.agent
    session = p.session
    if (p.status === 'idle' || p.status === 'done') {
      ready = true
      break
    }
    if (p.status === 'blocked') {
      if (o.trust && answered < 4 && (await answerStartup(pane, cwd, home, claudeDirs))) {
        answered++
        continue
      }
      throw new Error(
        kind === PI_AGENT
          ? `pi in ${pane} waits for a dialog. Answer it in that tab, then: herdr agent prompt ${pane} "${naming.command(o.name)}" and send the brief.`
          : `Claude in ${pane} waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt ${pane} "/rename ${o.name}" and send the brief.`,
      )
    }
  }
  if (!ready) throw new Error(`Claude did not get ready in ${pane} within ${o.timeoutSec} s`)
  if (kind === PI_AGENT && profile && carded && isPiSessionFile(session)) movePiCard(carded, session, profile.id)

  const agent = await nameInHerdr(pane, o.name)

  // /rename runs locally, no turn: herdr never sees it working and calls the prompt stalled. The
  // name is cosmetic and Claude runs by now: no failure for it, or a retry would start a second one.
  // A resumed session keeps the name it had.
  if (!o.resume) {
    const line = naming.command(o.name)
    try {
      await prompt(pane, line)
    } catch (err) {
      if (!stalled(err)) log(`${line.split(' ')[0]} in ${pane}: ${messageOf(err)}`)
    }
    for (let i = 0; i < 10; i++) {
      await sleep(500)
      const shown = await screen(pane)
      if (naming.done.test(shown)) break
      // pi's first Enter on a slash command with an argument can take its completion instead:
      // the line still in the editor gets one more.
      if (kind === PI_AGENT && i === 1 && stillTyped(shown, line))
        await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
    }
  }

  // Right after a slash command Claude can drop typed text, and a short turn can end before herdr
  // sees it working: both read as "agent_prompt_stalled". Text still on screen (or a pasted-text
  // chip) gets an Enter; text that vanished is typed again.
  if (text) {
    let sent = false
    for (let i = 1; i <= 3 && !sent; i++) {
      await sleep(800)
      try {
        await prompt(pane, text)
        sent = true
      } catch (err) {
        // "brief did not reach" tells the board the session runs: no retry that starts another.
        if (!stalled(err))
          throw new Error(
            `The brief did not reach ${naming.title} in ${pane}: ${messageOf(err)}. Send it by hand: herdr agent prompt ${pane} "<brief>"`,
          )
        if (stillTyped(await screen(pane), text)) {
          await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
          sent = true
        }
      }
    }
    if (!sent)
      throw new Error(
        `The brief did not reach ${naming.title} in ${pane}. Send it by hand: herdr agent prompt ${pane} "<brief>"`,
      )
  }
  return { pane, name: o.name, agent, kind }
}
