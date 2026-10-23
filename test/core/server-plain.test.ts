// The plan in plain words (the simple-setup spec's "The flow"): what was found, what will be done,
// what is not touched; no jargon, the full plan stays the details.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import { type PlainPlan, plainPlan } from '../../src/core/server-plain.ts'
import { buildPlan, type Manual, type RecordItem, undoPlan, type Wanted } from '../../src/core/server-plan.ts'
import { FENCE_FILE } from '../../src/core/server-texts.ts'
import { BOARD_KEY, factsFor, recordFor, stepOneMissing } from '../support/server-facts.ts'

const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
  publicKey: BOARD_KEY,
}
const en = translator('en')
const ru = translator('ru')
const plain = (f: ServerFacts, t = en, w: Wanted = W): PlainPlan =>
  plainPlan(f, buildPlan(f, w, { id: 'r1', docker: false }), w, t)
const lines = (p: PlainPlan): string[] => [
  p.found,
  ...p.will,
  ...(p.docker ? [p.docker] : []),
  p.untouched,
  ...(p.stop ? [p.stop] : []),
]

describe('the plan in plain words, per case', () => {
  test('nothing on the ports: the board’s own web server, nothing else touched', () => {
    expect(plain(factsFor('bare'))).toEqual({
      found: 'Debian 13 · nothing answers on 443 and 80',
      will: [
        'Run a web server of the board’s own for board.example.com on 443 and 80; it gets its certificate by itself.',
      ],
      docker: null,
      untouched: 'Nothing else on the server is touched.',
      stop: null,
    })
  })

  test('an empty server: the board’s own login first; Docker to install in a line of its own', () => {
    const p = plain({ ...stepOneMissing('bare', 'ubuntu2604'), docker: null })
    expect(p.found).toBe('Ubuntu 26.04 · nothing answers on 443 and 80')
    expect(p.will[0]).toBe('Make the board’s own login on the server (boardtunnel), allowed only to hold the tunnel.')
    expect(p.will).toHaveLength(2)
    expect(p.docker).toBe('Docker is not installed: I will install it from Docker’s own repository.')
  })

  test('only the board’s key missing: put in place, said so', () => {
    const f = factsFor('bare')
    const p = plain({
      ...f,
      fence: Object.fromEntries(
        [
          'authorizedkeysfile /etc/ssh/authorized_keys/boardtunnel',
          'authenticationmethods publickey',
          'passwordauthentication no',
          'kbdinteractiveauthentication no',
          'allowtcpforwarding remote',
          'permitlisten none',
          'allowstreamlocalforwarding remote',
          'streamlocalbindunlink yes',
          'streamlocalbindmask 0117',
          'x11forwarding no',
          'allowagentforwarding no',
          'permittunnel no',
          'permittty no',
          'forcecommand /bin/false',
          'clientaliveinterval 15',
          'clientalivecountmax 2',
        ].map(l => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]),
      ),
      stepOne: { user: { uid: 995, group: 'boardtunnel' }, keys: 'other', keysDir: true, include: true },
    })
    expect(p.will[0]).toBe('Put the board’s key in place for its login on the server (boardtunnel).')
  })

  test('Caddy as a service, Caddy in Docker: the domain added to their Caddy, their sites checked', () => {
    const two = plain(factsFor('2'))
    expect(two.found).toBe('Debian 13 · Caddy serves 443 and 80: blog.example.org, shop.example.org')
    expect(two.will).toEqual(['Add board.example.com to your Caddy and hand it the board’s tunnel.'])
    expect(two.untouched).toBe('Your sites are not touched; each is checked before and after.')
    const three = plain(factsFor('3a'))
    expect(three.found).toBe('Debian 13 · Caddy in Docker serves 443 and 80: shop.example.org')
    expect(three.will).toEqual(two.will)
    // no curl on the server: their sites are not fetched, so not said to be checked
    const f = factsFor('3b')
    expect(plain({ ...f, host: { ...f.host, fetch: null } }).untouched).toBe('Your sites are not touched.')
  })

  test('something else on 443: the board’s own web server on 8443, theirs untouched', () => {
    const a = plain(factsFor('4a'))
    expect(a.found).toBe('Debian 13 · nginx serves 443: shop.example.org; 80 is free')
    expect(a.will).toEqual([
      'Run a web server of the board’s own for board.example.com on port 8443 (https://board.example.com:8443); it takes 80 only for its certificate.',
    ])
    expect(a.untouched).toBe('nginx on 443 is not touched.')
    const b = plain(factsFor('4b'))
    expect(b.found).toBe('Debian 13 · nginx serves 443 and 80: shop.example.org')
    expect(b.will).toEqual([
      'Run a web server of the board’s own for board.example.com on port 8443 (https://board.example.com:8443); your nginx passes it only its certificate checks.',
    ])
    expect(b.untouched).toBe('Your sites are not touched; each is checked before and after.')
  })

  test('80 someone else’s, 443 free: the board’s own on 443 alone, theirs untouched', () => {
    const p = plain(factsFor('1b'))
    expect(p.found).toBe('Debian 13 · python3 answers on 80; 443 is free')
    expect(p.will).toEqual([
      'Run a web server of the board’s own for board.example.com on 443; it gets its certificate there by itself.',
    ])
    expect(p.untouched).toBe('python3 on 80 is not touched.')
  })

  test('many sites: the first three named, the rest counted', () => {
    const f = factsFor('2')
    if (!f.caddy) throw new Error('caddy')
    const hosts = ['a.example.org', 'b.example.org', 'c.example.org', 'd.example.org', 'e.example.org', '*.example.org']
    expect(plain({ ...f, caddy: { ...f.caddy, hosts } }).found).toBe(
      'Debian 13 · Caddy serves 443 and 80: a.example.org, b.example.org, c.example.org and 2 more',
    )
  })

  test('set up already: nothing to change; another address: moved', () => {
    const f = factsFor('2')
    if (!f.caddy || !f.folder) throw new Error('facts')
    const done: ServerFacts = {
      ...f,
      caddy: { ...f.caddy, hosts: [...f.caddy.hosts, 'board.example.com'] },
      folder: { ...f.folder, group: 'caddy' },
      record: recordFor('2', {
        items: [
          { kind: 'file', path: '/etc/caddy/agent-board/board.caddy', sha256: 'ab'.repeat(32) },
          {
            kind: 'line',
            file: '/etc/caddy/Caddyfile',
            line: 'import /etc/caddy/agent-board/board.caddy # agent-board',
          },
        ],
      }),
    }
    const same = plain(done)
    expect(same.will).toEqual(['Nothing to change: the board is set up here already.'])
    expect(same.untouched).toBe('Nothing on the server is changed.')
    const moved = plain(done, en, { ...W, domain: 'new.example.com' })
    expect(moved.will).toEqual(['Move the board’s address to https://new.example.com.'])
  })

  test('Undo: what the board added goes, its login too when it made it; nothing of theirs', () => {
    const items: RecordItem[] = [
      { kind: 'user', name: 'boardtunnel' },
      { kind: 'fence', path: FENCE_FILE },
      { kind: 'line', file: '/etc/caddy/Caddyfile', line: 'import /etc/caddy/agent-board/board.caddy # agent-board' },
    ]
    const r = recordFor('2', { items })
    const f = { ...factsFor('2'), record: r }
    const u = undoPlan(r, f, { id: 'u1', removeDocker: false, removeEdited: false })
    const p = plainPlan(f, u, W, en)
    expect(p.will).toEqual([
      'Remove what the board added for board.example.com, and its login on the server (boardtunnel).',
    ])
    expect(p.untouched).toBe('Nothing of yours is removed; your sites are checked before and after.')
    const r1 = recordFor('1', { items: [{ kind: 'container', name: 'agent-board-caddy', setup: 'r0' }] })
    const u1 = undoPlan(r1, { ...factsFor('bare'), record: r1 }, { id: 'u1', removeDocker: false, removeEdited: false })
    expect(plainPlan(factsFor('bare'), u1, W, en).will).toEqual(['Remove what the board added for board.example.com.'])
    expect(plainPlan(factsFor('bare'), u1, W, en).untouched).toBe('Nothing of yours is removed.')
  })
})

describe('a server the board does not do: why, in one line, and nothing done', () => {
  const stop = (f: ServerFacts, w: Wanted = W): PlainPlan => plain(f, en, w)
  test('its web server set up otherwise', () => {
    const f = factsFor('3a')
    const docker = f.docker
    if (!docker) throw new Error('docker')
    const p = stop({
      ...f,
      docker: {
        ...docker,
        containers: docker.containers.map(c => ({
          ...c,
          networks: [{ name: 'bridge', driver: 'bridge', userDefined: false }],
        })),
      },
    })
    expect(p.will).toEqual([])
    expect(p.docker).toBeNull()
    expect(p.stop).toBe(
      'The board does not set this server up by itself: your web server is set up in a way it does not change.',
    )
    expect(p.untouched).toBe('Nothing on the server is changed.')
  })
  test('another system, the domain served already, another board, no key of the board’s', () => {
    const bare = factsFor('bare')
    expect(stop({ ...bare, distro: { ...bare.distro, id: 'fedora', version: '41', supported: false } })).toMatchObject({
      found: 'Fedora 41 (not a system the board sets up) · nothing answers on 443 and 80',
      stop: 'The board does not set this server up by itself: it sets up Debian 12 and 13 and Ubuntu 22.04 to 26.04 only, with the tools they come with.',
    })
    const f2 = factsFor('2')
    if (!f2.caddy) throw new Error('caddy')
    expect(stop({ ...f2, caddy: { ...f2.caddy, hosts: ['board.example.com'] } }).stop).toBe(
      'The board does not set this server up by itself: your web server serves board.example.com already.',
    )
    const other = recordFor('1', { pair: { user: 'tun2', socket: '/var/lib/tun2/board.sock' } })
    expect(stop({ ...bare, record: other }).stop).toBe(
      'The board does not set this server up by itself: another board is set up on this server.',
    )
    const { publicKey: _, ...noKey } = W
    expect(stop(stepOneMissing('bare'), noKey).stop).toBe(
      'The board does not set this server up by itself: it has no key of its own yet for its login there.',
    )
  })
  test('each reason has its plain line', () => {
    const reasons: Manual[] = [
      'os',
      'selinux',
      'podman',
      'rootless',
      'userns',
      'requiretty',
      'noSystemd',
      'dockerConflicts',
      'caddyJson',
      'caddyResume',
      'adminOff',
      'autoHttpsOff',
      'caddyBaked',
      'caddy1',
      'twoConfigs',
      'bridge',
      'macvlan',
      'domainServed',
      'split',
      'other80',
      'otherSetup',
      'interrupted',
      'portTaken',
      'folder',
    ]
    for (const why of reasons) {
      const p = plainPlan(factsFor('bare'), { case: null, why: [why] }, W, en)
      expect([why, p.stop?.startsWith('The board does not set this server up by itself: ')]).toEqual([why, true])
      expect([why, p.stop?.includes('server.plain')]).toEqual([why, false])
    }
  })
})

describe('plain words: no jargon, both languages, at most three lines of what will be done', () => {
  const all = (t: typeof en): string[][] => {
    const out: string[][] = []
    for (const c of ['bare', 'nodocker', '1b', '2', '3a', '3b', '4a', '4b'] as const) {
      out.push(lines(plain(factsFor(c), t)))
      out.push(lines(plain({ ...stepOneMissing(c), docker: c === 'nodocker' ? null : factsFor(c).docker }, t)))
    }
    for (const why of ['os', 'bridge', 'otherSetup', 'folder', 'domainServed', 'podman'] as Manual[])
      out.push(lines(plainPlan(factsFor('bare'), { case: null, why: [why] }, W, t)))
    return out
  }
  test('English: none of “network”, “case”, “container”, “Caddyfile”', () => {
    for (const ls of all(en))
      for (const l of ls) expect([l, /network|\bcase\b|container|caddyfile/i.test(l)]).toEqual([l, false])
  })
  test('Russian: every line its own, none of “сеть”, “контейнер”, “Caddyfile”', () => {
    const e = all(en)
    const r = all(ru)
    expect(r.length).toBe(e.length)
    r.forEach((ls, i) => {
      for (const l of ls) expect([l, /сет[ьи]|контейнер|caddyfile|server\.plain/i.test(l)]).toEqual([l, false])
      expect(ls).not.toEqual(e[i])
    })
  })
  test('what will be done: two or three lines at most, with Docker’s apart', () => {
    for (const c of ['bare', '2', '3a', '4b'] as const) {
      const p = plain({ ...stepOneMissing(c), docker: null })
      expect([c, p.will.length <= 3]).toEqual([c, true])
    }
  })
})

test('the page can import it: no node: import', () => {
  expect(readFileSync('src/core/server-plain.ts', 'utf8')).not.toMatch(/from 'node:/)
})
