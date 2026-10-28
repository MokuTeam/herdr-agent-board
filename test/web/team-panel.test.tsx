// The Team panel (#231, components/team/TeamPanel.tsx): the roster with its online dots, the
// connection line, a person whose key changed with Trust, the thread with the delivery states,
// Send posting { to, text } with the board's header; and nothing of it, no /api/team fetch, on a
// page without the payload's teamRev or on a remote page.
import { afterEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { SidePanels } from '../../web/src/components/SidePanels.tsx'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import type { Schedule } from '../../web/src/hooks/useSchedule.ts'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import {
  isTeamView,
  isThread,
  offersTeam,
  sendError,
  stateLine,
  type TeamView,
  type ThreadMessage,
} from '../../web/src/models/team.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { byClass, findAll, hasClass, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

afterEach(restoreFetch)

const t = translator('en')
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const ANA = 'A'.repeat(43)
const BOB = 'B'.repeat(43)

const VIEW: TeamView = {
  state: 'online',
  me: { peer: 'M'.repeat(43), fingerprint: 'aaaa bbbb cccc dddd', name: 'Dima' },
  hub: 'wss://hub.example.com',
  roster: [
    { peer: ANA, name: 'Ana', online: true, lastSeen: null, fingerprint: '1111 2222 3333 4444', pin: 'trusted' },
    { peer: BOB, name: 'Bob', online: false, lastSeen: 1000, fingerprint: '5555 6666 7777 8888', pin: 'changed' },
  ],
}

const THREAD: ThreadMessage[] = [
  { id: 'q1', dir: 'out', text: 'queued one', ts: '2026-10-28T10:00:00Z', state: 'queued' },
  { id: 'q2', dir: 'out', text: 'delivered one', ts: '2026-10-28T10:01:00Z', state: 'delivered' },
  { id: 'q3', dir: 'out', text: 'acked one', ts: '2026-10-28T10:02:00Z', state: 'acked' },
  { id: 'q4', dir: 'out', text: 'expired one', ts: '2026-10-28T10:03:00Z', state: 'expired' },
  { id: 'i1', dir: 'in', text: null, ts: '2026-10-28T10:04:00Z', held: true },
]

function props(over: Partial<TeamBodyProps> = {}): TeamBodyProps {
  return {
    view: VIEW,
    peer: null,
    thread: [],
    draft: '',
    disabled: false,
    onSelect() {},
    onTrust() {},
    onDraft() {},
    onSend() {},
    ...over,
  }
}

const render = (p: TeamBodyProps, lang = 'en') => renderInBoard(<TeamBody {...p} />, board(), lang)

describe('Team panel', () => {
  test('roster: an online dot for who is on, none for who is not, and fingerprints', () => {
    const nodes = render(props())
    const rows = findAll(nodes, el => hasClass(el, 'team-peer'))
    expect(rows).toHaveLength(2)
    const dots = findAll(nodes, el => hasClass(el, 'team-dot'))
    expect(dots.map(d => hasClass(d, 'on'))).toEqual([true, false])
    const all = text(nodes)
    expect(all).toContain('Ana')
    expect(all).toContain('online')
    expect(all).toContain('Key 1111 2222 3333 4444')
    expect(all).toContain('Key aaaa bbbb cccc dddd')
  })

  test('connection line: one per state, the error and the next try', () => {
    expect(text(render(props()))).toContain('Online at wss://hub.example.com')
    expect(stateLine({ ...VIEW, state: 'connecting' }, t)).toBe('Connecting to wss://hub.example.com…')
    expect(stateLine({ ...VIEW, state: 'error', error: 'bad hub' }, t)).toBe(
      'Could not use wss://hub.example.com: bad hub',
    )
    expect(stateLine({ ...VIEW, state: 'reconnecting', nextAt: Date.now() + 5000 }, t)).toContain('trying again')
    expect(stateLine({ ...VIEW, state: 'revoked' }, t)).toContain('removed from the team')
    expect(stateLine({ ...VIEW, state: 'online' }, translator('ru'))).toContain('На связи')
  })

  test('a key that changed: its row says so, with Trust, which asks for that person', () => {
    const trusted: string[] = []
    const p = props({ onTrust: x => void trusted.push(x) })
    let hosts: Host[] = []
    function Probe() {
      hosts = hostElements(<TeamBody {...p} />)
      return null
    }
    renderInBoard(<Probe />, board())
    const nodes = render(p)
    expect(findAll(nodes, el => hasClass(el, 'team-changed'))).toHaveLength(1)
    expect(text([byClass(nodes, 'team-changed')])).toContain('The key of Bob changed')
    const trust = hosts.find(h => h.tag === 'button' && h.props.children === 'Trust the new key')
    if (typeof trust?.props.onClick !== 'function') throw new Error('no Trust button')
    trust.props.onClick()
    expect(trusted).toEqual([BOB])
  })

  test('nothing picked: no thread and no box; picked: the thread with delivery states and held', () => {
    expect(findAll(render(props()), el => el.tag === 'textarea')).toHaveLength(0)
    const nodes = render(props({ peer: ANA, thread: THREAD }))
    const all = text(nodes)
    expect(all).toContain('Messages with Ana')
    expect(all).toContain('from you · queued at the hub')
    expect(all).toContain('from you · delivered')
    expect(all).toContain('from you · received')
    expect(all).toContain('from you · expired, not delivered')
    expect(all).toContain('from them · held back until the new key is trusted')
    expect(all).toContain('held — key changed, Trust to read')
    expect(all).not.toContain('held one')
    expect(findAll(nodes, el => hasClass(el, 'held'))).toHaveLength(1)
    expect(findAll(nodes, el => el.tag === 'textarea')).toHaveLength(1)
  })

  test('a message the hub refused says so with the code, in both languages; the thread is accepted as such (#231)', () => {
    const refused: ThreadMessage = {
      id: 'r1',
      dir: 'out',
      text: 'refused one',
      ts: '2026-10-28T10:05:00Z',
      state: 'refused',
      code: 'not_member',
    }
    expect(isThread({ peer: ANA, messages: [refused] })).toBe(true)
    expect(isThread({ peer: ANA, messages: [{ ...refused, state: 'nonsense' }] })).toBe(false)
    expect(text(render(props({ peer: ANA, thread: [refused] })))).toContain(
      'from you · refused by the hub (not_member), not sent',
    )
    expect(text(render(props({ peer: ANA, thread: [refused] }), 'ru'))).toContain('хаб отклонил (not_member)')
  })

  test('a person whose key changed: Send is off and says why; the refusal code is explained (#231)', () => {
    const send = (peer: string) =>
      findAll(render(props({ peer, draft: 'hi' })), el => el.tag === 'button' && text([el]) === 'Send')[0]
    expect(send(ANA)?.attrs.has('disabled')).toBe(false)
    expect(send(BOB)?.attrs.has('disabled')).toBe(true)
    expect(text(render(props({ peer: BOB })))).toContain('trust the new key before you send')
    expect(sendError('changed', t)).toContain('their key changed')
  })

  test('Send is off for an empty draft and while disabled', () => {
    const send = (over: Partial<TeamBodyProps>) =>
      findAll(render(props({ peer: ANA, ...over })), el => el.tag === 'button' && text([el]) === 'Send')[0]
    expect(send({ draft: '' })?.attrs.has('disabled')).toBe(true)
    expect(send({ draft: 'hi', disabled: true })?.attrs.has('disabled')).toBe(true)
    expect(send({ draft: 'hi' })?.attrs.has('disabled')).toBe(false)
  })

  test('Trust and Send go through the source: POST /api/team/trust { peer }, /api/team/send { to, text }, with X-Board', async () => {
    const toasts: string[] = []
    const calls = answers(
      [200, { ok: true }],
      [200, VIEW],
      [200, { ok: true, id: 'x' }],
      [200, VIEW],
      [200, { ok: false }],
    )
    const source = teamSource({ t: () => t, toast: x => void toasts.push(x) })
    await source.trust(BOB)
    expect(await source.send(ANA, 'hello')).toBe(true)
    expect(sent(calls).slice(0, 3)).toEqual([
      ['/api/team/trust', 'POST', '1', { peer: BOB }],
      ['/api/team', undefined, undefined, undefined],
      ['/api/team/send', 'POST', '1', { to: ANA, text: 'hello' }],
    ])
  })

  test('a refused send says why and is not sent as done', async () => {
    const toasts: string[] = []
    answers([400, { ok: false, error: 'peer' }])
    const source = teamSource({ t: () => t, toast: x => void toasts.push(x) })
    expect(await source.send(ANA, 'hello')).toBe(false)
    expect(toasts).toEqual(['Not sent: not in the team'])
  })

  test('the view is fetched on opening and on each new teamRev while open, with the thread of the peer picked', async () => {
    const calls = answers(
      [200, VIEW],
      [200, VIEW],
      [200, { peer: ANA, messages: THREAD }],
      [200, VIEW],
      [200, { peer: ANA, messages: [] }],
    )
    const source = teamSource({ t: () => t, toast: () => {} })
    source.sync(false, 1)
    expect(calls).toHaveLength(0)
    source.sync(true, 1)
    await Bun.sleep(5)
    source.sync(true, 1)
    expect(calls.map(c => c.url)).toEqual(['/api/team'])
    source.select(ANA)
    await Bun.sleep(5)
    expect(source.now.get().thread).toEqual(THREAD)
    source.sync(true, 2)
    await Bun.sleep(5)
    expect(calls.map(c => c.url)).toEqual([
      '/api/team',
      '/api/team',
      `/api/team/thread/${ANA}`,
      '/api/team',
      `/api/team/thread/${ANA}`,
    ])
  })

  test('the answers are checked: a view and a thread of another shape are refused', () => {
    expect(isTeamView(VIEW)).toBe(true)
    expect(isTeamView({ ...VIEW, state: 'weird' })).toBe(false)
    expect(isTeamView({ ...VIEW, roster: [{ peer: 'x' }] })).toBe(false)
    expect(isThread({ peer: ANA, messages: THREAD })).toBe(true)
    expect(isThread({ peer: ANA, messages: [{ id: 1 }] })).toBe(false)
  })
})

describe('without teamRev, or on a remote page', () => {
  const now = {
    t,
    theme: 'dark',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right',
    sleepers: false,
    profiles: false,
    fold: null,
  } as unknown as Parameters<typeof settingsMenu>[0]
  const ids = (team: boolean) => settingsMenu({ ...now, team }).map(e => ('id' in e ? e.id : '—'))

  test('Settings offers Team… only when asked to, and picking it opens the panel', () => {
    expect(ids(false)).not.toContain('team')
    expect(ids(true)).toContain('team')
    expect(settingsMenu({ ...now, team: true }).find(e => 'id' in e && e.id === 'team')).toMatchObject({
      label: 'Team…',
    })
    expect(settingPicked('team')).toEqual({ kind: 'team' })
  })

  test('offersTeam: the local page with teamRev (0 too), nothing else', () => {
    expect(offersTeam({ teamRev: 0 }, false)).toBe(true)
    expect(offersTeam({ teamRev: 3 }, true)).toBe(false)
    expect(offersTeam({}, false)).toBe(false)
    expect(offersTeam(null, false)).toBe(false)
  })

  test('SidePanels draws the panel only on the local page with teamRev', () => {
    const RESTING: Schedule = { armed: null, held: null, cancel() {}, mode() {}, disarm() {} }
    const draw = (data: ReturnType<typeof payload>) =>
      renderInBoard(
        <PanelProvider>
          <SidePanels
            categories={{ open: false, focus: null, onClose() {}, onOpen() {} }}
            schedule={{ open: false, focus: null, onClose() {}, schedule: RESTING }}
            team={{ open: true, onClose() {} }}
          />
        </PanelProvider>,
        board({ data }),
      )
    const ids = (nodes: Node[]) => findAll(nodes, el => el.attrs.get('id') === 'team-sheet')
    expect(ids(draw(payload()))).toHaveLength(0)
    expect(ids(draw(payload({ teamRev: 1 })))).toHaveLength(1)
  })
})
