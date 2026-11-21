// A fake GitHub CLI for the tests of the owner's login on a node (#609). Its "keyring" is
// `<HOME>/.fake-gh/state.json` (per host the account and token; `accounts` maps a token to the
// account a login with it gets, else "owner"); it writes gh's own hosts file (`hosts.yml`, the
// host and the account, never a token) where gh does: GH_CONFIG_DIR, else "GitHub CLI" under
// APPDATA on Windows, else the XDG folder. Each call's argv goes to `<HOME>/.fake-gh/calls.jsonl`
// with whether it had a stdin, never what it was. `fail: "<command>"` in the state makes that
// command fail, `hang: "<command>"` makes it never end.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface State {
  hosts: Record<string, { user: string; token: string }>
  accounts?: Record<string, string>
  setupGit?: string[]
  fail?: string
  /** This command never ends (a host gh cannot reach). */
  hang?: string
}

const argv = process.argv.slice(2)
const home = process.env.HOME || process.env.USERPROFILE || '.'
const dir = join(home, '.fake-gh')
mkdirSync(dir, { recursive: true })
const stateFile = join(dir, 'state.json')
const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { hosts: {} }
const command = argv.slice(0, 2).join(' ')
const stdin = command === 'auth login' ? await Bun.stdin.text() : ''
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv, stdin: stdin.length > 0 })}\n`)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at < 0 ? undefined : argv[at + 1]
}
// gh's own order: GH_CONFIG_DIR, XDG_CONFIG_HOME, APPDATA on Windows, ~/.config.
const configDir =
  process.env.GH_CONFIG_DIR ||
  (process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'gh')
    : process.platform === 'win32' && process.env.APPDATA
      ? join(process.env.APPDATA, 'GitHub CLI')
      : join(home, '.config', 'gh'))
const save = (): void => {
  writeFileSync(stateFile, JSON.stringify(state))
  mkdirSync(configDir, { recursive: true })
  const yml = Object.entries(state.hosts)
    .map(([h, v]) => `${h}:\n    users:\n        ${v.user}:\n    git_protocol: https\n    user: ${v.user}\n`)
    .join('')
  writeFileSync(join(configDir, 'hosts.yml'), yml)
}
if (state.hang && command === state.hang) await new Promise(() => setInterval(() => {}, 1000))
if (state.fail && command === state.fail) {
  console.error(`could not ${command}`)
  process.exit(1)
}
const host = flag('--hostname') ?? 'github.com'
switch (command) {
  case 'auth token': {
    const h = state.hosts[host]
    if (!h) {
      console.error(`no oauth token found for ${host}`)
      process.exit(1)
    }
    console.log(h.token)
    break
  }
  case 'auth login': {
    if (!argv.includes('--with-token')) process.exit(2)
    const token = stdin.trim()
    if (!token) process.exit(1)
    state.hosts[host] = { user: state.accounts?.[token] ?? 'owner', token }
    save()
    break
  }
  case 'auth setup-git':
    state.setupGit = [...(state.setupGit ?? []), host]
    save()
    break
  case 'auth logout': {
    const h = state.hosts[host]
    const user = flag('--user')
    if (!h || (user !== undefined && h.user !== user)) {
      console.error(`not logged in to ${host}`)
      process.exit(1)
    }
    delete state.hosts[host]
    save()
    break
  }
  default:
    console.error(`fake gh: ${argv.join(' ')}`)
    process.exit(2)
}
