import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  peerOf,
  promptOf,
  promptsOf,
  spawnOf,
  spawnResult,
  spawnResults,
  spawnsOf,
  teammateMessages,
} from '../../src/core/transcript-links.ts'

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

test('the board links a session to the one that started it with spawn-agent, either spelling', () => {
  assert.deepEqual(spawnOf('Bash', { command: 'spawn-agent --name "Case 7" --cwd C:/w --brief-file b.txt' }), {
    name: 'Case 7',
  })
  assert.deepEqual(spawnOf('Bash', { command: "spawn-agent --name='Case 8' --cwd ." }), { name: 'Case 8' })
  assert.deepEqual(spawnOf('PowerShell', { command: 'spawn-agent.cmd -Name x -Cwd .' }), { name: 'x' })
  assert.deepEqual(spawnOf('PowerShell', { command: 'Spawn-Agent -name Mixed -cwd .' }), { name: 'Mixed' })
  assert.equal(spawnOf('Bash', { command: 'spawn-agent --named x' }), null)
  assert.deepEqual(spawnResult('pane=wP:p3 name=Case 7 agent=case-7'), { pane: 'wP:p3', name: 'Case 7' })
})

test("another session's or a teammate's message comes whole (#174); its summary stays short", () => {
  const long = `${'a long brief for the helper '.repeat(400)}end`
  assert.equal(peerOf({ kind: 'peer', name: 'Master', body: long }, '')?.text, long)
  const [mate] = teammateMessages(
    `<teammate-message teammate_id="lead" summary="${'s'.repeat(300)}">${long}</teammate-message>`,
  )
  assert.equal(mate?.text, long)
  assert.equal(mate?.summary?.length, 200)
})

test('#281: every spawn-agent of one call, and every session it printed, in order', () => {
  const bash = (command: string) => spawnsOf('Bash', { command })
  assert.deepEqual(
    bash('spawn-agent --name Orchestrator --cwd ~/orchestrator && spawn-agent --name Herdr --cwd ~/herdr-agent-board'),
    [{ name: 'Orchestrator' }, { name: 'Herdr' }],
  )
  // PowerShell, names with spaces, other alphabets and %, a variable, one without a name.
  assert.deepEqual(
    spawnsOf('PowerShell', {
      command:
        "spawn-agent.ps1 -Name 'Кейс 42' -Cwd 'C:\\w\\a b'; spawn-agent.ps1 -Cwd C:\\w; spawn-agent.ps1 -Name \"50% done\"; spawn-agent.ps1 -Name $n",
    }),
    [{ name: 'Кейс 42' }, { name: '50% done' }, { name: '' }],
  )
  // One spawn-agent: as before.
  assert.deepEqual(bash('spawn-agent --name=case-42 --cwd /w'), [{ name: 'case-42' }])
  assert.deepEqual(spawnOf('Bash', { command: 'spawn-agent --name A && spawn-agent --name B' }), { name: 'A' })
  assert.deepEqual(bash('echo spawn-agent'), [])
  assert.deepEqual(spawnsOf('Read', { command: 'spawn-agent --name A' }), [])

  const printed = 'pane=w1:p2 name=Orchestrator agent=Orchestrator\nready\npane=w2:p1 name=Кейс 42 agent=x\n'
  assert.deepEqual(spawnResults(printed), [
    { pane: 'w1:p2', name: 'Orchestrator' },
    { pane: 'w2:p1', name: 'Кейс 42' },
  ])
  assert.deepEqual(spawnResult(printed), { pane: 'w1:p2', name: 'Orchestrator' })
  assert.deepEqual(spawnResults('No such folder'), [])
})

test('herdr typing into another pane: each command a call runs, not one it only mentions', () => {
  const bash = (command: string) => promptsOf('Bash', { command })
  const pwsh = (command: string) => promptsOf('PowerShell', { command })
  assert.deepEqual(bash('herdr agent prompt Herdr "Go on with PR 2"'), [{ target: 'Herdr', verb: 'agent prompt' }])
  // Its options before or after the target; herdr's own before its command.
  assert.deepEqual(bash("herdr agent prompt --wait Herdr-edgelog 'x' --until idle --timeout 5000"), [
    { target: 'Herdr-edgelog', verb: 'agent prompt' },
  ])
  assert.deepEqual(bash('herdr --machine vps pane run w1:p2 "bun test"'), [{ target: 'w1:p2', verb: 'pane run' }])
  // Several in one call, each recorded; a line that goes on, an env variable in front.
  assert.deepEqual(
    bash(
      "herdr pane send-text w8:p4 'hi' && herdr pane send-keys w8:p4 Enter\nX=1 herdr agent \\\n  send-keys case-42 esc",
    ),
    [
      { target: 'w8:p4', verb: 'pane send-text' },
      { target: 'w8:p4', verb: 'pane send-keys' },
      { target: 'case-42', verb: 'agent send-keys' },
    ],
  )
  // Names with spaces, other alphabets and %; a variable is no name; a shell's own command line.
  assert.deepEqual(
    bash('herdr agent prompt "Кейс 42 — 50%" ok; herdr agent prompt "$T" ok; bash -c "herdr agent prompt Q hi"'),
    [
      { target: 'Кейс 42 — 50%', verb: 'agent prompt' },
      { target: '', verb: 'agent prompt' },
      { target: 'Q', verb: 'agent prompt' },
    ],
  )
  // PowerShell: herdr.exe by its path, the call operator, a here-string that only holds the words.
  assert.deepEqual(
    pwsh(
      '$b = @"\nherdr agent prompt X hi\n"@\n& C:\\Tools\\herdr.exe agent prompt \'Case 42\' $b; herdr pane send-keys w1:p3 Enter <# herdr agent prompt Z #>',
    ),
    [
      { target: 'Case 42', verb: 'agent prompt' },
      { target: 'w1:p3', verb: 'pane send-keys' },
    ],
  )
  // Mentions only: an echo, a file written with a here-document, a commit message, a search, a
  // comment, its help, another herdr command, the calling pane itself, another tool.
  for (const command of [
    'echo "herdr agent prompt Herdr hi"',
    "cat > CLAUDE.md <<'EOF'\nUse herdr agent prompt Herdr hi to wake it.\nEOF\nls",
    'cat <<-EOF > brief.md\n\therdr pane send-text w1:p1 x\n\tEOF',
    'git commit -m "Docs: herdr agent prompt <target>"',
    "grep -rn 'herdr agent prompt' src",
    '# herdr agent prompt Herdr hi',
    'herdr agent prompt --help',
    'herdr pane send-keys -h',
    'herdr agent list',
    'herdr pane send-text --current hi',
    'spawn-agent --name herdr-prompt',
  ])
    assert.deepEqual(bash(command), [], command)
  assert.deepEqual(promptsOf('Read', { command: 'herdr agent prompt X hi' }), [])
  assert.deepEqual(promptsOf('Bash', null), [])
})
