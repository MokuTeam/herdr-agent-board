// `board list` with the calendar (#328) off, absent and on: the same lines and the same herdr calls
// each time, no calendar source asked, nothing of the calendar written. The calendar is read only
// by `board cal` and the web board's own routes and timer.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const configDir = (box: Sandbox): string => join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')

function herdrState(box: Sandbox): void {
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'Work' }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
          panes: [
            {
              pane_id: 'w1:p1',
              tab_id: 't1',
              workspace_id: 'w1',
              agent: 'claude',
              agent_session: { value: 's-run' },
              agent_status: 'idle',
              cwd: box.dir,
              terminal_title_stripped: 'Running',
            },
          ],
        },
      },
    },
  })
}

test('board list: the same with the calendar absent, off and on; no source asked, nothing written', async () => {
  let asked = 0
  const source = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      asked++
      return new Response('', { status: 500 })
    },
  })
  const wake = await fakeWake()
  const sources = [{ id: 'work', kind: 'mcp', url: `http://127.0.0.1:${source.port}/mcp`, list: { tool: 'list' } }]
  try {
    const runs: { out: string; calls: string[][] }[] = []
    for (const calendar of [undefined, { on: false, sources }, { on: true, sources }]) {
      const box = await sandbox()
      herdrState(box)
      mkdirSync(configDir(box), { recursive: true })
      writeFileSync(
        join(configDir(box), 'config.json'),
        JSON.stringify({ language: 'en', port: 9, wake: false, wakeUrl: wake.url, ...(calendar && { calendar }) }),
      )
      const out = await box.run('cli', { args: ['list'], env: {} }).exited
      assert.equal(out.code, 0, out.stderr)
      runs.push({ out: out.stdout, calls: box.calls() })
      assert.equal(existsSync(join(stateDir(box), 'calendar')), false)
      assert.equal(existsSync(join(stateDir(box), 'board.db')), false)
    }
    assert.match(runs[0]?.out ?? '', /Running/)
    assert.deepEqual(runs[1], runs[0])
    assert.deepEqual(runs[2], runs[0])
    assert.equal(asked, 0)
  } finally {
    source.stop(true)
    wake.down()
  }
})
