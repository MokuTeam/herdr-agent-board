// The team quickstart (#231, docs/team-quickstart.md) and the unit it points at: the files exist,
// the README links the guide, the unit restarts the hub on failure, and the commands the guide
// tells people to type are ones the hub's CLI and the board's usage line actually have.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'

const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')

test('the quickstart is linked from the README Team section and has both languages', () => {
  const guide = read('docs/team-quickstart.md')
  expect(read('README.md')).toContain('docs/team-quickstart.md')
  expect(guide).toContain("## The hub's admin")
  expect(guide).toContain('## Каждый участник')
  expect(guide).toContain('## When something does not work')
  expect(guide).toContain('## Если что-то не работает')
})

test('the unit keeps the hub running and the guide names only commands that exist', () => {
  const unit = read('hub/hab-hub.service')
  expect(unit).toMatch(/^Restart=on-failure$/m)
  expect(unit).toMatch(/^ExecStart=.*hub\/src\/main\.ts .*--listen .*--dir %h\/\.local\/state\/hab-hub$/m)
  const guide = read('docs/team-quickstart.md')
  for (const cmd of ['invite create --note', 'invite revoke', 'revoke <name>', 'peers', 'invite list'])
    expect(guide).toContain(cmd)
  const hubCli = read('hub/src/cli.ts')
  for (const word of ['invite create', 'invite list', 'invite revoke', 'peers', 'revoke'])
    expect(hubCli).toContain(word)
  expect(guide).toContain('tailscale ip -4')
  expect(guide).toContain('loginctl enable-linger')
  expect(guide).toContain('board team join')
  expect(guide).toContain('board team draft')
})
