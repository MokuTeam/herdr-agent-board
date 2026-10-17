import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { promptOf, spawnOf, spawnResult } from '../../src/core/transcript-links.ts'

test('what a helper was asked: the prompt without the frames around it', () => {
  assert.deepEqual(promptOf('Review the diff.'), { prompt: 'Review the diff.', from: '' })
  // A prompt that only quotes the boilerplate's closing tag is not a fork's.
  assert.equal(promptOf('Explain what </fork-boilerplate> ends.')?.prompt, 'Explain what </fork-boilerplate> ends.')
  // A fork: the parent's history is inherited; its directive follows the boilerplate.
  assert.deepEqual(
    promptOf('<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nYour directive: Audit slice `a`.'),
    { prompt: 'Audit slice `a`.', from: '' },
  )
  assert.deepEqual(
    promptOf(
      '<teammate-message teammate_id="team-lead" summary="Check the design">\nIs the design sound?\n</teammate-message>',
    ),
    { prompt: 'Is the design sound?', from: 'team-lead' },
  )
  // A workflow agent: the relayed user request is not its task; the computed task is, dedented.
  assert.equal(promptOf('[Workflow harness — user request] The harness relays...:\n  polish it'), null)
  assert.deepEqual(
    promptOf(
      '[Workflow harness — computed task] The task text below...:\n  \n  Audit the home screen.\n  Report back.',
    ),
    { prompt: 'Audit the home screen.\nReport back.', from: '' },
  )
})

test('spawn-agent calls and what they print', () => {
  assert.deepEqual(spawnOf('Bash', { command: 'spawn-agent -Name board-x -Cwd C:\\w' }), { name: 'board-x' })
  assert.deepEqual(spawnOf('PowerShell', { command: '$r = spawn-agent -Name "Case 7" -Cwd .' }), { name: 'Case 7' })
  assert.deepEqual(spawnOf('Bash', { command: 'spawn-agent -Name $Name -Cwd .' }), { name: '' }) // a variable: the output names it
  assert.equal(spawnOf('Bash', { command: 'cat ~/.local/bin/spawn-agent.ps1' }), null)
  assert.equal(spawnOf('Bash', { command: 'grep -n spawn-agent notes.md' }), null) // no -Name: not a start
  assert.equal(spawnOf('Read', { command: 'spawn-agent -Name x' }), null)
  assert.deepEqual(spawnResult('result: pane=wP:pF name=spawn test agent=spawn-test\ntook: 8 s'), {
    pane: 'wP:pF',
    name: 'spawn test',
  })
  assert.equal(spawnResult('Claude did not get ready'), null)
})
