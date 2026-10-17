// Renaming in place in React (hooks/useRenameInPlace.ts, components/RenameField.tsx) against the
// old page — app.js startRename with rename.js, at the parity baseline and as rename.js is now —
// step by step in a fake DOM (support/rename-sides.tsx): the field over the name (its markup,
// place, type and max length, the "auto" name, the Claude option), Enter, Esc, leaving the field,
// the checkbox, a refused rename, the toasts and what went to the server.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { reducedMotion } from '../../web/src/models/spring.ts'
import { item } from './support/board.tsx'
import type { EventFields } from './support/fake-dom.ts'
import { oldRenameSide, type RenameBoard, type RenameSide, reactRenameSide } from './support/rename-sides.tsx'

type Step = (side: RenameSide) => Promise<unknown>

async function run(make: () => RenameSide, steps: Step[]): Promise<string[]> {
  const side = make()
  try {
    const shots = [side.snapshot()]
    for (const step of steps) {
      await step(side)
      shots.push(side.snapshot())
    }
    await side.world.settle()
    shots.push(side.snapshot())
    return shots
  } finally {
    await side.dispose()
  }
}

/** The three sides the same after every step; returns the baseline's snapshots. */
async function compare(board: RenameBoard, steps: Step[]): Promise<string[]> {
  const baseline = await run(() => oldRenameSide(board, true), steps)
  const now = await run(() => oldRenameSide(board, false), steps)
  const react = await run(() => reactRenameSide(board), steps)
  for (const [name, shots] of [
    ['old page now', now],
    ['react', react],
  ] as const) {
    expect(shots.length).toBe(baseline.length)
    for (const [i, shot] of baseline.entries())
      expect(`${name} step ${i}\n${shots[i]}`).toBe(`${name} step ${i}\n${shot}`)
  }
  return baseline
}

// ---------------------------------------------------------------- sessions and steps

const t = translator('en')
const claude = (fields: Partial<Item> = {}): Item =>
  item({ key: 's1', name: 'acme', autoName: 'acme-api', agent: 'claude', ...fields })
const boardOf = (items: Item[], more: Partial<RenameBoard> = {}): RenameBoard => ({
  items,
  canEdit: true,
  canMutate: true,
  t,
  ...more,
})

const start =
  (key = 's1', id = 'card-name'): Step =>
  s =>
    s.start(key, id)
const field = (s: RenameSide) => s.part('.rename-field')
const type =
  (text: string): Step =>
  async s => {
    field(s).value = text
  }
const key =
  (k: string, fields: EventFields = {}, on: (s: RenameSide) => ReturnType<RenameSide['part']> = field): Step =>
  async s => {
    const e = await s.world.fire(on(s), 'keydown', { key: k, ...fields })
    if (e.defaultPrevented) s.log.push(`${k} prevented`)
  }
const answer =
  (r: Parameters<RenameSide['answer']>[0]): Step =>
  s =>
    s.answer(r)
const tick =
  (ms = 16): Step =>
  s =>
    s.world.tick(ms)
const settle: Step = s => s.world.settle()
/** The focus leaves the field for `to` (the page's element, or one of the box's parts). */
const leave =
  (to: (s: RenameSide) => ReturnType<RenameSide['part']>): Step =>
  async s => {
    const next = to(s)
    await s.world.fire(field(s), 'focusout', { relatedTarget: next })
    next.focus()
  }
const tickBox: Step = async s => {
  s.part('.rename-claude input').checked = true
}
const press =
  (type: string, on: (s: RenameSide) => ReturnType<RenameSide['part']>): Step =>
  async s => {
    const e = await s.world.fire(on(s), type)
    if (e.defaultPrevented) s.log.push(`${type} prevented`)
  }
const outside = (s: RenameSide) => s.page('outside')
const label = (s: RenameSide) => s.part('.rename-claude')
const auto = (s: RenameSide) => s.part('.rename-more')

describe('renaming in place', () => {
  test('a field over the name, in its type, the name selected; the options under it grow in; Enter keeps the new name', async () => {
    const shots = await compare(boardOf([claude()]), [
      start(),
      tick(),
      tick(),
      settle,
      type('  new name  '),
      key('Enter'),
      key('Enter'),
      answer({ ok: true }),
    ])
    expect(shots[1]).toContain('maxlength="60"')
    expect(shots[1]).toContain('acme-api')
    expect(shots[1]).toContain('renaming: card-name')
    expect(shots[1]).toContain('focus: input.rename-field')
    expect(shots[1]).toContain('selected: input.rename-field')
    expect(shots[6]).toContain('disabled: true')
    // The second Enter while it saves sends nothing more.
    expect(shots[7]?.split('act s1 rename').length).toBe(2)
    expect(shots.at(-1)).toContain('act s1 rename {"name":"new name","claude":false}')
    expect(shots.at(-1)).toContain('toast Renamed: new name')
    expect(shots.at(-1)).toContain('renaming: \n')
  })

  test('Esc puts it back; the same name again is no rename; the keys stay in the field', async () => {
    const shots = await compare(boardOf([claude()]), [
      start(),
      type('other'),
      key('Escape'),
      start(),
      key('Enter'),
      start('s1', 'sheet-name'),
      key('n'),
      key('Process', { isComposing: true }),
      key('Enter', { keyCode: 229 }),
      key('Escape'),
    ])
    expect(shots.at(-1)).not.toContain('act ')
    expect(shots.at(-1)).not.toContain('keydown reached the page')
    expect(shots[3]).toContain('Escape prevented')
  })

  test('an empty name gives the automatic one back', async () => {
    const shots = await compare(boardOf([claude()]), [start(), type('   '), key('Enter'), answer({ ok: true })])
    expect(shots.at(-1)).toContain('act s1 rename {"name":"","claude":false}')
    expect(shots.at(-1)).toContain('acme-api')
  })

  test('in Claude and herdr too, when ticked: Enter on the box sends it; Claude confirms it, or does not say', async () => {
    const shots = await compare(boardOf([claude()]), [
      start(),
      type('renamed'),
      tickBox,
      key('Enter', {}, s => s.part('.rename-claude input')),
      answer({ ok: true, confirmed: true }),
      start(),
      tickBox,
      key('Enter'),
      answer({ ok: true }),
      start(),
      key('Escape', {}, s => s.part('.rename-claude input')),
    ])
    expect(shots[5]).toContain('act s1 rename {"name":"renamed","claude":true}')
    expect(shots[5]).toContain('toast Renamed on the board, in Claude and herdr: renamed')
    expect(shots[9]).toContain('act s1 rename {"name":"acme","claude":true}')
    expect(shots.at(-1)).not.toContain('act s1 rename {"name":"acme","claude":true} | act')
  })

  test('refused: the field stays, enabled and focused, with the error; then Esc', async () => {
    const shots = await compare(boardOf([claude()]), [
      start(),
      type('taken'),
      key('Enter'),
      answer({ ok: false, error: 'No such session' }),
      key('Escape'),
    ])
    expect(shots[4]).toContain('toast error No such session')
    expect(shots[4]).toContain('disabled: false')
    expect(shots[4]).toContain('focus: input.rename-field')
    expect(shots.at(-1)).not.toContain('class="rename"')
  })

  test('leaving the field keeps the name, unless the focus went to its checkbox or a press on its label is under way', async () => {
    const shots = await compare(boardOf([claude()]), [
      start(),
      type('left'),
      leave(s => s.part('.rename-claude input')),
      tick(),
      press('mousedown', label),
      leave(outside),
      tick(),
      press('pointerup', outside),
      tick(),
      press('click', label),
      tick(),
      press('mousedown', auto),
      press('pointerdown', auto),
      leave(outside),
      tick(),
      answer({ ok: true }),
    ])
    expect(shots[7]).not.toContain('act ')
    expect(shots[12]).toContain('mousedown prevented')
    expect(shots[13]).not.toContain('pointerdown reached the page')
    expect(shots.at(-1)).toContain('act s1 rename {"name":"left","claude":false}')
  })

  test('another rename puts the open one back first', async () => {
    const shots = await compare(boardOf([claude(), claude({ key: 's2', name: 'beta', autoName: '' })]), [
      start(),
      type('half typed'),
      start('s2', 'sheet-name'),
      settle,
    ])
    expect(shots.at(-1)).toContain('renaming: sheet-name')
    expect(shots.at(-1)).toContain('Empty: back to “beta”')
    expect(shots.at(-1)).not.toContain('act ')
  })

  test('the Claude option is gray with why while it sleeps, works or waits for fresh data; none for others', async () => {
    for (const [it, more] of [
      [claude({ sleeping: true }), {}],
      [claude({ status: 'working' }), {}],
      [claude({ status: 'blocked' }), {}],
      [claude(), { canMutate: false }],
      [claude({ agent: 'codex' }), {}],
      [claude({ pane: null }), {}],
      [claude({ session: null }), {}],
    ] as const) {
      await compare(boardOf([it], more), [start(), key('Escape')])
    }
  })

  test('offline: no field, the toast says why; the field keeps on screen near the edge; in Russian', async () => {
    const off = await compare(boardOf([claude()], { canEdit: false }), [start()])
    expect(off.at(-1)).toContain('toast error')
    expect(off.at(-1)).not.toContain('class="rename"')
    await compare(boardOf([claude()]), [start('s1', 'edge-name'), key('Escape')])
    await compare(boardOf([claude()], { t: translator('ru') }), [start(), key('Escape')])
    // A session no longer on the board: nothing opens.
    const gone = await compare(boardOf([claude()]), [start('nobody')])
    expect(gone.at(-1)).not.toContain('class="rename"')
  })

  test('with reduced motion the options show at once', async () => {
    const motion: { matches: boolean } = reducedMotion
    motion.matches = true
    try {
      const shots = await compare(boardOf([claude()]), [start(), tick(), settle, key('Escape')])
      expect(shots.join('\n')).not.toContain('translateY(')
    } finally {
      motion.matches = false
    }
  })
})
