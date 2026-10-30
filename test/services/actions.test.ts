import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { sandbox } from '../support/sandbox.ts'

setDefaultTimeout(10_000)

describe('send', () => {
  const agentOf = (identity: string) => ({
    result: {
      agent:
        identity === 'no-agent'
          ? null
          : {
              agent_status: identity === 'blocked' ? 'blocked' : 'idle',
              ...(identity === 'missing'
                ? {}
                : { agent_session: { value: identity === 'different' ? 'replacement' : 'expected' } }),
            },
    },
  })
  for (const sleeping of [false, true]) {
    // late: herdr names the session on its third read (its SessionStart hook after Claude is up, #267).
    for (const identity of ['same', 'different', 'missing', 'no-agent', 'blocked', 'late']) {
      // A session it just woke is waited for until herdr names it; an awake one is not.
      const sent = identity === 'same' || (sleeping && identity === 'late')
      test(`sleeping=${sleeping}, identity=${identity}`, async () => {
        const box = await sandbox()
        const reply = {
          'agent get':
            identity === 'late'
              ? { seq: [agentOf('missing'), agentOf('missing'), agentOf('same')] }
              : agentOf(identity),
          'agent prompt': { result: {} },
        }
        box.state(sleeping ? { 'agent get': { error: 'must wake first' } } : reply)
        let wakes = 0
        const cfg: { wakeUrl?: string } = {}
        if (sleeping) {
          const server = http.createServer((req, res) => {
            assert.equal(req.url, '/wake')
            wakes++
            box.state(reply)
            res.setHeader('content-type', 'application/json')
            res.end('{"ok":true}')
          })
          await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
          try {
            cfg.wakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
            // The wait for herdr to name a just woken session, 3 s instead of 15.
            const out = await box.run(
              'send',
              { item: { pane: 'pane1', session: 'expected', name: 'Test', sleeping }, cfg, text: '-hello' },
              { BOARD_NAMED_WAIT_MS: '3000' },
            ).exited
            assert.equal(out.code, 0, out.stderr)
            assert.equal(JSON.parse(out.stdout).ok, sent)
          } finally {
            await new Promise(resolve => server.close(resolve))
          }
        } else {
          const out = await box.run('send', {
            item: { pane: 'pane1', session: 'expected', name: 'Test', sleeping },
            cfg,
            text: '-hello',
          }).exited
          assert.equal(out.code, 0, out.stderr)
          assert.equal(JSON.parse(out.stdout).ok, sent)
        }
        assert.equal(wakes, sleeping ? 1 : 0)
        assert.deepEqual(
          box.calls().filter(a => a[1] === 'prompt'),
          sent ? [['agent', 'prompt', 'pane1', ' -hello']] : [],
        )
        // An awake session, or a just woken one herdr shows without an agent or with another
        // session, is read once; one it shows without a session yet is read again.
        const reads = box.calls().filter(a => a[0] === 'agent' && a[1] === 'get').length
        const waited = sleeping && (identity === 'missing' || identity === 'late')
        assert.ok(waited ? reads >= 3 : reads === 1, `${reads} reads`)
      })
    }
  }

  test('refuses when a previously unknown identity becomes a different known session', async () => {
    const box = await sandbox()
    box.state({ 'agent get': { result: { agent: { agent_session: { value: 'new-session' }, agent_status: 'idle' } } } })
    const out = await box.run('send', { cfg: {}, item: { pane: 'p', session: null, name: 'Test' }, text: 'hello' })
      .exited
    assert.equal(out.code, 0, out.stderr)
    expect(JSON.parse(out.stdout).ok).toBe(false)
    assert.equal(box.calls().length, 1)
  })
})

describe('waking a session of another profile than the board’s', () => {
  const REFUSED =
    'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it'

  /**
   * A sandbox whose home has the default and work profiles, herdr showing pane1 holding terminal
   * `terminal` (null: herdr does not say), the board's launches having left `panes` as
   * profile-panes.json (null: none); then `send` to the sleeping session of `profile` in pane1
   * through a herdr-wake stand-in: its answer, how often herdr-wake was asked to wake it, and
   * herdr's calls.
   */
  async function sendToSleeper(
    panes: Record<string, unknown> | null,
    { profile = 'work', terminal = 'term-1' }: { profile?: string; terminal?: string | null } = {},
  ): Promise<{ out: unknown; wakes: number; calls: string[][] }> {
    const box = await sandbox()
    const home = join(box.dir, 'home')
    for (const name of ['.claude', '.claude-work']) {
      mkdirSync(join(home, name), { recursive: true })
      writeFileSync(join(home, name, 'settings.json'), '{}')
    }
    if (panes) {
      const file = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'profile-panes.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(panes))
    }
    const pane = terminal === null ? { pane_id: 'pane1' } : { pane_id: 'pane1', terminal_id: terminal }
    const snapshot = { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } }
    box.state({ 'api snapshot': snapshot, 'agent get': { error: 'must wake first' } })
    let wakes = 0
    const server = http.createServer((req, res) => {
      assert.equal(req.url, '/wake')
      wakes++
      box.state({
        'api snapshot': snapshot,
        'agent get': { result: { agent: { agent_status: 'idle', agent_session: { value: 'expected' } } } },
        'agent prompt': { result: {} },
      })
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const cfg = {
        language: 'en',
        wakeUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        profiles: [
          { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
          { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
        ],
      }
      const item = { pane: 'pane1', session: 'expected', name: 'Test', sleeping: true, profile }
      const out = await box.run('send', { item, cfg, text: 'hello' }).exited
      assert.equal(out.code, 0, out.stderr)
      return { out: JSON.parse(out.stdout), wakes, calls: box.calls() }
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  }

  test('a session started outside the board in work is not woken: the reason, and herdr-wake never asked', async () => {
    const { out, wakes } = await sendToSleeper(null)
    expect(out).toEqual({ ok: false, error: REFUSED })
    expect(wakes).toBe(0)
  })

  test('a pane the board opened with work’s --env is woken', async () => {
    const { out, wakes } = await sendToSleeper({ pane1: { profile: 'work', terminal: 'term-1', at: 1 } })
    expect(out).toEqual({ ok: true })
    expect(wakes).toBe(1)
  })

  test('a record of another terminal than the one the pane holds now vouches for nothing', async () => {
    // herdr started over and gave the pane id to a terminal with its own env.
    const { out, wakes } = await sendToSleeper({ pane1: { profile: 'work', terminal: 'term-0', at: 1 } })
    expect(out).toEqual({ ok: false, error: REFUSED })
    expect(wakes).toBe(0)
  })

  const snapshots = (calls: string[][]) => calls.filter(a => a[0] === 'api' && a[1] === 'snapshot').length

  test('the board’s own profile in a pane no record names wakes with no more asked of herdr than before', async () => {
    const { out, wakes, calls } = await sendToSleeper(null, { profile: 'default' })
    expect(out).toEqual({ ok: true })
    expect(wakes).toBe(1)
    expect(snapshots(calls)).toBe(0)
  })

  const IN_WORK_PANE =
    'Its pane was opened in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it'

  test('a default session in a pane the board opened with work’s --env is not woken: herdr-wake would resume it in work', async () => {
    const record = { pane1: { profile: 'work', terminal: 'term-1', at: 1 } }
    // herdr shows the pane holds the terminal recorded, or does not say which it holds.
    for (const terminal of ['term-1', null]) {
      const { out, wakes, calls } = await sendToSleeper(record, { profile: 'default', terminal })
      expect(out).toEqual({ ok: false, error: IN_WORK_PANE })
      expect(wakes).toBe(0)
      expect(snapshots(calls)).toBe(1)
    }
  })

  test('a record of another terminal than the one the pane holds now is no bar to the board’s own profile', async () => {
    const record = { pane1: { profile: 'work', terminal: 'term-1', at: 1 } }
    const { out, wakes } = await sendToSleeper(record, { profile: 'default', terminal: 'term-9' })
    expect(out).toEqual({ ok: true })
    expect(wakes).toBe(1)
  })
})
