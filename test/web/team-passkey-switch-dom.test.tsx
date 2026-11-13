// The switch "Confirm with a passkey" (#367) on a real DOM (jsdom). In the Team panel's Passkeys:
// off by default, and it cannot be turned on before a passkey is added; with one, flipping it asks
// the board to turn it on, and on, to turn it off (which the board confirms in its window). The
// confirmation window says, before the browser's own dialog, what can sign there: Touch ID or
// iCloud Keychain on a Mac, Windows Hello, a security key, and that a phone cannot.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'

let createRoot: typeof import('react-dom/client').createRoot
let TeamPasskeys: typeof import('../../web/src/components/team/TeamPasskeys.tsx').TeamPasskeys
let ConfirmScreen: typeof import('../../web/src/components/team/ConfirmScreen.tsx').ConfirmScreen
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let board: typeof import('./support/board.tsx').board
let translator: typeof import('../../src/core/i18n/translator.ts').translator

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:12460/',
})
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TeamPasskeys } = await import('../../web/src/components/team/TeamPasskeys.tsx'))
  ;({ ConfirmScreen } = await import('../../web/src/components/team/ConfirmScreen.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ board } = await import('./support/board.tsx'))
  ;({ translator } = await import('../../src/core/i18n/translator.ts'))
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  restoreFetch()
})
afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null
const settle = () => act(async () => void (await new Promise(r => setTimeout(r, 10))))

async function show(node: React.ReactNode): Promise<void> {
  const host = dom.window.document.getElementById('root') as HTMLElement
  root = createRoot(host)
  act(() =>
    root?.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={board()}>{node}</BoardContext.Provider>
      </I18nProvider>,
    ),
  )
  await settle()
}

const PASSKEY = { id: 'k1', label: 'Chrome on macOS', addedAt: Date.UTC(2026, 10, 10), usedAt: null }
const t = (key: string) => translator('en')(key)

test('no passkey: the switch is off and cannot be turned on; the panel says to add one first, and what works', async () => {
  answers([200, { passkeys: [], required: false }])
  await show(<TeamPasskeys open disabled={false} />)
  const flip = q('[data-switch="passkey"]') as HTMLButtonElement
  expect(flip.getAttribute('aria-checked')).toBe('false')
  expect(flip.disabled).toBe(true)
  const hints = [...dom.window.document.querySelectorAll('.team-passkeys .hint')].map(h => h.textContent)
  expect(hints).toEqual([t('team.passkeys.about'), t('team.passkeys.none')])
  expect(t('team.passkeys.none')).toContain('Touch ID or iCloud Keychain')
})

test('with a passkey: flipping it asks the board to turn it on; on, flipping asks to turn it off', async () => {
  const calls = answers(
    [200, { passkeys: [PASSKEY], required: false }],
    [200, { ok: true }],
    [
      200,
      {
        passkeys: [PASSKEY],
        required: true,
      },
    ],
    [200, { ok: true }],
    [200, { passkeys: [PASSKEY], required: false }],
  )
  await show(<TeamPasskeys open disabled={false} />)
  const flip = () => q('[data-switch="passkey"]') as HTMLButtonElement
  expect(flip().disabled).toBe(false)
  expect(flip().getAttribute('aria-checked')).toBe('false')
  act(() => flip().click())
  await settle()
  expect(flip().getAttribute('aria-checked')).toBe('true')
  act(() => flip().click())
  await settle()
  expect(flip().getAttribute('aria-checked')).toBe('false')
  expect(sent(calls).filter(c => c[1] === 'POST')).toEqual([
    ['/api/team/passkeys', 'POST', '1', { op: 'on' }],
    ['/api/team/passkeys', 'POST', '1', { op: 'off' }],
  ])
})

test('the window says what can sign before the browser’s dialog, and words turning the switch off', async () => {
  answers([200, { action: { kind: 'passkey-off' }, step: 'get', options: { challenge: 'AAAA' } }])
  await show(<ConfirmScreen id="AAAAAAAAAAAAAAAAAAAAAA" />)
  expect(q('.team-confirm-title')?.textContent).toBe(t('team.confirm.off'))
  const notes = [...dom.window.document.querySelectorAll('.team-confirm-note')]
  const devices = notes.find(n => n.textContent === t('team.confirm.devices'))
  expect(devices).toBeDefined()
  // Before the button that opens the browser's dialog.
  const button = q('.team-confirm-actions .primary') as HTMLElement
  expect(devices?.compareDocumentPosition(button)).toBe(dom.window.Node.DOCUMENT_POSITION_FOLLOWING)
  for (const words of ['Touch ID', 'iCloud Keychain', 'Windows Hello', 'security key', 'phone cannot sign'])
    expect(t('team.confirm.devices')).toContain(words)
  expect(notes.map(n => n.textContent)).toContain(t('team.confirm.offNote'))
})
