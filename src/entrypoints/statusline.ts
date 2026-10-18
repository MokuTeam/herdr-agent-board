// Claude Code's status line (settings.json statusLine; the install action sets it when there is
// none). Claude runs it after every reply with the session's state on stdin. The board keeps:
//   the account's usage windows (rate_limits: 5 hours, 7 days) per Claude profile in
//   usageFileFor(), the same shape as the usagebar cache, so one reader serves both (claude-home.ts)
//   each session's context fill (context_window) in contextDir()/<session id>.json
//   in a herdr pane, the Claude profile the session runs in on its card, as the hooks write it
// and it prints one short line under the prompt, e.g. "ctx 34% · 5h 23% · 7d 41%".
// It never fails loudly: a bad input leaves the line blank and the files as they were.
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readCard, writeCard } from '../adapters/cards.ts'
import { replaceFile } from '../adapters/json-store.ts'
import { contextDir, usageFileFor } from '../adapters/paths.ts'
import { inheritedProfileDir, loadProfiles } from '../adapters/profiles.ts'
import { readStdin } from '../adapters/stdin.ts'
import { sameDir } from '../core/launch/names.ts'
import { DEFAULT_PROFILE, defaultProfileDir, type Profile, profileForDir } from '../core/profiles.ts'
import { digest, statusText } from '../core/statusline.ts'

const safe = (key: string): string => String(key).replace(/[^A-Za-z0-9_-]/g, '_')

function save(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(file, JSON.stringify(data))
}

/** Context files of sessions gone a week: dropped now and then. */
function prune(now: number): void {
  for (const name of readdirSync(contextDir())) {
    const file = join(contextDir(), name)
    try {
      if (now - statSync(file).mtimeMs > 7 * 86_400_000) unlinkSync(file)
    } catch {}
  }
}

/** The card's profile (hook.ts): the session's folder and the id of the profile that has it, written when they changed. */
function reportProfile(session: string, dir: string, list: Profile[]): void {
  const card = readCard(session)
  const id = profileForDir(list, dir)?.id ?? ''
  const patch = {
    ...(!sameDir(card?.profileDir, dir) && { profileDir: dir }),
    ...((card?.profile ?? '') !== id && { profile: id }),
  }
  if (Object.keys(patch).length) writeCard(session, patch)
}

async function main(): Promise<void> {
  const raw = await readStdin()
  const now = Date.now()
  const d = digest(JSON.parse(raw || '{}'), now)
  const home = homedir()
  const dir = inheritedProfileDir(process.env, home)
  let profiles: Profile[] | undefined
  const list = (): Profile[] => (profiles ??= loadProfiles({ home }))
  // An input without windows (before the first reply, other plans) keeps the last good ones. The
  // default folder's go where they always did, without reading the config; a folder no profile has
  // keeps none: the board could not tell whose they are.
  if (d.usage) {
    const id = sameDir(dir, defaultProfileDir(home)) ? DEFAULT_PROFILE : profileForDir(list(), dir)?.id
    if (id) save(usageFileFor(id), d.usage)
  }
  if (d.context && d.session) {
    save(join(contextDir(), `${safe(d.session)}.json`), d.context)
    if (Math.random() < 0.02) prune(now)
  }
  if (d.session && process.env.HERDR_PANE_ID) {
    try {
      reportProfile(d.session, dir, list())
    } catch {}
  }
  process.stdout.write(statusText(d))
}

main().catch(() => {})
