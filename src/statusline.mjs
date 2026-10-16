// Claude Code's status line (settings.json statusLine; the install action sets it when there is
// none). Claude runs it after every reply with the session's state on stdin. The board keeps:
//   the account's usage windows (rate_limits: 5 hours, 7 days) in usageFile(), the same shape as
//   the usagebar cache, so one reader serves both (claude-home.ts)
//   each session's context fill (context_window) in contextDir()/<session id>.json
// and it prints one short line under the prompt, e.g. "ctx 34% · 5h 23% · 7d 41%".
// It never fails loudly: a bad input leaves the line blank and the files as they were.
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { digest, statusText } from './core/statusline.ts'
import { contextDir, usageFile } from './adapters/paths.ts'

const safe = key => String(key).replace(/[^A-Za-z0-9_-]/g, '_')

function save(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

/** Context files of sessions gone a week: dropped now and then. */
function prune(now) {
  for (const name of readdirSync(contextDir())) {
    const file = join(contextDir(), name)
    try {
      if (now - statSync(file).mtimeMs > 7 * 86_400_000) unlinkSync(file)
    } catch {}
  }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const now = Date.now()
  const d = digest(JSON.parse(raw || '{}'), now)
  // An input without windows (before the first reply, other plans) keeps the last good ones.
  if (d.usage) save(usageFile(), d.usage)
  if (d.context && d.session) {
    save(join(contextDir(), `${safe(d.session)}.json`), d.context)
    if (Math.random() < 0.02) prune(now)
  }
  process.stdout.write(statusText(d))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {})
