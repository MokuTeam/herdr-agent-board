import { test } from 'bun:test'
import assert from 'node:assert/strict'
import manifest from '../../herdr-plugin.toml'
import {
  asSavedBoard,
  BOARD_LABEL,
  closeOfLeftover,
  lastBoard,
  lastBoardChecked,
  leftoverBoards,
  type PaneProcesses,
} from '../../src/core/board-pane.ts'

const panes = [{ pane_id: 'wZ:p1' }, { pane_id: 'wZ:p2' }]
const alive = (pid: number): boolean => pid === 100
const none = (): boolean => {
  throw new Error('no process to look for')
}

test('board.json: the pane and the pid the board wrote; no pane, no board', () => {
  assert.deepEqual(asSavedBoard({ pane: 'wZ:p2', pid: 31804, overlay: false }), { pane: 'wZ:p2', pid: 31804 })
  assert.deepEqual(asSavedBoard({ pane: 'wZ:p2' }), { pane: 'wZ:p2' })
  assert.deepEqual(asSavedBoard({ pane: 'pane-7 a%b', pid: 0 }), { pane: 'pane-7 a%b' })
  assert.deepEqual(asSavedBoard({ pane: 'p', pid: -4 }), { pane: 'p' })
  assert.deepEqual(asSavedBoard({ pane: 'p', pid: '31804' }), { pane: 'p' })
  assert.deepEqual(asSavedBoard({ pane: 'p', pid: 1.5 }), { pane: 'p' })
  for (const value of [null, undefined, 'wZ:p2', 7, [], {}, { pane: '' }, { pane: 3, pid: 100 }, { pid: 100 }])
    assert.equal(asSavedBoard(value), null, JSON.stringify(value))
})

test('board.json: the process that runs the board in its pane (host), when it is a process id', () => {
  assert.deepEqual(asSavedBoard({ pane: 'wZ:p2', pid: 47080, host: 61104, overlay: false }), {
    pane: 'wZ:p2',
    pid: 47080,
    host: 61104,
  })
  for (const host of [0, -1, 1.5, '61104', null])
    assert.deepEqual(asSavedBoard({ pane: 'wZ:p2', pid: 47080, host }), { pane: 'wZ:p2', pid: 47080 }, String(host))
})

test('a board whose pane is there and whose process lives runs', () => {
  assert.deepEqual(lastBoard({ pane: 'wZ:p2', pid: 100 }, panes, alive), { pane: 'wZ:p2', stale: false })
})

test('a pane that is there with the board process gone is stale: herdr brought the pane back, not the board', () => {
  assert.deepEqual(lastBoard({ pane: 'wZ:p2', pid: 31804 }, panes, alive), { pane: 'wZ:p2', stale: true })
})

test('a board.json without a pid (an older board) trusts the pane, as before', () => {
  assert.deepEqual(lastBoard({ pane: 'wZ:p2' }, panes, none), { pane: 'wZ:p2', stale: false })
})

test('pane ids are matched whole, whatever they hold', () => {
  const odd = [{ pane_id: 'pane-7 a%b' }, { pane_id: 'панель:2' }, { pane_id: 'C:\\x y' }]
  for (const { pane_id } of odd) {
    assert.deepEqual(lastBoard({ pane: pane_id, pid: 31804 }, odd, alive), { pane: pane_id, stale: true })
    assert.deepEqual(lastBoard({ pane: pane_id, pid: 100 }, odd, alive), { pane: pane_id, stale: false })
  }
  assert.equal(lastBoard({ pane: 'pane-7', pid: 31804 }, odd, none), null)
  assert.equal(lastBoard({ pane: 'ПАНЕЛЬ:2', pid: 31804 }, odd, none), null)
})

test('no board.json, or a pane that is gone: no board, and no process looked for', () => {
  assert.equal(lastBoard(null, panes, none), null)
  assert.equal(lastBoard({ pane: 'gone', pid: 100 }, panes, none), null)
  assert.equal(lastBoard({ pane: 'wZ:p2', pid: 100 }, [], none), null)
})

// What herdr 0.9.5 says runs in a pane (`pane process-info`), as adapters/herdr.ts reads it. The
// board's pane runs `bun src/entrypoints/run.ts` (the host), which runs the terminal board (tui.ts,
// the pid in board.json) under it; on Windows herdr lists the host alone.
const shellIn = (pid: number): PaneProcesses => ({
  shell: pid,
  foreground: [{ pid, args: ['C:\\Program Files\\Git\\bin\\bash.exe', '-l'] }],
})
const boardIn = (host: number, script = 'src/entrypoints/run.ts'): PaneProcesses => ({
  shell: host,
  foreground: [{ pid: host, args: ['C:\\Users\\me\\.bun\\bin\\bun.EXE', script] }],
})

/** A herdr that answers process-info from `answers` (an Error: it fails), and the panes it was asked of. */
function herdrSays(answers: Record<string, PaneProcesses | null | Error>): {
  asked: string[]
  inPane: (pane: string) => Promise<PaneProcesses | null>
} {
  const asked: string[] = []
  return {
    asked,
    inPane: async pane => {
      asked.push(pane)
      const answer = answers[pane]
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
  }
}

const saved = { pane: 'wZ:p2', pid: 100, host: 61104 }
// herdr keeps the board's label on the pane it restores.
const boardPanes = [{ pane_id: 'wZ:p1' }, { pane_id: 'wZ:p2', label: BOARD_LABEL }]

test('a pid Windows gave to another program: alive, but not in the board’s pane, so the pane is stale', async () => {
  const herdr = herdrSays({ 'wZ:p2': shellIn(13800) })
  assert.deepEqual(await lastBoardChecked(saved, boardPanes, alive, herdr.inPane), { pane: 'wZ:p2', stale: true })
  assert.deepEqual(herdr.asked, ['wZ:p2'])
})

test('a pane without the board’s label (herdr gave its id to a pane of the user’s) is trusted as before, herdr not asked', async () => {
  for (const other of [
    panes,
    [{ pane_id: 'wZ:p2', label: 'my shell' }],
    [{ pane_id: 'wZ:p2', label: 'agent board' }],
  ]) {
    const herdr = herdrSays({ 'wZ:p2': shellIn(13800) })
    assert.deepEqual(await lastBoardChecked(saved, other, alive, herdr.inPane), { pane: 'wZ:p2', stale: false })
    assert.deepEqual(herdr.asked, [])
  }
})

test('a live board is never stale: its host runs the pane, or its pid is in it, or a board’s script is', async () => {
  const running: PaneProcesses[] = [
    boardIn(61104),
    // Linux and macOS: the whole foreground group, the terminal board in it.
    {
      shell: 900,
      foreground: [
        { pid: 61104, args: ['bun', 'src/entrypoints/run.ts'] },
        { pid: 100, args: [] },
      ],
    },
    { shell: 900, foreground: [{ pid: 100, args: ['bun', '/home/me/agent board/src/entrypoints/tui.ts'] }] },
    // Neither recorded process in it, yet the board runs there (started again by hand, say).
    boardIn(5555),
    boardIn(5555, 'C:\\Users\\me\\herdr-agent-board\\src\\entrypoints\\tui.ts'),
    { shell: 5555, foreground: [{ pid: 5555, args: ['C:\\Users\\me\\.bun\\bin\\bun.EXE "src/entrypoints/run.ts"'] }] },
    // A process herdr gives no command line of may be the board.
    { shell: 5555, foreground: [{ pid: 5555, args: [] }] },
    // herdr names nothing in the foreground: nothing to judge by.
    { shell: 5555, foreground: [] },
  ]
  for (const info of running) {
    const herdr = herdrSays({ 'wZ:p2': info })
    assert.deepEqual(await lastBoardChecked(saved, boardPanes, alive, herdr.inPane), { pane: 'wZ:p2', stale: false })
    assert.deepEqual(herdr.asked, ['wZ:p2'], JSON.stringify(info))
  }
})

test('a dead pid is stale without asking herdr', async () => {
  const herdr = herdrSays({})
  assert.deepEqual(await lastBoardChecked({ ...saved, pid: 31804 }, boardPanes, alive, herdr.inPane), {
    pane: 'wZ:p2',
    stale: true,
  })
  assert.deepEqual(herdr.asked, [])
})

// herdr gives a pane's id out again: a dead board's id may name one of the user's panes now (#189).
test('a dead pid in a pane without the board’s label: no board, nothing to close, and herdr not asked', async () => {
  const others = [
    panes,
    [{ pane_id: 'wZ:p2', label: 'my shell' }],
    [{ pane_id: 'wZ:p2', label: 'agent board' }],
    [{ pane_id: 'wZ:p2', label: `${BOARD_LABEL} (old)` }],
    [{ pane_id: 'wZ:p2', label: '' }],
  ]
  for (const theirs of others)
    for (const dead of [
      { ...saved, pid: 31804 },
      { pane: 'wZ:p2', pid: 31804 },
    ]) {
      const herdr = herdrSays({})
      assert.equal(await lastBoardChecked(dead, theirs, alive, herdr.inPane), null, JSON.stringify([dead, theirs]))
      assert.deepEqual(herdr.asked, [])
    }
})

test('a dead pid in the board’s labelled pane is stale, with a host or without (Windows after shutdown)', async () => {
  for (const dead of [
    { ...saved, pid: 31804 },
    { pane: 'wZ:p2', pid: 31804 },
  ]) {
    const herdr = herdrSays({})
    assert.deepEqual(await lastBoardChecked(dead, boardPanes, alive, herdr.inPane), { pane: 'wZ:p2', stale: true })
    assert.deepEqual(herdr.asked, [])
  }
})

test('herdr that cannot say what runs in the pane (an error, an older herdr): the pane is trusted, as before', async () => {
  for (const answer of [new Error('unrecognized subcommand process-info'), null]) {
    const herdr = herdrSays({ 'wZ:p2': answer })
    assert.deepEqual(await lastBoardChecked(saved, boardPanes, alive, herdr.inPane), { pane: 'wZ:p2', stale: false })
    assert.deepEqual(herdr.asked, ['wZ:p2'])
  }
})

test('a board.json without a host or a pid (an older board) is judged as before, without asking herdr', async () => {
  for (const old of [
    { pane: 'wZ:p2', pid: 100 },
    { pane: 'wZ:p2', pid: 31804 },
    { pane: 'wZ:p2' },
    { pane: 'wZ:p2', host: 61104 },
  ]) {
    const herdr = herdrSays({ 'wZ:p2': shellIn(13800) })
    assert.deepEqual(
      await lastBoardChecked(old, boardPanes, alive, herdr.inPane),
      lastBoard(old, panes, alive),
      JSON.stringify(old),
    )
    assert.deepEqual(herdr.asked, [])
  }
})

test('no board.json, or its pane gone: no board, and herdr not asked', async () => {
  const herdr = herdrSays({})
  assert.equal(await lastBoardChecked(null, boardPanes, alive, herdr.inPane), null)
  assert.equal(await lastBoardChecked({ ...saved, pane: 'gone' }, boardPanes, alive, herdr.inPane), null)
  assert.deepEqual(herdr.asked, [])
})

test('the board’s label is the title herdr-plugin.toml gives the board’s pane', () => {
  const pane = (manifest as { panes: { id: string; title: string }[] }).panes.find(p => p.id === 'board')
  assert.equal(BOARD_LABEL, pane?.title)
})

// Panes herdr restored from earlier boards: the board's label, and nothing but an idle shell.
const label = BOARD_LABEL
const sidebar = { 'herdr-sidebar-git': '1' }
const many = [
  { pane_id: 'wZ:p2', tab_id: 'board-tab', label },
  { pane_id: 'wZ:p3', tab_id: 'board-tab', tokens: sidebar },
  { pane_id: 'wZ:p5', tab_id: 'old-tab', label },
  { pane_id: 'wZ:p6', tab_id: 'old-tab', tokens: sidebar },
  { pane_id: 'w1:p1', tab_id: 'user-tab' },
  { pane_id: 'w1:p4', tab_id: 'user-tab', label: 'my shell' },
  { pane_id: 'w1:p7', tab_id: 'user-tab', label },
  { pane_id: 'w1:p8', tab_id: 'other-tab', label },
  { pane_id: 'w1:p9', tab_id: 'other-tab', label, agent: 'claude' },
  { pane_id: 'w1:pa', tab_id: 'other-tab', label },
  { pane_id: 'w1:pb', tab_id: 'other-tab', label },
  { pane_id: 'w1:pc', tab_id: 'other-tab', label: 'agent board' },
  { pane_id: 'w1:pd', label },
]

test('leftover boards: panes with the board’s label that hold an idle shell and no board; herdr asked of those alone', async () => {
  const herdr = herdrSays({
    'wZ:p5': shellIn(13800),
    // A shell running something of the user's.
    'w1:p7': { shell: 7000, foreground: [{ pid: 7001, args: ['vim', 'notes.md'] }] },
    // A second board, in a tab of its own.
    'w1:p8': boardIn(8000),
    // herdr fails, or names a process without its command line.
    'w1:pa': new Error('pane not found'),
    'w1:pb': { shell: 9000, foreground: [{ pid: 9000, args: [] }] },
    'w1:pd': { shell: 9900, foreground: [{ pid: 9900, args: ['/usr/bin/zsh'] }] },
  })
  assert.deepEqual(await leftoverBoards(many, 'wZ:p2', herdr.inPane), ['wZ:p5', 'w1:pd'])
  // Not the pane board.json names, not an agent's, not one labelled otherwise (another case too).
  assert.deepEqual(herdr.asked, ['wZ:p5', 'w1:p7', 'w1:p8', 'w1:pa', 'w1:pb', 'w1:pd'])
})

test('leftover boards: none without a labelled pane, and herdr not asked', async () => {
  const herdr = herdrSays({})
  const unlabelled = many.filter(p => p.label !== label)
  assert.deepEqual(await leftoverBoards(unlabelled, null, herdr.inPane), [])
  assert.deepEqual(await leftoverBoards([{ pane_id: 'wZ:p2', label }], 'wZ:p2', herdr.inPane), [])
  assert.deepEqual(herdr.asked, [])
})

test('pane ids go to herdr and are matched whole, whatever they hold', async () => {
  const odd = ['pane-7 a%b', 'панель:2', 'C:\\x y']
  const herdr = herdrSays(Object.fromEntries(odd.map(id => [id, shellIn(13800)])))
  const oddPanes = odd.map(pane_id => ({ pane_id, label }))
  for (const pane of odd)
    assert.deepEqual(await lastBoardChecked({ ...saved, pane }, oddPanes, alive, herdr.inPane), { pane, stale: true })
  assert.deepEqual(await leftoverBoards(oddPanes, 'pane-7 a%b', herdr.inPane), ['панель:2', 'C:\\x y'])
  assert.deepEqual(herdr.asked, [...odd, 'панель:2', 'C:\\x y'])
  assert.equal(await lastBoardChecked({ ...saved, pane: 'pane-7' }, oddPanes, alive, herdr.inPane), null)
  assert.equal(await lastBoardChecked({ ...saved, pane: 'ПАНЕЛЬ:2' }, oddPanes, alive, herdr.inPane), null)
})

test('a dead pid: odd pane ids are stale with the board’s label and no board without it', async () => {
  const odd = ['pane-7 a%b', 'панель:2', 'C:\\x y']
  const herdr = herdrSays({})
  for (const pane of odd) {
    const dead = { pane, pid: 31804, host: 61104 }
    assert.deepEqual(await lastBoardChecked(dead, [{ pane_id: pane, label }], alive, herdr.inPane), {
      pane,
      stale: true,
    })
    assert.equal(await lastBoardChecked(dead, [{ pane_id: pane, label: 'панель' }], alive, herdr.inPane), null)
    assert.equal(await lastBoardChecked(dead, [{ pane_id: pane }], alive, herdr.inPane), null)
  }
  assert.deepEqual(herdr.asked, [])
})

test('a leftover closes with its tab when only herdr-sidebar’s panes are beside it, else alone', () => {
  assert.deepEqual(closeOfLeftover(many, 'wZ:p5'), ['tab', 'close', 'old-tab'])
  assert.deepEqual(closeOfLeftover([{ pane_id: 'wZ:p5', tab_id: 'old-tab', label }], 'wZ:p5'), [
    'tab',
    'close',
    'old-tab',
  ])
  assert.deepEqual(closeOfLeftover(many, 'w1:p7'), ['pane', 'close', 'w1:p7'])
  assert.deepEqual(closeOfLeftover(many, 'w1:pd'), ['pane', 'close', 'w1:pd'])
})
