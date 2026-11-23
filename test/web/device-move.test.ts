// A session moved to another device from its card's menu (#616): the card's Device on a master
// (models/menu-model.ts), and the call and the toast behind it (models/device-move.ts). A board
// without devices, or with this computer alone: no new item, the menu as before.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Reply } from '../../web/src/api/client.ts'
import { moveCardToDevice } from '../../web/src/models/device-move.ts'
import { cardMenu, type MenuEntry, type MenuItem } from '../../web/src/models/menu-model.ts'

const t = translator('en')
const isItem = (i: MenuEntry): i is MenuItem => !i.separator
const find = (items: readonly MenuEntry[] | null | undefined, id: string) =>
  (items ?? []).filter(isItem).find(i => i.id === id)

const DEVICES = [
  { id: 'local', title: 'This computer', why: '' },
  { id: 'server-1', title: 'Server 1', why: '' },
  { id: 'server-2', title: 'Server 2', why: 'Server 2 is not reachable' },
]

describe("the card's Device", () => {
  const ctx = { t, canMutate: true, canEdit: true, categories: [], column: 'idle', category: 'atlas' }
  const it = { key: 'k', session: 'k', agent: 'claude', pane: 'p1', cwd: '/w', status: 'idle', auto: 'idle' }

  test('each device, the one it runs on checked, one not reachable gray with why', () => {
    expect(find(cardMenu(it, { ...ctx, devices: DEVICES, deviceAt: 'local' }), 'device')?.submenu).toEqual([
      { id: 'device:local', label: 'This computer', checked: true },
      { id: 'device:server-1', label: 'Server 1', checked: false },
      { id: 'device:server-2', label: 'Server 2', checked: false, disabled: true, reason: 'Server 2 is not reachable' },
    ])
  })

  test('a session at work moves nowhere until it is free; stale data grays the item', () => {
    const busy = find(cardMenu({ ...it, status: 'working' }, { ...ctx, devices: DEVICES, deviceAt: 'local' }), 'device')
    expect(busy?.submenu?.filter(isItem).map(i => i.reason ?? '')).toEqual([
      '',
      'It is working: move it once it is free',
      'It is working: move it once it is free',
    ])
    const stale = find(cardMenu(it, { ...ctx, canMutate: false, devices: DEVICES }), 'device')
    expect([stale?.disabled, stale?.submenu]).toEqual([true, null])
  })

  test('no devices, this computer alone, or not a Claude session: the menu as before', () => {
    expect(cardMenu(it, { ...ctx, devices: DEVICES.slice(0, 1) })).toEqual(cardMenu(it, ctx))
    expect(find(cardMenu({ ...it, agent: 'pi' }, { ...ctx, devices: DEVICES }), 'device')).toBeUndefined()
  })
})

describe('the move and its toast', () => {
  function deps(answer: (body: { dryRun?: boolean }) => Promise<Reply>) {
    const calls: unknown[] = []
    const toasts: [string, boolean][] = []
    const actions: { label: string; run: () => void }[] = []
    const busy: [string, string | null][] = []
    return {
      calls,
      toasts,
      busy,
      actions,
      d: {
        t: () => t,
        post: async (path: string, body: unknown) => {
          calls.push([path, body])
          return answer(body as { dryRun?: boolean })
        },
        errorText: (err: unknown) => String(err instanceof Error ? err.message : err),
        toast: (text: string, error = false, options?: { action?: { label: string; run: () => void } }) => {
          toasts.push([text, error])
          if (options?.action) actions.push(options.action)
        },
        busy: (key: string, label: string | null) => void busy.push([key, label]),
        name: () => 'Atlas',
      },
    }
  }

  const planned = (plan: Record<string, unknown> = {}) =>
    ({ ok: true, results: [{ target: 'k', result: 'plan', plan: { changes: [], deleted: [], ...plan } }] }) as Reply

  test('moved: asked first, then the card says where it goes while it moves, the toast where it runs now', async () => {
    const x = deps(async b =>
      b.dryRun ? planned() : ({ ok: true, results: [{ target: 'k', result: 'moved' }] } as Reply),
    )
    await moveCardToDevice(x.d, 'k', 'server-1', 'Server 1')
    expect(x.calls).toEqual([
      ['/api/move', { targets: ['k'], device: 'server-1', dryRun: true }],
      ['/api/move', { targets: ['k'], device: 'server-1' }],
    ])
    expect(x.busy).toEqual([
      ['k', 'Moving to Server 1…'],
      ['k', null],
    ])
    expect(x.toasts).toEqual([['Atlas moved to Server 1', false]])
  })

  test('uncommitted changes are listed first; only "Move with them" moves it', async () => {
    const changes = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(path => ({ path, size: 1 }))
    const x = deps(async b =>
      b.dryRun
        ? planned({ changes, deleted: ['old.ts'] })
        : ({ ok: true, results: [{ target: 'k', result: 'moved' }] } as Reply),
    )
    await moveCardToDevice(x.d, 'k', 'server-1', 'Server 1')
    expect(x.toasts).toEqual([
      ['Atlas takes 6 uncommitted changes to Server 1: a.ts, b.ts, c.ts, d.ts, e.ts, …', false],
    ])
    expect(x.calls).toHaveLength(1)
    expect(x.actions.map(a => a.label)).toEqual(['Move with them'])
    x.actions[0]?.run()
    await Bun.sleep(0)
    expect(x.calls).toHaveLength(2)
    expect(x.toasts.at(-1)).toEqual(['Atlas moved to Server 1', false])
  })

  test("refused: the board's reason, in red, before anything moves; a failed call says why", async () => {
    const why = 'its branch feature-x is not pushed: push it first'
    const x = deps(async () => ({ ok: true, results: [{ target: 'k', result: 'refused', why }] }) as Reply)
    await moveCardToDevice(x.d, 'k', 'server-1', 'Server 1')
    expect(x.toasts).toEqual([[`Atlas stays where it is: ${why}`, true]])
    expect(x.calls).toHaveLength(1)
    expect(x.busy).toEqual([])
    const y = deps(async () => {
      throw new Error('the board does not answer')
    })
    await moveCardToDevice(y.d, 'k', 'server-1', 'Server 1')
    expect(y.toasts).toEqual([['the board does not answer', true]])
  })
})
