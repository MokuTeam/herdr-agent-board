// The secret form in the session sheet (#273, components/secrets/SecretForm.tsx), on a real DOM
// (jsdom): where the values go is shown before the fields; masked fields, kept out of spelling
// services, autofill and password managers; one POST with the values and what the form showed,
// then the fields are empty again; a refusal is said and the Bitwarden session is asked anew.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { SecretView } from '../../src/core/secrets.ts'
import type { Item } from '../../src/core/types.ts'
import type { board as Board } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let SecretRequests: typeof import('../../web/src/components/secrets/SecretForm.tsx').SecretRequests
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let board: typeof Board

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
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
  'KeyboardEvent',
  'HTMLInputElement',
  'MutationObserver',
  'getComputedStyle',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch
const watching = new WeakMap<object, (e: { propertyName: string }) => void>()

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.attachEvent = function (this: object, name: string, fn: (e: { propertyName: string }) => void) {
    if (name === 'onpropertychange') watching.set(this, fn)
  }
  proto.detachEvent = function (this: object) {
    watching.delete(this)
  }
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SecretRequests } = await import('../../web/src/components/secrets/SecretForm.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ board } = await import('./support/board.tsx'))
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLInputElement
const qa = (sel: string) => [...dom.window.document.querySelectorAll(sel)] as HTMLInputElement[]
async function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  await act(async () => {
    el.focus()
    setter?.call(el, value)
    watching.get(el)?.({ propertyName: 'value', target: el, srcElement: el } as { propertyName: string })
    for (const type of ['input', 'change']) el.dispatchEvent(new dom.window.Event(type, { bubbles: true }))
  })
}
async function click(el: Element | null) {
  expect(el).toBeTruthy()
  await act(async () => {
    el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 20))
  })
}

const view = (over: Partial<SecretView> = {}): SecretView => ({
  id: 'abcdef012345',
  title: 'ERP login',
  sink: 'vault',
  sinkTitle: 'The team vault',
  kind: 'bitwarden',
  where: 'folder “Agents”, item “ERP login” (made, or updated when it is there)',
  detail: '',
  fingerprint: 'f1f1f1f1f1f1f1f1',
  fields: [
    { name: 'username', hidden: false },
    { name: 'password', hidden: true, once: true },
  ],
  params: { item: 'ERP login' },
  at: Date.now(),
  expires: Date.now() + 600_000,
  ...over,
})

async function mount(secrets: SecretView[], reply: (body: Record<string, unknown>) => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    sent.push({ url, body })
    return reply(body)
  }) as typeof fetch
  const toasts: string[] = []
  const item = { key: 's1', secrets } as unknown as Item
  const el = dom.window.document.getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={board({ toast: text => toasts.push(text) })}>
          <SecretRequests item={item} />
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  return { sent, toasts, root }
}

test('where it goes first, masked fields kept from spelling, autofill and password managers; one POST, then empty fields', async () => {
  const { sent, toasts, root } = await mount([view()], () =>
    Response.json({ ok: true, target: 'Bitwarden: Agents › ERP login' }),
  )
  const text = q('form.secret')?.textContent ?? ''
  expect(text).toContain('folder “Agents”, item “ERP login”')
  expect(text).toContain('The team vault')
  expect(text).toContain('item = ERP login')
  expect(text).toContain('only if not set yet')
  const inputs = qa('form.secret input')
  expect(inputs.map(i => [i.getAttribute('aria-label'), i.type])).toEqual([
    ['username', 'text'],
    ['password', 'password'],
    ['Bitwarden session (bw unlock --raw)', 'password'],
  ])
  for (const i of inputs) {
    expect(i.getAttribute('spellcheck')).toBe('false')
    expect(i.getAttribute('autocomplete')).toBe('off')
    expect(i.hasAttribute('data-1p-ignore')).toBe(true)
  }
  const write = q('button[type="submit"]')
  expect(write.disabled).toBe(true)
  await setValue(inputs[0] as HTMLInputElement, 'me')
  await setValue(inputs[1] as HTMLInputElement, 'pw-1')
  expect(write.disabled).toBe(true) // no session yet
  await setValue(inputs[2] as HTMLInputElement, 'sess')
  // Show turns a masked field to text, and back; the owner can mask a shown one too
  const eyes = () => qa('form.secret .secret-eye')
  expect(eyes().map(b => b.textContent)).toEqual(['Hide', 'Show'])
  await click(eyes()[1] ?? null)
  expect((qa('form.secret input')[1] as HTMLInputElement).type).toBe('text')
  await click(eyes()[1] ?? null)
  expect((qa('form.secret input')[1] as HTMLInputElement).type).toBe('password')
  await click(eyes()[0] ?? null)
  expect((qa('form.secret input')[0] as HTMLInputElement).type).toBe('password')
  expect(q('form.secret')?.textContent).toContain('Written as typed, spaces too')
  await click(write)
  expect(sent).toEqual([
    {
      url: '/api/secret/abcdef012345',
      body: {
        op: 'submit',
        values: { username: 'me', password: 'pw-1' },
        fingerprint: 'f1f1f1f1f1f1f1f1',
        session: 'sess',
      },
    },
  ])
  expect(toasts).toEqual(['Written to Bitwarden: Agents › ERP login'])
  expect(qa('form.secret input').map(i => i.value)).toEqual(['', '', ''])
  await act(async () => root.unmount())
})

test('a refusal is said, what was typed stays for another try, and the Bitwarden session is asked again', async () => {
  const { sent, root } = await mount([view()], () =>
    Response.json({ ok: false, error: 'Bitwarden is not unlocked with this session' }, { status: 400 }),
  )
  const inputs = qa('form.secret input')
  await setValue(inputs[1] as HTMLInputElement, 'pw-2')
  await setValue(inputs[2] as HTMLInputElement, 'old-session')
  await click(q('button[type="submit"]'))
  expect(sent.length).toBe(1)
  expect(q('form.secret [role="alert"]')?.textContent).toBe('Bitwarden is not unlocked with this session')
  expect(qa('form.secret input').map(i => i.value)).toEqual(['', 'pw-2', ''])
  await act(async () => root.unmount())
})

test('Decline answers without values; a request whose sink is gone offers Decline only', async () => {
  const { sent, toasts, root } = await mount([view({ problem: 'The sink “vault” is no longer in config.json' })], () =>
    Response.json({ ok: true }),
  )
  expect(qa('form.secret input').length).toBe(0)
  expect(q('form.secret [role="alert"]')?.textContent).toBe('The sink “vault” is no longer in config.json')
  expect(q('button[type="submit"]').disabled).toBe(true)
  const decline = [...dom.window.document.querySelectorAll('form.secret button')].find(b => b.textContent === 'Decline')
  await click(decline ?? null)
  expect(sent).toEqual([{ url: '/api/secret/abcdef012345', body: { op: 'decline' } }])
  expect(toasts).toEqual(['Declined'])
  await act(async () => root.unmount())
})
