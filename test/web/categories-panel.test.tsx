// The categories panel against today's: #cats-sheet as web/app.js's own categories code draws and
// runs it in a fake DOM (support/old-categories.ts) and what <CategoriesPanel> and its rows render
// for the same board — at rest, with the swatches open, delete asking, a swatch picked and the
// "new category" form being filled in. What the old handlers send is held against the rules the
// React rows send by (models/categories.ts). Then the reorder: the old drag on the old rows and the
// React engine (hooks/useRowReorder.ts) on the rows React renders, frame by frame.
import { afterEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, Swatch } from '../../src/core/payload.ts'
import { CategoriesPanel } from '../../web/src/components/categories/CategoriesPanel.tsx'
import { CategoryDraftView } from '../../web/src/components/categories/CategoryDraft.tsx'
import { CategoryRowView } from '../../web/src/components/categories/CategoryRow.tsx'
import { rowReorder } from '../../web/src/hooks/useRowReorder.ts'
import { NO_EDITS, withEdit, withEdits } from '../../web/src/models/board-edits.ts'
import { NO_MOVES, withMove } from '../../web/src/models/board-view.ts'
import {
  confirmText,
  draftCategory,
  draftColor,
  paletteAfter,
  renamed,
  withoutPath,
  withPath,
} from '../../web/src/models/categories.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { box, type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { addButtonTypes, byClass, byId, canonical, type Element, find, hasClass, type Node } from './support/markup.ts'
import { OldCategories } from './support/old-categories.ts'

const SWATCHES: Swatch[] = [
  { name: 'blue', hex: '#007AFF' },
  { name: 'green', hex: '#34C759' },
  { name: 'orange', hex: '#FF9500' },
  { name: 'gray', hex: '#8E8E93' },
]
const cat = (fields: Partial<BoardCategory> & Pick<BoardCategory, 'id'>): BoardCategory => ({
  title: fields.id,
  color: '#007AFF',
  colorName: 'blue',
  paths: [],
  configured: true,
  fallback: false,
  ...fields,
})
const CATEGORIES: BoardCategory[] = [
  cat({ id: 'proj', title: 'Project <Acme> & "co"', paths: ['C:\\work\\acme', '/home/me/acme', '\\\\srv\\share'] }),
  // Named by its hex in the settings: its swatch is pressed all the same.
  cat({ id: 'ops', title: 'Ops', color: '#34C759', colorName: '#34c759' }),
  cat({ id: 'agent-made', title: 'agent-made', color: '#8E8E93', colorName: 'gray', configured: false }),
  cat({ id: 'other', title: 'Other', color: '#8E8E93', colorName: 'gray', fallback: true }),
]
const ITEMS = [
  item({ key: 'a', category: 'proj' }),
  item({ key: 'b', category: 'proj' }),
  item({ key: 'c', category: 'agent-made' }),
  item({ key: 'd', category: 'other' }),
  item({ key: 'e', category: 'other' }),
]
const VP = { w: 1600, h: 1000 }

interface Scene {
  lang?: string
  categories?: BoardCategory[]
  moved?: [string, string][]
  canEdit?: boolean
}

const dataOf = (scene: Scene) =>
  payload({
    lang: scene.lang === 'ru' ? 'ru' : 'en',
    items: ITEMS,
    categories: scene.categories ?? CATEGORIES,
    swatches: SWATCHES,
  })

const opened: OldCategories[] = []
function oldSide(scene: Scene): OldCategories {
  const side = new OldCategories({
    lang: scene.lang ?? 'en',
    data: dataOf(scene),
    moved: new Map(scene.moved ?? []),
    canEdit: scene.canEdit ?? true,
  })
  opened.push(side)
  side.draw()
  return side
}
afterEach(async () => {
  for (const side of opened.splice(0)) await side.dispose()
})

/** What comes under the panel's head: the list, the form, the footer. */
function reactBody(scene: Scene): Node[] {
  const moves = (scene.moved ?? []).reduce(
    (all, [key, c]) => withMove(all, key, { cat: c, column: null, at: 0 }),
    NO_MOVES,
  )
  const nodes = renderInBoard(
    <PanelProvider viewport={() => VP}>
      <CategoriesPanel open={false} focus={null} onClose={() => {}} onOpen={() => {}} />
    </PanelProvider>,
    board({ data: dataOf(scene), connected: scene.canEdit ?? true, ui: { moves } }),
    scene.lang ?? 'en',
  )
  const inner = byClass([byId(nodes, 'cats-sheet')], 'sheet-inner')
  return inner.children.filter(n => !(n.kind === 'element' && n.tag === 'header'))
}

const rowOf = (nodes: Node[], id: string): Element =>
  find(nodes, el => hasClass(el, 'cat-row') && el.attrs.get('data-id') === id)

/** A React row drawn for a state, as its markup. */
function reactRow(props: Partial<Parameters<typeof CategoryRowView>[0]> & { category: BoardCategory }): Node[] {
  const c = props.category
  const nodes = renderInBoard(
    <CategoryRowView
      count={0}
      swatches={SWATCHES}
      disabled={false}
      paletteOpen={false}
      lane={c.color}
      title={c.title}
      path=""
      asking={null}
      {...props}
    />,
    board(),
  )
  return nodes
}

const proj = CATEGORIES[0] as BoardCategory

describe('categories panel markup parity', () => {
  test('every kind of lane: folders, colors by name or hex, made by an agent, the fallback; counts with a card moved', () => {
    const scene: Scene = { moved: [['b', 'ops']] }
    expect(canonical(reactBody(scene))).toBe(canonical(oldSide(scene).body()))
  })

  test('in Russian', () => {
    const scene: Scene = { lang: 'ru' }
    expect(canonical(reactBody(scene))).toBe(canonical(oldSide(scene).body()))
  })

  test('without the board its buttons and fields do nothing', () => {
    const scene: Scene = { canEdit: false }
    expect(canonical(reactBody(scene))).toBe(canonical(oldSide(scene).body()))
  })

  test('no lanes yet', () => {
    const scene: Scene = { categories: [] }
    expect(canonical(reactBody(scene))).toBe(canonical(oldSide(scene).body()))
  })
})

describe('a row’s states, by the old page’s own clicks', () => {
  test('the swatches open; another lane’s color closes them; an agent’s lane opens none', async () => {
    const old = oldSide({})
    const clicks = ['proj', 'ops', 'ops', 'proj', 'agent-made', 'other', 'other', 'proj']
    let open: string | null = null
    for (const id of clicks) {
      await old.world.fire(old.el(`.cat-row[data-id="${id}"] .swatch`), 'click')
      open = paletteAfter(open, CATEGORIES.find(c => c.id === id) as BoardCategory)
      const shown = old.list.querySelectorAll('.palette').filter(p => !p.hidden)
      expect(shown.map(p => p.parentElement?.dataset.id ?? '')).toEqual(open ? [open] : [])
    }
    expect(canonical([rowOf(old.body(), 'proj')])).toBe(
      canonical(reactRow({ category: proj, count: 2, paletteOpen: true })),
    )
  })

  test('a swatch picked: the row takes its color at once, the swatches close, the lane is recolored', async () => {
    const old = oldSide({})
    await old.world.fire(old.el('.cat-row[data-id="proj"] .swatch'), 'click')
    await old.world.fire(old.el('.cat-row[data-id="proj"] .sw[data-color="orange"]'), 'click')
    expect(old.posts).toEqual([{ op: 'update', id: 'proj', color: 'orange' }])
    expect(canonical([rowOf(old.body(), 'proj')])).toBe(
      canonical(reactRow({ category: proj, count: 2, lane: '#FF9500' })),
    )
  })

  test('delete asks first, saying how many sessions then go by folder; the second click deletes', async () => {
    const old = oldSide({})
    await old.world.fire(old.el('.cat-row[data-id="proj"] .cat-del'), 'click')
    const asking = confirmText(2, translator('en'))
    expect(canonical([rowOf(old.body(), 'proj')])).toBe(canonical(reactRow({ category: proj, count: 2, asking })))
    await old.world.fire(old.el('.cat-row[data-id="proj"] .cat-del'), 'click')
    expect(old.posts).toEqual([{ op: 'delete', id: 'proj' }])
    expect(old.toasts).toEqual([['Category “Project <Acme> & "co"” deleted', false]])
    // Not confirmed in four seconds: it asks no more.
    await old.world.fire(old.el('.cat-row[data-id="ops"] .cat-del'), 'click')
    await old.world.tick(4000)
    expect(canonical([rowOf(old.body(), 'ops')])).toBe(
      canonical(reactRow({ category: CATEGORIES[1] as BoardCategory, count: 0 })),
    )
  })

  test('folders: one added as typed (Windows or POSIX), one removed by its ×', async () => {
    const old = oldSide({})
    const field = old.el('.cat-row[data-id="proj"] .path-add')
    for (const typed of ['  D:\\clients\\new ', '~/src/x/', '   ']) {
      field.value = typed
      await old.world.fire(field, 'keydown', { key: 'Enter' })
    }
    await old.world.fire(old.el('.cat-row[data-id="proj"] [data-path="/home/me/acme"]'), 'click')
    expect(old.posts).toEqual([
      { op: 'update', id: 'proj', paths: withPath(proj, '  D:\\clients\\new ') },
      { op: 'update', id: 'proj', paths: withPath(proj, '~/src/x/') },
      { op: 'update', id: 'proj', paths: withoutPath(proj, '/home/me/acme') },
    ])
    expect(withPath(proj, '   ')).toBe(null)
  })

  test('a title left: saved when new; an agent’s lane is added to the settings under its title', async () => {
    const old = oldSide({})
    const title = old.el('.cat-row[data-id="ops"] .cat-title')
    for (const typed of ['  Operations ', 'Ops', '']) {
      title.value = typed
      await old.world.fire(title, 'focusout')
    }
    await old.world.fire(old.el('.cat-row[data-id="agent-made"] .cat-add'), 'click')
    const ops = CATEGORIES[1] as BoardCategory
    expect(old.posts).toEqual([
      { op: 'update', id: 'ops', title: renamed(ops, '  Operations ') },
      { op: 'create', id: 'agent-made', title: 'agent-made' },
    ])
    expect([renamed(ops, 'Ops'), renamed(ops, '')]).toEqual([null, null])
  })

  test('the "new category" form: its color, the id following the title, Create', async () => {
    const old = oldSide({})
    await old.world.fire(old.el('#cat-new'), 'click')
    const titleField = old.el('#cat-draft .draft-title')
    // The title takes the focus once the form is in.
    await old.world.tick(30)
    expect(old.world.document.activeElement).toBe(titleField)
    titleField.value = 'Новый клиент'
    await old.world.fire(titleField, 'input')
    const color = draftColor(CATEGORIES, SWATCHES)
    const draft = renderInBoard(
      <div id="cat-draft">
        <CategoryDraftView color={color} title="Новый клиент" id="novyy-klient" disabled={false} />
      </div>,
      board(),
    )
    const oldBody = old.body()
    expect(canonical([byId(oldBody, 'cat-draft')])).toBe(canonical(draft))
    expect(byId(oldBody, 'cat-new').attrs.has('hidden')).toBe(true)
    await old.world.fire(titleField, 'keydown', { key: 'Enter' })
    expect(old.posts).toEqual([{ op: 'create', ...draftCategory('Новый клиент', 'novyy-klient'), color: color.name }])
    expect(old.toasts).toEqual([['Category “Новый клиент” created', false]])
    await old.world.tick(300)
    expect(old.opened).toEqual(['novyy-klient'])
  })

  test('an id typed by hand stays; Escape drops the form', async () => {
    const old = oldSide({})
    await old.world.fire(old.el('#cat-new'), 'click')
    const id = old.el('#cat-draft .draft-id')
    id.value = 'mine'
    await old.world.fire(id, 'input')
    const titleField = old.el('#cat-draft .draft-title')
    titleField.value = 'Acme Corp!'
    await old.world.fire(titleField, 'input')
    expect(id.value).toBe('mine')
    const pressed = await old.world.fire(titleField, 'keydown', { key: 'Escape' })
    expect(pressed.stopped).toBe(true)
    expect(old.aside.querySelector('#cat-draft .cat-row')).toBe(null)
  })
})

// ---------------------------------------------------------------- reorder

/** Rows 56 px high, 8 px apart, from 100 px down, where their place in the list and their transform put them. */
function rowRect(el: FakeElement): ReturnType<typeof box> | null {
  if (!el.classList.contains('cat-row')) return null
  const parent = el.parentElement
  const i = parent ? parent.children.indexOf(el) : 0
  const ty = /translateY\(([-\d.e]+)px\)/.exec(String(el.style.transform ?? ''))
  return box(20, 100 + i * 64 + (ty ? Number(ty[1]) : 0), 400, 56)
}

interface Gesture {
  /** The row picked up by its handle, then where the pointer goes, frame by frame. */
  row: string
  ys: number[]
  /** Frames after the release. */
  after?: number
}

/** What a viewer could tell apart at one moment: the rows (order, lift, offsets), the capture, what was sent. */
function shot(world: FakeWorld, list: FakeElement, posts: unknown[], order: string[]): string {
  const rows = list.children.map(r => {
    const lifted = r.classList.contains('lifted') ? ' lifted' : ''
    return `${r.dataset.id}${lifted} ${String(r.style.transform ?? '') || '-'}`
  })
  const captures = [...world.captures].map(([id, el]) => `${id}:${el.className}`).join(',')
  return [...rows, `captures ${captures}`, `posts ${JSON.stringify(posts)}`, `lanes ${order.join(',')}`].join('\n')
}

async function drag(world: FakeWorld, list: FakeElement, g: Gesture, snap: () => string): Promise<string[]> {
  const shots: string[] = []
  const handle = list.querySelector(`.cat-row[data-id="${g.row}"] .handle`)
  if (!handle) throw new Error('no handle')
  const [first = 0, ...rest] = g.ys
  await world.pointer('pointerdown', handle, { clientY: first, pointerId: 7 })
  shots.push(snap())
  for (const y of rest) {
    await world.tick()
    await world.pointer('pointermove', handle, { clientY: y, pointerId: 7 })
    shots.push(snap())
  }
  await world.tick()
  await world.pointer('pointerup', handle, { clientY: rest.at(-1) ?? first, pointerId: 7 })
  shots.push(snap())
  for (let i = 0; i < (g.after ?? 60); i++) {
    await world.tick()
    shots.push(snap())
  }
  return shots
}

async function oldDrag(...gestures: Gesture[]): Promise<string[]> {
  const old = new OldCategories({ data: dataOf({}) }, { rects: rowRect })
  try {
    old.draw()
    const snap = () =>
      shot(
        old.world,
        old.list,
        old.posts,
        old.state.data.categories.map(c => c.id),
      )
    const shots: string[] = []
    for (const g of gestures) shots.push(...(await drag(old.world, old.list, g, snap)))
    return shots
  } finally {
    await old.dispose()
  }
}

async function newDrag(...gestures: Gesture[]): Promise<string[]> {
  const world = new FakeWorld({ viewport: { w: 1200, h: 800 }, rects: rowRect })
  world.install()
  try {
    const body = reactBody({})
    const listNode = find(body, el => el.attrs.get('id') === 'cats-list')
    addButtonTypes([listNode])
    const list = world.mount(listNode)
    // The world is installed: its HTMLElement is the fake one.
    if (!(list instanceof HTMLElement)) throw new Error('the world is not installed')
    const data = dataOf({})
    let edits = NO_EDITS
    const posts: unknown[] = []
    const order = () => withEdits(data, edits).categories.map(c => c.id)
    const engine = rowReorder(list, '.handle', () => ({
      onLift() {},
      // As CategoriesPanel's onDrop, then React drawing the rows in the new order (keyed: it moves them).
      onDrop(rows, from, to) {
        if (to !== from) {
          const ids = rows.map(r => r.dataset.id ?? '')
          edits = withEdit(edits, { type: 'order', ids })
          posts.push({ op: 'order', ids })
          for (const id of order()) {
            const row = list.children.find(r => r.dataset.id === id)
            if (row) list.append(row)
          }
        }
        queueMicrotask(() => engine.flip())
      },
    }))
    try {
      const shots: string[] = []
      for (const g of gestures) shots.push(...(await drag(world, list, g, () => shot(world, list, posts, order()))))
      return shots
    } finally {
      engine.detach()
    }
  } finally {
    try {
      await world.settle()
    } finally {
      world.uninstall()
    }
  }
}

describe('reorder: the row follows the pointer 1:1, the others make room, all settle from where they are', () => {
  const rows = ['proj', 'ops', 'agent-made', 'other']
  const centerOf = (i: number) => 100 + i * 64 + 28

  test('down two places, slowly', async () => {
    const g: Gesture = {
      row: 'proj',
      ys: [centerOf(0), centerOf(0) + 20, centerOf(0) + 70, centerOf(0) + 110, centerOf(0) + 140],
    }
    const before = await oldDrag(g)
    const after = await newDrag(g)
    expect(after).toEqual(before)
    expect(before.at(-1)?.split('\n').slice(0, rows.length)).toEqual(['ops -', 'agent-made -', 'proj -', 'other -'])
    expect(before.at(-1)).toContain('"op":"order","ids":["ops","agent-made","proj","other"]')
  })

  test('up past the top, flicked: soft past the end, landing with the pointer’s speed', async () => {
    const g: Gesture = {
      row: 'other',
      ys: [centerOf(3), centerOf(3) - 90, centerOf(3) - 200, centerOf(3) - 260, centerOf(3) - 320],
    }
    const before = await oldDrag(g)
    expect(await newDrag(g)).toEqual(before)
    expect(before.at(-1)).toContain('lanes other,proj,ops,agent-made')
  })

  test('back where it was: nothing sent, it springs back into its place', async () => {
    const g: Gesture = { row: 'ops', ys: [centerOf(1), centerOf(1) + 25, centerOf(1) + 10, centerOf(1) - 5] }
    const before = await oldDrag(g)
    expect(await newDrag(g)).toEqual(before)
    expect(before.at(-1)).toContain('posts []')
  })

  test('another drag while the rows still settle takes them from where they are', async () => {
    const one: Gesture = { row: 'proj', ys: [centerOf(0), centerOf(0) + 80], after: 3 }
    const two: Gesture = { row: 'other', ys: [centerOf(3), centerOf(3) - 60, centerOf(3) - 140] }
    const before = await oldDrag(one, two)
    expect(await newDrag(one, two)).toEqual(before)
    expect(before.at(-1)).toContain('lanes ops,other,proj,agent-made')
  })
})
