// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief. The board starts new sessions with it when config.json sets no `launch.command` or
// `launch.agent` (launcher.ts), and agents start other sessions with it (entrypoints/spawn-agent.ts).
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { herdr, herdrText, tabCreate } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { slugName, uniqueSlug } from '../../core/launch/names.ts'
import { choosesSession, type SpawnOptions, shellLine, stillTyped } from '../../core/launch/spawn-args.ts'

/** A folder as given, absolute: ~ is the home folder, a relative one is from here. */
export function absoluteDir(p: string): string {
  const s = String(p)
    .trim()
    .replace(/^["']|["']$/g, '')
  return resolve(/^~([\\/]|$)/.test(s) ? homedir() + s.slice(1) : s)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const stalled = (err: unknown): boolean => isRecord(err) && /agent_prompt_stalled/.test(`${err.code} ${err.message}`)
const screen = (pane: string): Promise<string> =>
  herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => '')
const stringAt = (value: unknown, key: string): string | null =>
  isRecord(value) && typeof value[key] === 'string' ? value[key] : null

/** A pane as `herdr pane get` says: its agent, its status and its tab. */
async function paneInfo(pane: string, timeoutMs?: number) {
  const answer = await herdr(['pane', 'get', pane], timeoutMs)
  const p = isRecord(answer) ? answer.pane : null
  return { agent: stringAt(p, 'agent'), status: stringAt(p, 'agent_status'), tab: stringAt(p, 'tab_id') }
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

export interface SpawnResult {
  pane: string
  name: string
  agent: string
}

/**
 * Start Claude (`claude`, the command and its arguments) for the options: in a new tab of the
 * workspace (inside herdr the current one), or in `pane`; wait until herdr sees it ready, name it
 * in herdr and in Claude, then type the brief. Throws with the reason when it cannot.
 */
export async function spawnAgent(
  o: SpawnOptions,
  { claude = ['claude'], log = () => {} }: { claude?: string[]; log?: (text: string) => void } = {},
): Promise<SpawnResult> {
  const cwd = absoluteDir(o.cwd)
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {}
  if (!isDir) throw new Error(`No such folder: ${cwd}`)
  const workspace = o.workspace || process.env.HERDR_WORKSPACE_ID
  if (!o.pane && !workspace) throw new Error('No herdr workspace: run it inside herdr or pass --workspace')
  const label = o.label?.trim() || o.name
  const text =
    o.briefFile !== undefined
      ? readFileSync(o.briefFile, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
      : (o.brief ?? '').trim()
  const command = shellLine(o.sessionId && !choosesSession(claude) ? [...claude, '--session-id', o.sessionId] : claude)

  // The tab is labelled before Claude runs: a launcher may name things after it (a Telegram topic).
  let pane = o.pane
  if (pane) {
    const p = await paneInfo(pane)
    // Typed into a running agent, the command would go to it as a prompt.
    if (p.agent) throw new Error(`${pane} already runs ${p.agent}: --pane takes a pane at a shell prompt`)
    if (p.tab) await herdr(['tab', 'rename', p.tab, label]).catch(() => {})
  } else {
    pane = await tabCreate(workspace ?? '', cwd, label)
  }
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
