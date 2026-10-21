import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import {
  buildPlan,
  manualFacts,
  type Plan,
  type PlanStep,
  type RecordItem,
  setupRecord,
  undoPlan,
  type Wanted,
} from '../../src/core/server-plan.ts'
import { doItMyself, launchScript, readProgress, runScript, startProgress } from '../../src/core/server-script.ts'
import { CADDY_FILE, CADDY_IMAGE, IMPORT_LINE, SITE_FILE, SOCAT_IMAGE } from '../../src/core/server-texts.ts'
import { factsFor, recordFor } from '../support/server-facts.ts'

const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
}
const RUN = { id: 'r1', at: '2026-10-21T10:04:00.000Z' }

const planOf = (f: ServerFacts, w: Wanted = W): Plan => {
  const p = buildPlan(f, w, { id: 'r1', docker: true })
  if (!('steps' in p)) throw new Error(`no plan: ${JSON.stringify(p)}`)
  return p
}

/** Every plan the board can make from the test facts: each case on both distributions, the manual ones, and Undo. */
function everyPlan(): [string, Plan][] {
  const out: [string, Plan][] = []
  for (const distro of ['debian13', 'ubuntu2604'] as const)
    for (const c of ['bare', 'nodocker', '1b', '2', '3a', '3b', '4a', '4b'] as const)
      out.push([`${c} on ${distro}`, planOf(factsFor(c, distro))])
  for (const c of ['1', '2', '3a', '3b', '4a', '4b'] as const)
    out.push([`manual ${c}`, planOf(manualFacts(c, 'debian'))])
  const items2: RecordItem[] = [
    { kind: 'file', path: '/etc/caddy/agent-board/board.caddy', sha256: 'ab'.repeat(32) },
    { kind: 'group', path: '/var/lib/boardtunnel', from: 'boardtunnel', to: 'caddy' },
    { kind: 'line', file: '/etc/caddy/Caddyfile', line: IMPORT_LINE },
  ]
  const r2 = recordFor('2', { items: items2 })
  out.push([
    'undo 2',
    undoPlan(r2, { ...factsFor('2'), record: r2 }, { id: 'u1', removeDocker: false, removeEdited: false }),
  ])
  const items4: RecordItem[] = [
    { kind: 'docker', packages: ['docker-ce'], files: ['/etc/apt/sources.list.d/docker.list'] },
    { kind: 'image', ref: CADDY_IMAGE, before: false },
    { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
    { kind: 'volume', name: 'agent-board-caddy-data' },
    { kind: 'container', name: 'agent-board-caddy', setup: 'r0' },
    { kind: 'file', path: '/etc/nginx/conf.d/agent-board.conf', sha256: 'cd'.repeat(32) },
  ]
  const r4 = recordFor('4b', { items: items4 })
  out.push([
    'undo 4b',
    undoPlan(r4, { ...factsFor('4b'), record: r4 }, { id: 'u1', removeDocker: true, removeEdited: true }),
  ])
  const r3 = recordFor('3a', {
    items: [{ kind: 'block', file: '/srv/my web/Caddyfile', begin: '# >>> agent-board', end: '# <<< agent-board' }],
  })
  out.push([
    'undo 3a',
    undoPlan(r3, { ...factsFor('3a'), record: r3 }, { id: 'u1', removeDocker: false, removeEdited: false }),
  ])
  out.push([
    'update 2',
    planOf(
      {
        ...factsFor('2'),
        record: r2,
        folder: { mode: '2750', owner: 'boardtunnel', group: 'caddy', gid: 997, members: [] },
      },
      {
        ...W,
        domain: 'new.example.com',
      },
    ),
  ])
  return out
}

const PLANS = everyPlan()
// `[[ ` is bash's test; `[[:space:]]` is a POSIX class and fine
const BASHISMS = ['tail -f', '--pid', '[[ ', 'function ', 'local ', 'echo -e']

/** The shell to check and run the scripts with: dash when there is one (the stricter POSIX one), else sh. */
const SH = Bun.which('dash') ?? Bun.which('sh')
const syntax = (script: string): { code: number; err: string } => {
  if (!SH) return { code: 0, err: '' }
  const r = Bun.spawnSync([SH, '-n'], { stdin: new TextEncoder().encode(script), stderr: 'pipe' })
  return { code: r.exitCode, err: r.stderr.toString() }
}

describe('the run script: one plan, the same lines as "Do it myself"', () => {
  for (const [name, p] of PLANS) {
    test(name, () => {
      const run = runScript(p, W, RUN)
      expect(run.startsWith('exec </dev/null\n# agent-board: run\n')).toBe(true)
      expect(run).toContain('sudo() { "$@"; }')
      expect(run).toContain('flock -n 9')
      const blocks = doItMyself(p)
      expect(blocks).toHaveLength(p.steps.length)
      p.steps.forEach((s: PlanStep, i) => {
        const block = blocks[i]
        if (!block) throw new Error('a block per step')
        expect(block.title).toEqual({
          key: `server.step.${s.id}.title`,
          ...(block.title.params ? { params: block.title.params } : {}),
        })
        expect(block.commands).toBe(s.commands.join('\n'))
        expect(block.check).toBe(s.check.join('\n'))
        expect(block.undo).toBe(s.undo.join('\n'))
        for (const line of [...s.commands, ...s.check, ...s.undo])
          expect([s.id, run.includes(`\n${line}\n`)]).toEqual([s.id, true])
      })
      for (const b of BASHISMS) expect([name, b, run.includes(b)]).toEqual([name, b, false])
      expect(syntax(run)).toEqual({ code: 0, err: '' })
    })
  }
})

describe('the launch: the run written, started detached, its log followed', () => {
  const run = runScript(planOf(factsFor('2')), W, RUN)
  const launch = launchScript('r1', run)
  test('POSIX, the run in base64, @@exit at the end', () => {
    expect(launch.startsWith('exec </dev/null\n# agent-board: launch\n')).toBe(true)
    for (const b of BASHISMS) expect([b, launch.includes(b)]).toEqual([b, false])
    expect(launch).toContain('@@exit')
    expect(launch).toContain('setsid')
    expect(launch).toContain('wc -l')
    expect(launch).toContain('sed -n')
    // the run, verbatim, in a quoted here-document
    const body = launch.match(/<<'AGENT_BOARD_RUN'\n([\s\S]*?)\nAGENT_BOARD_RUN\n/)?.[1]
    expect(`${body}\n`).toBe(run)
    expect(syntax(launch)).toEqual({ code: 0, err: '' })
  })
  test('a run id that is not plain is refused', () => {
    expect(() => launchScript('a b', run)).toThrow()
    expect(() => launchScript('../x', run)).toThrow()
  })
  test('a run without its last line is refused: the launch checks its copy ends with it', () => {
    expect(run.trimEnd().split('\n').at(-1)).toBe('# agent-board: end')
    expect(() => launchScript('r1', run.replace('# agent-board: end\n', ''))).toThrow()
    expect(launch).toContain(`[ "$(tail -n 1 "$R.sh")" = '# agent-board: end' ] || { echo '@@exit 70'; exit 70; }`)
  })
  test('the biggest plans still fit a Windows command line in base64, with 20 of their hosts', () => {
    const f = factsFor('4b')
    const many = Array.from({ length: 25 }, (_, i) => `site-number-${i}.some-long-domain.example.org`)
    const big = planOf({ ...f, docker: null, nginx: f.nginx && { ...f.nginx, serverNames: many } })
    const f3 = factsFor('3a')
    const big3 = planOf({ ...f3, caddy: f3.caddy && { ...f3.caddy, hosts: many } })
    for (const [name, p] of [
      ...PLANS,
      ['4b with Docker to install', big] as const,
      ['3a with 25 hosts', big3] as const,
    ]) {
      const sent = Buffer.from(launchScript('r1', runScript(p, W, RUN))).toString('base64')
      expect([name, sent.length < 30_000]).toEqual([name, true])
    }
  })
})

describe('progress from the run’s lines', () => {
  const p = planOf(factsFor('2'))
  const feed = (lines: string[]): ReturnType<typeof startProgress> =>
    lines.reduce((pr, line, i) => readProgress(pr, line, 1000 + i), startProgress(p))
  test('every step waiting at first', () => {
    const pr = startProgress(p)
    expect(pr.steps.map(s => [s.n, s.id, s.state])).toEqual(p.steps.map((s, i) => [i + 1, s.id, 'waiting']))
    expect([pr.undo, pr.result, pr.exit]).toEqual([[], null, null])
  })
  test('steps, their output, a failure, the rollback, the result, the exit', () => {
    const pr = feed([
      '@@step 1 start',
      'checked 443',
      'checked the config',
      '@@step 1 ok',
      '@@step 2 start',
      '@@step 2 fail',
      '@@undo 1 ok',
      '@@result rolled-back',
      '@@exit 1',
    ])
    expect(pr.steps[0]).toEqual({
      n: 1,
      id: 'guard',
      state: 'ok',
      since: 1000,
      out: ['checked 443', 'checked the config'],
    })
    expect(pr.steps[1]).toMatchObject({ n: 2, state: 'fail', since: 1004 })
    expect(pr.steps[2]?.state).toBe('waiting')
    expect(pr.undo).toEqual([{ n: 1, ok: true }])
    expect([pr.result, pr.exit]).toEqual(['rolled-back', 1])
  })
  test('a skipped step, a running one', () => {
    const pr = feed(['@@step 1 start', '@@step 1 skip', '@@step 2 start'])
    expect(pr.steps.slice(0, 2).map(s => s.state)).toEqual(['skipped', 'running'])
  })
  test('a step keeps its last 200 lines', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`)
    const pr = feed(['@@step 1 start', ...lines])
    expect(pr.steps[0]?.out).toHaveLength(200)
    expect(pr.steps[0]?.out[0]).toBe('line 50')
    expect(pr.steps[0]?.out.at(-1)).toBe('line 249')
  })
  test('another run going on; the server changed since Look', () => {
    expect(feed(['@@busy', '@@exit 75'])).toMatchObject({ result: 'busy', exit: 75 })
    expect(feed(['@@step 1 start', '@@changed holder443', '@@step 1 fail', '@@exit 3'])).toMatchObject({
      result: 'changed',
    })
  })
  test('the input is not changed', () => {
    const pr = startProgress(p)
    const before = JSON.stringify(pr)
    readProgress(pr, '@@step 1 start', 5)
    readProgress(pr, 'x', 5)
    expect(JSON.stringify(pr)).toBe(before)
  })
})

test('the module has no node: import', () => {
  expect(readFileSync('src/core/server-script.ts', 'utf8')).not.toMatch(/from 'node:/)
})

test('what the panel wants is checked before a script is made: a domain that would end their site block gives none', () => {
  const p = planOf(factsFor('2'))
  for (const domain of ['a.com;\n}', 'a{b.example.com', 'x.com; include /etc/x', 'a.com\nimport /etc/x'])
    expect(() => runScript(p, { ...W, domain }, RUN)).toThrow()
  expect(() => runScript(p, { ...W, socket: '/var/lib/board tunnel/board.sock' }, RUN)).toThrow()
})

// The run's own logic, run for real by a POSIX shell: the steps in a sandbox folder instead of
// /etc/agent-board, flock and setsid stubbed, commands that only echo.
describe.skipIf(!SH)('a run, for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-run-')).replaceAll('\\', '/')
  const bin = `${dir}/bin`
  mkdirSync(bin)
  writeFileSync(`${bin}/flock`, '#!/bin/sh\n[ -z "$FLOCK_BUSY" ]\n', { mode: 0o755 })
  writeFileSync(`${bin}/setsid`, '#!/bin/sh\n[ "$1" = -w ] && shift\nexec "$@"\n', { mode: 0o755 })
  // `install -d -m MODE DIR`: the folder without its mode (Windows' ACLs refuse some modes Git's install sets)
  writeFileSync(
    `${bin}/install`,
    '#!/bin/sh\n[ "$1" = -d ] || exit 1\nshift\n[ "$1" = -m ] && shift 2\nmkdir -p "$@"\n',
    {
      mode: 0o755,
    },
  )
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const SEP = process.platform === 'win32' ? ';' : ':'
  const env = { ...process.env, PATH: `${bin}${SEP}${process.env.PATH ?? ''}` }

  const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({
    id,
    title: { key: `server.step.${id}.title` },
    why: { key: `server.step.${id}.why` },
    skipIf: [],
    commands: [`echo 'did ${id}'`],
    check: [],
    undo: [],
    touches: [],
    record: [],
    timeoutS: 20,
    ...over,
  })
  const fake = (steps: PlanStep[]): Plan => ({
    id: 'r1',
    kind: 'apply',
    case: '1',
    address: 'https://board.example.com',
    publicPort: null,
    relies: [],
    steps,
    undoTouches: [],
    warnings: [],
    ticks: [],
  })
  const runIn = (p: Plan, root: string, extra: Record<string, string> = {}): { out: string; code: number } => {
    mkdirSync(`${root}/runs`, { recursive: true })
    const script = sandboxed(runScript(p, W, RUN), root)
    writeFileSync(`${root}/runs/r1.sh`, script)
    const r = Bun.spawnSync([SH ?? 'sh', `${root}/runs/r1.sh`], {
      env: { ...env, ...extra },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { out: r.stdout.toString() + r.stderr.toString(), code: r.exitCode }
  }
  /** The script on this PC: sandbox folders for /etc/agent-board and /etc/caddy, this PATH (with the stubs) for the server's. */
  const sandboxed = (script: string, root: string): string =>
    script
      .replaceAll('/etc/agent-board', root)
      .replaceAll('/etc/caddy/', `${root}/etc-caddy/`)
      .replace(/^PATH=.*\n/gm, '')
  /** A step of the real case-2 plan (their Caddy as a service): its lines, run here on the sandbox's files. */
  const case2 = planOf(factsFor('2'))
  const real = (id: string): PlanStep => {
    const s = case2.steps.find(x => x.id === id)
    if (!s) throw new Error(`no step ${id}`)
    return s
  }
  /**
   * The run started in the background; once its log has the line `at`, a TERM sent to it, as the
   * overall timeout or a shutdown would. Its log, and how it ended.
   */
  const runAndTerm = (p: Plan, root: string, at: string): { out: string; code: number } => {
    mkdirSync(`${root}/runs`, { recursive: true })
    writeFileSync(`${root}/runs/r1.sh`, sandboxed(runScript(p, W, RUN), root))
    const wrapper = [
      'sh=$(command -v dash || command -v sh)',
      '"$sh" "$1" > "$2" 2>&1 &',
      'p=$!',
      'i=0',
      'until grep -qx -e "$3" "$2" || [ "$i" -ge 300 ]; do sleep 0.1; i=$((i + 1)); done',
      'kill -TERM "$p"',
      'wait "$p"',
    ].join('\n')
    const r = Bun.spawnSync([SH ?? 'sh', '-c', wrapper, 'sh', `${root}/runs/r1.sh`, `${root}/out`, at], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
    return { out: readFileSync(`${root}/out`, 'utf8'), code: r.exitCode }
  }
  const markers = (out: string): string[] =>
    out.split('\n').filter(l => l.startsWith('@@') || l.startsWith('did ') || l.startsWith('undid '))
  /** The record the run wrote, its sandbox folder read back as /etc/agent-board. */
  const record = (root: string): unknown =>
    JSON.parse(readFileSync(`${root}/setup.json`, 'utf8').replaceAll(root, '/etc/agent-board'))

  test('all steps: applied, the record written with each step’s items', () => {
    const root = `${dir}/ok`
    const p = fake([
      step('guard'),
      step('caddyfile', {
        record: [{ kind: 'file', path: CADDY_FILE, sha256: '' }],
        commands: ['mkdir -p /etc/agent-board/caddy', `echo hi > ${CADDY_FILE}`],
      }),
      step('pull-caddy', { skipIf: ['true'], record: [{ kind: 'image', ref: CADDY_IMAGE, before: false }] }),
      step('volumes', { record: [{ kind: 'volume', name: 'agent-board-caddy-data' }] }),
    ])
    const { out, code } = runIn(p, root)
    expect(markers(out)).toEqual([
      '@@step 1 start',
      'did guard',
      '@@step 1 ok',
      '@@step 2 start',
      '@@step 2 ok',
      '@@step 3 start',
      '@@step 3 skip',
      '@@step 4 start',
      'did volumes',
      '@@step 4 ok',
      '@@result applied',
    ])
    expect(code).toBe(0)
    const r = setupRecord(record(root))
    expect(r).toMatchObject({ id: 'r1', state: 'applied', case: '1', pair: { user: 'boardtunnel' } })
    expect(r?.items).toEqual([
      // the file's hash as sha256sum gives it on the server: of "hi\n"
      { kind: 'file', path: CADDY_FILE, sha256: '98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4' },
      { kind: 'image', ref: CADDY_IMAGE, before: true },
      { kind: 'volume', name: 'agent-board-caddy-data' },
    ])
    expect(readFileSync(`${root}/runs/r1.exit`, 'utf8').trim()).toBe('0')
  })

  test('Apply again: what the board did stays on the record, though the steps that did it skip now', () => {
    const root = `${dir}/again`
    const pulled: RecordItem = { kind: 'image', ref: CADDY_IMAGE, before: false }
    const there: RecordItem = { kind: 'image', ref: SOCAT_IMAGE, before: true }
    const group: RecordItem = { kind: 'group', path: '/var/lib/boardtunnel', from: 'boardtunnel', to: 'caddy' }
    const p = {
      ...fake([
        // the guard carries the earlier record's items, as buildPlan's for a setup already there
        step('guard', { record: [pulled, there, group] }),
        step('pull-caddy', { skipIf: ['true'], record: [{ kind: 'image', ref: CADDY_IMAGE, before: false }] }),
        step('pull-socat', { skipIf: ['true'], record: [{ kind: 'image', ref: SOCAT_IMAGE, before: false }] }),
        step('folder-group', { skipIf: ['true'], record: [{ ...group, from: 'caddy' }] }),
      ]),
      kind: 'nothing' as const,
    }
    const { code } = runIn(p, root)
    expect(code).toBe(0)
    // Undo removes an image only when the board pulled it, and puts the folder's group back from
    // what the record says it was: Apply again keeps both as the first Apply recorded them
    expect(setupRecord(record(root))?.items).toEqual([pulled, there, group])
  })

  test('a failure: its own undo and the done steps’, newest first, the skipped ones not; the record says rolled-back', () => {
    const root = `${dir}/fail`
    const p = fake([
      step('guard'),
      step('caddyfile', {
        undo: ["echo 'undid caddyfile'"],
        record: [{ kind: 'volume', name: 'agent-board-caddy-data' }],
      }),
      step('pull-caddy', { skipIf: ['true'], undo: ["echo 'undid pull-caddy'"] }),
      step('volumes', {
        commands: ["echo 'did volumes'", 'false', "echo 'not reached'"],
        undo: ["echo 'undid volumes'"],
      }),
      step('run-caddy', { undo: ["echo 'undid run-caddy'"] }),
    ])
    const { out, code } = runIn(p, root)
    expect(markers(out)).toEqual([
      '@@step 1 start',
      'did guard',
      '@@step 1 ok',
      '@@step 2 start',
      'did caddyfile',
      '@@step 2 ok',
      '@@step 3 start',
      '@@step 3 skip',
      '@@step 4 start',
      'did volumes',
      '@@step 4 fail',
      'undid volumes',
      '@@undo 4 ok',
      'undid caddyfile',
      '@@undo 2 ok',
      '@@result rolled-back',
    ])
    expect(code).toBe(1)
    expect(setupRecord(record(root))).toMatchObject({ state: 'rolled-back', items: [] })
  })

  test('an undo that fails: rollback-failed, its items left in the record', () => {
    const root = `${dir}/rbf`
    const p = fake([
      step('guard'),
      step('caddyfile', { undo: ['false'], record: [{ kind: 'volume', name: 'agent-board-caddy-data' }] }),
      step('volumes', { commands: ['false'] }),
    ])
    const { out, code } = runIn(p, root)
    expect(markers(out).slice(-2)).toEqual(['@@undo 2 fail', '@@result rollback-failed'])
    expect(code).toBe(2)
    expect(setupRecord(record(root))).toMatchObject({
      state: 'rollback-failed',
      items: [{ kind: 'volume', name: 'agent-board-caddy-data' }],
    })
  })

  test('the guard finds a change: nothing done, the record untouched, exit 3', () => {
    const root = `${dir}/changed`
    const p = fake([step('guard', { commands: ["echo '@@changed holder443'", 'false'] }), step('caddyfile')])
    const { out, code } = runIn(p, root)
    expect(markers(out)).toEqual(['@@step 1 start', '@@changed holder443', '@@step 1 fail'])
    expect(code).toBe(3)
    expect(() => readFileSync(`${root}/setup.json`)).toThrow()
  })

  test('another run holds the lock: @@busy, nothing done', () => {
    const root = `${dir}/busy`
    const { out, code } = runIn(fake([step('guard')]), root, { FLOCK_BUSY: '1' })
    expect(markers(out)).toEqual(['@@busy'])
    expect(code).toBe(75)
  })

  test('the launch follows the run’s log to its end and prints its exit', () => {
    const root = `${dir}/launch`
    mkdirSync(root, { recursive: true })
    const p = fake([
      step('guard'),
      step('caddyfile', { commands: ['sleep 1', "echo 'did caddyfile'"] }),
      step('volumes'),
    ])
    const launch = sandboxed(launchScript('r1', runScript(p, W, RUN)), root)
    const r = Bun.spawnSync([SH ?? 'sh', '-c', launch], { env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    const out = r.stdout.toString()
    expect(markers(out)).toEqual([
      '@@step 1 start',
      'did guard',
      '@@step 1 ok',
      '@@step 2 start',
      'did caddyfile',
      '@@step 2 ok',
      '@@step 3 start',
      'did volumes',
      '@@step 3 ok',
      '@@result applied',
      '@@exit 0',
    ])
    expect(r.exitCode).toBe(0)
  }, 30_000)

  test('a launch whose runs folder cannot be made, or whose copy of the run is cut, says @@exit 70 at once', () => {
    const root = `${dir}/nofolder`
    writeFileSync(root, 'a file where the folder would be')
    const run = (at: string): { out: string; code: number } => {
      const launch = sandboxed(launchScript('r1', runScript(fake([step('guard')]), W, RUN)), at)
      const r = Bun.spawnSync([SH ?? 'sh', '-c', launch], { env, stdout: 'pipe', stderr: 'pipe', timeout: 15_000 })
      return { out: r.stdout.toString(), code: r.exitCode }
    }
    const started = Date.now()
    expect(run(root)).toEqual({ out: '@@exit 70\n', code: 70 })
    // the run's own file taken by a folder: what is there does not end with the run's last line
    const cut = `${dir}/cut`
    mkdirSync(`${cut}/runs/r1.sh`, { recursive: true })
    expect(run(cut)).toEqual({ out: '@@exit 70\n', code: 70 })
    expect(existsSync(`${cut}/runs/r1.log`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 40_000)

  test('a step’s items are on the record before it runs: a run cut short names what it was changing', () => {
    const root = `${dir}/ahead`
    const p = fake([
      step('guard'),
      step('write', {
        commands: ['cat /etc/agent-board/setup.json'],
        record: [
          { kind: 'line', file: '/etc/caddy/Caddyfile', line: IMPORT_LINE },
          { kind: 'image', ref: CADDY_IMAGE, before: false },
        ],
      }),
    ])
    const { out, code } = runIn(p, root)
    expect(code).toBe(0)
    const during = JSON.parse(out.split('\n').find(l => l.startsWith('{')) ?? 'null')
    // an image as if there before while its step runs (an Undo after a cut keeps it), what the step found after
    expect(during).toMatchObject({
      state: 'running',
      items: [{ kind: 'line' }, { kind: 'image', ref: CADDY_IMAGE, before: true }],
    })
    expect(record(root)).toMatchObject({
      state: 'applied',
      items: [{ kind: 'line' }, { kind: 'image', ref: CADDY_IMAGE, before: false }],
    })
  })

  test('a TERM during a step: the step ends, then what the run did is rolled back; their file is its backup again', () => {
    const root = `${dir}/term`
    const theirs = `${root}/etc-caddy/Caddyfile`
    mkdirSync(`${root}/etc-caddy`, { recursive: true })
    const original = 'a.example.org {\n\trespond "a"\n}\n'
    writeFileSync(theirs, original)
    const p = fake([
      step('guard'),
      step('backup', {
        commands: [
          'sudo install -d -m 700 /etc/agent-board/backups/r1',
          'sudo cp -p /etc/caddy/Caddyfile /etc/agent-board/backups/r1/Caddyfile',
        ],
        record: [{ kind: 'backup', of: '/etc/caddy/Caddyfile', path: '/etc/agent-board/backups/r1/Caddyfile' }],
      }),
      step('write', {
        commands: [`printf '%s\\n' '${IMPORT_LINE}' >> /etc/caddy/Caddyfile`, 'sleep 2'],
        undo: real('write').undo,
        record: real('write').record,
      }),
      step('reload'),
    ])
    const { out, code } = runAndTerm(p, root, '@@step 3 start')
    expect(markers(out)).toEqual([
      '@@step 1 start',
      'did guard',
      '@@step 1 ok',
      '@@step 2 start',
      '@@step 2 ok',
      '@@step 3 start',
      '@@step 3 ok',
      '@@undo 3 ok',
      '@@result rolled-back',
    ])
    expect(code).toBe(1)
    expect(readFileSync(theirs, 'utf8')).toBe(original)
    expect(readFileSync(`${root}/backups/r1/Caddyfile`, 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(`${root}/setup.json`, 'utf8'))).toMatchObject({ state: 'rolled-back', items: [] })
  }, 60_000)

  test('a record that cannot be written: nothing after the guard; after a step, that step rolled back', () => {
    const root = `${dir}/norecord`
    // the record's new copy cannot be made where a folder has its name
    mkdirSync(`${root}/setup.json.new`, { recursive: true })
    const first = runIn(fake([step('guard'), step('caddyfile')]), root)
    expect(markers(first.out)).toEqual(['@@step 1 start', 'did guard', '@@step 1 ok'])
    expect(first.code).toBe(3)
    const later = runIn(
      fake([
        step('guard'),
        step('caddyfile', {
          commands: ["echo 'did caddyfile'", 'mkdir /etc/agent-board/setup.json.new'],
          undo: ["echo 'undid caddyfile'"],
        }),
        step('volumes'),
      ]),
      `${dir}/norecord-later`,
    )
    expect(markers(later.out)).toEqual([
      '@@step 1 start',
      'did guard',
      '@@step 1 ok',
      '@@step 2 start',
      'did caddyfile',
      '@@step 2 ok',
      'undid caddyfile',
      '@@undo 2 ok',
      '@@result rollback-failed',
    ])
    expect(later.code).toBe(2)
  })

  test('their file put back from a backup that is not there: it stays as it is, and the rollback says it failed', () => {
    const root = `${dir}/nobackup`
    const theirs = `${root}/etc-caddy/Caddyfile`
    mkdirSync(`${root}/etc-caddy`, { recursive: true })
    writeFileSync(theirs, 'theirs\n')
    const { out, code } = runIn(
      fake([step('guard'), step('write', { commands: ['false'], undo: real('write').undo })]),
      root,
    )
    expect(markers(out).slice(-2)).toEqual(['@@undo 2 fail', '@@result rollback-failed'])
    expect(code).toBe(2)
    expect(readFileSync(theirs, 'utf8')).toBe('theirs\n')
  })

  test('the board’s own file whose copy cannot be made: the step fails and the board.caddy there stays', () => {
    const root = `${dir}/owncopy`
    const site = `${root}/etc-caddy/agent-board/board.caddy`
    mkdirSync(`${root}/etc-caddy/agent-board`, { recursive: true })
    writeFileSync(site, 'old site\n')
    const failing = `${root}/bin`
    mkdirSync(failing)
    writeFileSync(`${failing}/cp`, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const { out, code } = runIn(fake([step('guard'), real('site-file')]), root, {
      PATH: `${failing}${SEP}${env.PATH}`,
    })
    expect(markers(out)).toEqual([
      '@@step 1 start',
      'did guard',
      '@@step 1 ok',
      '@@step 2 start',
      '@@step 2 fail',
      '@@undo 2 ok',
      '@@result rolled-back',
    ])
    expect(code).toBe(1)
    expect(readFileSync(site, 'utf8')).toBe('old site\n')
  })

  /** Case 2 on the sandbox: their Caddyfile with their site and the board's line, the board's site file. */
  const setUpCase2 = (root: string, line: string): { theirs: string; site: string; sha: string; mine: string } => {
    mkdirSync(`${root}/etc-caddy/agent-board`, { recursive: true })
    const theirs = `${root}/etc-caddy/Caddyfile`
    const mine = 'a.example.org {\n\trespond "a"\n}\n'
    writeFileSync(theirs, `${mine}${line.replaceAll('/etc/caddy/', `${root}/etc-caddy/`)}\n`)
    const site = `${root}/etc-caddy/agent-board/board.caddy`
    const text = 'board.example.com {\n\treverse_proxy unix//var/lib/boardtunnel/board.sock\n}\n'
    writeFileSync(site, text)
    return { theirs, site, sha: createHash('sha256').update(text).digest('hex'), mine }
  }
  const undoOf = (items: RecordItem[]): Plan => {
    const r = recordFor('2', { state: 'running', items })
    // no Caddy Look could read: the line comes out of the file, nothing reloaded
    return undoPlan(
      r,
      { ...factsFor('2'), caddy: null, record: r },
      { id: 'u1', removeDocker: false, removeEdited: false },
    )
  }

  test('Undo of a run cut short before it recorded the line: the line comes out of their file all the same', () => {
    const root = `${dir}/interrupted`
    const { theirs, site, sha, mine } = setUpCase2(root, IMPORT_LINE)
    const p = undoOf([
      { kind: 'file', path: SITE_FILE, sha256: sha },
      { kind: 'backup', of: '/etc/caddy/Caddyfile', path: '/etc/agent-board/backups/r0/Caddyfile' },
    ])
    const { out, code } = runIn(p, root)
    expect(markers(out).at(-1)).toBe('@@result applied')
    expect(code).toBe(0)
    expect(readFileSync(theirs, 'utf8')).toBe(mine)
    expect(existsSync(site)).toBe(false)
    expect(existsSync(`${root}/setup.json`)).toBe(false)
  })

  test('Undo keeps board.caddy while a Caddyfile still imports it (a line of their own): rolled back, nothing removed', () => {
    const root = `${dir}/imported`
    const own = `import ${SITE_FILE}`
    const { theirs, site, sha, mine } = setUpCase2(root, own)
    const p = undoOf([
      { kind: 'file', path: SITE_FILE, sha256: sha },
      { kind: 'line', file: '/etc/caddy/Caddyfile', line: IMPORT_LINE },
    ])
    const { out, code } = runIn(p, root)
    const n = p.steps.findIndex(s => s.id === 'drop-site-file') + 1
    expect(markers(out).slice(-3)).toEqual([`@@step ${n} fail`, `@@undo ${n} ok`, '@@result rolled-back'])
    expect(code).toBe(1)
    expect(readFileSync(site, 'utf8')).toContain('board.example.com {')
    expect(readFileSync(theirs, 'utf8')).toBe(`${mine}${own.replaceAll('/etc/caddy/', `${root}/etc-caddy/`)}\n`)
  })
})
