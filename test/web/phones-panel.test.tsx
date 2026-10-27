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
  pwa: { on: false, https: 443, url: null, certs: false, serve: null, error: null },
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
    expect(buttons).toEqual(['Approve', 'Deny', 'Set up the HTTPS address', 'Unpair', 'Turn off phones'])
  })

  test('on the board in a browser elsewhere: where to approve, and no button the server refuses', () => {
    const doc = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { hasAttribute: (name: string) => name === 'data-remote' } },
    })
    try {
      const nodes = render(REMOTE)
      const all = text([byId(nodes, 'phones-sheet')])
      expect(all).toContain('Agent board app on xiaomi-17 asks to use this board')
      expect(all).toContain('board remote approve r1')
      const buttons = findAll(nodes, el => el.tag === 'button' && hasClass(el, 'button'))
      expect(buttons.map(b => text(b.children))).toEqual(['Set up the HTTPS address', 'Unpair', 'Turn off phones'])
      expect(buttons.every(b => b.attrs.has('disabled'))).toBe(true)
    } finally {
      if (doc) Object.defineProperty(globalThis, 'document', doc)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })

  test("on the owner's desk elsewhere: Approve, Deny and Unpair; turning phones off stays with the computer", () => {
    const doc = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { hasAttribute: (name: string) => name === 'data-remote' || name === 'data-desk' } },
    })
    try {
      const nodes = render(REMOTE)
      expect(text([byId(nodes, 'phones-sheet')])).toContain('This browser is your desk.')
      const buttons = findAll(nodes, el => el.tag === 'button' && hasClass(el, 'button'))
      const enabled = buttons.filter(b => !b.attrs.has('disabled')).map(b => text(b.children))
      expect(enabled).toEqual(['Approve', 'Deny', 'Unpair'])
    } finally {
      if (doc) Object.defineProperty(globalThis, 'document', doc)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })

  test('no phone yet; and why phones cannot reach it', () => {
    const none = text(render({ ...REMOTE, pending: [], devices: [] }))
    expect(none).toContain('No phone is paired yet')
    const down = text(render({ ...REMOTE, url: null, error: 'Tailscale is not connected on this computer' }, 'ru'))
    expect(down).toContain('Телефоны не достанут доску: Tailscale is not connected on this computer')
  })

  test("in a phone's browser: what Tailscale still needs, then the address and its QR code", () => {
    const button = (nodes: Node[], label: string) =>
      findAll(nodes, el => el.tag === 'button' && text(el.children) === label)[0]
    const noCerts = render(REMOTE)
    expect(text(noCerts)).toContain('HTTPS certificates are off for your tailnet.')
    const link = findAll(noCerts, el => el.tag === 'a' && hasClass(el, 'ext'))[0]
    expect(link?.attrs.get('href')).toBe('https://login.tailscale.com/admin/dns')
    expect(button(noCerts, 'Set up the HTTPS address')?.attrs.has('disabled')).toBe(true)

    const ready = render({ ...REMOTE, pwa: { ...REMOTE.pwa, certs: true } })
    expect(text(ready)).not.toContain('HTTPS certificates are off')
    expect(button(ready, 'Set up the HTTPS address')?.attrs.has('disabled')).toBe(false)

    const url = 'https://box.tail0.ts.net'
    const on = render({ ...REMOTE, pwa: { on: true, https: 443, url, certs: true, serve: 'ours', error: null } })
    expect(text(on)).toContain(`Scan it with the phone, or open ${url}`)
    expect(findAll(on, el => el.tag === 'svg' && hasClass(el, 'phones-qr'))).toHaveLength(1)
    expect(button(on, 'Turn off')).toBeDefined()
    const other = render({
      ...REMOTE,
      pwa: { on: true, https: 443, url: null, certs: true, serve: 'other', error: null },
    })
    expect(text(other)).toContain("Port 443 of this computer's Tailscale name already serves something else")
  })

  test('a paired browser says so', () => {
    const devices = [{ ...(REMOTE.devices[0] as RemoteView['devices'][number]), kind: 'browser' as const }]
    expect(text(render({ ...REMOTE, devices }))).toContain('Agent board app · pixelbrowser')
  })
})
