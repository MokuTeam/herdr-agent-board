// Typing into a live agent's prompt through herdr: a line, Claude's /rename and pi's /name, and the checks that
// come first. Shared by the launches (name and first message) and renaming a session.
import { agentNames, herdr, herdrText } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { inputDraft } from '../../core/dialogs/input-box.ts'
import { stillTyped } from '../../core/launch/spawn-args.ts'
import { PI_NAMING } from '../../core/pi.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const stalled = (err: unknown): boolean => isRecord(err) && /agent_prompt_stalled/.test(`${err.code} ${err.message}`)
const visible = (pane: string): Promise<string> =>
  herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => '')

/**
 * Type a line into an agent's prompt. Right after a slash command Claude can drop typed text,
 * and a short turn can end before herdr sees it working: both read as agent_prompt_stalled.
 * Text still on screen gets an Enter; text that vanished is typed again (as spawn-agent does).
 */
export async function typeLine(pane: string, text: string, tries = 3): Promise<boolean> {
  const line = /^-/.test(text) ? ` ${text}` : text // a leading dash reads as an option to herdr
  for (let i = 1; i <= tries; i++) {
    try {
      await herdr(['agent', 'prompt', pane, line])
      return true
    } catch (err) {
      if (!stalled(err)) throw err
      const screen = await visible(pane)
      // Its first line (the screen breaks the rest) still in the prompt: it only needs its Enter.
      if (stillTyped(screen, text)) {
        await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
        return true
      }
      await sleep(800)
    }
  }
  return false
}

/** Claude's /rename runs without a turn: herdr calls the prompt stalled; the screen says whether it took. */
export async function claudeRename(pane: string, name: string): Promise<boolean> {
  try {
    await herdr(['agent', 'prompt', pane, `/rename ${name}`])
  } catch (err) {
    if (!stalled(err)) throw err
  }
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    if (/Session renamed/i.test(await visible(pane))) return true
  }
  return false
}

/**
 * pi's /name, as Claude's /rename: no turn, the screen says whether it took. pi's first Enter on a
 * slash command with an argument can take its completion instead: the line still in the editor
 * gets one more.
 */
export async function piName(pane: string, name: string): Promise<boolean> {
  const line = PI_NAMING.command(name)
  try {
    await herdr(['agent', 'prompt', pane, line])
  } catch (err) {
    if (!stalled(err)) throw err
  }
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    const shown = await visible(pane)
    if (PI_NAMING.done.test(shown)) return true
    if (i === 1 && stillTyped(shown, line)) await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
  }
  return false
}

/** The names herdr's agents go by; none when herdr cannot say. */
export async function takenNames(): Promise<Set<string>> {
  try {
    return await agentNames()
  } catch {
    return new Set()
  }
}

/** Whether Claude's input box is there and empty: nothing is typed over what the user started. */
export async function inputEmpty(pane: string): Promise<boolean> {
  const screen = await herdrText(
    ['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi'],
    10_000,
  ).catch(() => null)
  return screen !== null && inputDraft(screen) === ''
}
