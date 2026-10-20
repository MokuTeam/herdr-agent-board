// The Phones panel (components/phones/PhonesPanel.tsx), drawn only while the remote mode is on.
import { describe, expect, test } from 'bun:test'
import type { RemoteView } from '../../src/core/remote.ts'
import { PhonesPanel } from '../../web/src/components/phones/PhonesPanel.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { byId, findAll, hasClass, type Node } from './support/markup.ts'

const REMOTE: RemoteView = {
  on: true,
  url: 'http://box.tail0.ts.net:12422',
  error: null,
  pending: [
    {
      id: 'r1',
      name: 'Agent board app',
      device: 'xiaomi-17',
      login: 'me@example.com',
      node: 'n',
      os: 'android',
      at: 1,
    },
  ],
  devices: [
    {
      id: 'd1',
      name: 'Agent board app',
      device: 'pixel',
      login: 'me@example.com',
      node: 'n2',
      os: 'android',
      pairedAt: 1,
      seenAt: null,
    },
  ],
}

const render = (remote: RemoteView | undefined, lang = 'en') =>
  renderInBoard(
    <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
      <PhonesPanel open onClose={() => {}} />
    </PanelProvider>,
    board({ data: payload(remote ? { remote } : {}) }),
    lang,
  )

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

describe('Phones panel', () => {
  test('nothing while the remote mode is off', () => {
    expect(render(undefined)).toEqual([])
  })

  test('where phones reach the board, who asks, who is paired', () => {
    const nodes = render(REMOTE)
    const all = text([byId(nodes, 'phones-sheet')])
    expect(all).toContain('The board for phones: http://box.tail0.ts.net:12422')
    expect(all).toContain('Agent board app on xiaomi-17 asks to use this board')
    expect(all).toContain('me@example.com, android')
    expect(all).toContain('not seen yet')
    const buttons = findAll(nodes, el => el.tag === 'button' && hasClass(el, 'button')).map(b => text(b.children))
    expect(buttons).toEqual(['Approve', 'Deny', 'Unpair', 'Turn off phones'])
  })

  test('no phone yet; and why phones cannot reach it', () => {
    const none = text(render({ ...REMOTE, pending: [], devices: [] }))
    expect(none).toContain('No phone is paired yet')
    const down = text(render({ ...REMOTE, url: null, error: 'Tailscale is not connected on this computer' }, 'ru'))
    expect(down).toContain('Телефоны не достанут доску: Tailscale is not connected on this computer')
  })
})
