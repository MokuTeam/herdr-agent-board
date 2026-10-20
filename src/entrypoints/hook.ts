// Claude Code hooks (installed by the "install" action) that tell each session about the board.
//   SessionStart (new, resume, clear, compact): the full brief, since the context is fresh.
//   UserPromptSubmit: clears the card's `pin`, and its `ask` (the user answered) unless the prompt
//   is a board reminder, a MokuPilot call's results or a task notification (core/notices.ts); the brief once for sessions that were running before the
//   install; after that a one-line reminder only while the card says it waits for something.
//   Every event: the card says which Claude profile the session runs in (its CLAUDE_CONFIG_DIR,
//   unset: ~/.claude), written only when that changed.
// Only sessions in a herdr pane are briefed: `claude -p` runs and other terminals are not on the board.
// A pi session that runs Claude Code through its bridge (PI_CODING_AGENT) has two cards: the
// bridge's own Claude session, which the hook is told, and pi's, which the board shows and `board`
// writes (herdr's agent_session of the pane: the session's file). The user's answer clears pi's.
// Claude Code waits for it: an empty or broken input ends it at once, silently, with exit code 0.
import { type CardPatch, readCard, writeCard } from '../adapters/cards.ts'
import { loadConfig } from '../adapters/config-file.ts'
import { agentGet } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { inheritedProfileDir, loadProfiles } from '../adapters/profiles.ts'
import { readStdin } from '../adapters/stdin.ts'
import { BRIEF_VERSION, brief, waitReminder } from '../core/brief.ts'
import { isNotice } from '../core/notices.ts'
import { profileReport } from '../core/profiles.ts'

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * The key the board shows this pane's session by, when the pane runs pi and that is not the hook's
 * own session. Null everywhere else: a Claude session of its own asks herdr nothing.
 */
async function boardKeyOf(pane: string, sid: string): Promise<string | null> {
  if (!process.env.PI_CODING_AGENT) return null
  try {
    const agent = await agentGet(pane, 2000)
    const key = agent?.kind === 'pi' ? agent.session : null
    return key && key !== sid ? key : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const input: unknown = JSON.parse((await readStdin()) || '{}')
  if (!isRecord(input)) return
  const event = text(input.hook_event_name)
  const sid = input.session_id
  const pane = process.env.HERDR_PANE_ID
  if (!sid || typeof sid !== 'string' || !pane) return
  const card = readCard(sid)
  // What changes on the card, written at once. First the session's folder and its profile, where
  // the card says otherwise.
  const patch: CardPatch = profileReport(card, inheritedProfileDir(), loadProfiles())
  // The user wrote to the session: whatever it asked them is answered. A reminder from the board's
  // scheduler or a background task reporting back is not the user, so its ask stays. A column the
  // user dragged the card to has done its job either way: the session works again, which drops
  // the pin anyway (services/board.ts pinOf).
  const fromBoard = isNotice(input.prompt)
  const answered = (c: typeof card): CardPatch | null =>
    c?.pin || (c?.ask && !fromBoard)
      ? { ...(!fromBoard && { ask: '', askSince: '' }), pin: '', pinAt: '', pinBusy: '' }
      : null
  // A pi session's ask and wait are on pi's card; the brief stays with the Claude session it went to.
  const boardKey = event === 'UserPromptSubmit' ? await boardKeyOf(pane, sid) : null
  const boardCard = boardKey ? readCard(boardKey) : card
  if (event === 'UserPromptSubmit') {
    const done = answered(card)
    if (done) Object.assign(patch, done)
    const piDone = boardKey ? answered(boardCard) : null
    if (boardKey && piDone) writeCard(boardKey, piDone)
  }
  let context: string | null = null
  const briefed = card?.briefV ?? (card?.briefedAt ? 1 : 0)
  if (event === 'SessionStart' || (event === 'UserPromptSubmit' && Number(briefed) < BRIEF_VERSION)) {
    context = brief(loadConfig(), card, text(input.cwd) ?? '')
    Object.assign(patch, { briefedAt: Date.now(), briefV: BRIEF_VERSION })
  } else if (event === 'UserPromptSubmit' && boardCard?.wait) {
    context = waitReminder(boardCard)
  }
  if (Object.keys(patch).length) writeCard(sid, patch)
  if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }))
}

main().catch(() => {})
