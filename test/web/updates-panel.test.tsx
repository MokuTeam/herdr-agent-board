// Settings → Updates… (#617, components/updates/UpdatesPanel.tsx UpdatesBody, models/self-update.ts,
// models/settings-menu.ts): the item on the local page only, its pick; the panel loading, unread, on
// a checkout with the switch and the schedule, on a node or without a checkout (no switch, no Check
// now), a problem in the danger color, and what came in.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { UpdatesBody, type UpdatesBodyProps } from '../../web/src/components/updates/UpdatesPanel.tsx'
import { isUpdatesView, type UpdatesView } from '../../web/src/models/self-update.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const VIEW: UpdatesView = {
  config: { on: false, every: 'hour', at: '04:00' },
  state: {},
  standing: null,
  checkout: { branch: 'main', commit: '0123456789abcdef0123456789abcdef01234567' },
  node: false,
  canRestart: true,
  running: false,
}

function render(props: Partial<UpdatesBodyProps>) {
  const nodes = renderInBoard(
    <UpdatesBody
      view={null}
      loadError={null}
      busy={null}
      note={null}
      canEdit={true}
      onCheck={() => {}}
      onSettings={() => {}}
      {...props}
    />,
    board(),
  )
  const all = text(nodes)
  const buttons = findAll(nodes, el => el.tag === 'button').map(b => text(b.children))
  const switches = findAll(nodes, el => el.tag === 'input' && el.attrs.get('role') === 'switch')
  const selects = findAll(nodes, el => el.tag === 'select')
  const times = findAll(nodes, el => el.tag === 'input' && el.attrs.get('type') === 'time')
  const alerts = findAll(nodes, el => el.attrs.get('role') === 'alert').map(a => text(a.children))
  return { all, buttons, switches, selects, times, alerts }
}

test("the view guard takes the route's view and nothing else", () => {
  expect(isUpdatesView(VIEW)).toBe(true)
  expect(isUpdatesView({ ...VIEW, config: null })).toBe(false)
  expect(isUpdatesView(null)).toBe(false)
})

test('Updates… is offered on the local page and picked as itself', () => {
  const t = translator('en')
  const base = {
    t,
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right',
    sleepers: false,
    profiles: false,
  } as const
  const ids = (now: Record<string, unknown>) =>
    settingsMenu({ ...base, ...now } as Parameters<typeof settingsMenu>[0]).map(e => ('id' in e ? e.id : ''))
  expect(ids({ updates: true })).toContain('updates')
  expect(ids({})).not.toContain('updates')
  expect(settingPicked('updates')).toEqual({ kind: 'updates' })
})

test('loading, and a view that could not be read', () => {
  expect(render({}).all).toContain('Reading how updates stand…')
  const failed = render({ loadError: 'status 500' })
  expect(failed.alerts).toEqual(['Could not read how updates stand: status 500'])
})

test('a checkout, off: where it is, Check now, the switch off and no schedule', () => {
  const r = render({ view: VIEW })
  expect(r.all).toContain('On main at 01234567')
  expect(r.buttons).toEqual(['Check now'])
  expect(r.switches).toHaveLength(1)
  expect(r.switches[0]?.attrs.has('checked')).toBe(false)
  expect(r.selects).toHaveLength(0)
  expect(r.all).toContain('Nothing came in yet.')
})

test('on, once a day: the time field; a check running says so and holds the button', () => {
  const r = render({ view: { ...VIEW, config: { on: true, every: 'day', at: '05:00' }, running: true } })
  expect(r.selects).toHaveLength(1)
  expect(r.times).toHaveLength(1)
  expect(r.buttons).toEqual(['Checking…'])
})

test('a master view names the board whose schedule the controls edit', () => {
  const r = render({ view: { ...VIEW, masterId: 'hermes' } })
  expect(r.all).toContain('These settings apply to the master board (hermes).')
  expect(r.switches).toHaveLength(1)
})

test('a problem first, in red; what came in last time as a list', () => {
  const r = render({
    view: {
      ...VIEW,
      standing: { level: 'error', text: 'The board did not come back after updating to bbbbbbbb.' },
      state: {
        lastUpdate: {
          at: Date.now() - 60_000,
          outcome: 'updated',
          came: ['Cards keep their lane (#12)', 'A fix (#13)'],
        },
      },
    },
  })
  expect(r.alerts).toEqual(['The board did not come back after updating to bbbbbbbb.'])
  expect(r.all).toContain('What came in')
  expect(r.all).toContain('Cards keep their lane (#12)')
  expect(r.all).toContain('A fix (#13)')
})

test('a node, and a copy that is no checkout: said, and neither the switch nor Check now', () => {
  const node = render({ view: { ...VIEW, node: true } })
  expect(node.all).toContain("This computer is a node: it takes its master's version")
  expect(node.buttons).toEqual([])
  expect(node.switches).toHaveLength(0)
  const none = render({ view: { ...VIEW, checkout: null } })
  expect(none.all).toContain('This copy of the board is not a git checkout.')
  expect(none.switches).toHaveLength(0)
})
