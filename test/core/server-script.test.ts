import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { CADDY_FILE, CADDY_IMAGE, IMPORT_LINE } from '../../src/core/server-texts.ts'
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
const BASHISMS = ['tail -f', '--pid', '[[', 'function ', 'local ', 'echo -e']

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

// The run's own logic, run for real by a POSIX shell: the steps in a sandbox folder instead of
// /etc/agent-board, flock and setsid stubbed, commands that only echo.
describe.skipIf(!SH)('a run, for real', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-run-')).replaceAll('\\', '/')
  const bin = `${dir}/bin`
  mkdirSync(bin)
  writeFileSync(`${bin}/flock`, '#!/bin/sh\n[ -z "$FLOCK_BUSY" ]\n', { mode: 0o755 })
  writeFileSync(`${bin}/setsid`, '#!/bin/sh\n[ "$1" = -w ] && shift\nexec "$@"\n', { mode: 0o755 })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }

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
  /** The script on this PC: the sandbox folder for /etc/agent-board, this PATH (with the stubs) for the server's. */
  const sandboxed = (script: string, root: string): string =>
    script.replaceAll('/etc/agent-board', root).replace(/^PATH=.*\n/gm, '')
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
})
