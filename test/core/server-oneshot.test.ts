// The one command ("Do it myself"): what it carries, and that its awk reads Look, chooses and puts
// the run together as the board does. The awk runs on every Look fixture of both distributions and
// on changed copies of them (step 1's parts missing in each way Look can find them among them); its
// choice, its reasons, its warnings, the plan in plain words, its steps' titles and the run it
// makes are compared with what the board's own TypeScript makes of the same output (readRoundOne,
// readServerFacts, chooseCase, buildPlan, undoPlan, plainPlan, lookScript2, runScript), the run
// byte for byte.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { translator } from '../../src/core/i18n/translator.ts'
import { useLanguage as switchLanguage, t } from '../../src/core/lang.ts'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import { lookScript1, lookScript2, readRoundOne, readServerFacts } from '../../src/core/server-look.ts'
import { oneLine, oneshotAwk, oneshotDictionary, oneshotScripts } from '../../src/core/server-oneshot.ts'
import { launchTemplate, lookKey, lookShapes, lookTemplate } from '../../src/core/server-oneshot-templates.ts'
import { type PlainPlan, plainPlan } from '../../src/core/server-plain.ts'
import {
  buildPlan,
  chooseCase,
  type Plan,
  type RecordItem,
  type SetupRecord,
  setupRecord,
  undoPlan,
  type Wanted,
  whose,
} from '../../src/core/server-plan.ts'
import { launchScript, runScript } from '../../src/core/server-script.ts'
import { fill, type Value } from '../../src/core/server-template.ts'
import type { Translator } from '../../src/core/types.ts'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJvYXJkIGtleSBmb3IgdGVzdHM agent-board@pc'
const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
  publicKey: KEY,
}
const LOOK = { user: W.user, socket: W.socket, domain: W.domain }
const INPUT = { wanted: W, publicKey: KEY }
const IDS = { plan: '20261023-100400-3f9a', run: '20261023-100401-0b1c', at: '2026-10-23T10:04:01.000Z' }

const dir = mkdtempSync(join(tmpdir(), 'oneshot-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
/** What the board makes in a language. */
function inLanguage<T>(lang: 'en' | 'ru', make: () => T): T {
  const was = t.lang
  switchLanguage(lang)
  try {
    return make()
  } finally {
    switchLanguage(was)
  }
}
/** The awk program as the command carries it, in a language. */
function program(lang: 'en' | 'ru' = 'en'): string {
  const file = join(dir, `oneshot-${lang}.awk`)
  writeFileSync(
    file,
    inLanguage(lang, () => oneshotAwk(INPUT)),
  )
  return file
}
const PROGRAM = program()
const DICT = inLanguage('en', () => oneshotDictionary(INPUT))
/** mawk when there is one (Debian's and Ubuntu's awk), else this computer's. */
const AWK = Bun.which('mawk') ?? Bun.which('awk') ?? 'awk'

function awk(
  mode: string,
  input: string,
  env: Record<string, string> = {},
  file = PROGRAM,
): { out: string; code: number; err: string } {
  const r = Bun.spawnSync(
    [
      AWK,
      '-v',
      `mode=${mode}`,
      '-v',
      `PLAN_ID=${IDS.plan}`,
      '-v',
      `RUN_ID=${IDS.run}`,
      '-v',
      `RUN_AT=${IDS.at}`,
      '-f',
      file,
    ],
    {
      stdin: new TextEncoder().encode(input),
      env: { ...process.env, LC_ALL: 'C', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return { out: r.stdout.toString(), code: r.exitCode ?? -1, err: r.stderr.toString() }
}
/** What the apply and undo modes read: the step templates, then Look's two rounds. */
const looked = (r1: string, r2: string, dict = DICT): string => `${dict}\n@@ab-round1\n${r1}\n@@ab-round2\n${r2}`

/** The awk's value lines (v, e/w, l…@@ab-end-value) as values. */
function valuesOf(out: string): Record<string, Value> {
  const v: Record<string, Value> = {}
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (l.startsWith('v ')) {
      const rest = l.slice(2)
      const k = rest.indexOf(' ')
      if (k < 0) v[rest] = ''
      else v[rest.slice(0, k)] = rest.slice(k + 1)
    } else if (l.startsWith('e ')) v[l.slice(2)] = []
    else if (l.startsWith('w ')) {
      const rest = l.slice(2)
      const k = rest.indexOf(' ')
      ;(v[rest.slice(0, k)] as string[]).push(rest.slice(k + 1))
    } else if (l.startsWith('l ')) {
      const name = l.slice(2)
      const body: string[] = []
      for (i++; i < lines.length && lines[i] !== '@@ab-end-value'; i++) body.push(lines[i] ?? '')
      v[name] = body.join('\n')
    }
  }
  return v
}
/** What the awk says before its run, and the run. */
function parts(out: string): { said: string; run: string | null } {
  const at = out.indexOf('\n@@ab-run\n')
  return at < 0 ? { said: out, run: null } : { said: out.slice(0, at + 1), run: out.slice(at + '\n@@ab-run\n'.length) }
}
const said = (out: string, what: string): string[] =>
  parts(out)
    .said.split('\n')
    .filter(l => l.startsWith(`${what} `) || l === what)
    .map(l => l.slice(what.length + 1))
const decision = (out: string): string =>
  parts(out)
    .said.split('\n')
    .find(l =>
      /^(plan|stop|same|busy|unfinished|interrupted|unreadable|refuse|internal|nothing|unknown)( |$)/.test(l),
    ) ?? ''
/** The plan in plain words as the awk says it. */
function plainOf(out: string): PlainPlan {
  return {
    found: said(out, 'pfound')[0] ?? '',
    will: said(out, 'pwill'),
    docker: said(out, 'pdocker')[0] ?? null,
    untouched: said(out, 'puntouched')[0] ?? '',
    stop: said(out, 'pstop')[0] ?? null,
  }
}

const LOOK2 = new Map(lookShapes().map(s => [lookKey(s), lookTemplate(s, LOOK)]))
const LAUNCH = launchTemplate(W)
/** How the board's service packs a run for its launch (services/server-setup.ts). */
const PACK = (text: string): string => gzipSync(text).toString('base64')

/** Look's two rounds of a scenario: round one, and round two as the fixture has it (or none). */
interface Scenario {
  name: string
  r1: string
  r2: string
}

function fixtures(): Scenario[] {
  const root = 'test/fixtures/server-look'
  const out: Scenario[] = []
  for (const distro of ['debian13', 'ubuntu2604'])
    for (const name of readdirSync(join(root, distro))) {
      const at = join(root, distro, name)
      out.push({
        name: `${distro}/${name}`,
        r1: readFileSync(join(at, 'round1.txt'), 'utf8'),
        r2: existsSync(join(at, 'round2.txt')) ? readFileSync(join(at, 'round2.txt'), 'utf8') : '',
      })
    }
  for (const name of readdirSync(join(root, 'hand')))
    out.push({ name: `hand/${name}`, r1: readFileSync(join(root, 'hand', name), 'utf8'), r2: '' })
  return out
}

const byName = (name: string): Scenario => {
  const s = fixtures().find(x => x.name === name)
  if (!s) throw new Error(`no fixture ${name}`)
  return s
}

// ---------------------------------------------------------------------------------------------
// Changed copies of the fixtures, for the branches they do not reach by themselves

/** A record of this board's pair (or another), as a run writes it, in round one. */
function withRecord(s: Scenario, r: Partial<SetupRecord> & { items: RecordItem[] }, lock = 'free'): string {
  const record = {
    v: 1,
    id: '20261021-100400-aaaa',
    at: '2026-10-21T10:04:00.000Z',
    state: 'applied',
    case: '1',
    pair: { user: W.user, socket: W.socket },
    domain: W.domain,
    publicPort: null,
    address: `https://${W.domain}`,
    ...r,
  }
  return s.r1.replace('@@section record\n', `@@section record\n@@file\n${JSON.stringify(record)}\n\n@@lock ${lock}\n`)
}
const without = (text: string, line: RegExp): string =>
  text
    .split('\n')
    .filter(l => !line.test(l))
    .join('\n')
const CADDY_IMAGE_ITEM: Extract<RecordItem, { kind: 'image' }> = {
  kind: 'image',
  ref: 'caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af',
  before: false,
}
const OWN_ITEMS: RecordItem[] = [
  { kind: 'docker', packages: ['docker-ce', 'docker-ce-cli'], files: ['/etc/apt/sources.list.d/docker.list'] },
  CADDY_IMAGE_ITEM,
  { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
  { kind: 'volume', name: 'agent-board-caddy-data' },
  { kind: 'volume', name: 'agent-board-caddy-config' },
  { kind: 'container', name: 'agent-board-caddy', setup: '20261021-100400-aaaa' },
]
const UNIT_ITEMS: RecordItem[] = [
  { kind: 'file', path: '/etc/caddy/agent-board/board.caddy', sha256: 'cd'.repeat(32) },
  { kind: 'group', path: '/var/lib/boardtunnel', from: 'boardtunnel', to: 'caddy' },
  { kind: 'backup', of: '/etc/caddy/Caddyfile', path: '/etc/agent-board/backups/20261021-100400-aaaa/Caddyfile' },
  { kind: 'line', file: '/etc/caddy/Caddyfile', line: 'import /etc/caddy/agent-board/board.caddy # agent-board' },
]
const blockItems = (file: string): RecordItem[] => [
  {
    kind: 'image',
    ref: 'alpine/socat:1.8.1.3@sha256:22d77becaeeea8ef56b8c4bb2312323acafe85354be6a85714ff5050e3537842',
    before: false,
  },
  { kind: 'container', name: 'agent-board-socket', setup: '20261021-100400-aaaa' },
  { kind: 'backup', of: file, path: '/etc/agent-board/backups/20261021-100400-aaaa/Caddyfile' },
  { kind: 'block', file, begin: '# >>> agent-board', end: '# <<< agent-board' },
]

function mutations(): Scenario[] {
  const bare = byName('debian13/bare')
  const unit = byName('debian13/caddy-unit')
  const folder = byName('debian13/compose-folder')
  const file = byName('ubuntu2604/compose-file')
  const nginx = byName('debian13/nginx-80-443')
  const n443 = byName('ubuntu2604/nginx-443')
  const host = byName('debian13/caddy-host')
  const nodocker = byName('ubuntu2604/nodocker')
  const m = (name: string, s: Scenario, r1: string, r2 = s.r2): Scenario => ({ name: `${s.name} ${name}`, r1, r2 })
  const noCurl = (s: Scenario): string => without(s.r1, /^@@fetch curl$/)
  return [
    m('no curl', unit, noCurl(unit)),
    m('no curl', folder, noCurl(folder)),
    m('no curl', nginx, noCurl(nginx)),
    m(
      'no folder',
      bare,
      bare.r1.replace(/^@@dir .*$/m, "stat: cannot statx '/var/lib/boardtunnel': No such file or directory"),
    ),
    m('caddy as root', unit, unit.r1.replace(/^User=caddy$/m, 'User=root')),
    m(
      'folder group caddy',
      unit,
      unit.r1.replace(/^@@dir 2750 boardtunnel boardtunnel /m, '@@dir 2750 boardtunnel caddy '),
    ),
    m('members', bare, bare.r1.replace(/^@@group boardtunnel:x:(\d+):$/m, '@@group boardtunnel:x:$1:alice,bob')),
    // their names reach the steps as the board's own scripts have them: one shell word, quoted
    m('a unit group that needs quoting', unit, unit.r1.replace(/^Group=caddy$/m, 'Group=web;id')),
    m(
      'a unit user that needs quoting',
      unit,
      unit.r1.replace(/^User=caddy$/m, 'User=web user').replace(/^Group=caddy$/m, 'Group='),
    ),
    m(
      'a folder group that needs quoting',
      unit,
      unit.r1.replace(/^@@dir 2750 boardtunnel boardtunnel /m, '@@dir 2750 boardtunnel old;grp '),
    ),
    m('a network that needs quoting', folder, folder.r1.replaceAll('web_default', 'web;id')),
    m('domain served', unit, unit.r1, unit.r2.replace('"host":["a.example.com"]', '"host":["board.example.com"]')),
    m(
      'their sites on a v6 address',
      unit,
      unit.r1,
      unit.r2.replace(/^LISTEN 0 +4096 +\S+:443 /m, 'LISTEN 0      4096   [2001:db8::1]:443 '),
    ),
    m('selinux', bare, bare.r1.replace(/^@@selinux.*$/m, '@@selinux Enforcing')),
    m('debian 11', bare, bare.r1.replace('VERSION_ID="13"', 'VERSION_ID="11"')),
    m('no flock', bare, bare.r1.replace('@@section dns', '@@missing flock\n@@section dns')),
    m('docker conflicts', nodocker, nodocker.r1.replace('docker.io not-installed', 'docker.io installed')),
    m('forwarding', nodocker, nodocker.r1.replace(/^@@forward 0$/m, '@@forward 1')),
    m(
      'dns elsewhere',
      bare,
      bare.r1.replace(/^(\d+\.\d+\.\d+\.\d+)( +STREAM board\.example\.com)$/m, '198.51.100.9$2'),
    ),
    m('no dns', bare, without(bare.r1, /board\.example\.com$|^\S+ +(DGRAM|RAW) *$/)),
    // records
    m('set up already', bare, withRecord(bare, { items: OWN_ITEMS })),
    m(
      'set up for another domain',
      bare,
      withRecord(bare, { domain: 'old.example.com', address: 'https://old.example.com', items: OWN_ITEMS }),
    ),
    m(
      'another board',
      bare,
      withRecord(bare, { pair: { user: 'other', socket: '/var/lib/other/board.sock' }, items: OWN_ITEMS }),
    ),
    m('interrupted', bare, withRecord(bare, { state: 'running', items: OWN_ITEMS.slice(0, 3) })),
    m('busy', bare, withRecord(bare, { state: 'running', items: OWN_ITEMS.slice(0, 3) }, 'held')),
    m('rolled back, Docker kept', bare, withRecord(bare, { state: 'rolled-back', items: OWN_ITEMS.slice(0, 1) })),
    m(
      'rolled back, image there before',
      bare,
      withRecord(bare, {
        state: 'rolled-back',
        items: [OWN_ITEMS[0] as RecordItem, { ...CADDY_IMAGE_ITEM, before: true }],
      }),
    ),
    m('rollback failed', bare, withRecord(bare, { state: 'rollback-failed', items: OWN_ITEMS })),
    m('not a record', bare, bare.r1.replace('@@section record\n', '@@section record\n@@file\n{"v":2}\n\n')),
    m('set up already', unit, withRecord(unit, { case: '2', items: UNIT_ITEMS })),
    m(
      'set up for another domain',
      unit,
      withRecord(unit, { case: '2', domain: 'old.example.com', address: 'https://old.example.com', items: UNIT_ITEMS }),
    ),
    m(
      'record without its line',
      unit,
      withRecord(unit, { case: '2', state: 'running', items: UNIT_ITEMS.slice(0, 3) }),
    ),
    m(
      'set up for another domain',
      folder,
      withRecord(folder, {
        case: '3a',
        domain: 'old.example.com',
        address: 'https://old.example.com',
        items: blockItems('/srv/my web/Caddyfile'),
      }),
    ),
    // an update: their proxy serves the old domain (the board's site) until the reload moves it
    m(
      'serving the old domain, set up for it',
      unit,
      withRecord(unit, { case: '2', domain: 'old.example.com', address: 'https://old.example.com', items: UNIT_ITEMS }),
      unit.r2.replace('"host":["b.example.com"]', '"host":["b.example.com","old.example.com"]'),
    ),
    m(
      'serving the old domain, set up for it',
      folder,
      withRecord(folder, {
        case: '3a',
        domain: 'old.example.com',
        address: 'https://old.example.com',
        items: blockItems('/srv/my web/Caddyfile'),
      }),
      folder.r2.replace('"host":["b.example.com"]', '"host":["b.example.com","old.example.com"]'),
    ),
    m(
      'serving the old domain, set up for it',
      nginx,
      withRecord(nginx, {
        case: '4b',
        domain: 'old.example.com',
        publicPort: 8443,
        address: 'https://old.example.com:8443',
        items: [
          ...OWN_ITEMS.slice(1),
          { kind: 'file', path: '/etc/nginx/conf.d/agent-board.conf', sha256: 'ef'.repeat(32) },
        ],
      }),
      nginx.r2.replace(
        'server_name site.example.com;',
        'server_name site.example.com;\n    server_name old.example.com;',
      ),
    ),
    m('set up already', folder, withRecord(folder, { case: '3a', items: blockItems('/srv/my web/Caddyfile') })),
    m('set up already', file, withRecord(file, { case: '3a', items: blockItems('/srv/web/Caddyfile') })),
    m('set up already', host, withRecord(host, { case: '3b', items: blockItems('/srv/caddy/Caddyfile') })),
    m(
      'set up already',
      nginx,
      withRecord(nginx, {
        case: '4b',
        publicPort: 8443,
        address: `https://${W.domain}:8443`,
        items: [
          ...OWN_ITEMS.slice(1),
          { kind: 'file', path: '/etc/nginx/conf.d/agent-board.conf', sha256: 'ef'.repeat(32) },
        ],
      }),
    ),
    m(
      'set up already',
      n443,
      withRecord(n443, { case: '4a', publicPort: 8443, address: `https://${W.domain}:8443`, items: OWN_ITEMS }),
    ),
  ]
}

// ---------------------------------------------------------------------------------------------
// Step 1 as Look reads it (core/server-look.ts stepOneLines): each way its parts can be missing

const STEP_ONE_IDS = ['tunnel-user', 'socket-folder', 'keys-file', 'sshd-fence']
/** A tunnel user made by hand as the old step 1 made it: a system user with no shell to log in with. */
const NOLOGIN = '@@user-shell /usr/sbin/nologin'
const DONE = ['@@user 995 boardtunnel', NOLOGIN, '@@keys same', '@@keys-dir', '@@include']

/**
 * Round one with Look's step-1 lines at the end of the fence section; sshd's settings for the
 * tunnel user as the fixture has them (the fence in force), changed, or none; the socket's folder
 * there or not.
 */
function stepOne(r1: string, lines: string[], o: { fence?: 'none' | 'loose'; folder?: false } = {}): string {
  const start = r1.indexOf('@@section fence\n') + '@@section fence\n'.length
  const end = r1.indexOf('@@section folder\n')
  let fence = r1.slice(start, end).split('\n').filter(Boolean)
  if (o.fence === 'none') fence = []
  if (o.fence === 'loose') fence = fence.map(l => (l === 'permittty no' ? 'permittty yes' : l))
  let rest = r1.slice(end)
  if (o.folder === false)
    rest = rest
      .replace(/^@@dir .*$/m, "stat: cannot statx '/var/lib/boardtunnel': No such file or directory")
      .replace(/^@@group .*\n/m, '')
      .replace(/^@@socket .*\n/m, '')
  return `${r1.slice(0, start)}${[...fence, ...lines].join('\n')}\n${rest}`
}

const STEP_ONE_VARIANTS: { name: string; r1: (r1: string) => string }[] = [
  { name: 'step 1 done', r1: r1 => stepOne(r1, DONE) },
  {
    name: 'step 1 not done',
    r1: r1 => stepOne(r1, ['@@user none', '@@keys none', '@@include'], { fence: 'none', folder: false }),
  },
  {
    name: 'step 1 not done, sshd_config without Include, no keys folder',
    r1: r1 => stepOne(r1, ['@@user none', '@@keys none'], { fence: 'none', folder: false }),
  },
  {
    name: 'step 1 not done, the keys folder there',
    r1: r1 => stepOne(r1, ['@@user none', '@@keys none', '@@keys-dir', '@@include'], { fence: 'none', folder: false }),
  },
  {
    name: 'an older key',
    r1: r1 => stepOne(r1, ['@@user 995 boardtunnel', NOLOGIN, '@@keys other', '@@keys-dir', '@@include']),
  },
  { name: 'no tunnel user', r1: r1 => stepOne(r1, ['@@user none', '@@keys same', '@@keys-dir', '@@include']) },
  { name: 'no socket folder', r1: r1 => stepOne(r1, DONE, { folder: false }) },
  { name: 'the fence loosened', r1: r1 => stepOne(r1, DONE, { fence: 'loose' }) },
  // a tunnel user that is a login people use, not the board's: refused (core/server-plan.ts ownersLogin)
  {
    name: 'the tunnel user a person’s login',
    r1: r1 =>
      stepOne(r1, ['@@user 1000 migo', '@@user-shell /bin/bash', '@@keys none', '@@keys-dir', '@@include'], {
        fence: 'none',
      }),
  },
  {
    name: 'the tunnel user root, the admin',
    r1: r1 =>
      stepOne(r1, ['@@user 0 root', '@@user-shell /bin/bash', '@@user-admin', '@@keys none', '@@include'], {
        fence: 'none',
      }),
  },
  {
    name: 'the tunnel user the admin’s own',
    r1: r1 =>
      stepOne(r1, ['@@user 995 boardtunnel', NOLOGIN, '@@user-admin', '@@keys same', '@@keys-dir', '@@include']),
  },
  {
    name: 'the tunnel user with a shell',
    r1: r1 => stepOne(r1, ['@@user 995 boardtunnel', '@@user-shell /bin/sh', '@@keys same', '@@keys-dir', '@@include']),
  },
  {
    name: 'the tunnel user with passwd’s empty shell',
    r1: r1 => stepOne(r1, ['@@user 995 boardtunnel', '@@user-shell ', '@@keys none', '@@include'], { fence: 'none' }),
  },
  {
    name: 'the board’s own tunnel user, with a shell',
    r1: r1 =>
      stepOne(r1, [
        '@@user 1001 boardtunnel',
        '@@user-shell /bin/bash',
        '@@user-ours',
        '@@keys same',
        '@@keys-dir',
        '@@include',
      ]),
  },
  {
    name: 'no tunnel user, a group of its name left',
    r1: r1 =>
      stepOne(r1, ['@@user none', '@@user-group', '@@keys none', '@@include'], { fence: 'none', folder: false }),
  },
  {
    name: 'no socket folder, a tunnel user of another group',
    r1: r1 => stepOne(r1, ['@@user 995 tunnels', NOLOGIN, '@@keys same', '@@keys-dir', '@@include'], { folder: false }),
  },
]

const STEP_ONE_ITEMS: RecordItem[] = [
  { kind: 'user', name: 'boardtunnel' },
  { kind: 'folder', path: '/var/lib/boardtunnel' },
  { kind: 'keys', path: '/etc/ssh/authorized_keys/boardtunnel', dir: true },
  { kind: 'fence', path: '/etc/ssh/sshd_config.d/00-agent-board.conf' },
]
const STEP_ONE_BLOCK: RecordItem[] = [
  { kind: 'user', name: 'boardtunnel' },
  { kind: 'folder', path: '/var/lib/boardtunnel' },
  { kind: 'keys', path: '/etc/ssh/authorized_keys/boardtunnel', dir: false },
  { kind: 'fence', path: '/etc/ssh/sshd_config' },
]

function stepOneScenarios(): Scenario[] {
  const out: Scenario[] = []
  const all = ['bare', 'nodocker', 'caddy-unit', 'compose-folder', 'compose-file', 'caddy-host', 'nginx-80-443']
  for (const name of [...all, 'nginx-443', 'dummy80', 'apache', 'caddy-bridge'])
    for (const v of STEP_ONE_VARIANTS) {
      const s = byName(`debian13/${name}`)
      out.push({ name: `${s.name} ${v.name}`, r1: v.r1(s.r1), r2: s.r2 })
    }
  for (const name of all) {
    const s = byName(`ubuntu2604/${name}`)
    for (const v of STEP_ONE_VARIANTS.slice(1, 3)) out.push({ name: `${s.name} ${v.name}`, r1: v.r1(s.r1), r2: s.r2 })
  }
  // set up with step 1 made by the board: again, Undo, an update, a part of step 1 gone since
  const bare = byName('debian13/bare')
  const unit = byName('debian13/caddy-unit')
  const folder = byName('debian13/compose-folder')
  const nginx = byName('debian13/nginx-80-443')
  const m = (name: string, s: Scenario, r1: string, r2 = s.r2): Scenario => ({ name: `${s.name} ${name}`, r1, r2 })
  const done = (s: Scenario): Scenario => ({ ...s, r1: stepOne(s.r1, DONE) })
  const old = { domain: 'old.example.com', address: 'https://old.example.com' }
  out.push(
    m('set up with step 1', bare, withRecord(done(bare), { items: [...STEP_ONE_ITEMS, ...OWN_ITEMS] })),
    m('set up with step 1 in sshd_config', bare, withRecord(done(bare), { items: [...STEP_ONE_BLOCK, ...OWN_ITEMS] })),
    m(
      'set up with step 1 but the keys file (an older key written over)',
      bare,
      withRecord(done(bare), {
        items: [STEP_ONE_ITEMS[0], STEP_ONE_ITEMS[1], STEP_ONE_ITEMS[3], ...OWN_ITEMS] as RecordItem[],
      }),
    ),
    m(
      'set up with step 1, the tunnel user gone since',
      bare,
      withRecord(
        { ...bare, r1: stepOne(bare.r1, ['@@user none', '@@keys same', '@@keys-dir', '@@include']) },
        { items: [...STEP_ONE_ITEMS, ...OWN_ITEMS] },
      ),
    ),
    m(
      'set up with the folder and the keys file of step 1 alone (the user and the fence by hand)',
      bare,
      withRecord(done(bare), { items: [STEP_ONE_ITEMS[1], STEP_ONE_ITEMS[2], ...OWN_ITEMS] as RecordItem[] }),
    ),
    m(
      'set up with step 1 for another domain',
      bare,
      withRecord(done(bare), { ...old, items: [...STEP_ONE_ITEMS, ...OWN_ITEMS] }),
    ),
    // Apply refuses a tunnel user that became a login people use; Undo still removes the setup
    m(
      'set up with step 1, the tunnel user a person’s login since',
      bare,
      withRecord(
        {
          ...bare,
          r1: stepOne(bare.r1, [
            '@@user 1000 boardtunnel',
            '@@user-shell /bin/bash',
            '@@keys same',
            '@@keys-dir',
            '@@include',
          ]),
        },
        { items: [...STEP_ONE_ITEMS, ...OWN_ITEMS] },
      ),
    ),
    m(
      'set up with step 1, cut short making it',
      bare,
      withRecord(done(bare), { state: 'running', items: STEP_ONE_ITEMS.slice(0, 2) }),
    ),
    m(
      'set up with step 1, rolled back',
      bare,
      withRecord(
        {
          ...bare,
          r1: stepOne(bare.r1, ['@@user none', '@@keys none', '@@include'], { fence: 'none', folder: false }),
        },
        { state: 'rolled-back', items: [] },
      ),
    ),
    m('set up with step 1', unit, withRecord(done(unit), { case: '2', items: [...STEP_ONE_ITEMS, ...UNIT_ITEMS] })),
    m(
      'set up with step 1 for another domain',
      unit,
      withRecord(done(unit), { case: '2', ...old, items: [...STEP_ONE_ITEMS, ...UNIT_ITEMS] }),
      unit.r2.replace('"host":["b.example.com"]', '"host":["b.example.com","old.example.com"]'),
    ),
    m(
      'set up with step 1',
      folder,
      withRecord(done(folder), { case: '3a', items: [...STEP_ONE_BLOCK, ...blockItems('/srv/my web/Caddyfile')] }),
    ),
    m(
      'set up with step 1',
      nginx,
      withRecord(done(nginx), {
        case: '4b',
        publicPort: 8443,
        address: `https://${W.domain}:8443`,
        items: [
          ...STEP_ONE_ITEMS,
          ...OWN_ITEMS.slice(1),
          { kind: 'file', path: '/etc/nginx/conf.d/agent-board.conf', sha256: 'ef'.repeat(32) },
        ],
      }),
    ),
  )
  return out
}

const SCENARIOS = [...fixtures(), ...mutations(), ...stepOneScenarios()]

// ---------------------------------------------------------------------------------------------

describe('round two: the board’s own script, for what round one found', () => {
  for (const s of SCENARIOS) {
    test(s.name, () => {
      const r1 = readRoundOne(s.r1)
      const a = awk('r2', s.r1)
      const first = a.out.split('\n')[0] ?? ''
      if (!r1) return expect(first).toBe('unreadable')
      const want = lookScript2(r1, LOOK)
      if (want === null) return expect(first).toBe('r2 none')
      expect(first.startsWith('r2 ')).toBe(true)
      const template = LOOK2.get(first.slice(3))
      expect(template).toBeDefined()
      expect(fill(template ?? '', valuesOf(a.out))).toBe(want)
    })
  }
})

/** The record of this board's pair when the facts have one, as buildPlan carries it. */
function mine(f: ServerFacts): SetupRecord | null {
  const r = f.record === null || f.record === undefined ? null : setupRecord(f.record)
  return r && whose(r, W) !== 'other' ? r : null
}

/** What the board's run says of each step, in a language. */
const titles = (p: Plan, tr: Translator = t): string[] => p.steps.map(x => tr(x.title.key, x.title.params))

describe('Apply: the case, the reasons, the plan in plain words and the run the board would make', () => {
  for (const s of SCENARIOS) {
    test(s.name, () => {
      const r1 = readRoundOne(s.r1)
      const r2 = r1 && lookScript2(r1, LOOK) !== null ? s.r2 : ''
      const facts = r1 ? readServerFacts(r1, r2) : null
      const a = awk('apply', looked(s.r1, r2))
      expect(a.err).toBe('')
      const d = decision(a.out)
      if (!facts) return expect(d).toBe('unreadable')
      const p = buildPlan(facts, W, { id: IDS.plan, docker: true })
      if (!('steps' in p)) {
        expect(d).toBe(`stop ${p.why.join(' ')}`)
        expect(said(a.out, 'why')).toEqual(p.why.map(w => t(`server.manual.${w}`)))
        expect(plainOf(a.out)).toEqual(plainPlan(facts, p, W, t))
        return
      }
      const choice = chooseCase(facts, W)
      if (choice.case === null) return expect(d).toBe('interrupted')
      const record = mine(facts)
      const who = record ? whose(record, W) : null
      const holds =
        record &&
        (record.state !== 'rolled-back' ||
          record.items.some(i => i.kind !== 'docker' && !(i.kind === 'image' && i.before)))
      if (holds && (who === 'same' || who === 'update')) {
        if (record.state === 'running' && facts.lockHeld) return expect(d).toBe('busy')
        if (record.state !== 'applied') return expect(d).toBe(`unfinished ${record.state}`)
        // set up already: said so, unless step 1 lacks a part, which the plan makes again
        if (who === 'same' && !p.steps.some(x => STEP_ONE_IDS.includes(x.id)))
          return expect(d).toBe(`same ${record.address}`)
      }
      expect(d.startsWith('plan ')).toBe(true)
      const run = parts(a.out).run ?? ''
      expect(run).toBe(runScript(p, W, { id: IDS.run, at: IDS.at }))
      expect(said(a.out, 'title')).toEqual(titles(p))
      expect(said(a.out, 'warn')).toEqual(p.warnings.map(w => t(w.key, w.params)))
      expect(said(a.out, 'address')).toEqual([p.address])
      expect(plainOf(a.out)).toEqual(plainPlan(facts, p, W, t))
      // and the launch of the packed run, as the board's
      expect(fill(LAUNCH, { run_id: IDS.run, packed: PACK(run) })).toBe(launchScript(IDS.run, run, PACK))
    })
  }
})

/** The Undo command on a scenario: the run, the titles and the plain words of the board's Undo. */
function sameUndo(s: Scenario) {
  const r1 = readRoundOne(s.r1)
  if (!r1) return
  const r2 = lookScript2(r1, LOOK) === null ? '' : s.r2
  const facts = readServerFacts(r1, r2)
  if (!facts) return
  const a = awk('undo', looked(s.r1, r2))
  expect(a.err).toBe('')
  const d = decision(a.out)
  if (facts.record === null || facts.record === undefined) return expect(d).toBe('nothing')
  const r = setupRecord(facts.record)
  if (!r || whose(r, W) === 'other') return expect(d).toBe('stop otherSetup')
  if (r.state === 'running' && facts.lockHeld) return expect(d).toBe('busy')
  expect(d.startsWith('plan ')).toBe(true)
  const p = undoPlan(r, facts, { id: IDS.plan, removeDocker: false, removeEdited: false })
  expect(parts(a.out).run).toBe(runScript(p, W, { id: IDS.run, at: IDS.at }))
  expect(said(a.out, 'title')).toEqual(titles(p))
  expect(plainOf(a.out)).toEqual(plainPlan(facts, p, W, t))
}

describe('Undo: the run the board’s Undo would make, and what it says', () => {
  for (const s of SCENARIOS) test(s.name, () => sameUndo(s))
})

// ---------------------------------------------------------------------------------------------
// Records no whole run leaves, which the board's Undo plans all the same

const NGINX_FILE_ITEM: RecordItem = {
  kind: 'file',
  path: '/etc/nginx/conf.d/agent-board.conf',
  sha256: 'ef'.repeat(32),
}
/** An image an older board pulled (another release of Caddy): the board's own to remove. */
const OLDER_IMAGE: Extract<RecordItem, { kind: 'image' }> = { kind: 'image', ref: 'caddy:2.10.2', before: false }

/** Each subset of the items, by the bits of its number. */
const subsets = (items: readonly RecordItem[]): RecordItem[][] =>
  Array.from({ length: 1 << items.length }, (_, mask) => items.filter((_x, i) => mask & (1 << i)))

function leftRecords(): Scenario[] {
  const bare = byName('debian13/bare')
  const unit = byName('debian13/caddy-unit')
  const folder = byName('debian13/compose-folder')
  const host = byName('debian13/caddy-host')
  const nginx = byName('debian13/nginx-80-443')
  const out: Scenario[] = []
  const add = (name: string, s: Scenario, r: Partial<SetupRecord> & { items: RecordItem[] }): void => {
    out.push({ name: `${s.name} ${name}`, r1: withRecord(s, r), r2: s.r2 })
  }
  const four = { case: '4b', publicPort: 8443, address: `https://${W.domain}:8443` } as const
  const sets: [Scenario, Partial<SetupRecord>, RecordItem[]][] = [
    [bare, {}, OWN_ITEMS],
    [unit, { case: '2' }, UNIT_ITEMS],
    [folder, { case: '3a' }, blockItems('/srv/my web/Caddyfile')],
    [host, { case: '3b' }, blockItems('/srv/caddy/Caddyfile')],
    [nginx, four, [...OWN_ITEMS.slice(1), NGINX_FILE_ITEM]],
  ]
  for (const [s, head, items] of sets) {
    // a rollback that did not finish: any of its run's items left
    subsets(items).forEach((left, k) => {
      add(`rollback failed, items ${k}`, s, { ...head, state: 'rollback-failed', items: left })
    })
    // an update cut short after each of its steps: the old items, then the new ones made again so far
    for (let k = 1; k <= items.length; k++) {
      add(`update cut short after ${k}`, s, { ...head, state: 'running', items: [...items, ...items.slice(0, k)] })
      add(`update rolled back half after ${k}`, s, {
        ...head,
        state: 'rollback-failed',
        items: [...items, ...items.slice(0, k).reverse()],
      })
    }
    // runs of several boards, in another order
    add('items in another order', s, { ...head, items: [...items].reverse() })
  }
  // step 1's parts among them, and images an older board pulled
  add('rollback failed, step 1 and two pulled images', bare, {
    state: 'rollback-failed',
    items: [STEP_ONE_ITEMS[2] as RecordItem, OLDER_IMAGE, ...OWN_ITEMS.slice(1, 3), STEP_ONE_ITEMS[3] as RecordItem],
  })
  add('an older board’s image there before, then pulled', bare, {
    items: [{ ...OLDER_IMAGE, before: true }, ...OWN_ITEMS, OLDER_IMAGE],
  })
  add('the socket helper’s image, then Caddy’s', folder, {
    case: '3a',
    state: 'rollback-failed',
    items: [blockItems('/srv/my web/Caddyfile')[0] as RecordItem, CADDY_IMAGE_ITEM, OLDER_IMAGE],
  })
  // a line in another Caddyfile than the one Look finds now, and one in theirs
  add('lines in two Caddyfiles', unit, {
    case: '2',
    state: 'rollback-failed',
    items: [
      ...UNIT_ITEMS,
      { kind: 'line', file: '/srv/old/Caddyfile', line: 'import /etc/caddy/agent-board/board.caddy # agent-board' },
    ],
  })
  add('a block and a line', folder, {
    case: '3a',
    items: [...UNIT_ITEMS.slice(0, 1), ...blockItems('/srv/my web/Caddyfile'), ...UNIT_ITEMS.slice(3)],
  })
  return out
}

describe('Undo of a record no whole run leaves (a rollback that did not finish, an update cut short)', () => {
  for (const s of leftRecords()) test(s.name, () => sameUndo(s))
})

describe('the plan in plain words, in the board’s language', () => {
  test('Russian, as the panel says it', () => {
    const ru = program('ru')
    const dict = inLanguage('ru', () => oneshotDictionary(INPUT))
    const tr = translator('ru')
    for (const name of [
      'debian13/bare step 1 not done',
      'debian13/caddy-unit step 1 done',
      'debian13/compose-folder an older key',
      'debian13/nginx-80-443 step 1 not done',
      'debian13/nginx-443 no tunnel user',
      'debian13/apache step 1 done',
      'debian13/bare set up with step 1 for another domain',
      'debian13/bare the tunnel user a person’s login',
      'debian13/caddy-unit the tunnel user with a shell',
    ]) {
      const s = SCENARIOS.find(x => x.name === name)
      if (!s) throw new Error(`no scenario ${name}`)
      const r1 = readRoundOne(s.r1) as NonNullable<ReturnType<typeof readRoundOne>>
      const r2 = lookScript2(r1, LOOK) === null ? '' : s.r2
      const facts = readServerFacts(r1, r2) as ServerFacts
      const p = buildPlan(facts, W, { id: IDS.plan, docker: true })
      const a = awk('apply', looked(s.r1, r2, dict), {}, ru)
      expect([name, plainOf(a.out)]).toEqual([name, plainPlan(facts, p, W, tr)])
      if ('steps' in p) expect(said(a.out, 'title')).toEqual(titles(p, tr))
    }
  })
})

describe('a tunnel user that is a login people use', () => {
  test('stops before any change, as the board; the board’s own user, or one with no shell, goes on', () => {
    const decided = (name: string): string => {
      const s = SCENARIOS.find(x => x.name === name)
      if (!s) throw new Error(`no scenario ${name}`)
      return decision(awk('apply', looked(s.r1, s.r2)).out)
    }
    for (const v of [
      'the tunnel user a person’s login',
      'the tunnel user root, the admin',
      'the tunnel user the admin’s own',
      'the tunnel user with a shell',
      'the tunnel user with passwd’s empty shell',
    ])
      expect([v, decided(`debian13/bare ${v}`)]).toEqual([v, 'stop tunnelUser'])
    expect(decided('debian13/bare no tunnel user, a group of its name left')).toBe('stop tunnelGroup')
    expect(decided('debian13/apache the tunnel user with a shell').split(' ')).toContain('tunnelUser')
    for (const v of ['the board’s own tunnel user, with a shell', 'step 1 done', 'an older key'])
      expect([v, decided(`debian13/bare ${v}`).startsWith('plan ')]).toEqual([v, true])
    expect(decided('debian13/bare set up with step 1, the tunnel user a person’s login since')).toBe('stop tunnelUser')
  })
})

describe('a case-4 command made before Test connection found the board’s port', () => {
  test('pasted again after its setup: set up already at 8443, as the board says, not a move there', () => {
    expect(W.publicPort).toBeNull()
    for (const name of ['ubuntu2604/nginx-443 set up already', 'debian13/nginx-80-443 set up already']) {
      const s = SCENARIOS.find(x => x.name === name)
      if (!s) throw new Error(`no scenario ${name}`)
      const facts = readServerFacts(readRoundOne(s.r1) as NonNullable<ReturnType<typeof readRoundOne>>, s.r2)
      const r = setupRecord(facts?.record) as SetupRecord
      expect([name, whose(r, W)]).toEqual([name, 'same'])
      expect([name, decision(awk('apply', looked(s.r1, s.r2)).out)]).toEqual([name, `same https://${W.domain}:8443`])
    }
  })
})

describe('without the board’s key', () => {
  test('no step 1, as the board: a server without the socket’s folder is the owner’s', () => {
    const { publicKey: _, ...noKey } = W
    const input = { wanted: noKey, publicKey: null }
    const file = join(dir, 'nokey.awk')
    writeFileSync(file, oneshotAwk(input))
    const dict = oneshotDictionary(input)
    const variant = STEP_ONE_VARIANTS[1] as (typeof STEP_ONE_VARIANTS)[number]
    const s = byName('debian13/bare')
    const r1 = variant.r1(s.r1)
    const facts = readServerFacts(readRoundOne(r1) as NonNullable<ReturnType<typeof readRoundOne>>, '') as ServerFacts
    expect(buildPlan(facts, noKey, { id: IDS.plan, docker: true })).toEqual({ case: null, why: ['folder'] })
    const a = awk('apply', `${dict}\n@@ab-round1\n${r1}\n@@ab-round2\n`, {}, file)
    expect(decision(a.out)).toBe('stop folder')
    // and with step 1 done by hand, the case's own steps, as before
    const done = stepOne(s.r1, ['@@user 995 boardtunnel', NOLOGIN, '@@keys other', '@@keys-dir', '@@include'])
    const f2 = readServerFacts(readRoundOne(done) as NonNullable<ReturnType<typeof readRoundOne>>, '') as ServerFacts
    const p = buildPlan(f2, noKey, { id: IDS.plan, docker: true }) as Plan
    const b = awk('apply', `${dict}\n@@ab-round1\n${done}\n@@ab-round2\n`, {}, file)
    expect(parts(b.out).run).toBe(runScript(p, noKey, { id: IDS.run, at: IDS.at }))
  })
})

describe('the command', () => {
  const scripts = oneshotScripts(INPUT)
  const gzip = (b: Uint8Array): Uint8Array => gzipSync(b, { level: 9 })

  /** Both scripts, in each of the board's languages. */
  const both = (['en', 'ru'] as const).flatMap(lang => {
    const s = inLanguage(lang, () => oneshotScripts(INPUT))
    return [
      { name: `${lang} apply`, script: s.script },
      { name: `${lang} undo`, script: s.undoScript },
    ]
  })

  test('one line, base64 behind a fixed pipe, that decodes to the script, in each language', () => {
    for (const { name, script } of both) {
      const line = oneLine(script, gzip)
      expect(line).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| gunzip \| sh$/)
      const b64 = line.split(' ')[1] ?? ''
      expect(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')).toBe(script)
      // tens of KB paste into a terminal; hundreds do not
      expect([name, line.length < 80_000]).toEqual([name, true])
    }
  })

  test('it carries what the board knows', () => {
    for (const script of [scripts.script, scripts.undoScript]) {
      expect(script).toContain(`W_DOMAIN = "${W.domain}"`)
      expect(script).toContain(`W_USER = "${W.user}"`)
      expect(script).toContain(`W_SOCKET = "${W.socket}"`)
      expect(script).toContain(`W_KEY = "${KEY}"`)
      expect(script).toContain("# The board's address: https://board.example.com")
      // Look compares the tunnel user's keys file with the board's key line
      expect(script).toContain(`restrict,port-forwarding ${KEY}`)
    }
  })

  test('POSIX sh; the awk program in a file of its own, gone when the script ends; no argument near Linux’s 128 KiB', () => {
    const SH = Bun.which('dash') ?? Bun.which('sh')
    const bytes = (text: string): number => new TextEncoder().encode(text).length
    for (const { name, script } of both) {
      if (SH) {
        const r = Bun.spawnSync([SH, '-n'], { stdin: new TextEncoder().encode(script), stderr: 'pipe' })
        expect([name, r.stderr.toString(), r.exitCode]).toEqual([name, '', 0])
      }
      // the program (100 KB and more, past one argument of a command line) is awk's -f
      expect(script).toContain(`AWKF=$(mktemp "\${TMPDIR:-/tmp}/agent-board.XXXXXXXX")`)
      expect(script).toContain(`trap 'rm -f "$AWKF"' EXIT`)
      expect(script).toContain(`cat > "$AWKF" <<'AGENT_BOARD_AWK'`)
      expect(script).not.toContain('"$AWKP"')
      for (const l of script.split('\n').filter(x => /(^|[ (|])awk -v mode=/.test(x)))
        expect([name, l]).toEqual([name, expect.stringContaining('-f "$AWKF"')])
    }
    // what does go as one argument (sh -c): Look's rounds, the launch (whose run is packed)
    for (const lang of ['en', 'ru'] as const) {
      const program = inLanguage(lang, () => oneshotAwk(INPUT))
      expect(bytes(program)).toBeGreaterThan(64_000)
      expect(bytes(lookScript1({ ...LOOK, publicKey: KEY }))).toBeLessThan(64_000)
      for (const s of lookShapes()) expect(bytes(lookTemplate(s, LOOK))).toBeLessThan(64_000)
      expect(bytes(LAUNCH)).toBeLessThan(16_000)
    }
  })
})

describe('the run’s progress, as the owner reads it', () => {
  test('each step as it ends; a failed one with its output; the result as the exit status', () => {
    const titles = 'Check\nPull\nWrite'
    const run = [
      '@@step 1 start',
      '@@step 1 ok',
      '@@step 2 start',
      '@@step 2 skip',
      '@@step 3 start',
      'cp: cannot create',
      '@@step 3 fail',
      '@@undo 3 ok',
      '@@result rolled-back',
      '@@exit 1',
    ].join('\n')
    const a = awk('progress', run, { AB_TITLES: titles })
    expect(a.code).toBe(1)
    expect(a.out.split('\n').filter(Boolean)).toEqual([
      '  [ok] Check',
      `  [--] Pull (${t('server.oneshot.inPlace')})`,
      '  [!!] Write',
      '       cp: cannot create',
      `  ${t('server.oneshot.undid')}: Write`,
    ])
    expect(awk('progress', '@@step 1 start\n@@step 1 ok\n@@result applied\n@@exit 0', { AB_TITLES: titles }).code).toBe(
      0,
    )
    expect(awk('progress', '@@busy\n@@exit 75', { AB_TITLES: titles }).code).toBe(3)
    expect(awk('progress', '', { AB_TITLES: titles }).code).toBe(5)
  })

  test('Undo’s by-hand step said to stay, not “in place already”', () => {
    const titles = `Check\n${t('server.step.by-hand.title')}`
    const a = awk('progress', '@@step 1 start\n@@step 1 ok\n@@step 2 start\n@@step 2 skip\n@@result applied', {
      AB_TITLES: titles,
    })
    expect(a.out.split('\n')[1]).toBe(`  [--] ${t('server.step.by-hand.title')} (${t('server.oneshot.byHand')})`)
  })
})

describe('where the command stops where the board would go on', () => {
  test('a path with a quote (or a backslash, $ or a backquote) is refused before anything changes', () => {
    const s = byName('debian13/compose-folder')
    const r1 = s.r1.replace('"Source":"/srv/my web"', `"Source":"/srv/it's web"`)
    const facts = readServerFacts(readRoundOne(r1) as never, s.r2)
    // the board quotes it and goes on
    expect('steps' in buildPlan(facts as ServerFacts, W, { id: IDS.plan, docker: true })).toBe(true)
    const a = awk('apply', looked(r1, s.r2))
    expect(decision(a.out)).toBe('refuse file candidate')
    expect(parts(a.out).run).toBeNull()
  })

  test('more images the board pulled than the command takes off in one step: it has no plan, and changes nothing', () => {
    const s = byName('debian13/bare')
    const images: RecordItem[] = Array.from({ length: 7 }, (_, k) => ({
      kind: 'image',
      ref: `caddy:2.${k}.0`,
      before: false,
    }))
    const r1 = withRecord(s, { state: 'rollback-failed', items: images })
    const a = awk('undo', looked(r1, ''))
    // the script says so (server.oneshot.undo.unknown) and changes nothing
    expect(decision(a.out)).toBe('unknown u.I.7')
    expect(parts(a.out).run).toBeNull()
  })
})
