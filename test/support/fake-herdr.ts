// Compiled to an executable (see fake-herdr-bin.ts) and used as HERDR_BIN_PATH.
// Only file-backed canned replies (and herdr's Claude hook, written where herdr writes it); never
// loads or contacts Herdr.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

type Reply = {
  until?: string[]
  then?: Reply
  seq?: Reply[]
  waitFor?: string
  text?: string
  error?: string
  code?: unknown
  result?: unknown
  /**
   * What `herdr integration install claude` does: its hook script into the folder CLAUDE_CONFIG_DIR
   * names (else ~/.claude), registered at SessionStart in that folder's settings.json.
   */
  claudeHook?: true
}

const logPath = process.env.FAKE_HERDR_LOG ?? ''
const statePath = process.env.FAKE_HERDR_STATE ?? ''
const args = process.argv.slice(2)
appendFileSync(logPath, `${JSON.stringify(args)}\n`)
const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, Reply | undefined>
// The reply for the first four words (one pane's: `pane process-info --pane <id>`), else three, else two.
const four = args.slice(0, 4).join(' ')
const three = args.slice(0, 3).join(' ')
const key = state[four] ? four : state[three] ? three : args.slice(0, 2).join(' ')
let reply = state[key]
if (!reply) throw new Error(`Unexpected fake command: ${args.join(' ')}`)
// `herdr worktree create` also makes the worktree on disk, as herdr does: a test's git sees it.
if (key === 'worktree create') {
  const value = (flag: string): string => {
    const i = args.indexOf(flag)
    return i >= 0 ? (args[i + 1] ?? '') : ''
  }
  const cwd = value('--cwd')
  const branch = value('--branch')
  const base = value('--base')
  const path = value('--path')
  if (cwd && branch && path) {
    mkdirSync(dirname(path), { recursive: true })
    try {
      execFileSync('git', ['-C', cwd, 'worktree', 'add', '-b', branch, path, ...(base ? [base] : [])], {
        stdio: 'ignore',
      })
    } catch {}
  }
}
// { until: ['tab close', ...], then: <reply> }: this reply until one of those commands was
// called, the other one after (a pane that a close took away).
if (reply.until) {
  const called = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => (JSON.parse(line) as string[]).slice(0, 2).join(' '))
  if (reply.until.some(c => called.includes(c))) {
    if (!reply.then) throw new Error(`No "then" reply: ${key}`)
    reply = reply.then
  }
}
// { seq: [...] }: one reply per call in turn, the last one from then on (a screen that changes).
if (reply.seq) {
  const counter = `${statePath}.${key.replace(/[^\w-]+/g, '_')}.n`
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(n + 1))
  const next = reply.seq[Math.min(n, reply.seq.length - 1)]
  if (!next) throw new Error(`Empty fake sequence: ${key}`)
  reply = next
}
if (reply.waitFor) {
  const deadline = Date.now() + 5000
  while (!existsSync(reply.waitFor)) {
    if (Date.now() > deadline) throw new Error('Fake response gate timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
if (reply.claudeHook) {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const script = join(dir, 'hooks', 'herdr-agent-state.ps1')
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, '# installed by herdr\n# HERDR_INTEGRATION_ID=claude\n')
  const file = join(dir, 'settings.json')
  type Settings = { hooks?: Record<string, unknown[]> }
  const settings: Settings = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {}
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" session`
  settings.hooks ??= {}
  settings.hooks.SessionStart ??= []
  const list = settings.hooks.SessionStart
  if (!JSON.stringify(list).includes(JSON.stringify(command)))
    list.push({ matcher: '^(startup|resume|clear|compact|fork)$', hooks: [{ type: 'command', command, timeout: 10 }] })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  process.stdout.write(`installed claude integration hook to ${script}\nensured claude settings at ${file}\n`)
} else if (reply.text !== undefined) {
  // Commands that print plain text (agent read, pane read).
  process.stdout.write(reply.text)
} else if (reply.error) {
  console.error(JSON.stringify({ error: { code: reply.code, message: reply.error } }))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ result: reply.result ?? null }))
}
process.exit(process.exitCode ?? 0)
