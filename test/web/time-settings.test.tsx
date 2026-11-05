// Settings → Time tracking… (#237, web/src/models/time-settings.ts, components/time/TimeSettingsPanel.tsx
// TimeSettingsBody, the Settings menu): offered on the local board's page only; the view read with a
// guard; the clients in the lanes' order with a line of what each has; a client opened to its
// projects (billable a column named once, a client never billed without it), the retired ones to
// bring back, its systems; the lanes without time; every lane taking time made explicit first.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory } from '../../src/core/payload.ts'
import { TimeSettingsBody, type TimeSettingsBodyProps } from '../../web/src/components/time/TimeSettingsPanel.tsx'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import {
  clientLine,
  clientOrder,
  isTimeSettingsView,
  lanesWithout,
  type TimeClientView,
  type TimeSettingsView,
  zonesOf,
} from '../../web/src/models/time-settings.ts'
import { board, renderInBoard } from './support/board.tsx'
import { type Element, findAll, type Node } from './support/markup.ts'

const t = translator('en')
const lane = (id: string, title: string): BoardCategory => ({
  id,
  title,
  color: '#007AFF',
  colorName: 'blue',
  paths: [],
  configured: true,
  fallback: false,
})
const LANES = [
  lane('client-b', 'Client B'),
  lane('client-a', 'Client A'),
  lane('personal', 'Personal'),
  lane('other', 'Other'),
]
const CLIENT: TimeClientView = {
  on: true,
  projects: ['Support', 'Internal'],
  retired: ['Old'],
  billable: true,
  nonBillable: ['Internal'],
  systems: [
    { id: 'erp', title: 'ERP' },
    { id: 'tracker', title: 'tracker' },
  ],
  rules: 2,
  ref: false,
  zone: null,
  use: { Support: 3, Old: 1 },
}
const VIEW: TimeSettingsView = {
  on: true,
  set: true,
  zone: 'America/New_York',
  localZone: 'Europe/Istanbul',
  every: false,
  clients: {
    'client-a': CLIENT,
    personal: { ...CLIENT, projects: ['Internal'], retired: [], billable: false, systems: [], rules: 0, use: {} },
    'client-b': { ...CLIENT, on: false },
  },
  problems: [],
}

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

function render(props: Partial<TimeSettingsBodyProps>) {
  const nodes = renderInBoard(
    <TimeSettingsBody
      view={null}
      loadError={null}
      lanes={LANES}
      swatches={[]}
      disabled={false}
      refusal={null}
      send={async () => true}
      {...props}
    />,
    board(),
  )
  const by = (cls: string) => findAll(nodes, el => (el.attrs.get('class') ?? '').split(' ').includes(cls))
  return { nodes, all: text(nodes), by }
}

test('Time tracking… is offered on the local board only, after Backup…; picked, it opens its panel', () => {
  const now = {
    t,
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right' as const,
    sleepers: false,
    profiles: false,
  }
  const ids = (items: ReturnType<typeof settingsMenu>) => items.map(i => ('separator' in i ? '—' : i.id))
  const items = ids(settingsMenu({ ...now, backup: true, timeSettings: true }))
  expect(items.indexOf('timeSettings')).toBe(items.indexOf('backup') + 1)
  expect(ids(settingsMenu({ ...now, backup: true }))).not.toContain('timeSettings')
  expect(
    settingsMenu({ ...now, t: translator('ru'), timeSettings: true }).find(i => 'id' in i && i.id === 'timeSettings'),
  ).toEqual({ id: 'timeSettings', label: 'Учёт времени…' })
  expect(settingPicked('timeSettings')).toEqual({ kind: 'timeSettings' })
})

test('the view is read with a guard; the zones offered hold the one set; the clients in the lanes’ order', () => {
  expect(isTimeSettingsView(VIEW)).toBe(true)
  expect(isTimeSettingsView({ ...VIEW, clients: { a: { on: 'yes' } } })).toBe(false)
  expect(isTimeSettingsView(null)).toBe(false)
  const zones = zonesOf('Etc/Unknown-Set', 'Europe/Istanbul')
  expect(zones).toContain('Etc/Unknown-Set')
  expect(zones).toContain('UTC')
  expect(zones).toEqual([...zones].sort())
  // an agent's own lane id, with no lane on the board, after the others
  const view = { ...VIEW, clients: { ...VIEW.clients, 'agent-made': CLIENT } }
  expect(clientOrder(view, LANES)).toEqual(['client-b', 'client-a', 'personal', 'agent-made'])
  expect(lanesWithout(view, LANES).map(l => l.id)).toEqual(['other'])
  expect(clientLine(CLIENT, t)).toBe('2 projects · Entered into ERP, tracker')
  expect(clientLine({ ...CLIENT, projects: null, billable: false, systems: [] }, t)).toBe(
    'Takes any project. · never billed',
  )
})

test('while the view is asked, and when it could not be read', () => {
  expect(render({}).all).toContain('Reading the settings…')
  expect(render({ loadError: 'status 500' }).all).toContain('Could not read the settings: status 500')
})

test('time off says its settings stay; every lane taking time is made explicit first', () => {
  expect(render({ view: { ...VIEW, on: false } }).all).toContain('Off: nothing is logged.')
  const every = render({ view: { ...VIEW, every: true, clients: {} } })
  expect(every.all).toContain('Every lane takes time, with any project.')
  expect(every.all).toContain('Choose the lanes')
  expect(every.by('time-set-client')).toEqual([])
})

test('the clients: each with its line, one off says so, the lanes without time to take it', () => {
  const r = render({ view: VIEW })
  const names = r
    .by('time-set-client')
    .map(li => text(findAll(li.children, el => el.attrs.get('class') === 'time-dot')[0]?.children ?? []))
  expect(names).toEqual(['Client B', 'Client A', 'Personal'])
  expect(r.all).toContain('Off: takes no new entries. Its entries stay, billed as before.')
  expect(r.all).toContain('1 project · never billed')
  expect(text(r.by('time-set-lanes')[0]?.children ?? [])).toBe('OtherTake time')
  expect(r.all).toContain('New lane with time')
  // closed: no projects shown
  expect(r.by('time-set-projects')).toEqual([])
})

test('a client opened: projects with their entries and Billable, the retired to bring back, its systems, its rules kept in config.json', () => {
  // the only client opens by itself
  const r = render({ view: { ...VIEW, clients: { 'client-a': CLIENT } } })
  const rows = r.by('time-set-project')
  expect(rows.map(li => text(li.children))).toEqual(['Support3 entries', 'Internal', 'Old1 entryBring back'])
  const checks = findAll(rows, (el: Element) => el.tag === 'input' && el.attrs.get('type') === 'checkbox')
  // billable, then each of its two systems (a project entered elsewhere is unticked there)
  expect(checks.map(c => [c.attrs.get('aria-label'), c.attrs.has('checked')])).toEqual([
    ['Billable: Support', true],
    ['Entered into ERP: Support', true],
    ['Entered into tracker: Support', true],
    ['Billable: Internal', false],
    ['Entered into ERP: Internal', true],
    ['Entered into tracker: Internal', true],
  ])
  expect(r.all).toContain('Retired: not offered for new entries, kept by their entries')
  expect(text(r.by('time-set-systems')[0]?.children ?? [])).toBe('ERPerp×tracker×')
  expect(r.all).toContain('Billing rules and the reference are set in config.json.')
  // never billed: no Billable column, said
  const unbilled = render({ view: { ...VIEW, clients: { personal: { ...CLIENT, billable: false } } } })
  expect(
    findAll(unbilled.by('time-set-project'), el => (el.attrs.get('aria-label') ?? '').startsWith('Billable')),
  ).toEqual([])
  expect(unbilled.all).toContain('Never billed: its time counts as worked only.')
  // any project: kept as a list from what its entries have
  const any = render({ view: { ...VIEW, clients: { a: { ...CLIENT, projects: null } } } })
  expect(any.all).toContain('Keep a list')
})

test('a refusal is said under the part it is about', () => {
  const r = render({
    view: { ...VIEW, clients: { 'client-a': CLIENT } },
    refusal: { part: 'client-a', text: '"Support" is there already.' },
  })
  expect(text(r.by('time-set-client-body')[0]?.children ?? [])).toContain('"Support" is there already.')
  expect(render({ view: VIEW, refusal: { part: 'time', text: 'nope' } }).by('time-set-refusal').length).toBe(1)
})

test('a project’s systems: a column each where the client has two, named once; one alone is no choice', () => {
  const r = render({
    view: { ...VIEW, clients: { 'client-a': { ...CLIENT, projectSystems: { Internal: ['tracker'] } } } },
  })
  expect(text(r.by('time-set-projects-head')[0]?.children ?? [])).toBe('ProjectsBillableERPtracker')
  const checks = findAll(r.by('time-set-project'), el => (el.attrs.get('aria-label') ?? '').startsWith('Entered'))
  expect(checks.map(c => [c.attrs.get('aria-label'), c.attrs.has('checked')])).toEqual([
    ['Entered into ERP: Support', true],
    ['Entered into tracker: Support', true],
    ['Entered into ERP: Internal', false],
    ['Entered into tracker: Internal', true],
  ])
  expect(r.all).toContain('A system unticked for a project: its entries are not entered there')
  const one = render({
    view: { ...VIEW, clients: { 'client-a': { ...CLIENT, systems: [{ id: 'erp', title: 'ERP' }] } } },
  })
  expect(findAll(one.by('time-set-project'), el => (el.attrs.get('aria-label') ?? '').startsWith('Entered'))).toEqual(
    [],
  )
  expect(one.all).not.toContain('A system unticked')
})
