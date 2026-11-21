// The node's install as a plan (#509): the ceiling Look's memory gives, a server refused in words,
// the record and the Undo it gives, what a run says, and that no script the plan can emit holds a
// secret. Pure: nothing runs here (node-plan.e2e.test.ts and the others run the scripts on the fake
// root).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_STRINGS } from '../../src/core/i18n/node-strings.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  ceilingFor,
  ceilingProblem,
  type NodeFacts,
  type NodeRecord,
  type NodeWanted,
  nodeLookScript,
  nodePlan,
  nodeRecord,
  nodeRefusals,
  nodeRunScript,
  nodeUndoPlan,
  nodeWantedProblem,
  readNodeLook,
  readNodeRun,
} from '../../src/core/node-plan.ts'
import { linkFence, linkKeysLine, sliceDropIn } from '../../src/core/node-texts.ts'
import { SUPPORTED } from '../../src/core/server-look.ts'
import type { Text } from '../../src/core/server-plan.ts'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINodeLinkTestKeyOnly00000000000000000000 agent-board link'
const RUN = { id: 'run-1', at: '2026-11-21T10:00:00Z' }

const facts = (over: Partial<NodeFacts> = {}): NodeFacts => ({
  os: { id: 'ubuntu', version: '24.04', pretty: 'Ubuntu 24.04.1 LTS' },
  arch: 'x86_64',
  cpus: 4,
  memTotalMb: 8192,
  memAvailableMb: 7400,
  swapTotalMb: 0,
  homeFreeMb: 50_000,
  systemd: true,
  sudo: 'password',
  has: ['curl', 'git', 'unzip', 'tar', 'runuser', 'loginctl', 'useradd'],
  user: 'none',
  linkUser: 'none',
  slice: false,
  unit: false,
  linger: false,
  keysDir: false,
  keys: 'none',
  fence: 'none',
  include: true,
  sshdNow: 'ok',
  homeLeft: false,
  busy: false,
  plugin: null,
  record: null,
  recordTorn: false,
  listening: [
    { port: 22, name: 'sshd' },
    { port: 443, name: 'caddy' },
  ],
  bun: null,
  herdr: null,
  claude: null,
  serverBun: null,
  ...over,
})

const wanted = (over: Partial<NodeWanted> = {}): NodeWanted => ({
  id: 'server-1',
  port: 12430,
  linkKey: KEY,
  master: { id: 'laptop', name: 'Ноутбук Ромы 100%', tokenHash: 'ab'.repeat(32) },
  plugin: { path: '/var/tmp/agent-board-plugin.tar', sha256: 'cd'.repeat(32) },
  ceiling: ceilingFor(facts()) as NonNullable<ReturnType<typeof ceilingFor>>,
  packages: false,
  ...over,
})

const en = translator('en')
const ru = translator('ru')
const words = (t: Text, lang = en): string => lang(t.key, t.params ?? {})

const applied = (items: NodeRecord['items'], over: Partial<NodeRecord> = {}): NodeRecord => ({
  v: 1,
  run: 'run-0',
  at: '2026-11-20T10:00:00Z',
  state: 'applied',
  node: { id: 'server-1', port: 12430 },
  items,
  ...over,
})

describe('the ceiling from what Look read', () => {
  test('2, 8 and 32 GB servers: 60 percent of the memory, 80 percent of that before the slowdown, 512 MB of swap', () => {
    // a 2 GB server: 60 percent is under 1500 MB, too small for a node
    expect(ceilingFor({ memTotalMb: 2048, memAvailableMb: 1800 })).toBeNull()
    expect(ceilingFor({ memTotalMb: 8192, memAvailableMb: 7400 })).toEqual({
      memoryMaxMb: 4915,
      memoryHighMb: 3932,
      swapMaxMb: 512,
      cpuWeight: 50,
      tasksMax: 3000,
    })
    expect(ceilingFor({ memTotalMb: 32768, memAvailableMb: 30000 })).toEqual({
      memoryMaxMb: 19660,
      memoryHighMb: 15728,
      swapMaxMb: 512,
      cpuWeight: 50,
      tasksMax: 3000,
    })
  })

  test('a server with little available: what is free now less 1 GB, and none under 1500 MB', () => {
    expect(ceilingFor({ memTotalMb: 8192, memAvailableMb: 3000 })?.memoryMaxMb).toBe(1976)
    expect(ceilingFor({ memTotalMb: 8192, memAvailableMb: 3000 })?.memoryHighMb).toBe(1580)
    expect(ceilingFor({ memTotalMb: 8192, memAvailableMb: 2400 })).toBeNull()
  })

  test('the figures as the owner changed them are checked, and land in the drop-in as given', () => {
    const f = facts()
    const own = { memoryMaxMb: 6000, memoryHighMb: 5000, swapMaxMb: 0, cpuWeight: 80, tasksMax: 4000 }
    expect(ceilingProblem(own, f)).toBeNull()
    expect(ceilingProblem({ ...own, memoryMaxMb: 1000 }, f)?.key).toBe('node.refuse.memoryMax')
    expect(ceilingProblem({ ...own, memoryMaxMb: 9000 }, f)?.key).toBe('node.refuse.memoryMax')
    expect(ceilingProblem({ ...own, memoryHighMb: 7000 }, f)?.key).toBe('node.refuse.memoryHigh')
    expect(ceilingProblem({ ...own, cpuWeight: 0 }, f)?.key).toBe('node.refuse.cpuWeight')
    const p = nodePlan(f, wanted({ ceiling: own }))
    if (!p.ok) throw new Error('refused')
    const slice = p.plan.steps.find(s => s.id === 'slice')
    expect(slice?.commands.join('\n')).toContain("'MemoryMax=6000M'")
    expect(sliceDropIn(own)).toContain(
      'MemoryHigh=5000M\nMemoryMax=6000M\nMemorySwapMax=0M\nCPUWeight=80\nTasksMax=4000\n',
    )
    expect(words(p.plan.words[1] as Text)).toContain('5000 MB')
  })
})

describe('a server the board does not set up is refused in words', () => {
  const refused = (f: Partial<NodeFacts>, w: Partial<NodeWanted> = {}): string[] => {
    const p = nodePlan(facts(f), wanted(w))
    if (p.ok) throw new Error('not refused')
    for (const t of p.why) {
      // every reason reads in both languages, its values filled in
      for (const lang of [en, ru]) {
        const s = words(t, lang)
        expect(s.startsWith('node.')).toBe(false)
        expect(s).not.toMatch(/\{\w+\}/)
      }
    }
    return p.why.map(t => words(t))
  }

  test('too small', () => {
    expect(refused({ memTotalMb: 2048, memAvailableMb: 1800 })).toEqual([
      'The server is too small for a node: 2048 MB of memory, 1800 MB available; the ceiling would be under 1500 MB.',
    ])
  })

  test('not supported: the system, its version, the machine, no systemd, no way to root', () => {
    expect(refused({ os: { id: 'debian', version: '11', pretty: 'Debian GNU/Linux 11 (bullseye)' } })).toEqual([
      'Debian GNU/Linux 11 (bullseye) is not supported: Debian 12 or 13, Ubuntu 22.04 to 26.04.',
    ])
    expect(refused({ os: { id: 'centos', version: '9', pretty: '' } })[0]).toContain('centos 9 is not supported')
    expect(refused({ arch: 'armv7l' })).toEqual(['The machine is armv7l: a node needs x86_64 or aarch64.'])
    expect(refused({ systemd: false })).toEqual(['This server does not run systemd.'])
    expect(refused({ sudo: 'none' })).toEqual(['The login cannot become root here (no sudo).'])
  })

  test('every supported system is let through', () => {
    for (const [id, versions] of Object.entries(SUPPORTED))
      for (const version of versions)
        expect(nodePlan(facts({ os: { id, version, pretty: '' } }), wanted()).ok).toBe(true)
  })

  test("what is in the way: a user or a key of another's, the door's port taken, sshd that reads no drop-ins", () => {
    expect(refused({ user: 'other' })).toEqual([
      'A user agent-board is there that the board did not make: remove or rename it first.',
    ])
    expect(refused({ linkUser: 'group' })[0]).toContain('A group agent-board-link is there without its user')
    expect(refused({ listening: [{ port: 12430, name: 'nginx' }] })).toEqual(['Port 12430 is taken by nginx.'])
    expect(refused({ include: false })[0]).toContain('sshd_config does not read sshd_config.d')
    expect(refused({ sshdNow: 'line 3: Bad configuration option: BROKEN' })[0]).toContain('BROKEN')
    expect(refused({ fence: 'other' })[0]).toContain('/etc/ssh/sshd_config.d/00-agent-board-node.conf is there')
    expect(refused({ has: ['git', 'tar', 'runuser', 'loginctl', 'useradd'] })).toEqual([
      'curl is not on this server: tick the packages.',
      "unzip is not on this server and Bun's installer needs it: tick the packages.",
    ])
    // with the tick, apt installs them first
    expect(nodePlan(facts({ has: ['tar', 'runuser', 'loginctl', 'useradd'] }), wanted({ packages: true })).ok).toBe(
      true,
    )
  })

  test('a run that did not finish, or another node, is Undone first; a record that does not parse is looked at', () => {
    expect(refused({ record: applied([{ kind: 'unit' }], { state: 'running' }) })).toEqual([
      "A run of the board's here did not finish: Undo it first.",
    ])
    expect(refused({ record: applied([], { node: { id: 'server-2', port: 12430 } }) })).toEqual([
      'This server is already node server-2: Undo that first.',
    ])
    expect(refused({ recordTorn: true, record: null })[0]).toContain('/etc/agent-board-node/setup.json is there')
  })

  test('a home left by an Undo that kept the work, or a run going on, waits', () => {
    expect(refused({ homeLeft: true })).toEqual([
      '/home/agent-board is there without its user (an Undo kept its work): move it away first.',
    ])
    expect(refused({ busy: true })).toEqual(["A run of the board's is going on here: wait for it to end."])
  })

  test("the node's own board holding the door's port is no reason: a second Apply goes on", () => {
    const f = facts({
      user: 'ours',
      linkUser: 'ours',
      keys: 'same',
      fence: 'same',
      listening: [{ port: 12430, name: 'bun' }],
      record: applied([{ kind: 'unit' }, { kind: 'fence' }, { kind: 'keys' }]),
    })
    expect(nodeRefusals(f, wanted())).toEqual([])
  })
})

describe('the plan', () => {
  test('every step in order, each with its check; what each makes is on the record', () => {
    const p = nodePlan(facts(), wanted({ packages: true }))
    if (!p.ok) throw new Error('refused')
    expect(p.plan.steps.map(s => s.id)).toEqual([
      'check',
      'user',
      'slice',
      'linger',
      'packages',
      'profile',
      'bun',
      'herdr',
      'claude',
      'plugin',
      'config',
      'install',
      'unit',
      'link',
      'hello',
    ])
    const by = Object.fromEntries(p.plan.steps.map(s => [s.id, s]))
    expect(by.user?.record).toEqual([{ kind: 'user', name: 'agent-board' }])
    expect(by.link?.record).toEqual([
      { kind: 'user', name: 'agent-board-link' },
      { kind: 'keysdir' },
      { kind: 'keys' },
      { kind: 'fence' },
    ])
    for (const s of p.plan.steps) {
      expect(words(s.title).startsWith('node.')).toBe(false)
      expect(words(s.why).startsWith('node.')).toBe(false)
    }
    // what runs here stays: the plan says so
    expect(p.plan.words.map(t => words(t))).toContain('Nothing of what runs here is changed: sshd (22), caddy (443).')
    expect(p.plan.warnings.map(t => words(t))).toEqual(['Undo leaves the packages installed.'])
  })

  test('a user, a folder or a link user that was there before is not on the record: Undo leaves it', () => {
    const p = nodePlan(facts({ user: 'ours', linkUser: 'ours', keysDir: true }), wanted())
    if (!p.ok) throw new Error('refused')
    const by = Object.fromEntries(p.plan.steps.map(s => [s.id, s]))
    expect(by.user?.record).toEqual([])
    expect(by.link?.record).toEqual([{ kind: 'keys' }, { kind: 'fence' }])
  })

  test("a Bun on the server that is new enough is copied for the node's user instead of fetched", () => {
    const p = nodePlan(
      facts({
        serverBun: { path: '/usr/local/bin/bun', version: '1.4.5' },
        has: ['tar', 'curl', 'runuser', 'loginctl', 'useradd'],
      }),
      wanted(),
    )
    if (!p.ok) throw new Error('refused')
    const bun = p.plan.steps.find(s => s.id === 'bun')?.commands.join('\n') ?? ''
    expect(bun).toContain("< '/usr/local/bin/bun'")
    expect(bun).not.toContain('bun.sh/install')
    expect(words(p.plan.words[2] as Text)).toBe('Bun 1.4.5 is copied from /usr/local/bin/bun.')
  })

  test('the fence and the key line: one forward to the door, nothing else', () => {
    expect(linkKeysLine(` ${KEY} `, 12430)).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:12430" ${KEY}`)
    expect(linkFence(12430)).toBe(
      [
        '# agent-board: sshd\'s fence for the node\'s link user. Added by "Add a server"; its Undo removes it.',
        'Match User agent-board-link',
        '    AuthorizedKeysFile /etc/ssh/authorized_keys/agent-board-link',
        '    AuthenticationMethods publickey',
        '    AllowTcpForwarding local',
        '    PermitOpen 127.0.0.1:12430',
        '    AllowStreamLocalForwarding no',
        '    X11Forwarding no',
        '    AllowAgentForwarding no',
        '    PermitTunnel no',
        '    PermitTTY no',
        '    ForceCommand /bin/false',
        'Match all',
        '',
      ].join('\n'),
    )
  })

  test('values that cannot reach a script are refused before any is made', () => {
    expect(nodeWantedProblem(wanted())).toBeNull()
    const bad: [string, Partial<NodeWanted>][] = [
      ['id', { id: 'local' }],
      ['id', { id: 'Server 1' }],
      ['port', { port: 12422 }],
      ['port', { port: 80 }],
      ['linkKey', { linkKey: `${KEY}" evil` }],
      ['linkKey', { linkKey: 'ssh-ed25519 AAAA\nrm -rf /' }],
      ['master.name', { master: { id: 'laptop', name: 'a\nb', tokenHash: 'ab'.repeat(32) } }],
      ['master.tokenHash', { master: { id: 'laptop', name: 'a', tokenHash: 'AB'.repeat(32) } }],
      ['plugin.path', { plugin: { path: '/var/tmp/../etc/shadow', sha256: 'cd'.repeat(32) } }],
      ['plugin.path', { plugin: { path: '/var/tmp/a b.tar', sha256: 'cd'.repeat(32) } }],
    ]
    for (const [field, over] of bad) {
      expect([field, nodeWantedProblem(wanted(over))]).toEqual([field, field])
      expect(() => nodePlan(facts(), wanted(over))).toThrow()
    }
  })
})

describe('how the run is built', () => {
  const script = (): string => {
    const p = nodePlan(facts(), wanted())
    if (!p.ok) throw new Error('refused')
    return nodeRunScript(p.plan, RUN)
  }

  test('what a step makes is on the record before the step runs, and the record is written beside itself', () => {
    const s = script()
    for (const [k, id] of [
      [2, 'user'],
      [3, 'slice'],
      [4, 'linger'],
      [12, 'unit'],
      [13, 'link'],
    ] as const) {
      const start = s.indexOf(`echo '@@step ${id} start'`)
      const ahead = s.indexOf('rec running || back', start)
      const runs = s.indexOf(`if does `, start)
      expect([id, start > 0, ahead > start, runs > ahead, s.slice(start, runs).includes(`D${k}=1`)]).toEqual([
        id,
        true,
        true,
        true,
        true,
      ])
    }
    expect(s).toContain('> "$REC.part" && chmod 644 "$REC.part" && mv -f "$REC.part" "$REC"')
    expect(s).not.toMatch(/> "\$REC"/)
  })

  test("nothing root runs writes into the node user's home: those writes go through asNode", () => {
    const p = nodePlan(facts(), wanted({ packages: true }))
    if (!p.ok) throw new Error('refused')
    const lines = p.plan.steps.flatMap(st => [...st.skipIf, ...st.commands, ...st.check, ...st.undo])
    // a redirection, cp, mv, mkdir, chmod, install or tar whose target is in the home ("$H" or the path)
    const writes =
      />\s*("\$H[/"]|'\/home\/agent-board)|\b(cp|mv|mkdir|chmod|install|tar)\b[^|;&]*\s("\$H[/"]|'\/home\/agent-board)/
    const byRoot = lines.filter(l => writes.test(l) && !/^\s*(asNode|putAs|printf '%s\\n' \S+ \| putAs)/.test(l))
    expect(byRoot).toEqual([])
  })

  test('a plugin of another archive on the node is replaced with a warning: the running board keeps the old code', () => {
    const p = nodePlan(facts({ plugin: 'ef'.repeat(32) }), wanted())
    if (!p.ok) throw new Error('refused')
    expect(p.plan.warnings.map(t => words(t))).toEqual([
      "The board's code on the node is replaced; its running board keeps the old code until herdr restarts, which ends the node's sessions.",
    ])
  })
})

describe('no script the plan can emit holds a secret', () => {
  test('the master token crosses as its hash only, and a password reaches no script', async () => {
    const token = 'canary-token-5f2a9c'
    const password = 'canary-password-8e1d3b'
    const tokenHash = new Bun.CryptoHasher('sha256').update(token).digest('hex')
    // the password is in the facts and the values as a caller might leave it: nothing may carry it on
    const w = { ...wanted({ master: { id: 'laptop', name: 'Laptop', tokenHash } }), password } as NodeWanted
    const scripts: string[] = [nodeLookScript({ port: 12430 }), nodeLookScript({ port: 12430, linkKey: KEY })]
    const variants: NodeFacts[] = [
      facts(),
      facts({ serverBun: { path: '/usr/local/bin/bun', version: '1.4.5' } }),
      facts({
        user: 'ours',
        linkUser: 'ours',
        keysDir: true,
        record: applied([{ kind: 'user', name: 'agent-board' }]),
      }),
    ]
    for (const f of variants)
      for (const packages of [false, true]) {
        const p = nodePlan({ ...f, password } as NodeFacts, { ...w, packages })
        if (!p.ok) throw new Error('refused')
        scripts.push(nodeRunScript(p.plan, RUN))
      }
    const all = applied([
      { kind: 'user', name: 'agent-board' },
      { kind: 'linger' },
      { kind: 'slice', uid: 1001 },
      { kind: 'unit' },
      { kind: 'keysdir' },
      { kind: 'keys' },
      { kind: 'fence' },
      { kind: 'user', name: 'agent-board-link' },
    ])
    for (const work of [false, true]) scripts.push(nodeRunScript(nodeUndoPlan(all, { work }), RUN))
    for (const s of scripts) {
      expect(s).not.toContain(token)
      expect(s).not.toContain(password)
    }
    // the hash is what masters.json gets, in the apply scripts only
    expect(scripts.filter(s => s.includes(tokenHash)).length).toBe(6)
  })
})

describe('the record and its Undo', () => {
  test('only items the board knows, by their fixed paths: anything else on a record is left out', () => {
    const r = nodeRecord({
      ...applied([]),
      items: [
        { kind: 'user', name: 'agent-board' },
        { kind: 'user', name: 'root' },
        { kind: 'file', path: '/etc/shadow' },
        { kind: 'slice', uid: 0 },
        { kind: 'slice', uid: 1001, path: '/etc/passwd' },
        { kind: 'fence' },
        { kind: 'fence' },
      ],
    })
    expect(r?.items).toEqual([{ kind: 'user', name: 'agent-board' }, { kind: 'slice', uid: 1001 }, { kind: 'fence' }])
    expect(nodeRecord({ ...applied([]), state: 'done' })).toBeNull()
    expect(nodeRecord({ ...applied([]), run: 'a b' })).toBeNull()
    expect(nodeRecord({ ...applied([]), v: 2 })).toBeNull()
  })

  test('Undo has a step for each kind the record lists and none for the rest', () => {
    const steps = (items: NodeRecord['items']) => nodeUndoPlan(applied(items), { work: false }).steps.map(s => s.id)
    expect(steps([])).toEqual(['check'])
    expect(steps([{ kind: 'fence' }, { kind: 'keys' }])).toEqual(['check', 'fence', 'keys'])
    expect(
      steps([
        { kind: 'user', name: 'agent-board' },
        { kind: 'linger' },
        { kind: 'slice', uid: 1001 },
        { kind: 'unit' },
        { kind: 'keys' },
        { kind: 'fence' },
        { kind: 'user', name: 'agent-board-link' },
      ]),
    ).toEqual(['check', 'unit', 'linger', 'fence', 'keys', 'link-user', 'slice', 'user'])
    const kept = nodeUndoPlan(applied([{ kind: 'user', name: 'agent-board' }]), { work: false })
    expect(words(kept.words[1] as Text)).toBe('/home/agent-board/work stays, given to root.')
    const none = nodeUndoPlan(applied([{ kind: 'fence' }]), { work: true })
    expect(words(none.words[1] as Text)).toBe('The user agent-board was there before the board: it and its home stay.')
  })
})

test("Look's lines read, and a run's", () => {
  const f = readNodeLook([
    '@@os debian 13',
    '@@pretty Debian GNU/Linux 13 (trixie)',
    '@@arch aarch64',
    '@@cpus 2',
    '@@mem 3900 3100 1023',
    '@@home-free 20480',
    '@@systemd yes',
    '@@sudo nopasswd',
    '@@has curl',
    '@@has tar',
    '@@user ours',
    '@@link-user none',
    '@@slice yes',
    '@@keys same',
    '@@fence other',
    '@@include yes',
    '@@sshd-t ok',
    '@@home left',
    '@@busy',
    `@@plugin ${'ab'.repeat(32)}`,
    '@@record {"v":1}',
    '@@listen 22 sshd',
    '@@listen 12430 bun',
    '@@bun 1.4.3',
    '@@herdr herdr 0.9.5',
    '@@server-bun 1.4.5 /usr/local/bin/bun',
    '@@end',
  ])
  expect(f).toMatchObject({
    os: { id: 'debian', version: '13' },
    arch: 'aarch64',
    memTotalMb: 3900,
    memAvailableMb: 3100,
    homeFreeMb: 20480,
    sudo: 'nopasswd',
    has: ['curl', 'tar'],
    user: 'ours',
    linkUser: 'none',
    slice: true,
    keys: 'same',
    fence: 'other',
    homeLeft: true,
    busy: true,
    plugin: 'ab'.repeat(32),
    record: { v: 1 },
    listening: [
      { port: 22, name: 'sshd' },
      { port: 12430, name: 'bun' },
    ],
    bun: '1.4.3',
    herdr: null,
    serverBun: { path: '/usr/local/bin/bun', version: '1.4.5' },
  })
  expect(readNodeLook(['@@os debian 13'])).toBeNull()
  expect(
    readNodeRun([
      '@@step check start',
      '@@step check ok',
      '@@step user start',
      'useradd: cannot lock /etc/passwd',
      '@@step user fail',
      '@@undo user ok',
      '@@result rolled-back',
    ]),
  ).toEqual({
    result: 'rolled-back',
    steps: [
      { id: 'check', state: 'ok' },
      { id: 'user', state: 'fail' },
    ],
    undone: [{ id: 'user', ok: true }],
    warnings: [],
    kept: null,
    said: ['useradd: cannot lock /etc/passwd'],
  })
})

describe('without a node, nothing of this', () => {
  test('no module of the board imports the plan or its texts yet: every other setup runs the code it ran', () => {
    const root = join(import.meta.dir, '..', '..', 'src')
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap(n => {
        const p = join(d, n)
        return statSync(p).isDirectory() ? walk(p) : [p]
      })
    const importers = walk(root)
      .filter(p => !/node-(plan|texts)\.ts$/.test(p))
      .filter(p => /from '[^']*node-(plan|texts)(\.ts)?'/.test(readFileSync(p, 'utf8')))
    expect(importers).toEqual([])
  })

  test('its words are under node. and place. only (and the one launch error the pin has), in both languages, and no other dictionary has such a key', () => {
    expect(Object.keys(NODE_STRINGS.ru).sort()).toEqual(Object.keys(NODE_STRINGS.en).sort())
    // node.: the devices, the install, the door; place.: where a start goes and why (#504); the pin's
    // refusal beside the launch window's other errors.
    const strays = Object.keys(NODE_STRINGS.en).filter(
      k => !k.startsWith('node.') && !k.startsWith('place.') && k !== 'launch.err.pin',
    )
    expect(strays).toEqual([])
    const dir = join(import.meta.dir, '..', '..', 'src', 'core', 'i18n')
    const others = readdirSync(dir)
      .filter(n => n !== 'node-strings.ts')
      .filter(n => /['"](node|place)\.[a-zA-Z]/.test(readFileSync(join(dir, n), 'utf8')))
    expect(others).toEqual([])
  })
})
