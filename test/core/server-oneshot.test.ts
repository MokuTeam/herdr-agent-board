// The one command ("Do it myself"): what it carries, and that its awk reads Look and chooses as the
// board does. The awk runs on every Look fixture of both distributions and on changed copies of
// them; its choice, its reasons, its warnings and the run script it fills in are compared with what
// the board's own TypeScript makes of the same output (readRoundOne, readServerFacts, chooseCase,
// buildPlan, undoPlan, lookScript2, runScript), byte for byte.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { t } from '../../src/core/lang.ts'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import { lookScript2, readRoundOne, readServerFacts } from '../../src/core/server-look.ts'
import { oneLine, oneshotAwk, oneshotScripts } from '../../src/core/server-oneshot.ts'
import {
  applyShapes,
  applyTemplate,
  launchTemplate,
  lookKey,
  lookShapes,
  lookTemplate,
  undoCode,
  undoShapes,
  undoTemplate,
} from '../../src/core/server-oneshot-templates.ts'
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
import { shQuote } from '../../src/core/server-shell.ts'
import { fill, type Value } from '../../src/core/server-template.ts'

const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
}
const LOOK = { user: W.user, socket: W.socket, domain: W.domain }
const INPUT = { wanted: W, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGJvYXJkIGtleSBmb3IgdGVzdHM agent-board@pc' }
const IDS = { plan_id: '20261023-100400-3f9a', run_id: '20261023-100401-0b1c', at: '2026-10-23T10:04:01.000Z' }

const dir = mkdtempSync(join(tmpdir(), 'oneshot-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const PROGRAM = join(dir, 'oneshot.awk')
writeFileSync(PROGRAM, oneshotAwk(INPUT))
/** mawk when there is one (Debian's and Ubuntu's awk), else this computer's. */
const AWK = Bun.which('mawk') ?? Bun.which('awk') ?? 'awk'

function awk(mode: string, input: string, env: Record<string, string> = {}): { out: string; code: number } {
  const r = Bun.spawnSync([AWK, '-v', `mode=${mode}`, '-f', PROGRAM], {
    stdin: new TextEncoder().encode(input),
    env: { ...process.env, LC_ALL: 'C', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { out: r.stdout.toString(), code: r.exitCode ?? -1 }
}

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
const said = (out: string, what: string): string[] =>
  out
    .split('\n')
    .filter(l => l.startsWith(`${what} `) || l === what)
    .map(l => l.slice(what.length + 1))
const decision = (out: string): string =>
  out
    .split('\n')
    .find(l => /^(plan|stop|same|busy|unfinished|interrupted|unreadable|refuse|internal|nothing)( |$)/.test(l)) ?? ''

// the templates, as the scripts carry them
const LOOK2 = new Map(lookShapes().map(s => [lookKey(s), lookTemplate(s, LOOK)]))
const APPLY = new Map(applyShapes().map(s => [applyTemplate(s, W).key, applyTemplate(s, W)]))
const UNDO = new Map(undoShapes(W).map(s => [undoTemplate(s, W).key, undoTemplate(s, W)]))
const LAUNCH = launchTemplate(W)

// ---------------------------------------------------------------------------------------------
// What the board makes of the same output

/** A record's item as the run writes it (its JSON, as JSON.stringify gives it). */
const itemJson = (i: RecordItem): string => JSON.stringify(i)
/** The record line's items: the plan's guard carried them; the command's run carries them in `it=`. */
const carriedWord = (items: readonly RecordItem[]): string =>
  items.length ? shQuote(`,${items.map(itemJson).join(',')}`) : "''"

/** The board's run of a plan, with what its guard carries moved into the record line (as the command has it). */
function boardRun(p: Plan, moved: (i: RecordItem) => boolean): string {
  const [guard, ...rest] = p.steps
  if (!guard) throw new Error('no guard')
  const carry = guard.record.filter(moved)
  const keep = guard.record.filter(i => !moved(i))
  const run = runScript({ ...p, steps: [{ ...guard, record: keep }, ...rest] }, W, { id: IDS.run_id, at: IDS.at })
  return run.replace("\n  it=''\n", `\n  it=${carriedWord(carry)}\n`)
}

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

const SCENARIOS = [...fixtures(), ...mutations()]

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

/** The items each once, the newest of each (core/server-plan.ts dedupe, which is not exported). */
function dedupe(items: readonly RecordItem[]): RecordItem[] {
  const key = (i: RecordItem): string =>
    i.kind === 'file' || i.kind === 'backup' || i.kind === 'group'
      ? `${i.kind} ${i.path}`
      : i.kind === 'line' || i.kind === 'block'
        ? `${i.kind} ${i.file}`
        : i.kind === 'container' || i.kind === 'volume'
          ? `${i.kind} ${i.name}`
          : i.kind === 'image'
            ? `image ${i.ref}`
            : 'docker'
  const out = new Map<string, RecordItem>()
  for (const i of items) {
    const k = key(i)
    const was = out.get(k)
    if (was) out.delete(k)
    if (i.kind === 'image' && was?.kind === 'image') out.set(k, { ...i, before: i.before && was.before })
    else if (i.kind === 'docker' && was) out.set(k, was)
    else out.set(k, i)
  }
  return [...out.values()]
}

describe('Apply: the case, the reasons and the run the board would make', () => {
  for (const s of SCENARIOS) {
    test(s.name, () => {
      const r1 = readRoundOne(s.r1)
      const r2 = r1 && lookScript2(r1, LOOK) !== null ? s.r2 : ''
      const facts = r1 ? readServerFacts(r1, r2) : null
      const a = awk('apply', `${s.r1}\n@@ab-round2\n${r2}`)
      const d = decision(a.out)
      if (!facts) return expect(d).toBe('unreadable')
      const p = buildPlan(facts, W, { id: IDS.plan_id, docker: true })
      if (!('steps' in p)) {
        expect(d).toBe(`stop ${p.why.join(' ')}`)
        expect(said(a.out, 'why')).toEqual(p.why.map(w => t(`server.manual.${w}`)))
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
        if (who === 'same') return expect(d).toBe(`same ${record.address}`)
      }
      expect(d.startsWith('plan ')).toBe(true)
      const key = d.slice(5)
      const template = APPLY.get(key)
      if (!template) throw new Error(`no template ${key}`)
      expect(template.shape.c).toBe(p.case)
      const values = { ...valuesOf(a.out), ...IDS }
      // the guard carries the record's items (dedupe(mine.items)); the command's run has them in its record line
      expect(p.steps[0]?.record.map(itemJson)).toEqual((record ? dedupe(record.items) : []).map(itemJson))
      expect(fill(template.run, values)).toBe(boardRun(p, () => true))
      // what it says: why this plan, its steps, its warnings
      const text = fill([template.why, ...template.steps.map(x => x.title)].join('\n'), values).split('\n')
      expect(text).toEqual([t(choice.why.key, choice.why.params), ...p.steps.map(x => t(x.title.key, x.title.params))])
      expect(said(a.out, 'warn')).toEqual(p.warnings.map(w => t(w.key, w.params)))
      expect(said(a.out, 'address')).toEqual([p.address])
      // and the launch around the run, as the board's
      const run = fill(template.run, values)
      expect(fill(LAUNCH, { run_id: IDS.run_id, run: run.replace(/\n$/, '') })).toBe(launchScript(IDS.run_id, run))
    })
  }
})

describe('Undo: the record’s shape and the run the board’s Undo would make', () => {
  for (const s of SCENARIOS) {
    test(s.name, () => {
      const r1 = readRoundOne(s.r1)
      if (!r1) return
      const r2 = lookScript2(r1, LOOK) === null ? '' : s.r2
      const facts = readServerFacts(r1, r2)
      if (!facts) return
      const a = awk('undo', `${s.r1}\n@@ab-round2\n${r2}`)
      const d = decision(a.out)
      if (facts.record === null || facts.record === undefined) return expect(d).toBe('nothing')
      const r = setupRecord(facts.record)
      if (!r || whose(r, W) === 'other') return expect(d).toBe('stop otherSetup')
      if (r.state === 'running' && facts.lockHeld) return expect(d).toBe('busy')
      expect(d.startsWith('plan ')).toBe(true)
      const template = UNDO.get(d.slice(5))
      if (!template) throw new Error(`no Undo template ${d.slice(5)}`)
      const o = { id: IDS.plan_id, removeDocker: false, removeEdited: false }
      const p = undoPlan(r, facts, o)
      // the record's items as Undo has them (each once, their line or block named); Docker, backups
      // and images that were there before ride in the record line, the rest is what the template has
      const all = p.steps[0]?.record ?? []
      const moved = (i: RecordItem): boolean => undoCode(i) === null
      const plan = undoPlan({ ...r, items: all.filter(i => !moved(i)) }, facts, o)
      expect(plan.steps.map(x => x.id)).toEqual(p.steps.map(x => x.id))
      const values = { ...valuesOf(a.out), ...IDS }
      const [guard, ...rest] = plan.steps
      const want = boardRun({ ...plan, steps: [{ ...(guard as Plan['steps'][0]), record: all }, ...rest] }, moved)
      expect(fill(template.run, values)).toBe(want)
    })
  }
})

describe('the command', () => {
  const scripts = oneshotScripts(INPUT)
  const gzip = (b: Uint8Array): Uint8Array => gzipSync(b, { level: 9 })

  test('one line, base64 behind a fixed pipe, that decodes to the script', () => {
    for (const script of [scripts.script, scripts.undoScript]) {
      const line = oneLine(script, gzip)
      expect(line).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| gunzip \| sh$/)
      const b64 = line.split(' ')[1] ?? ''
      expect(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')).toBe(script)
      // tens of KB paste into a terminal; hundreds do not
      expect(line.length).toBeLessThan(80_000)
    }
  })

  test('it carries what the board knows', () => {
    for (const script of [scripts.script, scripts.undoScript]) {
      expect(script).toContain(`W_DOMAIN = "${W.domain}"`)
      expect(script).toContain(`W_USER = "${W.user}"`)
      expect(script).toContain(`W_SOCKET = "${W.socket}"`)
      expect(script).toContain(`W_KEY = "${INPUT.publicKey}"`)
      expect(script).toContain("# The board's address: https://board.example.com")
    }
  })

  test('POSIX sh, and the awk program fits one argument of a command line', () => {
    const SH = Bun.which('dash') ?? Bun.which('sh')
    if (SH)
      for (const script of [scripts.script, scripts.undoScript]) {
        const r = Bun.spawnSync([SH, '-n'], { stdin: new TextEncoder().encode(script), stderr: 'pipe' })
        expect(r.stderr.toString()).toBe('')
        expect(r.exitCode).toBe(0)
      }
    // Linux takes 128 KiB in one argument
    expect(new TextEncoder().encode(oneshotAwk(INPUT)).length).toBeLessThan(120_000)
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
})
