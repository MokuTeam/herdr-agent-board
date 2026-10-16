// Compiled to an executable (see fake-herdr-bin.ts) and used as HERDR_BIN_PATH.
// Only file-backed canned replies; never loads or contacts Herdr.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

type Reply = {
  seq?: Reply[]
  waitFor?: string
  text?: string
  error?: string
  code?: unknown
  result?: unknown
}

const logPath = process.env.FAKE_HERDR_LOG ?? ''
const statePath = process.env.FAKE_HERDR_STATE ?? ''
const args = process.argv.slice(2)
appendFileSync(logPath, `${JSON.stringify(args)}\n`)
const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, Reply | undefined>
const three = args.slice(0, 3).join(' ')
const key = state[three] ? three : args.slice(0, 2).join(' ')
let reply = state[key]
if (!reply) throw new Error(`Unexpected fake command: ${args.join(' ')}`)
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
if (reply.text !== undefined) {
  // Commands that print plain text (agent read, pane read).
  process.stdout.write(reply.text)
} else if (reply.error) {
  console.error(JSON.stringify({ error: { code: reply.code, message: reply.error } }))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ result: reply.result ?? null }))
}
process.exit(process.exitCode ?? 0)
