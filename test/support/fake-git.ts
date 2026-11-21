// A fake git for the tests of the owner's identity and login on a node (#609): only what
// adapters/git-access.ts runs. Its global config and its credential store are
// `<HOME>/.fake-git/state.json`; the store's lines go to `<HOME>/.git-credentials` too, as git's
// `store` helper keeps them. Each call's argv goes to `<HOME>/.fake-git/calls.jsonl` with whether
// it had a stdin, never what it was.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface State {
  config: Record<string, string[]>
  store: { host: string; username: string; password: string }[]
}

const all = process.argv.slice(2)
const home = process.env.HOME || process.env.USERPROFILE || '.'
const dir = join(home, '.fake-git')
mkdirSync(dir, { recursive: true })
const stateFile = join(dir, 'state.json')
const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { config: {}, store: [] }
const helpers: string[] = []
let at = 0
while (all[at] === '-c') {
  const [k, ...v] = (all[at + 1] ?? '').split('=')
  if (k === 'credential.helper') {
    if (v.join('=') === '') helpers.length = 0
    else helpers.push(v.join('='))
  }
  at += 2
}
const argv = all.slice(at)
const stdin = argv[0] === 'credential' ? await Bun.stdin.text() : ''
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv: all, stdin: stdin.length > 0 })}\n`)
const save = (): void => {
  writeFileSync(stateFile, JSON.stringify(state))
  const lines = state.store.map(s => `https://${s.username}:${s.password}@${s.host}\n`).join('')
  // Readable by others, as a careless store would leave it: the board makes it private.
  writeFileSync(join(home, '.git-credentials'), lines)
  chmodSync(join(home, '.git-credentials'), 0o644)
}
const fields = (): Record<string, string> =>
  Object.fromEntries(
    stdin
      .split('\n')
      .filter(l => l.includes('='))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )

if (argv[0] === 'config') {
  if (argv[1] !== '--global') process.exit(2)
  const op = argv[2]
  if (op === '--get' || op === '--get-all') {
    const v = state.config[argv[3] ?? ''] ?? []
    if (!v.length) process.exit(1)
    console.log(op === '--get' ? v[v.length - 1] : v.join('\n'))
    process.exit(0)
  }
  if (op === '--unset') {
    const key = argv[3] ?? ''
    const pattern = argv[4] === undefined ? null : new RegExp(argv[4])
    const v = state.config[key] ?? []
    const left = pattern ? v.filter(x => !pattern.test(x)) : []
    if (left.length === v.length) process.exit(5)
    if (left.length) state.config[key] = left
    else delete state.config[key]
    save()
    process.exit(0)
  }
  state.config[op ?? ''] = [argv[3] ?? '']
  save()
  process.exit(0)
}
if (argv[0] === 'credential') {
  if (helpers.at(-1) !== 'store') process.exit(2)
  const f = fields()
  const match = (s: State['store'][number]): boolean =>
    s.host === f.host && (f.username === undefined || s.username === f.username)
  if (argv[1] === 'fill') {
    const s = state.store.find(match)
    if (!s) {
      console.error('fatal: could not read Username: terminal prompts disabled')
      process.exit(128)
    }
    console.log(`protocol=https\nhost=${s.host}\nusername=${s.username}\npassword=${s.password}`)
    process.exit(0)
  }
  if (argv[1] === 'approve') {
    state.store = [
      ...state.store.filter(s => !match(s)),
      { host: f.host ?? '', username: f.username ?? '', password: f.password ?? '' },
    ]
    save()
    process.exit(0)
  }
  if (argv[1] === 'reject') {
    state.store = state.store.filter(s => !match(s))
    save()
    process.exit(0)
  }
}
console.error(`fake git: ${all.join(' ')}`)
process.exit(2)
