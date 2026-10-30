// A fake Bitwarden CLI for the secret sinks' tests (#273): its vault is FAKE_BW_STATE (a JSON file:
// the session that unlocks it, folders, items), each call's argv goes to FAKE_BW_LOG with whether
// it had a session and a stdin, never what they were. `fail: "<command>"` in the state makes that
// command fail with an error that echoes its stdin, as a careless program might.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

interface Vault {
  session: string
  folders: { id: string; name: string }[]
  items: Record<string, unknown>[]
  fail?: string
}

const argv = process.argv.slice(2)
const stateFile = process.env.FAKE_BW_STATE ?? ''
const vault: Vault = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { session: 'sess', folders: [], items: [] }
const stdin = argv[0] === 'create' || argv[0] === 'edit' ? await Bun.stdin.text() : ''
if (process.env.FAKE_BW_LOG)
  appendFileSync(
    process.env.FAKE_BW_LOG,
    `${JSON.stringify({ argv, session: process.env.BW_SESSION === vault.session, noInteraction: process.env.BW_NOINTERACTION, stdin: stdin.length > 0 })}\n`,
  )
const save = (): void => writeFileSync(stateFile, JSON.stringify(vault))
const decoded = (): Record<string, unknown> => JSON.parse(Buffer.from(stdin.trim(), 'base64').toString('utf8'))
const command = argv.slice(0, 2).join(' ')
if (vault.fail && command === vault.fail) {
  console.error(`Error: could not ${command}: ${Buffer.from(stdin.trim(), 'base64').toString('utf8')}`)
  process.exit(1)
}
const unlocked = process.env.BW_SESSION === vault.session
if (argv[0] === 'status') {
  console.log(JSON.stringify({ status: unlocked ? 'unlocked' : 'locked' }))
  process.exit(0)
}
if (!unlocked) {
  console.error('You are not logged in.')
  process.exit(1)
}
const id = (): string => crypto.randomUUID()
switch (command) {
  case 'sync':
    console.log('Syncing complete.')
    break
  case 'list folders':
    console.log(JSON.stringify(vault.folders))
    break
  case 'create folder': {
    const folder = { id: id(), name: String(decoded().name) }
    vault.folders.push(folder)
    save()
    console.log(JSON.stringify(folder))
    break
  }
  case 'list items': {
    const folder = argv[argv.indexOf('--folderid') + 1]
    console.log(JSON.stringify(vault.items.filter(i => i.folderId === folder)))
    break
  }
  case 'create item': {
    const item = { ...decoded(), id: id() }
    vault.items.push(item)
    save()
    console.log(JSON.stringify(item))
    break
  }
  case 'edit item': {
    const at = vault.items.findIndex(i => i.id === argv[2])
    if (at < 0) {
      console.error('Not found.')
      process.exit(1)
    }
    vault.items[at] = { ...decoded(), id: argv[2] }
    save()
    console.log(JSON.stringify(vault.items[at]))
    break
  }
  default:
    console.error(`unknown: ${argv.join(' ')}`)
    process.exit(1)
}
