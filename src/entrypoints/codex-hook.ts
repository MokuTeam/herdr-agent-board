// Installed only in Codex's hooks.json. A pane's reported identity gates all card writes;
// a SessionStart racing herdr's identity hook is briefed on its first UserPromptSubmit instead.
import { type CardPatch, readCard, writeCard } from '../adapters/cards.ts'
import { loadConfig } from '../adapters/config-file.ts'
import { agentGet } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { readStdin } from '../adapters/stdin.ts'
import { BRIEF_VERSION, brief, waitReminder } from '../core/brief.ts'
import { CODEX_AGENT, isCodexSession } from '../core/codex.ts'
import { isNotice } from '../core/notices.ts'

async function main(): Promise<void> {
  const input: unknown = JSON.parse((await readStdin()) || '{}')
  if (!isRecord(input)) return
  const event = input.hook_event_name
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return
  const sid = input.session_id
  const pane = process.env.HERDR_PANE_ID
  if (!pane || typeof sid !== 'string' || !isCodexSession(sid)) return
  const own = process.env.CODEX_THREAD_ID
  if (own && own !== sid) return
  const agent = await agentGet(pane, 2000)
  if (agent?.kind !== CODEX_AGENT || agent.session !== sid) return
  const card = readCard(sid)
  const patch: CardPatch = {}
  const parentClaude = process.env.CLAUDE_CODE_SESSION_ID || false
  if (card?.codexParentClaude !== parentClaude) patch.codexParentClaude = parentClaude
  if (event === 'UserPromptSubmit' && (card?.pin || card?.ask)) {
    Object.assign(patch, { pin: '', pinAt: '', pinBusy: '' })
    if (!isNotice(input.prompt)) Object.assign(patch, { ask: '', askSince: '' })
  }
  let context: string | null = null
  if (event === 'SessionStart' || Number(card?.briefV ?? 0) < BRIEF_VERSION) {
    context = [
      brief(loadConfig(), card, typeof input.cwd === 'string' ? input.cwd : '', process.env, 'Codex'),
      `Use \`board --session ${sid} <command>\` for the commands above, so a tool's shell targets this session even when it does not inherit the pane environment.`,
    ].join('\n')
    Object.assign(patch, { briefedAt: Date.now(), briefV: BRIEF_VERSION })
  } else if (card?.wait) context = waitReminder(card)
  if (Object.keys(patch).length) writeCard(sid, patch)
  if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }))
}

main().catch(() => {}) // Hooks must not hold a user's prompt when herdr or a card is unavailable.
