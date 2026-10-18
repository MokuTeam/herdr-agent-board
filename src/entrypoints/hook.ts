// Claude Code hooks (installed by the "install" action) that tell each session about the board.
//   SessionStart (new, resume, clear, compact): the full brief, since the context is fresh.
//   UserPromptSubmit: clears the card's `pin`, and its `ask` (the user answered) unless the prompt
//   is a board reminder, a MokuPilot call's results or a task notification (core/notices.ts); the brief once for sessions that were running before the
//   install; after that a one-line reminder only while the card says it waits for something.
//   Every event: the card says which Claude profile the session runs in (its CLAUDE_CONFIG_DIR,
//   unset: ~/.claude), written only when that changed.
// Only sessions in a herdr pane are briefed: `claude -p` runs and other terminals are not on the board.
// Claude Code waits for it: an empty or broken input ends it at once, silently, with exit code 0.
import { type CardPatch, readCard, writeCard } from '../adapters/cards.ts'
import { loadConfig } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { inheritedProfileDir, loadProfiles } from '../adapters/profiles.ts'
import { readStdin } from '../adapters/stdin.ts'
import { BRIEF_VERSION, brief, waitReminder } from '../core/brief.ts'
import { sameDir } from '../core/launch/names.ts'
import { isNotice } from '../core/notices.ts'
import { profileForDir } from '../core/profiles.ts'
import type { Card } from '../core/types.ts'

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The session's folder and the id of the profile that has it ('' when none does), where the card says otherwise. */
function profileChange(card: Card | null): CardPatch {
  const dir = inheritedProfileDir()
  const id = profileForDir(loadProfiles(), dir)?.id ?? ''
  return {
    ...(!sameDir(card?.profileDir, dir) && { profileDir: dir }),
    ...((card?.profile ?? '') !== id && { profile: id }),
  }
}

async function main(): Promise<void> {
  const input: unknown = JSON.parse((await readStdin()) || '{}')
  if (!isRecord(input)) return
  const event = text(input.hook_event_name)
  const sid = input.session_id
  if (!sid || typeof sid !== 'string' || !process.env.HERDR_PANE_ID) return
  const card = readCard(sid)
  // What changes on the card, written at once.
  const patch = profileChange(card)
  // The user wrote to the session: whatever it asked them is answered. A reminder from the board's
  // scheduler or a background task reporting back is not the user, so its ask stays. A column the
  // user dragged the card to has done its job either way: the session works again, which drops
  // the pin anyway (services/board.ts pinOf).
  const fromBoard = isNotice(input.prompt)
  if (event === 'UserPromptSubmit' && (card?.pin || (card?.ask && !fromBoard))) {
    Object.assign(patch, { ...(!fromBoard && { ask: '', askSince: '' }), pin: '', pinAt: '', pinBusy: '' })
  }
  let context: string | null = null
  const briefed = card?.briefV ?? (card?.briefedAt ? 1 : 0)
  if (event === 'SessionStart' || (event === 'UserPromptSubmit' && Number(briefed) < BRIEF_VERSION)) {
    context = brief(loadConfig(), card, text(input.cwd) ?? '')
    Object.assign(patch, { briefedAt: Date.now(), briefV: BRIEF_VERSION })
  } else if (event === 'UserPromptSubmit' && card?.wait) {
    context = waitReminder(card)
  }
  if (Object.keys(patch).length) writeCard(sid, patch)
  if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }))
}

main().catch(() => {})
