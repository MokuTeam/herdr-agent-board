// `board tg-key` (#119): the Telegram key claude-tg puts in TG_KEY, without Node. In herdr
// (HERDR_PANE_ID) the topic of the pane's tab, from one `herdr api snapshot`; outside herdr, or
// with a herdr that does not answer, the folder. It prints the key and exits 0 whatever happens.
// Ported from herdr-wake's tg-key.mjs cases, through the CLI with the compiled fake herdr.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { asciiKey } from '../../src/core/wake/topics.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const SNAPSHOT = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Счета 2' },
    { workspace_id: 'w3', label: '' },
    { workspace_id: 'w4', label: 'Счета' },
  ],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'hotfix', number: 2 },
    { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
    { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
    { tab_id: 'w3:t1', workspace_id: 'w3', label: '1', number: 1 },
    { tab_id: 'w4:t1', workspace_id: 'w4', label: '1', number: 1 },
  ],
  panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' },
    { pane_id: 'w3:p1', tab_id: 'w3:t1', workspace_id: 'w3' },
    { pane_id: 'w4:p1', tab_id: 'w4:t1', workspace_id: 'w4' },
  ],
}

/** `board tg-key` in a pane (none: outside herdr): its output, exit code and herdr's calls. */
async function tgKey(box: Sandbox, pane?: string) {
  const out = await box.run('cli', { args: ['tg-key'], env: pane ? { HERDR_PANE_ID: pane } : {} }).exited
  return { code: out.code, stdout: out.stdout, stderr: out.stderr, calls: box.calls() }
}

test('board tg-key: the tab’s topic in herdr, the folder outside', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: SNAPSHOT } } })
  const folder = asciiKey(root.replace(/[\\/]+$/, ''))
  for (const [pane, key] of [
    ['w1:p1', 'topic:Billing'],
    ['w1:p3', 'topic:Billing / hotfix'],
    // Headers are ASCII: the rest of the name is dropped.
    ['w2:p1', 'topic: 2'],
    // No workspace name, or none left in ASCII: the folder, never a nameless topic.
    ['w3:p1', folder],
    ['w4:p1', folder],
    // A pane herdr does not know.
    ['gone', folder],
  ] as const) {
    const r = await tgKey(box, pane)
    expect([pane, r.code, r.stdout, r.stderr]).toEqual([pane, 0, `${key}\n`, ''])
  }
  // One snapshot per call.
  expect(box.calls()).toEqual(Array(6).fill(['api', 'snapshot']))
})

test('outside herdr: the folder, and herdr is not asked', async () => {
  const box = await sandbox()
  box.state({})
  const r = await tgKey(box)
  expect([r.code, r.stdout.trim()]).toEqual([0, asciiKey(root.replace(/[\\/]+$/, ''))])
  expect(r.calls).toEqual([])
})

test('a herdr that fails: the folder, exit 0, nothing on stderr', async () => {
  const box = await sandbox()
  // The fake herdr has no answer for the snapshot: it fails.
  box.state({})
  const r = await tgKey(box, 'w1:p3')
  expect([r.code, r.stdout.trim(), r.stderr]).toEqual([0, asciiKey(root.replace(/[\\/]+$/, '')), ''])
  expect(r.calls).toEqual([['api', 'snapshot']])
})
