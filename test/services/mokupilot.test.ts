// Starting a MokuPilot call (services/mokupilot.ts startCall): upstream's test/mokupilot.test.mjs
// (#44), its third test, with a stand-in for spawn; then whether the page offers calls at all,
// looked up again when the setting changes and once a minute.
import { beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { profileSet, sessionProfile } from '../../src/core/profiles.ts'
import type { Config } from '../../src/core/types.ts'
import { type CallChild, type CallOptions, mokupilotCheck, startCall } from '../../src/services/mokupilot.ts'

beforeEach(() => {
  useLanguage('en')
})
const ID = '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f'

type Run = NonNullable<CallOptions['run']>
type Started = { file: string; args: string[]; opts: Parameters<Run>[2]; child: EventEmitter & { unrefed?: boolean } }

test('a call starts MokuPilot on its own, in the folder the session started in, for Claude sessions only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mokupilot-'))
  try {
    const project = join(dir, 'Acme project')
    mkdirSync(project)
    const transcript = join(dir, `${ID}.jsonl`)
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: project, sessionId: ID })}\n`)
    const runs: Started[] = []
    const run: Run = (file, args, opts) => {
      const child: Started['child'] = new EventEmitter()
      const started = Object.assign(child, {
        unref: () => {
          child.unrefed = true
        },
      })
      runs.push({ file, args, opts, child })
      queueMicrotask(() => child.emit('spawn'))
      return started as unknown as CallChild
    }
    const cfg = { mokupilot: { command: ['/opt/mp/MokuPilot'] } }
    const env = { PATH: '', HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', HOME: '/home/u' }
    const item = { key: ID, session: ID, agent: 'claude', cwd: join(dir, 'elsewhere'), transcript }
    // A program by its path: there is none at /opt/mp here, so the check goes through `exists`.
    const opts = { platform: 'linux', env, run }
    const missing = await startCall(cfg, item, opts)
    assert.equal(missing.ok, false)
    assert.match(missing.ok ? '' : missing.error, /MokuPilot not found \(\/opt\/mp\/MokuPilot\)/)

    const real = { mokupilot: { command: [process.execPath] } }
    assert.deepEqual(await startCall(real, item, opts), { ok: true, file: process.execPath })
    const r = runs.at(-1)
    assert.ok(r)
    assert.deepEqual(r.args, ['call', '--claude-session', ID, '--cwd', project])
    assert.equal(r.opts.cwd, project)
    assert.equal(r.opts.detached, true)
    assert.equal(r.opts.stdio, 'ignore')
    assert.equal(r.child.unrefed, true)
    // herdr's pane and tab stay with the board; the rest of the environment goes along.
    assert.equal(r.opts.env?.HERDR_PANE_ID, undefined)
    assert.equal(r.opts.env?.HERDR_TAB_ID, undefined)
    assert.equal(r.opts.env?.HOME, '/home/u')

    // No transcript to read and no folder on disk: no --cwd, MokuPilot finds it from the session.
    await startCall(real, { ...item, transcript: null, cwd: join(dir, 'gone') }, opts)
    assert.deepEqual(runs.at(-1)?.args, ['call', '--claude-session', ID])
    assert.equal(runs.at(-1)?.opts.cwd, undefined)

    const count = runs.length
    for (const bad of [
      { ...item, agent: 'codex' },
      { ...item, session: null },
      { ...item, session: 'pane-p1' },
    ]) {
      const out = await startCall(real, bad, opts)
      assert.equal(out.ok, false)
      assert.match(out.ok ? '' : out.error, /Claude Code session/)
    }
    const off = await startCall({ mokupilot: false }, item, opts)
    assert.match(off.ok ? '' : off.error, /turned off/)
    assert.equal(runs.length, count)

    // A program that cannot start says so.
    const failing: Run = () => {
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
      return Object.assign(child, { unref() {} }) as unknown as CallChild
    }
    const failed = await startCall(real, item, { ...opts, run: failing })
    assert.match(failed.ok ? '' : failed.error, /did not start: .* not found/)
    // One that throws as it is asked to start, too.
    const throwing: Run = () => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    }
    const refused = await startCall(real, item, { ...opts, run: throwing })
    assert.equal(refused.ok ? '' : refused.error, 'MokuPilot did not start: EACCES')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a call from a session in another profile than the board’s is refused before anything starts', async () => {
  const DEFAULT = { id: 'default', title: 'Default', dir: '/home/u/.claude', color: 'indigo', hidden: false }
  const WORK = { id: 'work', title: 'Work', dir: '/home/u/.claude-work', color: 'teal', hidden: false }
  const SET = profileSet([DEFAULT, WORK], DEFAULT.dir)
  const started: string[][] = []
  const run: Run = (_file, args) => {
    started.push(args)
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('spawn'))
    return Object.assign(child, { unref() {} }) as unknown as CallChild
  }
  const cfg = { mokupilot: { command: [process.execPath] } }
  const call = { agent: 'claude', session: ID, cwd: tmpdir(), transcript: null }
  const opts = { platform: 'linux', env: { PATH: '' }, profiles: SET, run }

  const work = await startCall(cfg, { ...call, profile: 'work' }, opts)
  assert.deepEqual(work, {
    ok: false,
    error: 'MokuPilot takes the profile of its running copy, Default: a call from Work would run in the wrong account',
  })
  assert.equal(started.length, 0)
  // A session whose profile the board does not know: refused too, naming the folder it reported.
  const odd = await startCall(cfg, { ...call, profile: null, profileFolder: '/srv/.claude-x' }, opts)
  assert.match(odd.ok ? '' : odd.error, /a call from \/srv\/\.claude-x would run in the wrong account/)
  const unknown = await startCall(cfg, { ...call, profile: null }, opts)
  assert.match(unknown.ok ? '' : unknown.error, /a call from unknown profile would/)
  assert.equal(started.length, 0)

  assert.deepEqual(await startCall(cfg, { ...call, profile: 'default' }, opts), { ok: true, file: process.execPath })
  assert.equal(started.length, 1)
  // One profile listed: a session that names none is in it.
  const one = { ...opts, profiles: profileSet([DEFAULT], DEFAULT.dir) }
  assert.equal((await startCall(cfg, { ...call, profile: null }, one)).ok, true)
  assert.equal(started.length, 2)
  // One shown, a hidden folder found besides: a session with no card yet is in the shown one, as
  // before profiles; one that reported a folder no profile has is still refused.
  const shown = profileSet([DEFAULT, { ...WORK, hidden: true }], DEFAULT.dir)
  const cardless = { ...call, ...sessionProfile(null, shown.list) }
  assert.equal(cardless.profile, null)
  assert.deepEqual(await startCall(cfg, cardless, { ...opts, profiles: shown }), { ok: true, file: process.execPath })
  assert.equal(started.length, 3)
  const stray = await startCall(
    cfg,
    { ...call, profile: null, profileFolder: '/srv/.claude-x' },
    { ...opts, profiles: shown },
  )
  assert.match(stray.ok ? '' : stray.error, /a call from \/srv\/\.claude-x would run in the wrong account/)
  assert.equal(started.length, 3)
})

test('whether the page offers calls: looked up again when the setting changes, and once a minute', () => {
  let now = 1_000
  const asked: unknown[] = []
  const cfg: Partial<Config> = { mokupilot: { command: ['/opt/mp/MokuPilot'] } }
  const on = mokupilotCheck(cfg, {
    now: () => now,
    find: c => {
      asked.push(c.mokupilot)
      return { state: c.mokupilot === false ? 'off' : 'ok' }
    },
  })
  assert.equal(on(), true)
  now += 59_000
  assert.equal(on(), true)
  assert.equal(asked.length, 1)
  // The live config changed: asked again at once.
  cfg.mokupilot = false
  assert.equal(on(), false)
  assert.equal(asked.length, 2)
  // A minute on: asked again, for one installed or removed meanwhile.
  now += 60_001
  on()
  assert.equal(asked.length, 3)
})
