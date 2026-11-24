// A node's part of the master's payload (#500, core/node-items.ts): keys prefixed and a device on
// each, references to the node's keys prefixed with them, every field checked against the board's
// types, strings cut to the board's own lengths, and nothing of the node's payload but its items,
// launches and schedule entries.
import { describe, expect, test } from 'bun:test'
import { nodePart } from '../../src/core/node-items.ts'

const SID = '1f0e3c1a-5b7d-4c2e-9a10-3c4b5d6e7f80'
const OTHER = '2f0e3c1a-5b7d-4c2e-9a10-3c4b5d6e7f81'

/** An item as a node's board sends it. */
const item = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: SID,
  session: SID,
  pane: 'w1:p1',
  workspace: 'w1',
  cwd: '/home/owner/work/atlas',
  status: 'working',
  name: 'atlas 12',
  autoName: 'claude',
  category: 'atlas',
  categorySet: true,
  column: 'work',
  attention: '',
  ...fields,
})

const launch = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'l-1',
  resume: null,
  fork: null,
  name: 'atlas 13',
  cwd: '/home/owner/work/atlas',
  category: 'atlas',
  workspace: 'atlas',
  workspaceId: null,
  state: 'starting',
  step: 'tab',
  error: '',
  kind: '',
  pane: null,
  key: null,
  startedAt: 1795210000000,
  doneAt: null,
  message: 'go',
  worktree: null,
  newWorkspace: false,
  parent: SID,
  ...fields,
})

describe('nodePart', () => {
  test('keys prefixed, each item a device; pane-1 of two devices stays two keys', () => {
    const payload = { items: [item(), item({ key: 'pane-1', session: null, name: 'shell' })] }
    const one = nodePart(payload, 'server-1')
    const two = nodePart(payload, 'server-2')
    expect(one?.items.map(i => [i.key, i.device])).toEqual([
      [`@server-1:${SID}`, 'server-1'],
      ['@server-1:pane-1', 'server-1'],
    ])
    expect(two?.items.map(i => i.key)).toEqual([`@server-2:${SID}`, '@server-2:pane-1'])
    // The session id is the node's: Claude knows it so.
    expect(one?.items[0]?.session).toBe(SID)
  })

  test('a pi file path, a Windows path, a name with spaces, Cyrillic and % keep their key whole', () => {
    const keys = ['/home/o w/.pi/sessions/Тест 50%.jsonl', 'C:\\Users\\o w\\.pi\\Тест 50%.jsonl']
    const got = nodePart({ items: keys.map(key => item({ key, name: 'Тест 50% x' })) }, 'server-1')
    expect(got?.items.map(i => [i.key, i.name])).toEqual(keys.map(k => [`@server-1:${k}`, 'Тест 50% x']))
  })

  test('references to the node keys and sessions are prefixed too', () => {
    const got = nodePart(
      {
        items: [
          item({
            links: {
              from: { key: OTHER, name: 'boss', at: 1 },
              started: [{ key: 'pane-2', name: 'kid', at: 2 }],
              talks: [{ key: OTHER, name: 'boss', at: 3, in: 1, out: 2 }],
            },
            fork: { of: OTHER, at: 4 },
            launch: launch({ key: SID }),
          }),
        ],
        launches: [launch()],
        schedules: [
          { id: 'a1b2c3', key: SID, text: 'check', next: 5, idle: true, from: { key: OTHER, name: 'boss' } },
          { id: 'd4e5f6', key: SID, kind: 'call', text: 'r'.repeat(20_000), next: 6 },
        ],
      },
      'server-1',
    )
    const it = got?.items[0]
    expect(it?.links).toEqual({
      from: { key: `@server-1:${OTHER}`, name: 'boss', at: 1 },
      started: [{ key: '@server-1:pane-2', name: 'kid', at: 2 }],
      talks: [{ key: `@server-1:${OTHER}`, name: 'boss', at: 3, in: 1, out: 2 }],
    })
    expect(it?.fork).toEqual({ of: `@server-1:${OTHER}`, at: 4 })
    expect((it?.launch as { key: string } | undefined)?.key).toBe(`@server-1:${SID}`)
    expect(got?.launches as unknown[]).toEqual([
      { ...launch(), id: '@server-1:l-1', parent: `@server-1:${SID}`, device: 'server-1' },
    ])
    expect(got?.schedules).toEqual([
      {
        id: '@server-1:a1b2c3',
        key: `@server-1:${SID}`,
        text: 'check',
        next: 5,
        idle: true,
        from: { key: `@server-1:${OTHER}`, name: 'boss' },
        device: 'server-1',
      },
      // A call report is as long as the store lets it be (core/schedule-rules.ts MAX_REPORT).
      {
        id: '@server-1:d4e5f6',
        key: `@server-1:${SID}`,
        kind: 'call',
        text: 'r'.repeat(16_000),
        next: 6,
        device: 'server-1',
      },
    ])
  })

  test('a field that is not what the type says is dropped, not passed on', () => {
    const got = nodePart(
      {
        items: [
          item({
            status: 'pwned',
            column: 'nowhere',
            attention: 7,
            session: 42,
            categorySet: 'yes',
            doing: { html: '<b>' },
            context: 'NaN',
            sleeping: 'true',
            favorite: 1,
            tool: { id: 't1', name: 'Bash', input: { command: 'rm -rf ~' }, label: 'ls', pending: true },
            links: { from: 'boss', started: [], talks: [] },
            todos: [{ id: 'x', text: 'ok', owner: 'user', by: 'user', at: 1 }, { id: 'y' }],
            // never an item's: the server's own, or not of the type at all
            transcript: '/home/owner/.claude/projects/x.jsonl',
            pipe: 'uds:/tmp/p',
            claudeRoot: '/home/owner/.claude',
            alive: true,
            fsToken: 'canary-token',
            extra: 'anything',
          }),
        ],
      },
      'server-1',
    )
    const it = got?.items[0] as Record<string, unknown>
    expect([it.status, it.column, it.attention, it.session, it.categorySet]).toEqual([
      'unknown',
      'idle',
      '',
      null,
      false,
    ])
    for (const k of [
      'doing',
      'context',
      'sleeping',
      'favorite',
      'links',
      'transcript',
      'pipe',
      'claudeRoot',
      'alive',
      'fsToken',
      'extra',
    ])
      expect([k, k in it]).toEqual([k, false])
    expect(it.tool).toEqual({ id: 't1', name: 'Bash', label: 'ls', pending: true })
    expect(it.todos).toEqual([{ id: 'x', text: 'ok', owner: 'user', by: 'user', at: 1 }])
  })

  test('strings are cut to the lengths the board carries', () => {
    const got = nodePart(
      {
        items: [
          item({ doing: 'd'.repeat(5000), lastText: 'l'.repeat(5000), model: 'm'.repeat(100), name: 'n'.repeat(500) }),
        ],
      },
      'server-1',
    )
    const it = got?.items[0]
    expect([it?.doing?.length, it?.lastText?.length, it?.model?.length, it?.name.length]).toEqual([2000, 700, 60, 200])
  })

  test('an item without a usable key or name, or not the node own, is left out whole', () => {
    const got = nodePart(
      {
        items: [
          item({ key: '' }),
          item({ key: 7 }),
          item({ key: 'k'.repeat(2000) }),
          item({ key: 'no-name', name: undefined }),
          item({ key: 'blank-name', name: '   ' }),
          item({ key: '@server-3:abc' }),
          item({ key: 'claims', device: 'server-2' }),
          'not an item',
          item({ key: 'kept' }),
          item({ key: 'kept', name: 'second' }),
        ],
        launches: [launch({ device: 'server-2' }), launch({ id: '' }), launch({ state: 'odd' })],
        schedules: [
          { id: 'x', key: SID, text: 't' },
          { id: 'y', key: SID, text: 't', next: 1, device: 'server-2' },
        ],
      },
      'server-1',
    )
    expect(got?.items.map(i => [i.key, i.name])).toEqual([['@server-1:kept', 'atlas 12']])
    expect(got?.launches).toEqual([])
    expect(got?.schedules).toEqual([])
  })

  test('without a device: the same check, the node own keys, no device field', () => {
    const got = nodePart({ items: [item({ fsToken: 'canary' })], launches: [launch()], fsToken: 'canary' }, null)
    expect(got?.items.map(i => [i.key, 'device' in i, 'fsToken' in i])).toEqual([[SID, false, false]])
    expect(got?.launches[0]?.id).toBe('l-1')
    expect(JSON.stringify(got)).not.toContain('canary')
  })

  test('not a payload: null; lists that are not lists: empty', () => {
    expect(nodePart(null, 'server-1')).toBeNull()
    expect(nodePart([], 'server-1')).toBeNull()
    expect(nodePart({ items: 'x', launches: {}, schedules: 1 }, 'server-1')).toEqual({
      items: [],
      launches: [],
      schedules: [],
    })
  })

  test('checklist field passes when active and bounded, and drops when completed or invalid (#637)', () => {
    const active = {
      done: 2,
      total: 5,
      current: 'Writing tests',
      items: [
        { content: 'Parse', status: 'completed' as const },
        { content: 'Wire', status: 'completed' as const },
        { content: 'Write tests', status: 'in_progress' as const, activeForm: 'Writing tests' },
      ],
      at: 1795210000000,
    }
    const oversized = {
      done: 1,
      total: 60,
      current: 'x'.repeat(500),
      items: Array.from({ length: 70 }, (_, i) => ({
        content: `${i}-${'y'.repeat(300)}`,
        status: i === 0 ? 'completed' : 'pending',
      })),
    }
    const completed = {
      done: 2,
      total: 2,
      current: 'Done',
      items: [
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'completed' },
      ],
    }
    const got = nodePart(
      {
        items: [
          item({ key: 'active', checklist: active }),
          item({ key: 'big', checklist: oversized }),
          item({ key: 'done', checklist: completed }),
          item({ key: 'empty', checklist: { done: 0, total: 1, current: 'A', items: [] } }),
          item({ key: 'bad', checklist: 'not-an-object' }),
        ],
      },
      'server-1',
    )
    expect(got?.items[0]?.checklist).toEqual(active)
    expect(got?.items[1]?.checklist?.current.length).toBe(200)
    expect(got?.items[1]?.checklist?.items).toHaveLength(50)
    expect(got?.items[1]?.checklist?.items[0]?.content.length).toBe(200)
    expect(got?.items[2]?.checklist).toBeUndefined()
    expect(got?.items[3]?.checklist).toBeUndefined()
    expect(got?.items[4]?.checklist).toBeUndefined()
  })
})
