// Claude Code hooks (installed by the "install" action) that tell each session about the board.
//   SessionStart (new, resume, clear, compact): the full brief, since the context is fresh.
//   UserPromptSubmit: clears the card's `pin`, and its `ask` (the user answered) unless the prompt
//   is a board reminder, a MokuPilot call's results or a task notification (core/notices.ts); the brief once for sessions that were running before the
//   install; after that a one-line reminder only while the card says it waits for something, and
//   one line when the user's presence changed since the session was told (core/presence.ts; only
//   a card that heard of presence reads it, so a setup that never turned it on reads nothing).
//   Every event: the card says which Claude profile the session runs in (its CLAUDE_CONFIG_DIR,
//   unset: ~/.claude), written only when that changed.
//   PreToolUse (AskUserQuestion only): the call's id and questions go on the card (card.asking),
//   for when Claude Code holds them back from the transcript (core/held-question.ts); nothing
//   else, and the call goes on as it would without the hook.
// Only sessions in a herdr pane are briefed: `claude -p` runs and other terminals are not on the board.
// A pi session that runs Claude Code through its bridge (PI_CODING_AGENT) has two cards: the
// bridge's own Claude session, which the hook is told, and pi's, which the board shows and `board`
// writes (herdr's agent_session of the pane: the session's file). The user's answer clears pi's,
// and pi's is told the profile of the folder this Claude runs in: the account of pi's turn.
// SessionStart of a session in another profile than the default one, or in the default one while
// wake's Telegram router is on and launch.claude is a launcher: herdr is told to bring it back with
// `board resume …` after a restart (core/resume.ts), by a process of its own; every other session
// is left to herdr's own `claude --resume <id>`, and nothing more is read or started for it.
// Claude Code waits for it: an empty or broken input ends it at once, silently, with exit code 0.
import { homedir } from 'node:os'
import { type CardPatch, readCard, writeCard } from '../adapters/cards.ts'
import { loadConfig } from '../adapters/config-file.ts'
import { agentGet } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { presenceForBrief, presenceNews } from '../adapters/presence-store.ts'
import { inheritedProfileDir, loadProfiles } from '../adapters/profiles.ts'
import { readStdin } from '../adapters/stdin.ts'
import { BRIEF_VERSION, brief, waitReminder } from '../core/brief.ts'
import { heldQuestionOf } from '../core/held-question.ts'
import { isNotice } from '../core/notices.ts'
import { type Profile, profileReport } from '../core/profiles.ts'
import type { Config } from '../core/types.ts'

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * At SessionStart: the reporter of `board resume …` for a session herdr would resume in the wrong
 * profile, or without the launcher wake's Telegram router needs, after a restart (resumeCommand),
 * unless herdr-wake reports a command of its own in that profile or `board` is not on PATH. `cfg`
 * is the config the brief was given. Anything that goes wrong leaves the session as it was.
 */
async function reportResume(
  input: Record<string, unknown>,
  sid: string,
  pane: string,
  dir: string,
  profiles: Profile[],
  cfg: Config | undefined,
): Promise<void> {
  try {
    const [{ resumeCommand }, { claudeProgram }, { wakeConfig }] = await Promise.all([
      import('../core/resume.ts'),
      import('../core/launch/spawn-args.ts'),
      import('../core/wake/config.ts'),
    ])
    const wake = wakeConfig(cfg?.wake)
    const command = resumeCommand({
      event: 'SessionStart',
      session: sid,
      agentId: input.agent_id,
      dir,
      home: homedir(),
      profiles,
      env: process.env,
      wakeTelegram: wake.enabled && wake.telegram === 'auto',
      launchProgram: claudeProgram(cfg?.launch?.claude, cfg?.launch?.args),
    })
    if (!command) return
    const { boardOnPath, herdrWakeResumesIn, startResumeReport } = await import('../adapters/resume-report.ts')
    if (herdrWakeResumesIn(dir) || !boardOnPath()) return
    startResumeReport(pane, sid, command)
  } catch {}
}

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
  if (event === 'PreToolUse') {
    const asking = heldQuestionOf(input, Date.now())
    if (asking) writeCard(sid, { asking })
    return
  }
  const card = readCard(sid)
  // What changes on the card, written at once. First the session's folder and its profile, where
  // the card says otherwise.
  const dir = inheritedProfileDir()
  const profiles = loadProfiles()
  const patch: CardPatch = profileReport(card, dir, profiles)
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
  // pi's card is told the profile too: the folder this Claude runs in is the account pi's turn
  // goes to, whichever of the bridge's providers it took.
  const boardKey = event === 'UserPromptSubmit' ? await boardKeyOf(pane, sid) : null
  const boardCard = boardKey ? readCard(boardKey) : card
  if (event === 'UserPromptSubmit') {
    const done = answered(card)
    if (done) Object.assign(patch, done)
    const piPatch: CardPatch = boardKey ? { ...profileReport(boardCard, dir, profiles), ...answered(boardCard) } : {}
    if (boardKey && Object.keys(piPatch).length) writeCard(boardKey, piPatch)
  }
  let context: string | null = null
  let cfg: Config | undefined
  const briefed = card?.briefV ?? (card?.briefedAt ? 1 : 0)
  if (event === 'SessionStart' || (event === 'UserPromptSubmit' && Number(briefed) < BRIEF_VERSION)) {
    cfg = loadConfig()
    // The user's presence (#172), only where config.json turned it on.
    const presence = presenceForBrief(cfg)
    context = brief(cfg, card, text(input.cwd) ?? '', process.env, 'Claude', presence)
    Object.assign(patch, { briefedAt: Date.now(), briefV: BRIEF_VERSION })
    if (presence) patch.presenceSeen = presence.since
    else if (card?.presenceSeen !== undefined) patch.presenceSeen = ''
  } else if (event === 'UserPromptSubmit') {
    if (boardCard?.wait) context = waitReminder(boardCard)
    // Presence changed since this session was told: one line. A card that never heard of it reads nothing.
    const news = presenceNews(card)
    if (news) {
      context = context ? `${context}\n${news.line}` : news.line
      patch.presenceSeen = news.seen
    }
  }
  if (Object.keys(patch).length) writeCard(sid, patch)
  if (event === 'SessionStart') await reportResume(input, sid, pane, dir, profiles, cfg)
  if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }))
}

main().catch(() => {})
