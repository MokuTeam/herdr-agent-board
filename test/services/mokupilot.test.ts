// Starting a MokuPilot call (services/mokupilot.ts startCall): upstream's test/mokupilot.test.mjs
// (#44), its third test, with a stand-in for spawn; then whether the page offers calls at all,
// looked up again when the setting changes and once a minute.
import { beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SpawnOptions } from 'node:child_process'
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
    // No mode: auto, and with no request the board's own computer, which has no MokuPilot.
    assert.match(
      missing.ok ? '' : missing.error,
      /MokuPilot is not installed on this computer \(\/opt\/mp\/MokuPilot\)/,
    )

    const real = { mokupilot: { command: [process.execPath] } }
    // No request to say who asks (a test, the CLI): the board's own computer, as before the modes.
    assert.deepEqual(await startCall(real, item, opts), {
      ok: true,
      state: 'launched',
      file: process.execPath,
      resolved: 'local',
      why: 'no-peer',
    })
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

test('launcher spawn acknowledges only launched, including an immediate application failure', async () => {
  const run: Run = () => {
    const child = new EventEmitter()
    queueMicrotask(() => {
      child.emit('spawn')
      child.emit('exit', 2, null)
    })
    return Object.assign(child, { unref() {} }) as unknown as CallChild
  }
  const result = await startCall(
    { mokupilot: { command: [process.execPath] } },
    { session: ID, agent: 'claude', cwd: '' },
    { run },
  )
  assert.equal(result.ok, true)
  const state = result.ok ? result.state : null
  assert.equal(state, 'launched')
  assert.notEqual(state, 'ready')
  assert.notEqual(state, 'recording')
})

test('a call from a session in another profile than the board’s starts MokuPilot in that profile', async () => {
  const DEFAULT = { id: 'default', title: 'Default', dir: '/home/u/.claude', color: 'indigo', hidden: false }
  const WORK = { id: 'work', title: 'Work', dir: '/home/u/.claude-work', color: 'teal', hidden: false }
  const SET = profileSet([DEFAULT, WORK], DEFAULT.dir)
  const started: { args: string[]; env: SpawnOptions['env'] }[] = []
  const run: Run = (_file, args, options) => {
    started.push({ args, env: options.env })
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('spawn'))
    return Object.assign(child, { unref() {} }) as unknown as CallChild
  }
  const cfg = { mokupilot: { command: [process.execPath] } }
  const call = { agent: 'claude', session: ID, cwd: tmpdir(), transcript: null }
  const opts = { platform: 'linux', env: { PATH: '' }, profiles: SET, run }
  const launched = { ok: true, state: 'launched', file: process.execPath, resolved: 'local', why: 'no-peer' }
  const configDir = () => started.at(-1)?.env?.CLAUDE_CONFIG_DIR

  // MokuPilot finds the session and runs its fork in the profile its launcher starts in, and hands
  // that to a copy already running in another: same command line, the session's folder in the env.
  assert.deepEqual(await startCall(cfg, { ...call, profile: 'work' }, opts), launched)
  assert.deepEqual(started.at(-1)?.args, ['call', '--claude-session', ID, '--cwd', tmpdir()])
  assert.equal(configDir(), WORK.dir)
  assert.equal(started.at(-1)?.env?.PATH, '')
  // A folder no profile has, that the session reported: that folder.
  assert.deepEqual(await startCall(cfg, { ...call, profile: null, profileFolder: '/srv/.claude-x' }, opts), launched)
  assert.equal(configDir(), '/srv/.claude-x')
  // The board in Work, the session in the default profile: its folder, set as for a launch.
  const fromWork = { ...opts, profiles: profileSet([DEFAULT, WORK], WORK.dir), env: { CLAUDE_CONFIG_DIR: WORK.dir } }
  assert.deepEqual(await startCall(cfg, { ...call, profile: 'default' }, fromWork), launched)
  assert.equal(configDir(), DEFAULT.dir)
  assert.equal(started.length, 3)

  // A session whose profile the board does not know: refused, as nothing says which account it is.
  const unknown = await startCall(cfg, { ...call, profile: null }, opts)
  assert.deepEqual(unknown, {
    ok: false,
    error: 'The folder of this session’s profile is not known (unknown profile): a call could run in the wrong account',
  })
  assert.equal(started.length, 3)

  // The board's own profile: the env as the board inherited it, as before profiles.
  assert.deepEqual(await startCall(cfg, { ...call, profile: 'default' }, opts), launched)
  assert.equal(Object.hasOwn(started.at(-1)?.env ?? {}, 'CLAUDE_CONFIG_DIR'), false)
  assert.deepEqual(await startCall(cfg, { ...call, profile: 'work' }, fromWork), launched)
  assert.equal(configDir(), WORK.dir)
  assert.equal(started.length, 5)
  // One profile listed: a session that names none is in it.
  const one = { ...opts, profiles: profileSet([DEFAULT], DEFAULT.dir) }
  assert.equal((await startCall(cfg, { ...call, profile: null }, one)).ok, true)
  assert.equal(configDir(), undefined)
  // One shown, a hidden folder found besides: a session with no card yet is in the shown one, as
  // before profiles.
  const shown = profileSet([DEFAULT, { ...WORK, hidden: true }], DEFAULT.dir)
  const cardless = { ...call, ...sessionProfile(null, shown.list) }
  assert.equal(cardless.profile, null)
  assert.deepEqual(await startCall(cfg, cardless, { ...opts, profiles: shown }), launched)
  assert.equal(configDir(), undefined)
  // No profiles at all (the CLI, a test): the env as it is.
  assert.deepEqual(
    await startCall(cfg, { ...call, profile: 'work' }, { platform: 'linux', env: { PATH: '' }, run }),
    launched,
  )
  assert.equal(configDir(), undefined)
  assert.equal(started.length, 8)
})

test('whether the page offers calls: looked up again when the setting changes, and once a minute', () => {
  let now = 1_000
  const asked: unknown[] = []
  // This machine: the mode that asks whether MokuPilot is here.
  const cfg: Partial<Config> = { mokupilot: { command: ['/opt/mp/MokuPilot'], mode: 'local' } }
  const on = mokupilotCheck(cfg, {
    now: () => now,
    find: c => {
      asked.push(c.mokupilot)
      return { state: JSON.stringify(c.mokupilot).includes('/gone') ? 'missing' : 'ok' }
    },
  })
  assert.equal(on(), true)
  now += 59_000
  assert.equal(on(), true)
  assert.equal(asked.length, 1)
  // The live config changed: asked again at once.
  cfg.mokupilot = { command: ['/gone/MokuPilot'], mode: 'local' }
  assert.equal(on(), false)
  assert.equal(asked.length, 2)
  // A minute on: asked again, for one installed or removed meanwhile.
  now += 60_001
  on()
  assert.equal(asked.length, 3)
})

test('link mode starts nothing here: the page gets the link, the folder the session started in in it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mokupilot-'))
  try {
    const project = join(dir, 'Acme project & co')
    mkdirSync(project)
    const transcript = join(dir, `${ID}.jsonl`)
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: project, sessionId: ID })}\n`)
    const runs: string[] = []
    const run: Run = file => {
      runs.push(file)
      throw new Error('link mode must not spawn')
    }
    // A command beside the link, one that would start: the link goes first all the same.
    for (const cfg of [{ mokupilot: { link: true } }, { mokupilot: { link: true, command: [process.execPath] } }]) {
      const opts = { platform: 'linux', env: { PATH: '' }, run }
      const item = { key: ID, session: ID, agent: 'claude', cwd: join(dir, 'elsewhere'), transcript }
      assert.deepEqual(await startCall(cfg, item, opts), {
        ok: true,
        state: 'link',
        url: `mokupilot://call?claude-session=${ID}&cwd=${encodeURIComponent(project)}`,
        resolved: 'link',
        why: 'mode-link',
      })
      // No folder on disk: no cwd.
      assert.deepEqual(await startCall(cfg, { ...item, transcript: null, cwd: join(dir, 'gone') }, opts), {
        ok: true,
        state: 'link',
        url: `mokupilot://call?claude-session=${ID}`,
        resolved: 'link',
        why: 'mode-link',
      })
      for (const bad of [
        { ...item, agent: 'codex' },
        { ...item, session: null },
        { ...item, session: 'pane-p1' },
      ]) {
        const out = await startCall(cfg, bad, opts)
        assert.equal(out.ok, false)
        assert.match(out.ok ? '' : out.error, /Claude Code session/)
      }
      // Another profile than the board's: refused before a link. The viewer's MokuPilot runs the
      // fork over ssh in its login's profile, which the board cannot set.
      const profiles = profileSet(
        [
          { id: 'default', title: 'Default', dir: '/home/u/.claude', color: 'indigo', hidden: false },
          { id: 'work', title: 'Work', dir: '/home/u/.claude-work', color: 'teal', hidden: false },
        ],
        '/home/u/.claude',
      )
      const other = await startCall(cfg, { ...item, profile: 'work' }, { ...opts, profiles })
      assert.match(other.ok ? '' : other.error, /a call from Work would run in the wrong account/)
    }
    assert.deepEqual(runs, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('link mode offers the call on the page, with nothing installed here', () => {
  assert.equal(mokupilotCheck({ mokupilot: { link: true } })(), true)
  assert.equal(mokupilotCheck({ mokupilot: false })(), false)
})

test('the mode decides where a call starts; under auto, who asks: here or by the link, and why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mokupilot-'))
  try {
    const project = join(dir, 'Acme')
    mkdirSync(project)
    const runs: string[] = []
    const run: Run = file => {
      runs.push(file)
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('spawn'))
      return Object.assign(child, { unref() {} }) as unknown as CallChild
    }
    let asked = 0
    const own = () => {
      asked++
      return ['192.168.1.20', '100.101.102.103']
    }
    const item = { key: ID, session: ID, agent: 'claude', cwd: project, transcript: null }
    const link = `mokupilot://call?claude-session=${ID}&cwd=${encodeURIComponent(project)}`
    const here = { platform: 'linux', env: { PATH: '' }, run, own }
    const local = { viewer: { peer: '127.0.0.1', forwardedFor: null } }
    const phone = { viewer: { peer: '127.0.0.1', forwardedFor: '100.64.0.7' } }
    const self = { viewer: { peer: '::ffff:127.0.0.1', forwardedFor: '100.101.102.103' } }
    const launched = { ok: true, state: 'launched', file: process.execPath }
    const linked = { ok: true, state: 'link', url: link }

    for (const set of [{ command: [process.execPath] }, { command: [process.execPath], mode: 'auto' }]) {
      const cfg = { mokupilot: set }
      assert.deepEqual(await startCall(cfg, item, { ...here, ...local }), {
        ...launched,
        resolved: 'local',
        why: 'loopback-direct',
        viewer: '127.0.0.1',
      })
      assert.deepEqual(await startCall(cfg, item, { ...here, ...phone }), {
        ...linked,
        resolved: 'link',
        why: 'forwarded-other',
        viewer: '100.64.0.7',
      })
      assert.deepEqual(await startCall(cfg, item, { ...here, ...self }), {
        ...launched,
        resolved: 'local',
        why: 'forwarded-own',
        viewer: '100.101.102.103',
      })
    }
    assert.equal(runs.length, 4)

    // local: here for everyone; link: the link for everyone. Neither asks for this computer's addresses.
    asked = 0
    const forLocal = { mokupilot: { command: [process.execPath], mode: 'local' } }
    const forLink = { mokupilot: { command: [process.execPath], mode: 'link' } }
    for (const who of [local, phone, self]) {
      assert.deepEqual(await startCall(forLocal, item, { ...here, ...who }), {
        ...launched,
        resolved: 'local',
        why: 'mode-local',
      })
      assert.deepEqual(await startCall(forLink, item, { ...here, ...who }), {
        ...linked,
        resolved: 'link',
        why: 'mode-link',
      })
    }
    assert.equal(asked, 0)
    assert.equal(runs.length, 7)

    // The older key, a `mode` beside it winning.
    assert.equal((await startCall({ mokupilot: { link: true } }, item, { ...here, ...local })).ok, true)
    assert.deepEqual(
      await startCall({ mokupilot: { link: true, mode: 'local', command: [process.execPath] } }, item, {
        ...here,
        ...phone,
      }),
      { ...launched, resolved: 'local', why: 'mode-local' },
    )
    assert.equal(runs.length, 8)

    // Nothing installed here: auto gives a viewer elsewhere the link all the same; at this computer
    // and under local it is MokuPilot not found, saying where the call went.
    const none = { mokupilot: { command: [join(dir, 'no-such-MokuPilot')] } }
    assert.deepEqual(await startCall(none, item, { ...here, ...phone }), {
      ...linked,
      resolved: 'link',
      why: 'forwarded-other',
      viewer: '100.64.0.7',
    })
    const there = await startCall(none, item, { ...here, ...local })
    assert.equal(there.ok, false)
    assert.match(there.ok ? '' : there.error, /MokuPilot is not installed on this computer/)
    assert.equal(there.resolved, 'local')
    assert.equal(there.why, 'loopback-direct')
    const forced = await startCall({ mokupilot: { ...none.mokupilot, mode: 'local' } }, item, { ...here, ...phone })
    assert.equal(forced.ok, false)
    assert.equal(forced.why, 'mode-local')
    // Turned off: off for everyone, nothing resolved.
    assert.deepEqual(await startCall({ mokupilot: false }, item, { ...here, ...phone }), {
      ok: false,
      error: 'MokuPilot is turned off in config.json ("mokupilot": false)',
    })
    assert.equal(runs.length, 8)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('whether the page offers calls, by the mode: off and This machine without MokuPilot hide it', () => {
  const missing = () => ({ state: 'missing' })
  const ok = () => ({ state: 'ok' })
  const offered = (mokupilot: unknown, find = missing) => mokupilotCheck({ mokupilot }, { find })()
  // Auto (said, unsaid, the default with nothing set): offered, MokuPilot here or not.
  for (const set of [undefined, {}, { mode: 'auto' }, { command: ['/opt/mp/MokuPilot'] }, { mode: 'bogus' }])
    assert.equal(offered(set), true, JSON.stringify(set))
  // The link, the panel's or the older key: offered, nothing here needed.
  assert.equal(offered({ mode: 'link' }), true)
  assert.equal(offered({ link: true }), true)
  // This machine: only with MokuPilot found here.
  assert.equal(offered({ mode: 'local' }), false)
  assert.equal(offered({ mode: 'local' }, ok), true)
  assert.equal(offered({ link: true, mode: 'local' }), false)
  // Off: never.
  assert.equal(offered(false), false)
  assert.equal(offered(false, ok), false)
})

test('under auto at this computer without MokuPilot: the error says it is not installed here, and where to switch', async () => {
  for (const [lang, words] of [
    [
      'en',
      /MokuPilot is not installed on this computer \(.*no-such\).*“The computer you’re viewing from” in Settings → MokuPilot…/,
    ],
    ['ru', /MokuPilot не установлен на этом компьютере.*«Компьютер, с которого ты смотришь» в Настройках → MokuPilot…/],
  ] as const) {
    // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
    useLanguage(lang)
    const item = { key: ID, session: ID, agent: 'claude', cwd: tmpdir(), transcript: null }
    const r = await startCall({ mokupilot: { command: ['/opt/no-such'] } }, item, {
      platform: 'linux',
      env: { PATH: '' },
      viewer: { peer: '127.0.0.1', forwardedFor: null },
      own: () => [],
    })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.error, words)
    // This machine keeps its own text.
    const local = await startCall({ mokupilot: { command: ['/opt/no-such'], mode: 'local' } }, item, {
      platform: 'linux',
      env: { PATH: '' },
    })
    assert.doesNotMatch(local.ok ? '' : local.error, /Settings → MokuPilot|Настройках/)
  }
  useLanguage('en')
})
