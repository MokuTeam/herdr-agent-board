// The tunnel's web server setup and the server mode's (the board on a server of the owner's) on one
// server, side by side (core/server-texts.ts Names): each with its own record, folder, site file,
// block, helper and Undo, and each sees the other's parts as someone else's: the other's site among
// their sites (fetched before and after a reload, kept answering), its helper another container,
// its own Caddy on the web ports another board's web server it does not plan over. Both orders:
// the tunnel first (the owner's server), and the server mode first.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Container, Holder, ServerFacts } from '../../src/core/server-facts.ts'
import { BOARD_SOCKET, serverWanted } from '../../src/core/server-install.ts'
import { lookScript1, readRoundOne } from '../../src/core/server-look.ts'
import { plainPlan } from '../../src/core/server-plain.ts'
import {
  buildPlan,
  chooseCase,
  type Plan,
  type RecordItem,
  type SetupCase,
  type SetupRecord,
  setupRecord,
  undoPlan,
  type Wanted,
} from '../../src/core/server-plan.ts'
import { launchScript, runScript } from '../../src/core/server-script.ts'
import {
  caddyRunArgs,
  type Names,
  namesOf,
  SERVER_NAMES,
  SOCAT_IMAGE,
  socatRunArgs,
  TUNNEL_NAMES,
} from '../../src/core/server-texts.ts'
import { factsFor, GID, THEIR_SHA } from '../support/server-facts.ts'

const TUNNEL: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
}
const SERVER: Wanted = serverWanted('workbench.example.com', 'agent')
const O = { id: 'p1', docker: true }
const NO = { removeDocker: false, removeEdited: false }
const en = translator('en')
/** The server mode's socket folder's gid (the board's user's group, or their Caddy's in case 2). */
const AGENT_GID = 1001
type Who = 'tunnel' | 'server'
const wantedOf = (who: Who): Wanted => (who === 'tunnel' ? TUNNEL : SERVER)
const other = (who: Who): Who => (who === 'tunnel' ? 'server' : 'tunnel')

/** What of a setup shows in a plan or a run: its folder, files, block, containers, user and socket. */
const MARKS: Record<Who, RegExp[]> = {
  tunnel: [
    /\/etc\/agent-board(?!-server)/,
    /\/etc\/caddy\/agent-board\//,
    /agent-board\.conf/,
    /agent-board-caddy/,
    /agent-board-socket/,
    /# (>>>|<<<) agent-board/,
    /\.Caddyfile\.agent-board(?!-)/,
    /boardtunnel/,
    /:8481\b/,
  ],
  server: [
    /agent-board-server/,
    /server agent-board/,
    /\/var\/lib\/agent-board/,
    /server-(caddy|socket)/,
    /:8482\b/,
    // its domain as the board's own (their hosts fetched are their sites: allowed)
    /workbench\.example\.com \{/,
  ],
}
const textOf = (p: Plan): string => p.steps.flatMap(s => [...s.commands, ...s.check, ...s.skipIf, ...s.undo]).join('\n')
const marksIn = (text: string, who: Who): string[] =>
  MARKS[who].filter(m => m.test(text)).map(m => `${m}: ${text.match(m)?.[0]}`)

// ---------------------------------------------------------------------------------------------
// A server as each setup's Look finds it: their Caddy (cases 2, 3a, 3b), with what each setup
// made on it (its helper, its site among their hosts, its folder, its record where its own Look reads)

/** The helper's container as Docker has it, its labels those of its run (core/server-texts.ts socatRunArgs). */
function helper(who: Who, host: boolean): Container {
  const w = wantedOf(who)
  const n = namesOf(w)
  const args = socatRunArgs(
    host ? { host: true } : { network: 'web_default' },
    w,
    who === 'tunnel' ? GID : AGENT_GID,
    'r0',
  )
  const labels: Record<string, string> = {}
  args.forEach((a, i) => {
    if (args[i - 1] === '--label') labels[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
  })
  return {
    id: (who === 'tunnel' ? 'a1' : 'b2').repeat(32),
    name: `/${n.socketName}`,
    image: SOCAT_IMAGE,
    cmd: args.slice(args.indexOf(SOCAT_IMAGE) + 1),
    hostNetwork: host,
    networks: host
      ? [{ name: 'host', driver: 'host', userDefined: false }]
      : [{ name: 'web_default', driver: 'bridge', userDefined: true }],
    mounts: [],
    ports: [],
    labels,
  }
}

/** The facts a Look of `look` finds on a server of case `c` where the setups `made` are applied (with their records). */
function seen(c: '2' | '3a' | '3b', look: Who, made: Partial<Record<Who, SetupRecord>>): ServerFacts {
  const f = factsFor(c)
  const host = c === '3b'
  const containers = [...(f.docker?.containers ?? [])]
  const hosts = [...(f.caddy?.hosts ?? [])]
  const ports = { ...f.ports }
  for (const who of ['tunnel', 'server'] as const) {
    if (!made[who]) continue
    hosts.push(wantedOf(who).domain)
    if (c === '2') continue
    const h = helper(who, host)
    containers.push(h)
    const at: Holder = { kind: 'container', id: h.id, program: 'socat' }
    // 3b's helpers on the loopback: the server mode's port only its own Look watches
    if (host && who === 'tunnel') ports[8481] = at
    if (host && who === 'server' && look === 'server') ports[8482] = at
  }
  if (host && look === 'server' && !made.server) ports[8482] = { kind: 'free' }
  const sha = Object.keys(made).length ? `${made.tunnel ? 'a' : '0'}${made.server ? 'b' : '0'}`.repeat(32) : THEIR_SHA
  // case 2's folder in their Caddy's group once its setup is applied
  const folder =
    look === 'tunnel'
      ? f.folder && made.tunnel && c === '2'
        ? { ...f.folder, group: 'caddy', gid: 990 }
        : f.folder
      : made.server
        ? {
            mode: '2750',
            owner: 'agent',
            group: c === '2' ? 'caddy' : 'agent',
            gid: c === '2' ? 990 : AGENT_GID,
            members: [],
          }
        : null
  return {
    ...f,
    ports,
    folder,
    record: made[look] ? JSON.parse(JSON.stringify(made[look])) : null,
    docker: f.docker && { ...f.docker, containers },
    caddy: f.caddy && { ...f.caddy, hosts, sha256: sha },
  }
}

/** A plan's record as its run leaves it applied (a file's hash, an image pulled), read back as the board reads it. */
function applied(p: Plan, w: Wanted): SetupRecord {
  const items = p.steps.flatMap(s => s.record).map(i => (i.kind === 'file' ? { ...i, sha256: 'cd'.repeat(32) } : i))
  const r = setupRecord(
    JSON.parse(
      JSON.stringify({
        v: 1,
        id: p.id,
        at: '2026-10-28T10:00:00.000Z',
        state: 'applied',
        case: p.case,
        pair: { user: w.user, socket: w.socket, ...(w.server && { server: true }) },
        domain: w.domain,
        publicPort: p.publicPort,
        address: p.address,
        items,
      }),
    ),
  )
  if (!r) throw new Error('the record does not read back')
  return r
}

function planOf(f: ServerFacts, w: Wanted): Plan {
  const made = buildPlan(f, w, O)
  if (!('steps' in made)) throw new Error(`no plan: ${made.why.join(', ')}`)
  return made
}

/** sh, when this computer has one, for the plan's own awk lines. */
const SH = Bun.which('sh')
/** One of the plan's command lines run on a text (sudo as the run has it: a function that runs its command). */
function onText(line: string, text: string): string {
  const r = Bun.spawnSync([SH as string, '-c', `sudo() { "$@"; }; ${line}`], {
    stdin: new TextEncoder().encode(text),
    env: { ...process.env, LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString()
}
/** A plan's line that strips its block from their Caddyfile on stdin (core/server-plan.ts stripBlock). */
const stripLine = (p: Plan): string => {
  const cmd = p.steps.flatMap(s => s.commands).find(c => c.includes('awk \'index($0, ENVIRON["B0"]) == 1 { s = 1 } !s'))
  const m = cmd && /B0='[^']*' E0='[^']*' awk '[^']*'/.exec(cmd)
  if (!m) throw new Error('no strip line')
  return m[0]
}

// ---------------------------------------------------------------------------------------------

describe('the names: each setup its own, none taken for the other’s', () => {
  test('folder, record, lock, runs, backups, files, import line, block, containers, volumes, roles, 3b port, candidate', () => {
    const t = TUNNEL_NAMES as unknown as Record<string, unknown>
    const s = SERVER_NAMES as unknown as Record<string, unknown>
    for (const k of Object.keys(t))
      expect([k, t[k] === s[k] || JSON.stringify(t[k]) === JSON.stringify(s[k])]).toEqual([k, false])
    expect(namesOf(TUNNEL)).toBe(TUNNEL_NAMES)
    expect(namesOf(SERVER)).toBe(SERVER_NAMES)
    // the tunnel's are what they always were
    expect(TUNNEL_NAMES).toMatchObject({
      record: '/etc/agent-board/setup.json',
      lock: '/etc/agent-board/lock',
      siteFile: '/etc/caddy/agent-board/board.caddy',
      blockBegin: '# >>> agent-board',
      blockEnd: '# <<< agent-board',
      caddyName: 'agent-board-caddy',
      socketName: 'agent-board-socket',
      port3b: 8481,
    })
    expect(SERVER_NAMES.dir).toBe('/etc/agent-board-server')
  })

  test('a block is found by the start of its first line: neither setup’s marker starts as the other’s', () => {
    const a = TUNNEL_NAMES
    const b = SERVER_NAMES
    expect(b.blockBegin.startsWith(a.blockBegin)).toBe(false)
    expect(a.blockBegin.startsWith(b.blockBegin)).toBe(false)
    // grep -c '^<begin>' of one never counts the other's first line; their ends are whole lines
    expect(new RegExp(`^${a.blockBegin}`).test(`${b.blockBegin}: x`)).toBe(false)
    expect(new RegExp(`^${b.blockBegin}`).test(`${a.blockBegin}: x`)).toBe(false)
    expect(a.blockEnd).not.toBe(b.blockEnd)
    // an import of one's site file is not an import of the other's
    const imports = (n: Names, line: string): boolean =>
      new RegExp(`^\\s*import\\s+${n.siteFile.replaceAll('.', '\\.')}(\\s|$)`).test(line)
    expect(imports(a, b.importLine)).toBe(false)
    expect(imports(b, a.importLine)).toBe(false)
    expect(imports(a, a.importLine)).toBe(true)
    expect(imports(b, b.importLine)).toBe(true)
  })
})

describe('Look: each setup reads its own record and lock; the server mode watches its 3b port too', () => {
  test('the server mode’s Look', () => {
    const s = lookScript1({ user: 'agent', socket: BOARD_SOCKET, domain: SERVER.domain, server: true })
    expect(s).toContain('if [ -f /etc/agent-board-server/setup.json ]; then')
    expect(s).toContain('  cat /etc/agent-board-server/setup.json')
    expect(s).toContain('  i=$(stat -c %i /etc/agent-board-server/lock)')
    expect(s).not.toMatch(/\/etc\/agent-board\//)
    expect(s).toContain("echo '@@watch 8482'")
    expect(s).toContain('sport = :8481 or sport = :8482 )')
    expect(s).toContain("grep -E ':(80|443|8443|8480|8481|8482)->'")
  })

  test('the tunnel’s Look: its own record and lock, the ports it always watched', () => {
    const s = lookScript1({ user: TUNNEL.user, socket: TUNNEL.socket, domain: TUNNEL.domain })
    expect(s).toContain('  cat /etc/agent-board/setup.json')
    expect(s).toContain('  i=$(stat -c %i /etc/agent-board/lock)')
    expect(s).not.toContain('agent-board-server')
    expect(s).not.toContain('8482')
  })

  test('round one: the server mode’s port read only from its own Look', () => {
    const r1 = (watch: boolean): string =>
      [
        '@@section os',
        'ID=debian',
        'VERSION_ID="13"',
        '@@arch x86_64',
        '@@section ports',
        ...(watch ? ['@@watch 8482'] : []),
        'LISTEN 0      4096   127.0.0.1:8482 0.0.0.0:* users:(("python3",pid=77,fd=3))',
        '@@pid 77',
        '0::/system.slice/other.service',
        '@@section docker',
        '@@none',
        '@@section systemd',
        '@@section fence',
        '@@section folder',
        '@@section record',
        '@@section host',
        '@@section dns',
        '@@part domain',
        '@@part local',
        '@@end',
      ].join('\n')
    expect(readRoundOne(r1(true))?.ports[8482]).toEqual({ kind: 'unit', unit: 'other.service', program: 'python3' })
    expect(readRoundOne(r1(false))?.ports).not.toHaveProperty('8482')
  })
})

for (const c of ['2', '3a', '3b'] as const) {
  for (const first of ['tunnel', 'server'] as const) {
    const second = other(first)
    describe(`case ${c}: the ${first}'s setup first, then the ${second}'s`, () => {
      const firstPlan = planOf(seen(c, first, {}), wantedOf(first))
      const firstRec = applied(firstPlan, wantedOf(first))
      const secondFacts = seen(c, second, { [first]: firstRec })
      const secondPlan = planOf(secondFacts, wantedOf(second))
      const secondRec = applied(secondPlan, wantedOf(second))
      const both = { [first]: firstRec, [second]: secondRec } as Record<Who, SetupRecord>

      test(`the ${second}'s Look: the ${first}'s parts are someone else's, its site among their sites`, () => {
        expect(chooseCase(secondFacts, wantedOf(second)).case).toBe(c)
        expect(secondPlan.kind).toBe('apply')
        expect(marksIn(textOf(secondPlan), first)).toEqual([])
        // the other's site is fetched before and after the reload: it must answer as before
        const before = secondPlan.steps.find(s => s.id === 'fetch-before')?.commands.join('\n') ?? ''
        expect(before).toContain(`'${wantedOf(first).domain}'`)
        // its own block or line, with its own markers
        const n = namesOf(wantedOf(second))
        const all = textOf(secondPlan)
        if (c === '2') expect(all).toContain(n.importLine)
        else expect(all).toContain(n.blockBegin)
        expect(plainPlan(secondFacts, secondPlan, wantedOf(second), en).stop).toBeNull()
      })

      test('each setup Looked at again: in place, nothing to change; the other’s parts left as they are', () => {
        for (const who of ['tunnel', 'server'] as const) {
          const p = planOf(seen(c, who, both), wantedOf(who))
          expect([who, p.kind]).toEqual([who, 'nothing'])
        }
      })

      if (c !== '2')
        test('their Caddyfile with both blocks: each strip takes its own block, never the other’s', () => {
          if (!SH) return
          const block = (who: Who): string =>
            [
              `${namesOf(wantedOf(who)).blockBegin}: x`,
              `${wantedOf(who).domain} {`,
              '}',
              namesOf(wantedOf(who)).blockEnd,
            ].join('\n')
          const theirs = 'shop.example.org {\n\trespond "shop"\n}'
          const file = `${theirs}\n${block(first)}\n${block(second)}\n`
          const firstStrip = stripLine(firstPlan)
          const secondStrip = stripLine(secondPlan)
          expect(onText(secondStrip, file)).toBe(`${theirs}\n${block(first)}\n`)
          expect(onText(firstStrip, file)).toBe(`${theirs}\n${block(second)}\n`)
        })

      for (const who of [first, second]) {
        test(`Undo of the ${who}'s setup: its own parts alone; the other's site checked to answer as before`, () => {
          const f = seen(c, who, both)
          const rec = both[who]
          const u = undoPlan(rec, f, { id: 'u1', ...NO })
          expect(marksIn(textOf(u), other(who))).toEqual([])
          const fetch = u.steps.find(s => s.id === 'fetch-before')?.commands.join('\n') ?? ''
          expect(fetch).toContain(`'${wantedOf(other(who)).domain}'`)
          const forget = u.steps.find(s => s.id === 'forget')
          expect(forget?.commands[0]).toBe(
            `sudo rm -rf ${namesOf(wantedOf(who)).record} ${namesOf(wantedOf(who)).backups} ${namesOf(wantedOf(who)).caddyDir}`,
          )
          // Docker is not offered for removal: the other setup's containers are in it
          if (c !== '2') expect(u.ticks).not.toContain('removeDocker')
          // and its run writes and removes only its own record
          const run = runScript(u, wantedOf(who), { id: 'r9', at: '2026-10-28T11:00:00.000Z' })
          expect(run).toContain(`rm -f ${namesOf(wantedOf(who)).record}`)
          expect(run).toContain(`exec 9>${namesOf(wantedOf(who)).lock}`)
          expect(marksIn(run, other(who))).toEqual([])
        })
      }
    })
  }
}

describe('3b: the helpers on the loopback, each on its own port', () => {
  test('the server mode’s helper on 8482; the port taken: Do it myself; the tunnel’s 8481 is not its', () => {
    const f = seen('3b', 'server', {})
    const p = planOf(
      { ...f, ports: { ...f.ports, 8481: { kind: 'container', id: 'a1'.repeat(32), program: 'socat' } } },
      SERVER,
    )
    expect(textOf(p)).toContain('TCP-LISTEN:8482,bind=127.0.0.1,fork,reuseaddr')
    expect(textOf(p)).toContain('reverse_proxy 127.0.0.1:8482')
    const held: Holder = { kind: 'unit', unit: 'other.service', program: 'python3' }
    expect(chooseCase({ ...f, ports: { ...f.ports, 8482: held } }, SERVER)).toEqual({ case: null, why: ['portTaken'] })
    // the tunnel's Look does not watch 8482: the server mode's helper there is not in its way
    const t = planOf(seen('3b', 'tunnel', {}), TUNNEL)
    expect(textOf(t)).toContain('TCP-LISTEN:8481,bind=127.0.0.1,fork,reuseaddr')
  })
})

describe('the other setup’s own Caddy on the web ports: not planned over (cases 1, 1b, 4a, 4b)', () => {
  /** The board's own Caddy of `who`, as Look reads its container: on the ports its case publishes. */
  function ownCaddy(who: Who, c: '1' | '1b' | '4a' | '4b'): Container {
    const w = wantedOf(who)
    const args = caddyRunArgs(c, w, GID, 'r0')
    const labels: Record<string, string> = {}
    args.forEach((a, i) => {
      if (args[i - 1] === '--label') labels[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1)
    })
    return {
      id: 'c3'.repeat(32),
      name: `/${namesOf(w).caddyName}`,
      image: 'caddy:2.11.7',
      cmd: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
      hostNetwork: false,
      networks: [{ name: 'bridge', driver: 'bridge', userDefined: false }],
      mounts: [{ type: 'bind', source: namesOf(w).caddyDir, destination: '/etc/caddy' }],
      ports: [],
      labels,
    }
  }
  const nginx: Holder = { kind: 'unit', unit: 'nginx.service', program: 'nginx' }
  for (const first of ['tunnel', 'server'] as const)
    for (const c of ['1', '1b', '4a', '4b'] as const) {
      test(`case ${c}, the ${first}'s first: the ${other(first)}'s Look says so, and changes nothing`, () => {
        const base = factsFor(c === '4a' || c === '4b' ? c : c === '1b' ? '1b' : 'bare')
        const own = ownCaddy(first, c)
        const at: Holder = { kind: 'container', id: own.id, program: 'caddy' }
        const ports =
          c === '1'
            ? { ...base.ports, 80: at, 443: at }
            : c === '1b'
              ? { ...base.ports, 443: at }
              : c === '4a'
                ? { ...base.ports, 443: nginx, 80: at, 8443: at }
                : { ...base.ports, 8443: at, 8480: at }
        const second = wantedOf(other(first))
        const f: ServerFacts = {
          ...base,
          ports,
          folder: other(first) === 'server' ? null : base.folder,
          docker: { version: '29.0.1', podman: false, rootless: false, userns: false, containers: [own] },
        }
        expect(chooseCase(f, second)).toEqual({ case: null, why: ['otherBoard'] })
        expect(buildPlan(f, second, O)).toEqual({ case: null, why: ['otherBoard'] })
        expect(plainPlan(f, { case: null, why: ['otherBoard'] }, second, en).stop).toBe(
          'The board does not set this server up by itself: the other board’s own web server holds the ports it needs here.',
        )
        // and the first's own Look, its record there, takes its Caddy as its own
        const mine = planOf({ ...base, folder: base.folder }, wantedOf(first))
        const record = JSON.parse(JSON.stringify(applied(mine, wantedOf(first))))
        expect(chooseCase({ ...f, folder: base.folder, record }, wantedOf(first)).case).toBe(c)
      })
    }
})

describe('records: each reads only its own names', () => {
  const item = (who: Who): RecordItem[] => {
    const n = namesOf(wantedOf(who))
    return [
      { kind: 'container', name: n.socketName, setup: 'r0' },
      { kind: 'block', file: '/srv/my web/Caddyfile', begin: n.blockBegin, end: n.blockEnd },
      { kind: 'backup', of: '/srv/my web/Caddyfile', path: `${n.backups}/r0/Caddyfile` },
    ]
  }
  const rec = (who: Who, items: RecordItem[]): unknown =>
    JSON.parse(
      JSON.stringify({
        v: 1,
        id: 'r0',
        at: 'x',
        state: 'applied',
        case: '3a' as SetupCase,
        pair: { user: wantedOf(who).user, socket: wantedOf(who).socket, ...(who === 'server' && { server: true }) },
        domain: wantedOf(who).domain,
        publicPort: null,
        address: `https://${wantedOf(who).domain}`,
        items,
      }),
    )
  test('a record naming the other setup’s parts is no board’s', () => {
    for (const who of ['tunnel', 'server'] as const) {
      expect(setupRecord(rec(who, item(who)))?.items).toEqual(item(who))
      for (const i of item(other(who))) expect([who, i.kind, setupRecord(rec(who, [i]))]).toEqual([who, i.kind, null])
    }
  })
})

describe('the run and its launch: each setup’s own record, lock and folder', () => {
  test('the server mode’s; the tunnel’s as it was', () => {
    const p = planOf(seen('3a', 'server', {}), SERVER)
    const run = runScript(p, SERVER, { id: 'r1', at: '2026-10-28T10:00:00.000Z' })
    expect(run).toContain('exec 9>/etc/agent-board-server/lock')
    expect(run).toContain('trap \'echo "$?" > /etc/agent-board-server/runs/r1.exit\' EXIT')
    expect(run).toContain('> /etc/agent-board-server/setup.json.new &&')
    expect(marksIn(run, 'tunnel')).toEqual([])
    const launch = launchScript('r1', run, undefined, SERVER_NAMES)
    expect(launch).toContain('R=/etc/agent-board-server/runs/r1')
    expect(launch).toContain(
      'if [ ! -e /etc/agent-board-server/setup.json ] && [ ! -e /etc/agent-board-server/backups ]; then flock -n /etc/agent-board-server/lock rm -rf /etc/agent-board-server; fi',
    )
    expect(launch).not.toMatch(/\/etc\/agent-board(?!-server)/)
    const tunnel = launchScript(
      'r1',
      runScript(planOf(seen('3a', 'tunnel', {}), TUNNEL), TUNNEL, { id: 'r1', at: 'x' }),
    )
    expect(tunnel).toContain(
      'if [ ! -e /etc/agent-board/setup.json ] && [ ! -e /etc/agent-board/backups ]; then flock -n /etc/agent-board/lock rm -rf /etc/agent-board; fi',
    )
    expect(tunnel).not.toContain('agent-board-server')
  })
})
