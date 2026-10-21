import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import { readRoundOne, readServerFacts } from '../../src/core/server-look.ts'
import {
  buildPlan,
  chooseCase,
  type Manual,
  manualFacts,
  type Plan,
  type PlanStep,
  placeholderFinders,
  type RecordItem,
  type SetupCase,
  type SetupRecord,
  setupRecord,
  undoPlan,
  type Wanted,
  wantedProblem,
  whose,
} from '../../src/core/server-plan.ts'
import {
  CADDY_IMAGE,
  caddyRunArgs,
  IMPORT_LINE,
  SITE_FILE,
  SOCAT_IMAGE,
  socatRunArgs,
} from '../../src/core/server-texts.ts'
import { factsFor, GID, recordFor, type TestDistro, THEIR_ID, THEIR_SHA } from '../support/server-facts.ts'

const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
}
const O = { id: 'r1', docker: false }
const DISTROS: TestDistro[] = ['debian13', 'ubuntu2604']

const plan = (f: ServerFacts, w: Wanted = W): Plan => {
  const p = buildPlan(f, w, O)
  if (!('steps' in p)) throw new Error(`no plan: ${JSON.stringify(p)}`)
  return p
}
const ids = (p: Plan): string[] => p.steps.map(s => s.id)
const step = (p: Plan, id: string): PlanStep => {
  const s = p.steps.find(x => x.id === id)
  if (!s) throw new Error(`no step ${id} in ${ids(p).join(', ')}`)
  return s
}
const text = (s: PlanStep): string => [...s.commands, ...s.check].join('\n')
const all = (p: Plan): string =>
  p.steps.map(s => [...s.commands, ...s.check, ...s.undo, ...s.skipIf].join('\n')).join('\n')
const manual = (f: ServerFacts, w: Wanted = W): unknown => chooseCase(f, w)
const why = (...reasons: Manual[]): { case: null; why: Manual[] } => ({ case: null, why: reasons })

const OWN = ['guard', 'pull-caddy', 'caddyfile', 'volumes', 'run-caddy', 'caddy-up']
const CHAIN = ['backup', 'candidate', 'validate', 'write', 'fetch-before', 'reload', 'fetch-after']

/** The board's own Caddy already running as the record says, holding 80 and 443. */
function setUp1(distro: TestDistro): ServerFacts {
  const f = factsFor('1', distro)
  const args = caddyRunArgs('1', W, GID, 'r0')
  const labels = Object.fromEntries(
    args
      .filter((_, i) => args[i - 1] === '--label')
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]),
  )
  const ours = {
    id: `ab${'cd'.repeat(31)}`,
    name: '/agent-board-caddy',
    image: CADDY_IMAGE,
    cmd: [],
    hostNetwork: false,
    networks: [{ name: 'bridge', driver: 'bridge', userDefined: false }],
    mounts: [],
    ports: [],
    labels,
  }
  const holder = { kind: 'container' as const, id: ours.id, program: 'docker-proxy' }
  return {
    ...f,
    ports: { ...f.ports, 80: holder, 443: holder },
    docker: { version: '29.0.1', podman: false, rootless: false, userns: false, containers: [ours] },
    record: recordFor('1', {
      items: [
        { kind: 'image', ref: CADDY_IMAGE, before: false },
        { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
        { kind: 'volume', name: 'agent-board-caddy-data' },
        { kind: 'volume', name: 'agent-board-caddy-config' },
        { kind: 'container', name: 'agent-board-caddy', setup: 'r0' },
      ],
    }),
  }
}

const CASE2_ITEMS: RecordItem[] = [
  { kind: 'file', path: '/etc/caddy/agent-board/board.caddy', sha256: 'ab'.repeat(32) },
  { kind: 'group', path: '/var/lib/boardtunnel', from: 'boardtunnel', to: 'caddy' },
  { kind: 'backup', of: '/etc/caddy/Caddyfile', path: '/etc/agent-board/backups/r0/Caddyfile' },
  { kind: 'line', file: '/etc/caddy/Caddyfile', line: IMPORT_LINE },
]

/** Case 2 applied: their Caddy serves the domain through the import line, the folder is Caddy's. */
function setUp2(distro: TestDistro, record: SetupRecord = recordFor('2', { items: CASE2_ITEMS })): ServerFacts {
  const f = factsFor('2', distro)
  if (!f.caddy || !f.folder) throw new Error('case 2 facts')
  return {
    ...f,
    caddy: { ...f.caddy, hosts: [...f.caddy.hosts, record.domain] },
    folder: { ...f.folder, group: 'caddy' },
    record,
  }
}

for (const distro of DISTROS) {
  describe(`choosing the case on ${distro}`, () => {
    test('every row of the table', () => {
      expect(chooseCase(factsFor('bare', distro), W)).toMatchObject({ case: '1' })
      expect(chooseCase(factsFor('nodocker', distro), W)).toMatchObject({ case: '1' })
      expect(chooseCase(factsFor('1b', distro), W)).toMatchObject({ case: '1b' })
      expect(chooseCase(factsFor('2', distro), W)).toMatchObject({ case: '2' })
      expect(chooseCase(factsFor('3a', distro), W)).toMatchObject({ case: '3a' })
      expect(chooseCase(factsFor('3b', distro), W)).toMatchObject({ case: '3b' })
      expect(chooseCase(factsFor('4a', distro), W)).toMatchObject({ case: '4a' })
      expect(chooseCase(factsFor('4b', distro), W)).toMatchObject({ case: '4b' })
      const c = chooseCase(factsFor('3a', distro), W)
      expect('why' in c && !Array.isArray(c.why) && c.why.key).toBe('server.case.3a')
    })

    test('every "anything else" reason', () => {
      const f3 = factsFor('3a', distro)
      const f2 = factsFor('2', distro)
      const caddy2 = f2.caddy
      const docker = f3.docker
      if (!caddy2 || !docker) throw new Error('facts')
      const bridge: ServerFacts = {
        ...f3,
        docker: {
          ...docker,
          containers: docker.containers.map(c => ({
            ...c,
            networks: [{ name: 'bridge', driver: 'bridge', userDefined: false }],
          })),
        },
      }
      expect(manual(bridge)).toEqual(why('bridge'))
      const macvlan: ServerFacts = {
        ...f3,
        docker: {
          ...docker,
          containers: docker.containers.map(c => ({
            ...c,
            networks: [{ name: 'lan', driver: 'macvlan', userDefined: true }],
          })),
        },
      }
      expect(manual(macvlan)).toEqual(why('macvlan'))
      const apache = { kind: 'unit' as const, unit: 'apache2.service', program: 'apache2' }
      expect(
        manual({
          ...f2,
          caddy: null,
          units: { caddy: null, nginx: null },
          ports: { ...f2.ports, 80: apache, 443: apache },
        }),
      ).toEqual(why('other80'))
      const unsupported = factsFor('bare', distro)
      expect(manual({ ...unsupported, distro: { ...unsupported.distro, version: '11', supported: false } })).toEqual(
        why('os'),
      )
      const bare = factsFor('bare', distro)
      expect(manual({ ...bare, host: { ...bare.host, selinux: 'enforcing' } })).toEqual(why('selinux'))
      const d = bare.docker
      if (!d) throw new Error('docker')
      expect(manual({ ...bare, docker: { ...d, podman: true } })).toEqual(why('podman'))
      expect(manual({ ...bare, docker: { ...d, rootless: true } })).toEqual(why('rootless'))
      expect(manual({ ...bare, docker: { ...d, userns: true } })).toEqual(why('userns'))
      expect(manual({ ...f2, caddy: { ...caddy2, hosts: [...caddy2.hosts, 'board.example.com'] } })).toEqual(
        why('domainServed'),
      )
      expect(manual({ ...f2, caddy: { ...caddy2, adapter: 'json', config: '/etc/caddy/caddy.json' } })).toEqual(
        why('caddyJson'),
      )
      expect(manual({ ...f2, caddy: { ...caddy2, adminOff: true } })).toEqual(why('adminOff'))
      expect(manual({ ...f2, caddy: { ...caddy2, autoHttpsOff: true } })).toEqual(why('autoHttpsOff'))
      expect(manual({ ...f2, caddy: { ...caddy2, version: 'v1.0.4' } })).toEqual(why('caddy1'))
      expect(manual({ ...f2, systemd: false })).toEqual(why('noSystemd'))
      const split = { kind: 'split' as const, programs: ['caddy', 'nginx'] }
      expect(manual({ ...f2, ports: { ...f2.ports, 443: split } })).toEqual(why('split'))
      const caddy3 = f3.caddy
      if (!caddy3) throw new Error('caddy')
      expect(manual({ ...f3, caddy: { ...caddy3, mount: null, hostPath: null } })).toEqual(why('caddyBaked'))
      const nd = factsFor('nodocker', distro)
      expect(manual({ ...nd, host: { ...nd.host, conflicts: ['docker.io'] } })).toEqual(why('dockerConflicts'))
    })

    test('a Caddy the board cannot reload falls back to case 4 when 80 allows it', () => {
      const f2 = factsFor('2', distro)
      if (!f2.caddy) throw new Error('caddy')
      expect(
        chooseCase({ ...f2, ports: { ...f2.ports, 80: { kind: 'free' } }, caddy: { ...f2.caddy, adminOff: true } }, W),
      ).toMatchObject({
        case: '4a',
      })
    })

    test('whose setup a record is: the pair names it, whatever its domain (call 30)', () => {
      const r = recordFor('1')
      expect(whose(r, W)).toBe('same')
      expect(whose(r, { ...W, domain: 'new.example.com' })).toBe('update')
      expect(whose(recordFor('4a'), { ...W, publicPort: 8443 })).toBe('same')
      expect(whose(recordFor('4a'), W)).toBe('update')
      expect(whose(r, { ...W, user: 'other' })).toBe('other')
      expect(whose(r, { ...W, socket: '/var/lib/other/board.sock' })).toBe('other')
    })

    test('another board’s record stops the plan; this board’s gives its own case', () => {
      const other = recordFor('2', { pair: { user: 'tun2', socket: '/var/lib/tun2/board.sock' } })
      expect(manual({ ...factsFor('bare', distro), record: other })).toEqual(why('otherSetup'))
      expect(buildPlan({ ...factsFor('bare', distro), record: other }, W, O)).toEqual(why('otherSetup'))
      expect(chooseCase(setUp2(distro), W)).toMatchObject({ case: '2' })
      expect(chooseCase(setUp1(distro), W)).toMatchObject({ case: '1' })
    })

    test('a run rolled back that left only the Docker it installed: the case from the ports again, Docker kept on record', () => {
      const docker: RecordItem = {
        kind: 'docker',
        packages: ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-ce-rootless-extras'],
        files: ['/etc/apt/sources.list.d/docker.list', '/etc/apt/keyrings/docker.asc'],
      }
      const left = recordFor('1', {
        state: 'rolled-back',
        items: [docker, { kind: 'image', ref: SOCAT_IMAGE, before: true }],
      })
      const f = { ...factsFor('2', distro), record: left }
      expect(chooseCase(f, W)).toMatchObject({ case: '2' })
      const p = plan(f)
      expect(p.kind).toBe('apply')
      expect(step(p, 'guard').record).toContainEqual(docker)
      // another board's leftovers stop nothing either
      expect(
        chooseCase({ ...f, record: { ...left, pair: { user: 'tun2', socket: '/var/lib/tun2/b.sock' } } }, W),
      ).toMatchObject({
        case: '2',
      })
    })

    test('a run that did not finish: the plan is its record’s Undo', () => {
      const f = { ...setUp2(distro, recordFor('2', { state: 'running', items: CASE2_ITEMS })) }
      expect(manual(f)).toEqual(why('interrupted'))
      expect(plan(f).kind).toBe('undo')
      expect(manual({ ...f, lockHeld: true })).toMatchObject({ case: '2' })
    })
  })

  describe(`the plan per case on ${distro}`, () => {
    test('the steps of each case, in order', () => {
      expect(ids(plan(factsFor('bare', distro)))).toEqual(OWN)
      expect(ids(plan(factsFor('nodocker', distro)))).toEqual(['guard', 'docker-install', ...OWN.slice(1)])
      expect(ids(plan(factsFor('1b', distro)))).toEqual(OWN)
      expect(ids(plan(factsFor('4a', distro)))).toEqual(OWN)
      expect(ids(plan(factsFor('4b', distro)))).toEqual([
        ...OWN,
        'nginx-file',
        'nginx-check',
        'nginx-reload',
        'acme-path',
      ])
      expect(ids(plan(factsFor('2', distro)))).toEqual(['guard', 'site-file', 'folder-group', ...CHAIN])
      expect(ids(plan(factsFor('3a', distro)))).toEqual(['guard', 'pull-socat', 'run-socat', 'reach-helper', ...CHAIN])
      // a file mount: written in place, then checked inside at once
      expect(ids(plan(factsFor('3b', distro)))).toEqual([
        'guard',
        'pull-socat',
        'run-socat',
        'reach-helper',
        'backup',
        'write',
        'validate',
        'fetch-before',
        'reload',
        'fetch-after',
      ])
    })

    test('the kind, the address, the public port and the Docker tick', () => {
      for (const c of ['bare', '1b', '2', '3a', '3b', '4a', '4b'] as const) {
        const p = plan(factsFor(c, distro))
        const four = c === '4a' || c === '4b'
        expect([c, p.kind, p.address, p.publicPort, p.ticks]).toEqual([
          c,
          'apply',
          four ? 'https://board.example.com:8443' : 'https://board.example.com',
          four ? 8443 : null,
          [],
        ])
        expect(p.id).toBe('r1')
      }
      expect(plan(factsFor('nodocker', distro)).ticks).toEqual(['docker'])
      expect(step(plan(factsFor('nodocker', distro)), 'docker-install').commands).toContain(
        `sudo curl -fsSL https://download.docker.com/linux/${distro === 'debian13' ? 'debian' : 'ubuntu'}/gpg -o /etc/apt/keyrings/docker.asc`,
      )
    })

    test('the guard first: what the plan relies on, "@@changed" when it differs', () => {
      const p2 = plan(factsFor('2', distro))
      expect(p2.steps[0]?.id).toBe('guard')
      expect(text(step(p2, 'guard'))).toContain('@@changed holder443')
      expect(text(step(p2, 'guard'))).toContain(THEIR_SHA)
      expect(p2.relies.length).toBeGreaterThan(0)
      const p3 = plan(factsFor('3a', distro))
      expect(text(step(p3, 'guard'))).toContain(THEIR_ID)
      expect(text(step(plan(factsFor('bare', distro)), 'guard'))).toContain("'sport = :443'")
    })

    test('the commands: sudo in front of what needs root, their values one shell word each', () => {
      const f = factsFor('3a', distro)
      if (!f.caddy) throw new Error('caddy')
      const odd: ServerFacts = { ...f, caddy: { ...f.caddy, hostPath: "/srv/it's web/Caddyfile" } }
      const p = plan(odd)
      expect(text(step(p, 'backup'))).toContain(String.raw`'/srv/it'\''s web/Caddyfile'`)
      expect(text(step(p, 'write'))).toContain(String.raw`'/srv/it'\''s web/Caddyfile'`)
      expect(text(step(p, 'candidate'))).toContain(String.raw`'/srv/it'\''s web/.Caddyfile.agent-board'`)
      expect(all(p)).not.toContain("/srv/it's web")
      // the argv after `docker`, `run` its first word: once
      expect(text(step(p, 'run-socat'))).toContain(
        `sudo docker ${socatRunArgs({ network: 'web_default' }, W, GID, 'r1').join(' ')}`,
      )
      expect(all(p)).not.toContain('docker run run')
      expect(all(plan(factsFor('bare', distro)))).not.toContain('docker run run')
      expect(text(step(p, 'pull-socat'))).toBe(
        `sudo docker pull ${SOCAT_IMAGE}\nsudo docker image inspect ${SOCAT_IMAGE} >/dev/null`,
      )
      expect(text(step(p, 'validate'))).toContain(
        `sudo docker exec -e STEPPATH=/ ${THEIR_ID} caddy validate --config /etc/caddy/.Caddyfile.agent-board --adapter caddyfile`,
      )
      expect(text(step(p, 'reload'))).toContain(
        `sudo docker exec -e STEPPATH=/ ${THEIR_ID} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
      )
    })

    test('case 2: the site file, Caddy’s group, the import line written in place, checked as caddy', () => {
      const p = plan(factsFor('2', distro))
      expect(text(step(p, 'site-file'))).toContain('| sudo tee /etc/caddy/agent-board/board.caddy.part >/dev/null')
      expect(text(step(p, 'folder-group'))).toContain('sudo chgrp caddy /var/lib/boardtunnel')
      expect(step(p, 'folder-group').record).toEqual([
        { kind: 'group', path: '/var/lib/boardtunnel', from: 'boardtunnel', to: 'caddy' },
      ])
      expect(text(step(p, 'backup'))).toContain('sudo cp -p /etc/caddy/Caddyfile /etc/agent-board/backups/r1/Caddyfile')
      expect(text(step(p, 'candidate'))).toContain(
        `printf '%s\\n' '${IMPORT_LINE}' | sudo tee -a /etc/caddy/.Caddyfile.agent-board >/dev/null`,
      )
      expect(text(step(p, 'validate'))).toContain(
        'sudo runuser -u caddy -- env STEPPATH=/ /usr/bin/caddy validate --config /etc/caddy/.Caddyfile.agent-board --adapter caddyfile',
      )
      expect(text(step(p, 'write'))).toContain(
        `sudo sh -c 'test -s /etc/caddy/.Caddyfile.agent-board && cat /etc/caddy/.Caddyfile.agent-board > /etc/caddy/Caddyfile'`,
      )
      expect(text(step(p, 'reload'))).toContain('sudo systemctl reload caddy.service')
      expect(text(step(p, 'fetch-before'))).toContain("'blog.example.org' 'shop.example.org'")
      expect(step(p, 'write').undo.join('\n')).toContain(
        `sudo sh -c 'test -s /etc/agent-board/backups/r1/Caddyfile && cat /etc/agent-board/backups/r1/Caddyfile > /etc/caddy/Caddyfile'`,
      )
      // the group already Caddy's (a folder made the old way), or Caddy as root: no group step
      const f = factsFor('2', distro)
      if (!f.folder || !f.units.caddy) throw new Error('facts')
      expect(ids(plan({ ...f, folder: { ...f.folder, group: 'caddy' } }))).not.toContain('folder-group')
      expect(
        ids(plan({ ...f, units: { ...f.units, caddy: { ...f.units.caddy, user: 'root', group: '' } } })),
      ).not.toContain('folder-group')
    })

    test('case 4b: nginx’s file, checked, reloaded, the check path through it', () => {
      const p = plan(factsFor('4b', distro))
      expect(text(step(p, 'nginx-file'))).toContain('| sudo tee /etc/nginx/conf.d/agent-board.conf.part >/dev/null')
      expect(text(step(p, 'nginx-check'))).toBe('sudo nginx -t')
      expect(text(step(p, 'nginx-reload'))).toContain('sudo systemctl reload nginx')
      expect(text(step(p, 'acme-path'))).toContain('/.well-known/acme-challenge/agent-board-check')
      expect(text(step(p, 'run-caddy'))).toContain('-p 127.0.0.1:8480:80 -p 8443:8443')
    })

    test('a folder of theirs the board writes into keeps its mode: made only when missing', () => {
      // `install -d -m 755` on a folder that is there sets its mode (GNU and uutils alike)
      const nginx = step(plan(factsFor('4b', distro)), 'nginx-file').commands
      expect(nginx).toContain('sudo test -d /etc/nginx/conf.d || sudo install -d -m 755 /etc/nginx/conf.d')
      expect(nginx).not.toContain('sudo install -d -m 755 /etc/nginx/conf.d')
      const site = step(plan(factsFor('2', distro)), 'site-file').commands
      expect(site).toContain('sudo test -d /etc/caddy/agent-board || sudo install -d -m 755 /etc/caddy/agent-board')
    })

    test('the record each step leaves, and what Undo will remove', () => {
      const p = plan(factsFor('nodocker', distro))
      expect(step(p, 'docker-install').record).toEqual([
        {
          kind: 'docker',
          packages: ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-ce-rootless-extras'],
          files: ['/etc/apt/sources.list.d/docker.list', '/etc/apt/keyrings/docker.asc'],
        },
      ])
      expect(step(p, 'run-caddy').record).toEqual([{ kind: 'container', name: 'agent-board-caddy', setup: 'r1' }])
      expect(p.undoTouches.map(t => t.kind)).toContain('container')
    })

    test('apply twice: nothing to change; the same pair with another domain: an update', () => {
      expect(plan(setUp1(distro)).kind).toBe('nothing')
      expect(plan(setUp2(distro)).kind).toBe('nothing')
      const moved = plan(setUp1(distro), { ...W, domain: 'new.example.com' })
      expect(moved.kind).toBe('update')
      expect(moved.address).toBe('https://new.example.com')
      expect(text(step(moved, 'caddyfile'))).toContain('new.example.com {')
      const moved2 = plan(setUp2(distro), { ...W, domain: 'new.example.com' })
      expect(moved2.kind).toBe('update')
      // the host set: the old domain out, the new one in
      expect(text(step(moved2, 'validate'))).toContain(`grep -vxF '"board.example.com"'`)
      expect(text(step(moved2, 'validate'))).toContain(`echo '"new.example.com"'`)
      // an update always edits and reloads: its backup is never skipped, so neither is the rest
      expect(step(moved2, 'backup').skipIf).toEqual([])
      // something of the setup gone: Apply repairs it
      const f = setUp1(distro)
      expect(plan({ ...f, ports: factsFor('1', distro).ports, docker: factsFor('1', distro).docker }).kind).toBe(
        'apply',
      )
    })
  })

  describe(`Undo on ${distro}`, () => {
    test('case 2: the line out of the file as it is now, never the backup written back', () => {
      const r = recordFor('2', { items: CASE2_ITEMS })
      const p = undoPlan(r, setUp2(distro, r), { id: 'u1', removeDocker: false, removeEdited: false })
      expect(p.kind).toBe('undo')
      const unedit = text(step(p, 'unedit'))
      expect(unedit).toContain(IMPORT_LINE)
      expect(unedit).not.toContain('/etc/agent-board/backups/r0')
      expect(all(p)).not.toContain('/etc/agent-board/backups/r0')
      expect(ids(p).indexOf('reload')).toBeLessThan(ids(p).indexOf('drop-site-file'))
      expect(ids(p).at(-2)).toBe('forget')
      expect(ids(p).at(-1)).toBe('by-hand')
      expect(text(step(p, 'group-back'))).toContain('sudo chgrp boardtunnel /var/lib/boardtunnel')
      expect(step(p, 'by-hand').skipIf).toEqual(['true'])
      expect(text(step(p, 'by-hand'))).toContain('sudo userdel boardtunnel')
      expect(p.ticks).toEqual(['removeEdited'])
    })

    test('an edited file of ours stays unless removeEdited', () => {
      const r = recordFor('2', { items: CASE2_ITEMS })
      const kept = text(
        step(undoPlan(r, setUp2(distro, r), { id: 'u1', removeDocker: false, removeEdited: false }), 'drop-site-file'),
      )
      expect(kept).toContain(`= ${'ab'.repeat(32)} ]`)
      expect(kept).toContain('sudo rm -f /etc/caddy/agent-board/board.caddy')
      const gone = text(
        step(undoPlan(r, setUp2(distro, r), { id: 'u1', removeDocker: false, removeEdited: true }), 'drop-site-file'),
      )
      expect(gone).not.toContain('ab'.repeat(32))
      expect(gone).toContain('sudo rm -f /etc/caddy/agent-board/board.caddy')
    })

    test('containers and volumes by name and label; images only the board pulled; Docker only when ticked and installed', () => {
      const items: RecordItem[] = [
        {
          kind: 'docker',
          packages: ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-ce-rootless-extras'],
          files: ['/etc/apt/sources.list.d/docker.list', '/etc/apt/keyrings/docker.asc'],
        },
        { kind: 'image', ref: CADDY_IMAGE, before: true },
        { kind: 'image', ref: SOCAT_IMAGE, before: false },
        { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
        { kind: 'volume', name: 'agent-board-caddy-data' },
        { kind: 'container', name: 'agent-board-caddy', setup: 'r0' },
      ]
      const r = recordFor('1', { items })
      const f = setUp1(distro)
      const p = undoPlan(r, { ...f, record: r }, { id: 'u1', removeDocker: true, removeEdited: false })
      const drop = text(step(p, 'drop-caddy'))
      expect(drop).toContain(`{{index .Config.Labels "agent-board.role"}}`)
      expect(drop).toContain('sudo docker rm -f agent-board-caddy')
      expect(text(step(p, 'drop-volumes'))).toContain(`{{index .Labels "agent-board.role"}}`)
      const images = text(step(p, 'drop-images'))
      expect(images).toContain(SOCAT_IMAGE)
      expect(images).not.toContain(CADDY_IMAGE)
      expect(text(step(p, 'drop-docker'))).toContain('purge -y docker-ce docker-ce-cli containerd.io')
      expect(p.ticks).toEqual(['removeDocker', 'removeEdited'])
      expect(
        ids(undoPlan(r, { ...f, record: r }, { id: 'u1', removeDocker: false, removeEdited: false })),
      ).not.toContain('drop-docker')
      const without = recordFor('1', { items: items.slice(1) })
      expect(
        undoPlan(without, { ...f, record: without }, { id: 'u1', removeDocker: true, removeEdited: false }).ticks,
      ).toEqual(['removeEdited'])
      expect(
        ids(undoPlan(without, { ...f, record: without }, { id: 'u1', removeDocker: true, removeEdited: false })),
      ).not.toContain('drop-docker')
    })

    test('case 3: the marked block out of their file as it is now, then the helper', () => {
      const r = recordFor('3a', {
        items: [
          { kind: 'image', ref: SOCAT_IMAGE, before: false },
          { kind: 'container', name: 'agent-board-socket', setup: 'r0' },
          { kind: 'backup', of: '/srv/my web/Caddyfile', path: '/etc/agent-board/backups/r0/Caddyfile' },
          { kind: 'block', file: '/srv/my web/Caddyfile', begin: '# >>> agent-board', end: '# <<< agent-board' },
        ],
      })
      const f = factsFor('3a', distro)
      const p = undoPlan(r, { ...f, record: r }, { id: 'u1', removeDocker: false, removeEdited: false })
      expect(text(step(p, 'unedit'))).toContain("'/srv/my web/Caddyfile'")
      expect(ids(p).indexOf('reload')).toBeLessThan(ids(p).indexOf('drop-socket'))
      expect(all(p)).not.toContain('/etc/agent-board/backups/r0')
    })
  })
}

describe('their sites fetched before and after a reload: as many as fit, the others named in a note', () => {
  /** Host names of 253 characters (the most a name has), each its own. */
  const long = (n: number): string[] =>
    Array.from(
      { length: n },
      (_, i) =>
        `${String(i).padStart(2, '0')}${'a'.repeat(59)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(59)}.org`,
    )
  const fetched = (s: PlanStep): string[] => [...text(s).matchAll(/'([a-z0-9.-]+\.org)'/g)].map(m => m[1] ?? '')
  const note = (p: Plan) => p.warnings.find(w => w.key === 'server.warn.someHosts')

  test('a few: all of them, no note', () => {
    const p = plan(factsFor('2'))
    expect(fetched(step(p, 'fetch-before'))).toEqual(['blog.example.org', 'shop.example.org'])
    expect(note(p)).toBeUndefined()
  })
  test('long names: the first that fit in 1,500 characters; the note says how many of how many', () => {
    const hosts = long(20)
    expect(hosts[0]).toHaveLength(253)
    for (const c of ['2', '3a', '3b'] as const) {
      const f = factsFor(c)
      // a wildcard or an address is no name to fetch, nor counted
      const p = plan({ ...f, caddy: f.caddy && { ...f.caddy, hosts: [...hosts, '*.example.org', '192.0.2.4'] } })
      expect([c, fetched(step(p, 'fetch-before'))]).toEqual([c, hosts.slice(0, 5)])
      expect([c, note(p)]).toEqual([c, { key: 'server.warn.someHosts', params: { n: '5', all: '20' } }])
    }
    const f4 = factsFor('4b')
    const p4 = plan({ ...f4, nginx: f4.nginx && { ...f4.nginx, serverNames: hosts } })
    expect(fetched(step(p4, 'nginx-reload'))).toEqual(hosts.slice(0, 5))
    expect(note(p4)).toEqual({ key: 'server.warn.someHosts', params: { n: '5', all: '20' } })
    // Undo fetches the same, with the same note, once
    const r = recordFor('4b', {
      items: [
        { kind: 'file', path: '/etc/nginx/conf.d/agent-board.conf', sha256: 'cd'.repeat(32) },
        { kind: 'container', name: 'agent-board-caddy', setup: 'r0' },
      ],
    })
    const u = undoPlan(
      r,
      { ...f4, nginx: f4.nginx && { ...f4.nginx, serverNames: hosts }, record: r },
      { id: 'u1', removeDocker: false, removeEdited: false },
    )
    expect(fetched(step(u, 'drop-nginx-file'))).toEqual(hosts.slice(0, 5))
    expect(u.warnings.filter(w => w.key === 'server.warn.someHosts')).toEqual([
      { key: 'server.warn.someHosts', params: { n: '5', all: '20' } },
    ])
  })
  test('more than 20 short ones: the first 20, and the note', () => {
    const many = Array.from({ length: 25 }, (_, i) => `site-${i}.example.org`)
    const f = factsFor('2')
    const p = plan({ ...f, caddy: f.caddy && { ...f.caddy, hosts: many } })
    expect(fetched(step(p, 'fetch-before'))).toEqual(many.slice(0, 20))
    expect(note(p)).toEqual({ key: 'server.warn.someHosts', params: { n: '20', all: '25' } })
  })
  test('the note in English and Russian', () => {
    const params = { n: '5', all: '20' }
    expect(translator('en')('server.warn.someHosts', params)).toBe(
      'Your config names 20 sites: the board checks the first 5 before and after the reload, not the others.',
    )
    expect(translator('ru')('server.warn.someHosts', params)).toContain('20')
  })
})

describe('what the panel wants is checked before anything is planned: their Caddy or nginx loads it as config', () => {
  const bad: [string, Wanted][] = [
    ['a domain that ends the site block', { ...W, domain: 'a.com;\n}' }],
    ['a domain with a brace', { ...W, domain: 'a{b.example.com' }],
    ['a domain with a space', { ...W, domain: 'x.com; include /etc/x' }],
    ['a domain with a newline', { ...W, domain: 'a.com\nimport /etc/x' }],
    ['no domain', { ...W, domain: '' }],
    ['a socket with a space', { ...W, socket: '/var/lib/board tunnel/board.sock' }],
    ['a socket with a brace', { ...W, socket: '/var/lib/boardtunnel/b}.sock' }],
    ['a user like an option', { ...W, user: '-l' }],
    ['no user', { ...W, user: '' }],
    ['a public port that is none', { ...W, publicPort: 70000 }],
  ]
  for (const [name, w] of bad)
    test(name, () => {
      expect(wantedProblem(w)).toEqual(expect.any(String))
      for (const c of ['bare', '2', '3a', '3b', '4b'] as const) {
        expect(() => chooseCase(factsFor(c), w)).toThrow()
        expect(() => buildPlan(factsFor(c), w, O)).toThrow()
      }
      expect(() => buildPlan(manualFacts('2', 'debian'), w, O)).toThrow()
    })
  test('the tunnel’s defaults and a public port pass', () => {
    expect(wantedProblem(W)).toBeNull()
    expect(wantedProblem({ ...W, publicPort: 8443 })).toBeNull()
  })
  test('a record whose domain or pair fails the same checks is not the board’s, and has no Undo', () => {
    for (const r of [
      recordFor('2', { domain: 'x.com; include /etc/x', items: CASE2_ITEMS }),
      recordFor('2', { domain: 'a{b.example.com', items: CASE2_ITEMS }),
      recordFor('2', { pair: { user: '-l', socket: '/var/lib/boardtunnel/board.sock' }, items: CASE2_ITEMS }),
    ]) {
      expect(setupRecord(JSON.parse(JSON.stringify(r)))).toBeNull()
      expect(() => undoPlan(r, factsFor('2'), { id: 'u1', removeDocker: false, removeEdited: false })).toThrow()
    }
  })
})

describe('nothing the board does leaves their Caddy a file it cannot load', () => {
  test('their file is written back only from a backup that is there (else it stays as it is)', () => {
    const p = plan(factsFor('2'))
    for (const s of [step(p, 'write'), step(p, 'reload')])
      expect(s.undo.join('\n')).toContain(
        `sudo sh -c 'test -s /etc/agent-board/backups/r1/Caddyfile && cat /etc/agent-board/backups/r1/Caddyfile > /etc/caddy/Caddyfile'`,
      )
    // and never a file that imports the board's site while that site is not there
    expect(step(p, 'write').undo.join('\n')).toContain(`! sudo test -s ${SITE_FILE}`)
  })
  test('the board’s own files: written beside and moved, an earlier one kept whole, removed by the rollback only when this run made it', () => {
    const s = step(plan(factsFor('2')), 'site-file')
    expect(text(s)).toContain(`| sudo tee ${SITE_FILE}.part >/dev/null`)
    expect(text(s)).toContain(`sudo mv -f ${SITE_FILE}.part ${SITE_FILE}`)
    expect(text(s)).toContain('sudo touch /etc/agent-board/backups/r1/board.caddy.new')
    const undo = s.undo.join('\n')
    expect(undo).toContain(
      `elif sudo test -f /etc/agent-board/backups/r1/board.caddy.new; then sudo rm -f ${SITE_FILE}; fi`,
    )
    expect(undo).not.toMatch(/else sudo rm -f/)
  })
  test('Undo: each file of the board’s is copied first and put back by the rollback; board.caddy stays while a Caddyfile imports it', () => {
    const r = recordFor('2', { items: CASE2_ITEMS })
    const p = undoPlan(r, setUp2('debian13', r), { id: 'u1', removeDocker: false, removeEdited: false })
    const drop = step(p, 'drop-site-file')
    expect(text(drop)).toContain(`sudo cp -p ${SITE_FILE} /etc/agent-board/backups/u1/board.caddy.dropped`)
    expect(text(drop)).toMatch(/if sudo grep -Eqs '\^\[\[:space:\]\]\*import.*' \/etc\/caddy\/Caddyfile; then/)
    expect(drop.undo.join('\n')).toContain(
      `sudo cp -p /etc/agent-board/backups/u1/board.caddy.dropped ${SITE_FILE}.part; sudo mv -f ${SITE_FILE}.part ${SITE_FILE}`,
    )
    const own: RecordItem[] = [
      { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
      { kind: 'file', path: '/etc/nginx/conf.d/agent-board.conf', sha256: 'cd'.repeat(32) },
    ]
    const r4 = recordFor('4b', { items: own })
    const p4 = undoPlan(r4, { ...factsFor('4b'), record: r4 }, { id: 'u1', removeDocker: false, removeEdited: false })
    for (const id of ['drop-caddyfile', 'drop-nginx-file'])
      expect([id, step(p4, id).undo.length > 0]).toEqual([id, true])
  })
  test('a record of a run cut short before it recorded the line: Undo takes the line out all the same', () => {
    const r = recordFor('2', {
      state: 'running',
      items: [
        { kind: 'file', path: SITE_FILE, sha256: 'ab'.repeat(32) },
        { kind: 'backup', of: '/etc/caddy/Caddyfile', path: '/etc/agent-board/backups/r0/Caddyfile' },
      ],
    })
    const p = undoPlan(r, { ...factsFor('2'), record: r }, { id: 'u1', removeDocker: false, removeEdited: false })
    expect(ids(p).slice(0, 3)).toEqual(['guard', 'backup', 'unedit'])
    expect(text(step(p, 'unedit'))).toContain(IMPORT_LINE)
    expect(ids(p).indexOf('reload')).toBeLessThan(ids(p).indexOf('drop-site-file'))
  })
})

describe('the record on the server', () => {
  const good = { ...recordFor('2', { items: CASE2_ITEMS }), extra: 'kept?' }
  test('read back when it is the board’s', () => {
    expect(setupRecord(good)).toMatchObject({ v: 1, case: '2', items: CASE2_ITEMS })
    expect(setupRecord(JSON.parse(JSON.stringify(recordFor('4b'))))).toMatchObject({ publicPort: 8443 })
  })
  test('refused: a wrong v, a missing pair, an unknown item kind, an odd state or case, our names spelled otherwise', () => {
    const { pair: _, ...noPair } = good
    for (const bad of [
      null,
      'x',
      { ...good, v: 2 },
      noPair,
      { ...good, pair: { user: 'boardtunnel' } },
      { ...good, items: [{ kind: 'magic' }] },
      { ...good, items: [{ kind: 'file', path: '/etc/passwd', sha256: 'ab'.repeat(32) }] },
      { ...good, items: [{ kind: 'container', name: 'web-caddy-1', setup: 'r0' }] },
      { ...good, state: 'sideways' },
      { ...good, case: '5' },
      { ...good, domain: 'a\nb' },
    ])
      expect([bad, setupRecord(bad)]).toEqual([bad, null])
  })
})

describe('Do it myself without Look (call 28)', () => {
  test('the facts’ unknowns are placeholders, each with the command that finds it', () => {
    const f = manualFacts('3a', 'ubuntu')
    const p = plan(f)
    expect(p.case).toBe('3a')
    expect(all(p)).toContain('<your Caddyfile>')
    const finders = placeholderFinders('3a')
    expect(finders.map(x => x.command).join('\n')).toContain('docker ps')
    expect(finders.map(x => x.command).join('\n')).toContain('docker inspect')
    for (const x of finders) expect(all(p)).toContain(x.placeholder)
  })
  test('each case’s manual plan', () => {
    for (const c of ['1', '2', '3a', '3b', '4a', '4b'] as SetupCase[]) {
      const p = plan(manualFacts(c, 'debian'))
      expect([c, p.case]).toEqual([c, c])
      for (const x of placeholderFinders(c)) expect([c, all(p).includes(x.placeholder)]).toEqual([c, true])
    }
    expect(all(plan(manualFacts('2', 'debian')))).toContain('<your Caddyfile>')
    expect(all(plan(manualFacts('1', 'debian')))).toContain("'<gid>'")
  })
})

/** The facts Look read on a trial server (Task 20's fixtures, through its own parsers). */
function lookedAt(distro: TestDistro, scenario: string): ServerFacts {
  const dir = `test/fixtures/server-look/${distro}/${scenario}`
  const r = readRoundOne(readFileSync(`${dir}/round1.txt`, 'utf8'))
  if (!r) throw new Error(`round one of ${dir}`)
  const two = existsSync(`${dir}/round2.txt`) ? readFileSync(`${dir}/round2.txt`, 'utf8') : ''
  const f = readServerFacts(r, two)
  if (!f) throw new Error(`round two of ${dir}`)
  return f
}

/** Their sites' fetch at an address, as the plan's status function writes it. */
const fetchAt = (address: string): string => `--resolve "$1:\${2:-443}:${address}"`

describe('planned from what Look read on the trial servers (not from shapes guessed)', () => {
  for (const distro of DISTROS) {
    test(`every scenario on ${distro}: its case, and the plan's first step the guard`, () => {
      const cases: Record<string, SetupCase | Manual> = {
        bare: '1',
        nodocker: '1',
        dummy80: '1b',
        'caddy-unit': '2',
        'compose-folder': '3a',
        'compose-file': '3a',
        'caddy-host': '3b',
        'caddy-bridge': 'bridge',
        'nginx-443': '4a',
        'nginx-80-443': '4b',
        apache: 'other80',
      }
      for (const [scenario, want] of Object.entries(cases)) {
        const choice = chooseCase(lookedAt(distro, scenario), W)
        expect([scenario, choice.case ?? choice.why[0]]).toEqual([scenario, want])
        if (choice.case !== null)
          expect([scenario, ids(plan(lookedAt(distro, scenario)))[0]]).toEqual([scenario, 'guard'])
      }
    })

    test(`case 2 on ${distro}: every run of their Caddy with STEPPATH=/, so Caddy 2.6 makes no $HOME/.step`, () => {
      const p = plan(lookedAt(distro, 'caddy-unit'))
      expect(text(step(p, 'validate'))).toContain(
        'sudo runuser -u caddy -- env STEPPATH=/ /usr/bin/caddy validate --config /etc/caddy/.Caddyfile.agent-board --adapter caddyfile',
      )
      expect(all(p)).toContain('hosts() { sudo env STEPPATH=/ /usr/bin/caddy adapt --config "$1" --adapter caddyfile')
      const runs = all(p)
        .split('\n')
        .filter(l => /\/usr\/bin\/caddy (adapt|validate)/.test(l))
      expect(runs.length).toBeGreaterThan(0)
      for (const l of runs) expect(l).toContain('STEPPATH=/ /usr/bin/caddy')
    })

    test(`case 3 on ${distro}: the container's name as Docker gives it, and their Caddy run with STEPPATH=/`, () => {
      const f = lookedAt(distro, 'compose-folder')
      expect(chooseCase(f, W)).toEqual({
        case: '3a',
        why: { key: 'server.case.3a', params: { container: 'web-caddy-1', network: 'web_default' } },
      })
      const p = plan(f)
      const execs = all(p)
        .split('\n')
        .filter(l => l.includes('docker exec') && / caddy (adapt|validate|reload) /.test(l))
      expect(execs.length).toBeGreaterThan(0)
      for (const l of execs) expect(l).toContain(`docker exec -e STEPPATH=/ ${f.caddy?.container} caddy `)
      // their sites fetched where Look found their Caddy listening
      expect(text(step(p, 'fetch-before'))).toContain(fetchAt('127.0.0.1'))
    })

    test(`case 4b on ${distro}: the board's nginx file listens where theirs does on 80`, () => {
      const f = lookedAt(distro, 'nginx-80-443')
      expect(f.nginx?.listen80).toEqual(['80', '[::]:80'])
      const p = plan(f)
      const file = text(step(p, 'nginx-file'))
      expect(file).toContain("'    listen 80;'")
      expect(file).toContain("'    listen [::]:80;'")
      expect(text(step(p, 'acme-path'))).toContain('--resolve board.example.com:80:127.0.0.1 ')
    })
  }

  test('their Caddy on an IPv6 address (as ss prints it, in brackets): fetched there, bracketed once', () => {
    const f = lookedAt('debian13', 'caddy-unit')
    if (!f.caddy) throw new Error('caddy')
    for (const address of ['[::1]', '::1']) {
      const p = plan({ ...f, caddy: { ...f.caddy, address } })
      expect(text(step(p, 'fetch-before'))).toContain(fetchAt('[::1]'))
    }
    const bound = plan({ ...f, caddy: { ...f.caddy, address: '192.0.2.4%eth0' } })
    expect(text(step(bound, 'fetch-before'))).toContain(fetchAt('192.0.2.4'))
  })

  test('a tool the run needs missing (as Look names it): Do it myself', () => {
    const f = lookedAt('ubuntu2604', 'bare')
    for (const tool of ['flock', 'setsid', 'timeout', 'sha256sum', 'ss'])
      expect(chooseCase({ ...f, host: { ...f.host, missing: [tool] } }, W)).toEqual(why('os'))
    expect(chooseCase({ ...f, host: { ...f.host, missing: ['getent'] } }, W).case).toBe('1')
  })

  test('Undo’s commands for what was made by hand reload sshd as on a socket-activated Ubuntu 26.04', () => {
    const r = recordFor('1', { items: [] })
    const p = undoPlan(r, lookedAt('ubuntu2604', 'bare'), { id: 'u1', removeDocker: false, removeEdited: false })
    expect(text(step(p, 'by-hand'))).toContain(
      'sudo sshd -t && { sudo systemctl try-reload-or-restart ssh 2>/dev/null || sudo systemctl try-reload-or-restart sshd; }',
    )
  })
})

test('the page can import them: no node: import', () => {
  for (const file of [
    'src/core/server-plan.ts',
    'src/core/server-view.ts',
    'src/core/server-facts.ts',
    'src/core/server-shell.ts',
  ])
    expect([file, readFileSync(file, 'utf8')]).not.toEqual([file, expect.stringMatching(/from 'node:/)])
})

test('every text a plan or a choice shows is there in English and in Russian', () => {
  const en = translator('en')
  const ru = translator('ru')
  const keys = new Set<string>()
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
  for (const r of reasons) keys.add(`server.manual.${r}`)
  const plans: Plan[] = []
  for (const distro of DISTROS) {
    for (const c of ['bare', 'nodocker', '1b', '2', '3a', '3b', '4a', '4b'] as const) {
      const f = factsFor(c, distro)
      plans.push(plan(f))
      const choice = chooseCase(f, W)
      if (choice.case !== null) keys.add(choice.why.key)
    }
    plans.push(plan(setUp2(distro), { ...W, domain: 'new.example.com' }), plan(setUp1(distro)))
    keys.add('server.case.same')
    keys.add('server.case.update')
    const r2 = recordFor('2', { items: CASE2_ITEMS })
    plans.push(undoPlan(r2, setUp2(distro, r2), { id: 'u1', removeDocker: true, removeEdited: false }))
    plans.push(plan({ ...setUp2(distro, recordFor('2', { state: 'running', items: CASE2_ITEMS })) }))
  }
  const own: RecordItem[] = [
    { kind: 'docker', packages: ['docker-ce'], files: ['/etc/apt/sources.list.d/docker.list'] },
    { kind: 'image', ref: SOCAT_IMAGE, before: false },
    { kind: 'file', path: '/etc/nginx/conf.d/agent-board.conf', sha256: 'ab'.repeat(32) },
    { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
    { kind: 'volume', name: 'agent-board-caddy-data' },
    { kind: 'container', name: 'agent-board-caddy', setup: 'r0' },
    { kind: 'container', name: 'agent-board-socket', setup: 'r0' },
    { kind: 'block', file: '/srv/my web/Caddyfile', begin: '# >>> agent-board', end: '# <<< agent-board' },
  ]
  const r4 = recordFor('4b', { items: own })
  plans.push(undoPlan(r4, { ...factsFor('4b'), record: r4 }, { id: 'u1', removeDocker: true, removeEdited: false }))
  for (const c of ['1', '1b', '2', '3a', '3b', '4a', '4b'] as SetupCase[]) plans.push(plan(manualFacts(c, 'debian')))
  for (const p of plans) {
    for (const s of p.steps) keys.add(s.title.key).add(s.why.key)
    for (const w of p.warnings) keys.add(w.key)
  }
  for (const k of keys) expect([k, en(k) !== k, ru(k) !== en(k)]).toEqual([k, true, true])
  expect(keys.size).toBeGreaterThan(100)
})
