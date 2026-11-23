// Typing into a live agent's prompt through herdr: a line, Claude's /rename and pi's /name, and the checks that
// come first. Shared by the launches (name and first message) and renaming a session.
import { agentNames, herdr, herdrText } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { pause } from '../../adapters/pacing.ts'
import { inputDraft, type PromptScreen, promptScreen } from '../../core/dialogs/input-box.ts'
import { stillTyped } from '../../core/launch/spawn-args.ts'
import { AGY_NAMING, PI_NAMING } from '../../core/pi.ts'

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
      await pause(800)
    }
  }
  return false
}

/** What Claude's input box holds as the screen shows it: '' when empty, null when no box can be read. */
export async function boxDraft(pane: string): Promise<string | null> {
  const screen = await herdrText(['agent', 'read', pane, '--source', 'visible', '--ansi'], 10_000).catch(() => null)
  return screen === null ? null : inputDraft(screen)
}

/**
 * What Claude's screen shows where a line would go: its input box and what it holds, a dialog that
 * wants an answer first, or neither (null, also for a screen herdr cannot show). The read boxDraft makes.
 */
export async function screenNow(pane: string): Promise<PromptScreen> {
  const screen = await herdrText(['agent', 'read', pane, '--source', 'visible', '--ansi'], 10_000).catch(() => null)
  return screen === null ? null : promptScreen(screen)
}

/**
 * Whether Claude's /rename line is still in its input box, not sent: Claude can drop its Enter at
 * a slow start (#479), and a line typed after it would go with it as one, the name eating it.
 * Asked only while "Session renamed" is not on screen and the line is, so a rename that took asks
 * nothing more.
 */
export const renameLeft = async (pane: string, line: string): Promise<boolean> => stillTyped(await boxDraft(pane), line)

/**
 * Claude's /rename runs without a turn: herdr calls the prompt stalled; the screen says whether it
 * took. A line Claude left in its box gets one more Enter, twice at most (renameLeft).
 */
export async function claudeRename(pane: string, name: string): Promise<boolean> {
  const line = `/rename ${name}`
  try {
    await herdr(['agent', 'prompt', pane, line])
  } catch (err) {
    if (!stalled(err)) throw err
  }
  for (let i = 0; i < 10; i++) {
    await pause(500)
    const shown = await visible(pane)
    if (/Session renamed/i.test(shown)) return true
    // The box is read only when the line is on screen at all, as a dropped Enter leaves it.
    if ((i === 1 || i === 5) && stillTyped(shown, line) && (await renameLeft(pane, line)))
      await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
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
    await pause(500)
    const shown = await visible(pane)
    if (PI_NAMING.done.test(shown)) return true
    if (i === 1 && stillTyped(shown, line)) await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
  }
  return false
}

/** Antigravity's `/rename`, as Claude's: runs locally without a model turn. */
export async function agyRename(pane: string, name: string): Promise<boolean> {
  const line = AGY_NAMING.command(name)
  try {
    await herdr(['agent', 'prompt', pane, line])
  } catch (err) {
    if (!stalled(err)) throw err
  }
  for (let i = 0; i < 10; i++) {
    await pause(500)
    const shown = await visible(pane)
    if (AGY_NAMING.done.test(shown)) return true
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
