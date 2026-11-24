// Settings, Devices, "Add a computer" (#513, components/devices/AddComputer.tsx):
// renders collapsed without fetching, displays pasted command, found device + fingerprint + Approve,
// expired state, done state, and Russian strings.
import { afterEach, describe, expect, test } from 'bun:test'
import { COMPUTER_IDLE_VIEW, type ComputerSetupView } from '../../src/core/node-computer-setup.ts'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { FakeWorld } from './support/fake-dom.ts'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { byId, type Node, serializeNodes } from './support/markup.ts'
import { first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const NOW = Date.now()
const VP = { w: 1600, h: 900 }
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

const draw = (computerSetup?: ComputerSetupView, lang: 'en' | 'ru' = 'en') =>
  renderInBoard(
    <PanelProvider viewport={() => VP}>
      <DevicesPanel open onClose={() => {}} {...(computerSetup && { computerSetup })} />
    </PanelProvider>,
    board({ data: payload({}), now: NOW }),
    lang,
  )

describe('Add a computer UI (#513)', () => {
  afterEach(restoreFetch)

  test('asks nothing while collapsed and sends start / approve on interaction', async () => {
    const calls = answers()
    let hosts: Host[] = []
    const view: ComputerSetupView = {
      ...COMPUTER_IDLE_VIEW,
      phase: 'found',
      command: 'echo ABC | base64 -d | gunzip | sh',
      socket: 'anna-mac-123',
      found: {
        id: 'anna-mac',
        host: 'anna-mbp',
        platform: 'darwin',
        version: '0.1.0',
        fingerprint: 'ab'.repeat(32),
      },
    }
    function Probe() {
      hosts = hostElements(<DevicesPanel open onClose={() => {}} computerSetup={view} />)
      return null
    }
    renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Probe />
      </PanelProvider>,
      board({ data: payload({}), now: NOW }),
    )
    const world = new FakeWorld({ viewport: VP })
    const el = world.mount(
      first(
        renderInBoard(
          <PanelProvider viewport={() => VP}>
            <DevicesPanel open onClose={() => {}} computerSetup={view} />
          </PanelProvider>,
          board({ data: payload({}), now: NOW }),
        ),
      ),
    )
    listenLikeReact(
      world.wrap(world.body),
      () => el,
      () => hosts,
    )
    expect(calls).toEqual([])
    const approveBtn = el.querySelector('.devices-computer-found .button.primary')
    if (!approveBtn) throw new Error('missing Approve button')
    await world.fire(approveBtn, 'click')
    await new Promise(r => setTimeout(r, 0))
    const posts = calls.filter(c => c.init?.method === 'POST').map(c => JSON.parse(String(c.init?.body)))
    expect(posts).toEqual([{ op: 'approve', id: 'anna-mac' }])
  })

  test('renders waiting, found, expired, done, and Russian views', () => {
    const waiting = text([
      byId(
        draw({ ...COMPUTER_IDLE_VIEW, phase: 'waiting', command: 'echo XYZ | base64 -d | gunzip | sh' }),
        'devices-sheet',
      ),
    ])
    expect(waiting).toContain('echo XYZ | base64 -d | gunzip | sh')
    expect(waiting).toContain('Waiting for the computer to dial the relay')

    const found = text([
      byId(
        draw({
          ...COMPUTER_IDLE_VIEW,
          phase: 'found',
          command: 'echo XYZ | base64 -d | gunzip | sh',
          found: {
            id: 'anna-mac',
            host: 'anna-mbp',
            platform: 'darwin',
            version: '0.1.0',
            fingerprint: 'cd'.repeat(32),
          },
        }),
        'devices-sheet',
      ),
    ])
    expect(found).toContain('anna-mac (anna-mbp, darwin) answered on the relay.')
    expect(found).toContain('Approve')
    expect(serializeNodes(draw({ ...COMPUTER_IDLE_VIEW, phase: 'expired' }))).toContain('Create command')
    expect(
      text([byId(draw({ ...COMPUTER_IDLE_VIEW, phase: 'done', device: { id: 'anna-mac' } }), 'devices-sheet')]),
    ).toContain('anna-mac is now a node of this board.')
    expect(
      text([
        byId(
          draw({
            ...COMPUTER_IDLE_VIEW,
            phase: 'waiting',
            command: 'echo XYZ | base64 -d | gunzip | sh',
            next: { key: 'node.computer.hint.claimed' },
          }),
          'devices-sheet',
        ),
      ]),
    ).toContain('board node forget')
    expect(text([byId(draw(COMPUTER_IDLE_VIEW, 'ru'), 'devices-sheet')])).toContain('Добавить компьютер')
  })
})
