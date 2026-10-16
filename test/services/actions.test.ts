import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { sandbox } from '../support/sandbox.ts'

setDefaultTimeout(10_000)

describe('send', () => {
  for (const sleeping of [false, true]) {
    for (const identity of ['same', 'different', 'missing', 'no-agent', 'blocked']) {
      test(`sleeping=${sleeping}, identity=${identity}`, async () => {
        const box = await sandbox()
        const reply = {
          'agent get': {
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
          },
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
            const out = await box.run('send', {
              item: { pane: 'pane1', session: 'expected', name: 'Test', sleeping },
              cfg,
              text: '-hello',
            }).exited
            assert.equal(out.code, 0, out.stderr)
            assert.equal(JSON.parse(out.stdout).ok, identity === 'same')
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
          assert.equal(JSON.parse(out.stdout).ok, identity === 'same')
        }
        assert.equal(wakes, sleeping ? 1 : 0)
        assert.deepEqual(
          box.calls().filter(a => a[1] === 'prompt'),
          identity === 'same' ? [['agent', 'prompt', 'pane1', ' -hello']] : [],
        )
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
