// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief. The board starts new sessions with it when config.json sets no `launch.command` or
// `launch.agent` (launcher.ts), and agents start other sessions with it (entrypoints/spawn-agent.ts).
// The session starts in a Claude profile (core/profiles.ts spawnEnv): the one the board asks for,
// the one named with --profile, or the profile of the agent that runs it. When that cannot be
// sure, it refuses before herdr is asked anything.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { writeCard } from '../../adapters/cards.ts'
import { herdr, herdrText, tabCreateRoot } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import {
  forgetProfilePane,
  possibleProfilePanes,
  provenProfilePanes,
  recordProfilePane,
} from '../../adapters/profile-panes.ts'
import { type Env, inheritedProfileDir, loadProfiles } from '../../adapters/profiles.ts'
import { slugName, uniqueSlug } from '../../core/launch/names.ts'
import { choosesSession, type SpawnOptions, shellLine, stillTyped } from '../../core/launch/spawn-args.ts'
import { envRejected, type Profile, type SpawnEnv, spawnEnv } from '../../core/profiles.ts'

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

/** A pane as `herdr pane get` says: its agent, its status, its tab and the terminal it holds. */
async function paneInfo(pane: string, timeoutMs?: number) {
  const answer = await herdr(['pane', 'get', pane], timeoutMs)
  const p = isRecord(answer) ? answer.pane : null
  return {
    agent: stringAt(p, 'agent'),
    status: stringAt(p, 'agent_status'),
    tab: stringAt(p, 'tab_id'),
    terminal: stringAt(p, 'terminal_id'),
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

/**
 * The profile the start is in and CLAUDE_CONFIG_DIR for its tab (null: herdr's env); throws with
 * the reason it is refused. A folder to set must be there and named in full: a relative one would
 * be another folder in the tab. A --pane that needs the folder set and is not even recorded in
 * that profile is refused here too; the rest of its check needs herdr (paneCheck).
 */
function startProfile(
  o: SpawnOptions,
  { profiles, env, home }: { profiles: readonly Profile[]; env: Env; home: string },
): Start {
  const target = spawnEnv(o, inheritedProfileDir(env, home), profiles, home)
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
}

/**
 * Start Claude (`claude`, the command and its arguments) for the options: in a new tab of the
 * workspace (inside herdr the current one), or in `pane`; wait until herdr sees it ready, name it
 * in herdr and in Claude, then type the brief. Throws with the reason when it cannot. The profile
 * comes from the options, else from `env` (the agent's own); `profiles` are the board's (default:
 * config.json's merged with the folders found in `home`).
 */
export async function spawnAgent(
  o: SpawnOptions,
  {
    claude = ['claude'],
    log = () => {},
    profiles,
    env = process.env,
    home = homedir(),
  }: { claude?: string[]; log?: (text: string) => void; profiles?: Profile[]; env?: Env; home?: string } = {},
): Promise<SpawnResult> {
  const cwd = absoluteDir(o.cwd)
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {}
  if (!isDir) throw new Error(`No such folder: ${cwd}`)
  const workspace = o.workspace || process.env.HERDR_WORKSPACE_ID
  if (!o.pane && !workspace) throw new Error('No herdr workspace: run it inside herdr or pass --workspace')
  const start = startProfile(o, { profiles: profiles ?? loadProfiles({ home }), env, home })
  const { configDir, profile } = start
  const label = o.label?.trim() || o.name
  const text =
    o.briefFile !== undefined
      ? readFileSync(o.briefFile, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
      : (o.brief ?? '').trim()
  const program = [...claude, ...(profile?.args ?? [])]
  const argv = o.sessionId && !choosesSession(program) ? [...program, '--session-id', o.sessionId] : program
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
  // start that leaves the env as herdr makes it too, as herdr's env may point elsewhere.
  if (profile && o.sessionId) writeCard(o.sessionId, { profileWant: profile.id })
  await herdr(['pane', 'run', pane, command])

  const deadline = Date.now() + o.timeoutSec * 1000
  let ready = false
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
    if (p.agent !== 'claude') continue
    if (p.status === 'idle' || p.status === 'done') {
      ready = true
      break
    }
    if (p.status === 'blocked') {
      throw new Error(
        `Claude in ${pane} waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt ${pane} "/rename ${o.name}" and send the brief.`,
      )
    }
  }
  if (!ready) throw new Error(`Claude did not get ready in ${pane} within ${o.timeoutSec} s`)

  const agent = await nameInHerdr(pane, o.name)

  // /rename runs locally, no turn: herdr never sees it working and calls the prompt stalled. The
  // name is cosmetic and Claude runs by now: no failure for it, or a retry would start a second one.
  try {
    await prompt(pane, `/rename ${o.name}`)
  } catch (err) {
    if (!stalled(err)) log(`/rename in ${pane}: ${messageOf(err)}`)
  }
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    if (/Session renamed/i.test(await screen(pane))) break
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
            `The brief did not reach Claude in ${pane}: ${messageOf(err)}. Send it by hand: herdr agent prompt ${pane} "<brief>"`,
          )
        if (stillTyped(await screen(pane), text)) {
          await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
          sent = true
        }
      }
    }
    if (!sent)
      throw new Error(
        `The brief did not reach Claude in ${pane}. Send it by hand: herdr agent prompt ${pane} "<brief>"`,
      )
  }
  return { pane, name: o.name, agent }
}
