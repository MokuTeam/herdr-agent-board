// The entries parked with an archived session in the archive's panel (#295): listed under the
// session's row when the server sends them (soonest first, those that run no more last), with when
// each is due once Return puts it back, Move (a picker of the sessions on the board, by lane) and
// Unschedule (two clicks); a row the server sends no entries for keeps its count, as before.
import { describe, expect, test } from 'bun:test'
import type { ParkedEntry, PublicArchiveRecord } from '../../src/core/archive.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory } from '../../src/core/payload.ts'
import { ArchiveBody, type ArchiveBodyProps } from '../../web/src/components/archive/ArchivePanel.tsx'
import { archiveRowView, moveTargets, parkedViews } from '../../web/src/models/archive-view.ts'
import { board, payload, renderInBoard } from './support/board.tsx'
import { type Element, findAll, hasClass, type Node } from './support/markup.ts'

const HOUR = 3_600_000
const now = new Date(2026, 10, 20, 12, 0).getTime()
const CATEGORIES: BoardCategory[] = [
  { id: 'acme', title: 'Acme Corp', color: '#007AFF', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'other', title: 'Other', color: '#8E8E93', colorName: 'gray', paths: [], configured: true, fallback: true },
]

const PARKED: ParkedEntry[] = [
  { id: 'aaa111', text: 'weekly report', due: now + 26 * HOUR, cron: '0 14 * * 6' },
  { id: 'bbb222', text: 'check the CI', due: now + 2 * HOUR },
  { id: 'ccc333', text: 'ran out', due: null, cron: '0 9 1 1 *' },
  { id: 'ddd444', text: 'was due meanwhile', due: now - HOUR, idle: true },
]

const record = (fields: Partial<PublicArchiveRecord> = {}): PublicArchiveRecord => ({
  key: 'atlas',
  session: 'atlas',
  name: 'atlas',
  autoName: 'atlas',
  category: 'acme',
  cwd: '/srv/atlas',
  workspace: '',
  workspaceId: 'w1',
  pane: 'w1:p1',
  tab: 'w1:t1',
  note: '',
  title: 'atlas',
  sleeping: false,
  activity: now - HOUR,
  archivedAt: now - HOUR,
  by: 'user',
  state: 'archived',
  closeAt: now - HOUR,
  held: PARKED.length,
  parked: PARKED,
  returning: false,
  ...fields,
})

/** A record as a board before #295 sends it, or one with no entries: no `parked`. */
const unlisted = (fields: Partial<PublicArchiveRecord> = {}): PublicArchiveRecord => {
  const { parked: _, ...r } = record(fields)
  return r
}

const TARGETS = [
  { lane: 'Acme Corp', sessions: [{ key: 'ben', name: 'ben' }] },
  { lane: 'Other', sessions: [{ key: 'cleo', name: 'cleo' }] },
]

function body(fields: Partial<ArchiveBodyProps> = {}, lang = 'en'): Node[] {
  const props: ArchiveBodyProps = {
    records: [record()],
    query: '',
    sleepy: 0,
    returning: new Set(),
    armed: null,
    canMutate: true,
    canEdit: true,
    categories: CATEGORIES,
    t: translator(lang),
    now,
    targets: TARGETS,
    ...fields,
  }
  return renderInBoard(<ArchiveBody {...props} />, board({ data: payload({ categories: CATEGORIES }) }), lang)
}

const text = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(text).join(''))
const all = (nodes: Node[], cls: string): Element[] => findAll(nodes, el => hasClass(el, cls))

describe('the parked entries of a row', () => {
  test('listed soonest first, those that run no more last; the row says no count beside them', () => {
    const nodes = body()
    const list = all(nodes, 'arch-parked')
    expect(list.length).toBe(1)
    expect(list[0]?.tag).toBe('ul')
    expect(list[0]?.attrs.get('aria-label')).toBe('Reminders that wait with it')
    const rows = all(nodes, 'arch-parked-entry')
    expect(rows.map(r => r.attrs.get('data-id'))).toEqual(['ddd444', 'bbb222', 'aaa111', 'ccc333'])
    expect(rows.map(r => text(all([r], 'arch-parked-text')[0] as Node))).toEqual([
      'was due meanwhile',
      'check the CI',
      'weekly report',
      'ran out',
    ])
    // Overdue in orange, ended muted; a repeating one has the repeat mark.
    expect(rows.map(r => [hasClass(r, 'overdue'), hasClass(r, 'ended')])).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [false, true],
    ])
    expect(rows.map(r => findAll([r], el => el.tag === 'svg').length > 2)).toEqual([false, false, true, true])
    expect(text(all([rows[3] as Node], 'arch-parked-time')[0] as Node)).toBe('runs no more')
    expect(all(nodes, 'arch-extra').length).toBe(0)
    // The repeat rule in sight, as the schedule panel shows it.
    expect(rows.map(r => all([r], 'arch-parked-cron').map(text).join(''))).toEqual(['', '', '0 14 * * 6', '0 9 1 1 *'])
  })

  test('Move asks first: a pick arms it, its pill then says where to, and only that click moves it', () => {
    const nodes = body({ armed: 'move:bbb222:cleo' })
    const go = findAll(nodes, el => el.attrs.has('data-arch-move-to'))
    expect(go.map(el => [el.tag, el.attrs.get('data-arch-move-to'), el.attrs.has('data-confirm'), text(el)])).toEqual([
      ['button', 'bbb222', true, 'Move to “cleo”?'],
    ])
    // The others keep their picker; a key no session on the board has arms nothing.
    expect(findAll(nodes, el => el.tag === 'select').map(s => s.attrs.get('data-arch-move'))).toEqual([
      'ddd444',
      'aaa111',
      'ccc333',
    ])
    expect(findAll(body({ armed: 'move:bbb222:gone' }), el => el.attrs.has('data-arch-move-to'))).toEqual([])
    expect(
      text(findAll(body({ armed: 'move:bbb222:ben' }, 'ru'), el => el.attrs.has('data-arch-move-to'))[0] as Node),
    ).toBe('Перенести в «ben»?')
  })

  test('Move lists the sessions on the board by lane; Unschedule asks first', () => {
    const nodes = body({ armed: 'held:bbb222' })
    const selects = findAll(nodes, el => el.tag === 'select')
    expect(selects.map(s => s.attrs.get('data-arch-move'))).toEqual(['ddd444', 'bbb222', 'aaa111', 'ccc333'])
    // One that runs no more cannot move.
    expect(selects.map(s => s.attrs.has('disabled'))).toEqual([false, false, false, true])
    const groups = findAll([selects[0] as Node], el => el.tag === 'optgroup')
    expect(groups.map(g => [g.attrs.get('label'), findAll([g], el => el.tag === 'option').map(text)])).toEqual([
      ['Acme Corp', ['ben']],
      ['Other', ['cleo']],
    ])
    const drops = findAll(nodes, el => el.attrs.has('data-arch-drop'))
    expect(drops.map(d => [d.attrs.get('data-arch-drop'), d.attrs.has('data-confirm'), text(d)])).toEqual([
      ['ddd444', false, ''],
      ['bbb222', true, 'Unschedule?'],
      ['aaa111', false, ''],
      ['ccc333', false, ''],
    ])
    // The row's own trash can is not the one armed.
    const trash = findAll(nodes, el => el.attrs.has('data-arch-remove'))
    expect(trash.map(el => el.attrs.has('data-confirm'))).toEqual([false])
  })

  test('offline, or on its way back: Move and Unschedule are gray; no session to move to, Move is too', () => {
    for (const fields of [
      { canEdit: false },
      { returning: new Set(['atlas']) },
      { records: [record({ returning: true })] },
    ]) {
      const nodes = body(fields)
      const controls = findAll(nodes, el => el.tag === 'select' || el.attrs.has('data-arch-drop'))
      expect(controls.every(el => el.attrs.has('disabled'))).toBe(true)
    }
    const alone = body({ targets: [] })
    expect(findAll(alone, el => el.tag === 'select').every(el => el.attrs.has('disabled'))).toBe(true)
    expect(findAll(alone, el => el.attrs.has('data-arch-drop')).some(el => el.attrs.has('disabled'))).toBe(false)
  })

  test('a row with no entries, or from a board that sends none, draws as before: no list, its count', () => {
    for (const r of [unlisted({ held: 0 }), unlisted({ held: 2 })]) {
      const nodes = body({ records: [r] })
      expect(all(nodes, 'arch-parked').length).toBe(0)
      expect(all(nodes, 'arch-extra').map(text)).toEqual(r.held ? ['2 reminders'] : [])
    }
  })

  test('in Russian', () => {
    const nodes = body({ armed: 'held:aaa111' }, 'ru')
    expect(text(all(nodes, 'arch-move')[0] as Node)).toContain('Перенести в…')
    expect(findAll(nodes, el => el.attrs.has('data-confirm')).map(text)).toEqual(['Отменить?'])
    expect(text(all(nodes, 'arch-parked-time')[3] as Node)).toBe('больше не сработает')
  })
})

describe('the parts the row is drawn from', () => {
  const t = translator('en')
  test('parkedViews: due as the schedule words it, its day in the tooltip; a call by its title', () => {
    const views = parkedViews(
      record({ parked: [...PARKED, { id: 'eee555', text: 'x', due: now + HOUR, kind: 'call' }] }),
      t,
      now,
    )
    expect(views.map(v => v.id)).toEqual(['ddd444', 'eee555', 'bbb222', 'aaa111', 'ccc333'])
    expect(views[2]?.timeTitle).toContain('Due once Return puts it back')
    expect(views[1]?.text.startsWith('MokuPilot call results')).toBe(true)
    expect(views.find(v => v.id === 'aaa111')?.cron).toBe('0 14 * * 6')
    expect(parkedViews(unlisted(), t, now)).toEqual([])
  })

  test('archiveRowView: the count only while the entries are not listed', () => {
    const scene = { t, categories: CATEGORIES, returning: false, armed: false, canMutate: true, canEdit: true }
    expect(archiveRowView(record(), scene).extra).toBe('')
    expect(archiveRowView(record(), scene).extraTitle).toBe(null)
    expect(archiveRowView(unlisted(), scene).extra).toBe('4 reminders')
    expect(archiveRowView(record({ from: { key: 'x', name: 'Lead' } }), scene).extra).toBe('by Lead')
  })

  test('moveTargets: by lane in the board’s order, by name within one, skipping those on their way out', () => {
    const items = [
      { key: 'k3', name: 'cleo', category: 'other' },
      { key: 'k1', name: 'ben', category: 'acme' },
      { key: 'k2', name: 'anna', category: 'acme' },
      { key: 'k4', name: 'gone', category: 'acme' },
      { key: 'k5', name: '', category: 'new-lane' },
    ]
    expect(moveTargets(items, CATEGORIES, key => key === 'k4', t)).toEqual([
      {
        lane: 'Acme Corp',
        sessions: [
          { key: 'k2', name: 'anna' },
          { key: 'k1', name: 'ben' },
        ],
      },
      { lane: 'Other', sessions: [{ key: 'k3', name: 'cleo' }] },
      { lane: expect.any(String), sessions: [{ key: 'k5', name: 'Session' }] },
    ])
  })
})
