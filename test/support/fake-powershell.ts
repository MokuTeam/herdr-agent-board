// A fake Windows PowerShell for the env sink's tests (#273): it takes the board's stdin as the real
// script would ({ check, set } with each value as base64) and keeps the user's variables in
// FAKE_ENV_STATE (a JSON object), so no test ever sets this computer's. Each call's argv goes to
// FAKE_PS_LOG.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const stateFile = process.env.FAKE_ENV_STATE ?? ''
if (process.env.FAKE_PS_LOG) appendFileSync(process.env.FAKE_PS_LOG, `${JSON.stringify(process.argv.slice(2))}\n`)
const vars: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
const input = JSON.parse(await Bun.stdin.text()) as { check: string[]; set: Record<string, string> }
const taken = input.check.filter(name => Object.hasOwn(vars, name))
if (taken.length) {
  console.log(`taken:${taken.join(',')}`)
  process.exit(3)
}
for (const [name, value] of Object.entries(input.set)) vars[name] = Buffer.from(value, 'base64').toString('utf8')
writeFileSync(stateFile, JSON.stringify(vars))
console.log('ok')
