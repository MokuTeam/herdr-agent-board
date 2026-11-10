// The team quickstart (#231, docs/team-quickstart.md) and the unit it points at: the files exist,
// the README links the guide, the unit restarts the hub on failure, and the commands the guide
// tells people to type are ones the hub's CLI and the board's usage line actually have.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'
import { DEAD_MS } from '../../src/services/team-hub.ts'

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

test('behind a proxy (#353): the nginx block and the system unit fit the hub, and the guide has both languages', () => {
  const nginx = read('hub/hab-hub.nginx.conf')
  // The protocol's path only, to the hub's default loopback address, upgraded to a WebSocket.
  expect(nginx).toMatch(/^\s*location = \/v1 \{$/m)
  expect(nginx).toMatch(/^\s*proxy_pass http:\/\/127\.0\.0\.1:7443;$/m)
  expect(nginx).toMatch(/^\s*proxy_http_version 1\.1;$/m)
  expect(nginx).toMatch(/^\s*proxy_set_header Upgrade \$http_upgrade;$/m)
  expect(nginx).toMatch(/^\s*proxy_set_header Connection \$hab_hub_connection;$/m)
  expect(nginx).toMatch(/^\s*proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;$/m)
  expect(nginx).toMatch(/^\s*listen 443 ssl;$/m)
  // Longer than a board waits for a word (DEAD_MS), so the board's timer decides a connection is dead.
  const read_s = Number(/^\s*proxy_read_timeout\s+(\d+)s;$/m.exec(nginx)?.[1])
  expect(read_s * 1000).toBeGreaterThan(DEAD_MS)
  // A placeholder name only, in both server blocks.
  const names = [...nginx.matchAll(/^\s*server_name (\S+);$/gm)].map(m => m[1])
  expect(names).toEqual(['hub.example.com', 'hub.example.com'])

  const unit = read('hub/hab-hub.system.service')
  expect(unit).toMatch(/^Restart=on-failure$/m)
  expect(unit).toMatch(/^User=hab-hub$/m)
  expect(unit).toMatch(/^StateDirectory=hab-hub$/m)
  expect(unit).toMatch(
    /^ExecStart=\S+ \S+\/hub\/src\/main\.ts --listen 127\.0\.0\.1:7443 --trust-proxy --dir \/var\/lib\/hab-hub$/m,
  )
  // Every flag the unit passes is one the hub takes.
  const main = read('hub/src/main.ts')
  for (const flag of ['--listen', '--trust-proxy', '--dir']) expect(main).toContain(`'${flag}'`)

  const guide = read('docs/team-quickstart.md')
  expect(guide).toContain("## The hub's admin on your own server with a domain")
  expect(guide).toContain('## Админ хаба на своём сервере с доменом')
  for (const word of [
    'hub/hab-hub.nginx.conf',
    'hub/hab-hub.system.service',
    '--hub wss://hub.example.com',
    'NODE_EXTRA_CA_CERTS',
  ])
    expect(guide.split(word).length - 1).toBeGreaterThanOrEqual(2)
})
