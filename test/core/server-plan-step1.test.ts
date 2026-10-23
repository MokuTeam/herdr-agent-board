// Step 1 made by the board (the simple-setup spec's "Step 1 by the board", calls 5 and 6): the
// tunnel user, the socket's folder, the keys file and sshd's fence as Apply's first steps, recorded
// and undone like the rest; what was there before is used and kept.
import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ServerFacts, StepOneFacts } from '../../src/core/server-facts.ts'
import { fenceWanted } from '../../src/core/server-look.ts'
import {
  buildPlan,
  type Choice,
  chooseCase,
  type Plan,
  type PlanStep,
  type RecordItem,
  setupRecord,
  stepOneNeeds,
  undoPlan,
  type Wanted,
  wantedProblem,
} from '../../src/core/server-plan.ts'
import { caddyRunArgs, FENCE_FILE, fenceBlock, fenceFile, SSHD_CONFIG } from '../../src/core/server-texts.ts'
import { keysLine, SSHD_RELOAD, sshdBlock } from '../../src/core/tunnel-snippets.ts'
import { BOARD_KEY, factsFor, GID, recordFor, stepOneMissing, type TestDistro } from '../support/server-facts.ts'

const KEY = BOARD_KEY
const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
  publicKey: KEY,
}
const { publicKey: _, ...NO_KEY } = W
const O = { id: 'r1', docker: true }
const DISTROS: TestDistro[] = ['debian13', 'ubuntu2604']
const STEP1 = ['tunnel-user', 'socket-folder', 'keys-file', 'sshd-fence']
const OWN = ['pull-caddy', 'caddyfile', 'volumes', 'run-caddy', 'caddy-up']
const KEYS = '/etc/ssh/authorized_keys/boardtunnel'
const FENCE = Object.entries(fenceWanted('boardtunnel')).map(([k, v]) => `${k} ${v}`)

const empty = stepOneMissing
/** sshd_config put in place whole from this file: a copy beside it written, then moved over it (through a link). */
const movedOver = (from: string): string =>
  `sudo sh -c 'test -s ${from} && t=$(readlink -f ${SSHD_CONFIG}) && p="\${t%/*}/.\${t##*/}.agent-board" && cp -p "$t" "$p" && cat ${from} > "$p" && mv -f "$p" "$t"'`
/** Step 1 done (by hand or by an earlier Apply): the fence in force, the folder, the user, the board's key. */
function done(c: Parameters<typeof factsFor>[0], distro: TestDistro = 'debian13'): ServerFacts {
  const f = factsFor(c, distro)
  return {
    ...f,
    fence: fenceWanted('boardtunnel'),
    stepOne: {
      user: { uid: 995, group: 'boardtunnel', shell: '/usr/sbin/nologin', ours: false, admin: false },
      keys: 'same',
      keysDir: true,
      include: true,
    },
  }
}

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
const undo = (r: ReturnType<typeof recordFor>, f: ServerFacts): Plan =>
  undoPlan(r, { ...f, record: r }, { id: 'u1', removeDocker: false, removeEdited: false })

const MADE: RecordItem[] = [
  { kind: 'user', name: 'boardtunnel' },
  { kind: 'folder', path: '/var/lib/boardtunnel' },
  { kind: 'keys', path: KEYS, dir: true },
  { kind: 'fence', path: FENCE_FILE },
]

for (const distro of DISTROS) {
  describe(`step 1 by the board on ${distro}`, () => {
    test('an empty server: the user, the folder, the keys file and the fence first, then each case’s steps', () => {
      expect(ids(plan(empty('bare', distro)))).toEqual(['guard', ...STEP1, ...OWN])
      expect(ids(plan(empty('nodocker', distro)))).toEqual(['guard', ...STEP1, 'docker-install', ...OWN])
      for (const c of ['1b', '4a', '4b', '2', '3a', '3b'] as const) {
        const got = ids(plan(empty(c, distro)))
        expect([c, got.slice(0, 5)]).toEqual([c, ['guard', ...STEP1]])
        // the case's own steps as before
        expect([c, got.slice(5)]).toEqual([c, ids(plan(factsFor(c, distro), NO_KEY)).slice(1)])
      }
    })

    test('only what is missing: each part there already is used as it is', () => {
      expect(ids(plan(done('bare', distro)))).toEqual(['guard', ...OWN])
      const f = done('bare', distro)
      const one = (over: Partial<ServerFacts>, s: Partial<StepOneFacts> = {}): string[] =>
        ids(plan({ ...f, ...over, stepOne: { ...(f.stepOne as StepOneFacts), ...s } })).filter(id => STEP1.includes(id))
      expect(one({}, { user: null })).toEqual(['tunnel-user'])
      expect(one({ folder: null })).toEqual(['socket-folder'])
      expect(one({}, { keys: 'none' })).toEqual(['keys-file'])
      expect(one({}, { keys: 'other' })).toEqual(['keys-file'])
      expect(one({ fence: { ...fenceWanted('boardtunnel'), permittty: 'yes' } })).toEqual(['sshd-fence'])
      expect(stepOneNeeds(f, W)).toEqual({ user: false, folder: false, keys: null, fence: false })
      expect(stepOneNeeds(empty('bare', distro), W)).toEqual({ user: true, folder: true, keys: 'make', fence: true })
    })

    test('without the board’s key, or from a Look that did not read step 1: nothing of step 1, as before', () => {
      expect(stepOneNeeds(empty('bare', distro), NO_KEY)).toBeNull()
      expect(chooseCase(empty('bare', distro), NO_KEY)).toEqual({ case: null, why: ['folder'] })
      const { stepOne: _s, ...older } = empty('bare', distro)
      expect(stepOneNeeds(older, W)).toBeNull()
      expect(chooseCase(older, W)).toEqual({ case: null, why: ['folder'] })
      // a folder there and the fence off, as before: the case's steps only
      expect(ids(plan(factsFor('bare', distro)))).toEqual(['guard', ...OWN])
      expect(ids(plan(factsFor('bare', distro), NO_KEY))).toEqual(['guard', ...OWN])
    })

    test('a tunnel user that is a login people use, not made by the board: refused before any change', () => {
      const f = done('bare', distro)
      const s1 = f.stepOne as StepOneFacts
      const as = (
        user: Partial<NonNullable<StepOneFacts['user']>>,
        keys: StepOneFacts['keys'] = 'none',
      ): ServerFacts => ({
        ...f,
        fence: {},
        stepOne: { ...s1, keys, user: { ...(s1.user as NonNullable<StepOneFacts['user']>), ...user } },
      })
      const refused: Choice = { case: null, why: ['tunnelUser'] }
      // root, a person's account, the admin's own, one with a shell (passwd's empty one is /bin/sh)
      expect(chooseCase(as({ uid: 0, shell: '/bin/bash' }), W)).toEqual(refused)
      expect(chooseCase(as({ uid: 0, shell: '/usr/sbin/nologin' }), W)).toEqual(refused)
      expect(chooseCase(as({ uid: 1000 }), W)).toEqual(refused)
      expect(chooseCase(as({ uid: 65534 }), W)).toEqual(refused)
      expect(chooseCase(as({ admin: true }), W)).toEqual(refused)
      expect(chooseCase(as({ shell: '/bin/sh' }), W)).toEqual(refused)
      expect(chooseCase(as({ shell: '' }), W)).toEqual(refused)
      // with all of step 1 in place too: the board leaves that login alone
      expect(
        chooseCase({ ...as({ uid: 1000, shell: '/bin/bash' }, 'same'), fence: fenceWanted('boardtunnel') }, W),
      ).toEqual(refused)
      expect(buildPlan(as({ uid: 1000, shell: '/bin/bash' }), W, O)).toEqual(refused)
      // a system user with no shell to log in with, made by hand (the old step 1), or one the board made
      expect(chooseCase(as({ shell: '/usr/sbin/nologin' }), W).case).toBe('1')
      expect(chooseCase(as({ shell: '/bin/false' }), W).case).toBe('1')
      expect(chooseCase(as({ uid: 1001, shell: '/bin/bash', ours: true }), W).case).toBe('1')
      // no tunnel user yet, or a Look that did not read step 1: as before
      expect(chooseCase(as({}), W).case).toBe('1')
      expect(chooseCase({ ...f, stepOne: { ...s1, user: null } }, W).case).toBe('1')
      const { stepOne: _s, ...older } = f
      expect(chooseCase(older, W).case).toBe('1')
      // after other limits, as its own reason
      expect(chooseCase({ ...as({ uid: 0 }), host: { ...f.host, selinux: 'enforcing' } }, W)).toEqual({
        case: null,
        why: ['selinux', 'tunnelUser'],
      })
      // the reason in both languages
      for (const lang of ['en', 'ru'] as const)
        expect([lang, translator(lang)('server.manual.tunnelUser').startsWith('server.')]).toEqual([lang, false])
    })

    test('no tunnel user but a group of its name left: refused before any change (useradd would fail on it)', () => {
      const f = empty('bare', distro)
      const left: ServerFacts = { ...f, stepOne: { ...(f.stepOne as StepOneFacts), groupLeft: true } }
      expect(chooseCase(left, W)).toEqual({ case: null, why: ['tunnelGroup'] })
      expect(buildPlan(left, W, O)).toEqual({ case: null, why: ['tunnelGroup'] })
      // without the board's key it makes no user: as before
      expect(chooseCase(left, NO_KEY)).toEqual({ case: null, why: ['folder'] })
      expect(chooseCase({ ...left, folder: factsFor('bare', distro).folder }, NO_KEY).case).toBe('1')
      // no group left: the user made as before
      expect(ids(plan(f))).toContain('tunnel-user')
      for (const lang of ['en', 'ru'] as const)
        expect([lang, translator(lang)('server.manual.tunnelGroup').startsWith('server.')]).toEqual([lang, false])
    })

    test('the tunnel user: as step 1 made it, with the board’s comment; never a user that is there', () => {
      const p = plan(empty('bare', distro))
      const s = step(p, 'tunnel-user')
      expect(s.commands).toEqual([
        "sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment 'agent-board tunnel' boardtunnel",
        "sudo usermod -p '*' boardtunnel",
      ])
      expect(s.skipIf).toEqual(['getent passwd boardtunnel >/dev/null'])
      expect(s.record).toEqual([{ kind: 'user', name: 'boardtunnel' }])
      // its rollback: only the board's user, its processes (the tunnel's session) ended first
      const back = s.undo.join('\n')
      expect(back).toContain("cut -d: -f5)\" = 'agent-board tunnel' ]")
      expect(back).toContain('/proc/[0-9]*/status')
      expect(back).toContain('sudo userdel boardtunnel')
      // the guard: the user still missing when the run starts, else nothing changes
      expect(text(step(p, 'guard'))).toContain(
        "if getent passwd boardtunnel >/dev/null; then echo '@@changed user'; false; fi",
      )
      expect(p.relies).toContain('user boardtunnel: none')
    })

    test('the socket’s folder: 2750, the tunnel user’s and its group’s; its parent must be there', () => {
      const p = plan(empty('bare', distro))
      const s = step(p, 'socket-folder')
      expect(text(s)).toContain(
        'sudo install -d -m 2750 -o boardtunnel -g "$(id -gn boardtunnel)" /var/lib/boardtunnel',
      )
      expect(text(s)).toContain('if ! sudo test -d /var/lib; then')
      expect(s.record).toEqual([{ kind: 'folder', path: '/var/lib/boardtunnel' }])
      expect(s.undo.join('\n')).toContain('sudo rm -f /var/lib/boardtunnel/board.sock; sudo rmdir /var/lib/boardtunnel')
      expect(text(step(p, 'guard'))).toContain("if sudo test -e /var/lib/boardtunnel; then echo '@@changed folder'")
    })

    test('the keys file: the board’s key line alone; recorded when the board made it, put back when it was there', () => {
      const made = step(plan(empty('bare', distro)), 'keys-file')
      expect(text(made)).toContain(`printf '%s\\n' '${keysLine(KEY)}' | sudo tee ${KEYS}.part >/dev/null`)
      expect(text(made)).toContain(`sudo mv -f ${KEYS}.part ${KEYS}`)
      expect(text(made)).toContain(
        'sudo test -d /etc/ssh/authorized_keys || sudo install -d -m 755 /etc/ssh/authorized_keys',
      )
      expect(made.record).toEqual([{ kind: 'keys', path: KEYS, dir: true }])
      expect(made.undo.join('\n')).toContain('sudo rmdir /etc/ssh/authorized_keys 2>/dev/null || true')
      const inDir = step(plan(empty('bare', distro, { keysDir: true })), 'keys-file')
      expect(inDir.record).toEqual([{ kind: 'keys', path: KEYS, dir: false }])
      expect(inDir.undo.join('\n')).not.toContain('rmdir')
      // a keys file of someone else's: rewritten, its copy put back by a rollback, never recorded
      const theirs = step(plan(empty('bare', distro, { keys: 'other', keysDir: true })), 'keys-file')
      expect(theirs.record).toEqual([])
      expect(theirs.undo.join('\n')).toContain(`then sudo cp -p /etc/agent-board/backups/r1/keys.board ${KEYS}.part`)
    })

    test('sshd’s fence in a file of its own: written, sshd -t, in force for the tunnel user, the admin’s as before, then a reload', () => {
      const p = plan(empty('bare', distro))
      const s = step(p, 'sshd-fence')
      const lines = s.commands
      const at = (part: string): number => lines.findIndex(l => l.includes(part))
      expect(text(s)).toContain(`| sudo tee ${FENCE_FILE}.part >/dev/null`)
      for (const l of fenceFile('boardtunnel').split('\n')) expect(text(s)).toContain(`'${l.replaceAll("'", `'\\''`)}'`)
      // the admin's settings read before anything is written, compared after; the reload last
      expect(at('admins()')).toBeLessThan(at(`${FENCE_FILE}.part`))
      expect(at('sudo sshd -t')).toBeGreaterThan(at(`sudo mv -f ${FENCE_FILE}.part`))
      expect(at('sudo sshd -t')).toBeLessThan(at(SSHD_RELOAD))
      expect(at('bad=$(for kv in')).toBeLessThan(at(SSHD_RELOAD))
      expect(lines.at(-2)).toBe(SSHD_RELOAD)
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
      expect(text(s)).toContain('for u in root ${SUDO_USER:-}; do')
      expect(text(s)).toContain('sudo sshd -T -C "user=$u,host=localhost,addr=127.0.0.1"')
      for (const kv of FENCE) expect(text(s)).toContain(`'${kv}'`)
      // a run that finds the fence in force skips it
      expect(s.skipIf.at(-1)).toBe('[ -z "$bad" ]')
      expect(s.check.join('\n')).toContain('bad=$(for kv in')
      // its rollback: the file off (or the earlier one back), sshd reloaded only when it had been, and only a config that passes
      const back = s.undo.join('\n')
      expect(back).toContain(
        `elif sudo test -f /etc/agent-board/backups/r1/sshd-fence.new; then sudo rm -f ${FENCE_FILE}; fi`,
      )
      expect(back).toContain(
        `if sudo test -f /etc/agent-board/backups/r1/sshd-reloaded && sudo sshd -t; then ${SSHD_RELOAD}; fi`,
      )
      expect(s.record).toEqual([{ kind: 'fence', path: FENCE_FILE }])
      expect(s.touches).toEqual([
        { kind: 'file', what: FENCE_FILE },
        { kind: 'reload', what: 'sshd' },
      ])
      // never a restart: sshd reloads as the tunnel snippets have it (a reload for a unit that has one)
      const all = p.steps.flatMap(x => [...x.commands, ...x.undo]).join('\n')
      expect(all).not.toMatch(/systemctl (restart|stop)|(?<!reload-or-)restart ssh/)
      expect(all).toContain(SSHD_RELOAD)
    })

    test('no Include in sshd_config: the fence between markers at its end, moved over it whole, the backup back on a rollback', () => {
      const s = step(plan(empty('bare', distro, { include: false })), 'sshd-fence')
      expect(text(s)).toContain(`sudo cp -p ${SSHD_CONFIG} /etc/agent-board/backups/r1/sshd_config`)
      expect(text(s)).toContain('awk \'index($0, ENVIRON["B0"]) == 1 { s = 1 } !s { print }')
      for (const l of fenceBlock('boardtunnel').split('\n'))
        expect(text(s)).toContain(`'${l.replaceAll("'", `'\\''`)}'`)
      expect(text(s)).toContain(movedOver('/etc/agent-board/backups/r1/sshd_config.new'))
      expect(text(s)).not.toContain(`> ${SSHD_CONFIG}`)
      expect(s.undo.join('\n')).toContain(movedOver('/etc/agent-board/backups/r1/sshd_config'))
      // run by a real sh on files of a test's own: the new text in place whole, its mode kept,
      // no copy left beside it; through a link, the file it points to, the link kept
      const sh = Bun.which('sh')
      if (!sh) return
      const dir = mkdtempSync(join(tmpdir(), 'sshd-config-'))
      try {
        const command = movedOver('/etc/agent-board/backups/r1/sshd_config.new')
        const moved = (config: string, from: string): number =>
          Bun.spawnSync([
            sh,
            '-c',
            `sudo() { "$@"; }\n${command.replaceAll(SSHD_CONFIG, config).replaceAll('/etc/agent-board/backups/r1/sshd_config.new', from)}`,
          ]).exitCode
        const config = join(dir, 'sshd_config').replaceAll('\\', '/')
        const from = join(dir, 'sshd_config.new').replaceAll('\\', '/')
        writeFileSync(config, 'Port 22\n')
        chmodSync(config, 0o640)
        writeFileSync(from, 'Port 22\n# >>> agent-board\n')
        expect(moved(config, from)).toBe(0)
        expect(readFileSync(config, 'utf8')).toBe('Port 22\n# >>> agent-board\n')
        if (process.platform !== 'win32') expect(statSync(config).mode & 0o777).toBe(0o640)
        expect(readdirSync(dir).sort()).toEqual(['sshd_config', 'sshd_config.new'])
        // an empty or missing text: nothing changes
        writeFileSync(from, '')
        expect(moved(config, from)).not.toBe(0)
        expect(readFileSync(config, 'utf8')).toBe('Port 22\n# >>> agent-board\n')
        if (process.platform === 'win32') return
        mkdirSync(join(dir, 'real'))
        writeFileSync(join(dir, 'real', 'sshd_config'), 'Port 22\n')
        const link = join(dir, 'linked')
        symlinkSync(join(dir, 'real', 'sshd_config'), link)
        writeFileSync(from, 'Port 2222\n')
        expect(moved(link, from)).toBe(0)
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(readFileSync(join(dir, 'real', 'sshd_config'), 'utf8')).toBe('Port 2222\n')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      expect(s.record).toEqual([{ kind: 'fence', path: SSHD_CONFIG }])
      expect(text(s)).not.toContain(FENCE_FILE)
    })

    test('the board’s Caddy and helper get the folder’s gid on the server when the run makes the folder', () => {
      const p = plan(empty('bare', distro))
      const run = step(p, 'run-caddy')
      expect(run.commands).toContain('G=$(stat -c %g /var/lib/boardtunnel)')
      expect(text(run)).toContain('--group-add "$G"')
      expect(text(run)).toContain('"agent-board.gid=$G"')
      expect(run.skipIf.join('\n')).toContain('G=$(stat -c %g /var/lib/boardtunnel)')
      expect(run.skipIf.join('\n')).toContain(' true" ]')
      const helper = step(plan(empty('3a', distro)), 'run-socat')
      expect(text(helper)).toContain('--user "65534:$G"')
      // Look knew the gid: as before, the number itself
      const known = step(plan(done('bare', distro)), 'run-caddy')
      expect(text(known)).toContain(`--group-add ${GID}`)
      expect(text(known)).not.toContain('$G')
    })

    test('case 2 on an empty server: the folder the run makes goes to Caddy’s group, its own group recorded as before', () => {
      const s = step(plan(empty('2', distro)), 'folder-group')
      expect(s.record).toEqual([{ kind: 'group', path: '/var/lib/boardtunnel', from: 'boardtunnel', to: 'caddy' }])
      expect(s.undo.join('\n')).toContain('sudo chgrp boardtunnel /var/lib/boardtunnel')
    })

    test('Apply again after the board made step 1: nothing to change, its parts still on the record', () => {
      const f = done('bare', distro)
      const args = caddyRunArgs('1', W, GID, 'r0')
      const labels = Object.fromEntries(
        args
          .filter((_, i) => args[i - 1] === '--label')
          .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]),
      )
      const ours = {
        id: `ab${'cd'.repeat(31)}`,
        name: '/agent-board-caddy',
        image: 'caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af',
        cmd: [],
        hostNetwork: false,
        networks: [],
        mounts: [],
        ports: [],
        labels,
      }
      const holder = { kind: 'container' as const, id: ours.id, program: 'docker-proxy' }
      const r = recordFor('1', {
        items: [
          ...MADE,
          { kind: 'image', ref: ours.image, before: false },
          { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
          { kind: 'volume', name: 'agent-board-caddy-data' },
          { kind: 'volume', name: 'agent-board-caddy-config' },
          { kind: 'container', name: 'agent-board-caddy', setup: 'r0' },
        ],
      })
      const p = plan({
        ...f,
        ports: { ...f.ports, 80: holder, 443: holder },
        docker: { version: '29.0.1', podman: false, rootless: false, userns: false, containers: [ours] },
        record: r,
      })
      expect(p.kind).toBe('nothing')
      expect(ids(p).filter(id => STEP1.includes(id))).toEqual([])
      for (const item of MADE) expect(step(p, 'guard').record).toContainEqual(item)
    })
  })

  describe(`Undo of step 1 on ${distro}`, () => {
    test('what the board made goes, newest first, after the case’s parts: the keys file, the fence, the folder, the user', () => {
      const r = recordFor('1', { items: [...MADE, { kind: 'container', name: 'agent-board-caddy', setup: 'r0' }] })
      const p = undo(r, factsFor('bare', distro))
      // the board's key goes before the fence: an Undo cut short between them leaves no key that logs in unfenced
      expect(ids(p)).toEqual(['guard', 'drop-caddy', 'drop-keys', 'drop-fence', 'drop-folder', 'drop-user', 'forget'])
      const fence = step(p, 'drop-fence')
      expect(text(fence)).toContain(`sudo rm -f ${FENCE_FILE}`)
      expect(text(fence)).toContain('sudo sshd -t')
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
      expect(text(fence)).toContain('for u in root ${SUDO_USER:-}; do')
      expect(fence.commands.at(-2)).toBe(SSHD_RELOAD)
      expect(text(step(p, 'drop-keys'))).toContain(`sudo rm -f ${KEYS}`)
      expect(text(step(p, 'drop-keys'))).toContain('sudo rmdir /etc/ssh/authorized_keys 2>/dev/null || true')
      expect(text(step(p, 'drop-folder'))).toContain('sudo rmdir /var/lib/boardtunnel')
      const user = text(step(p, 'drop-user'))
      expect(user).toContain("= 'agent-board tunnel' ]")
      expect(user).toContain('sudo userdel boardtunnel')
    })

    test('step 1’s parts always last, in that order, whatever order a record of several runs has them in', () => {
      const r = recordFor('2', {
        items: [
          { kind: 'fence', path: FENCE_FILE },
          { kind: 'user', name: 'boardtunnel' },
          { kind: 'group', path: '/var/lib/boardtunnel', from: 'boardtunnel', to: 'caddy' },
          { kind: 'keys', path: KEYS, dir: false },
          { kind: 'folder', path: '/var/lib/boardtunnel' },
          {
            kind: 'line',
            file: '/etc/caddy/Caddyfile',
            line: 'import /etc/caddy/agent-board/board.caddy # agent-board',
          },
        ],
      })
      const got = ids(undo(r, factsFor('2', distro)))
      const at = (id: string): number => got.indexOf(id)
      expect(at('group-back')).toBeLessThan(at('drop-keys'))
      expect(at('reload')).toBeLessThan(at('drop-keys'))
      expect(got.slice(at('drop-keys'), at('drop-keys') + 4)).toEqual([
        'drop-keys',
        'drop-fence',
        'drop-folder',
        'drop-user',
      ])
    })

    test('what was there before the board stays: only that is left to the owner, by hand', () => {
      const all = undo(recordFor('1', { items: MADE }), factsFor('bare', distro))
      expect(ids(all)).not.toContain('by-hand')
      const some = undo(recordFor('1', { items: MADE.slice(3) }), factsFor('bare', distro))
      const hand = text(step(some, 'by-hand'))
      expect(hand).toContain('sudo userdel boardtunnel')
      expect(hand).toContain(`sudo rm -f ${KEYS}`)
      expect(hand).toContain('sudo rm -rf /var/lib/boardtunnel')
      expect(hand).not.toContain('Match User')
      expect(ids(some)).toContain('drop-fence')
      const none = undo(recordFor('1', { items: [] }), factsFor('bare', distro))
      expect(text(step(none, 'by-hand'))).toContain('Match User boardtunnel')
      expect(ids(none)).not.toContain('drop-user')
    })

    test('the fence at the end of sshd_config: the block out of the file as it is now, never a backup written back', () => {
      const p = undo(recordFor('1', { items: [{ kind: 'fence', path: SSHD_CONFIG }] }), factsFor('bare', distro))
      const s = step(p, 'drop-fence')
      expect(text(s)).toContain(`sudo cat ${SSHD_CONFIG} | B0='# >>> agent-board'`)
      expect(text(s)).toContain(movedOver('/etc/agent-board/backups/u1/sshd_config.new'))
      expect(s.undo.join('\n')).toContain(movedOver('/etc/agent-board/backups/u1/sshd_config'))
      expect(s.skipIf).toEqual([`! sudo grep -qx '# <<< agent-board' ${SSHD_CONFIG}`])
    })
  })
}

describe('the record names step 1’s parts only by the pair’s own names', () => {
  const good = recordFor('1', { items: MADE })
  test('read back', () => {
    expect(setupRecord(JSON.parse(JSON.stringify(good)))?.items).toEqual(MADE)
    expect(setupRecord({ ...good, items: [{ kind: 'fence', path: SSHD_CONFIG }] })?.items).toEqual([
      { kind: 'fence', path: SSHD_CONFIG },
    ])
  })
  test('refused: another user, folder, keys file or sshd file', () => {
    for (const item of [
      { kind: 'user', name: 'root' },
      { kind: 'folder', path: '/var/lib' },
      { kind: 'folder', path: '/' },
      { kind: 'keys', path: '/etc/ssh/authorized_keys/root', dir: false },
      { kind: 'keys', path: KEYS },
      { kind: 'fence', path: '/etc/ssh/sshd_config.d/50-cloud-init.conf' },
      { kind: 'fence', path: '/etc/passwd' },
    ])
      expect([item, setupRecord({ ...good, items: [item] })]).toEqual([item, null])
  })
})

describe('the board’s key is checked before anything is planned: it becomes a line of a keys file', () => {
  test('one line of an OpenSSH public key passes', () => {
    expect(wantedProblem(W)).toBeNull()
    expect(wantedProblem({ ...W, publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== ' })).not.toBeNull()
    expect(wantedProblem({ ...W, publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ==' })).toBeNull()
    expect(wantedProblem({ ...W, publicKey: 'ecdsa-sha2-nistp256 AAAAE2VjZHNh it’s Иван’s' })).toBeNull()
  })
  test('anything else is refused', () => {
    for (const publicKey of [
      '',
      `${KEY}\nssh-ed25519 AAAAother`,
      `command="sh" ${KEY}`,
      'ssh-ed25519',
      'ssh-dss AAAAB3NzaC1kc3M=',
      `${KEY}\r`,
    ]) {
      expect([publicKey, wantedProblem({ ...W, publicKey })]).toEqual([publicKey, expect.any(String)])
      expect(() => buildPlan(empty('bare'), { ...W, publicKey }, O)).toThrow()
    }
  })
})

test('every text of step 1’s steps is there in English and in Russian', () => {
  const en = translator('en')
  const ru = translator('ru')
  const keys = new Set<string>()
  const plans = [
    plan(empty('bare')),
    plan(empty('bare', 'debian13', { include: false })),
    undo(recordFor('1', { items: MADE }), factsFor('bare')),
    undo(recordFor('1', { items: [{ kind: 'fence', path: SSHD_CONFIG }] }), factsFor('bare')),
  ]
  for (const p of plans) for (const s of p.steps) keys.add(s.title.key).add(s.why.key)
  for (const kind of ['user', 'folder']) keys.add(`server.panel.touch.${kind}`)
  keys.add('server.err.publicKey')
  for (const k of keys) expect([k, en(k) !== k, ru(k) !== en(k)]).toEqual([k, true, true])
})

test('the fence the board writes is the Match block the tunnel spec has, for the panel’s user', () => {
  expect(fenceFile('tun2').split('\n').slice(1).join('\n')).toBe(sshdBlock('tun2'))
})
