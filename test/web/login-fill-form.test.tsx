// A login fill in the session sheet (components/secrets/LoginFill.tsx), on a real DOM (jsdom): the
// site the board read, the field with the focus and what will be typed first; the master password
// masked and kept from spelling, autofill and password managers; one POST, then the field empty,
// a wrong password asked again; several matches picked by name and username; kept unlocked, no
// password asked; Decline answers without one.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { LoginFillView } from '../../src/core/login-fill.ts'
import type { Item } from '../../src/core/types.ts'
import type { board as Board } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let LoginFills: typeof import('../../web/src/components/secrets/LoginFill.tsx').LoginFills
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
  ;({ LoginFills } = await import('../../web/src/components/secrets/LoginFill.tsx'))
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

const view = (over: Partial<LoginFillView> = {}): LoginFillView => ({
  id: 'abcdef012345',
  site: 'login.acme.test',
  title: 'Sign in · Acme',
  field: 'email',
  fields: ['username', 'password'],
  submit: true,
  username: '',
  at: Date.now(),
  expires: Date.now() + 600_000,
  stage: 'asked',
  matches: null,
  unlockedUntil: null,
  firstLogin: false,
  error: '',
  ...over,
})

async function mount(fills: LoginFillView[], reply: (body: Record<string, unknown>) => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    sent.push({ url, body })
    return reply(body)
  }) as typeof fetch
  const toasts: string[] = []
  const item = { key: 's1', loginFill: fills } as unknown as Item
  const el = dom.window.document.getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={board({ toast: text => toasts.push(text) })}>
          <LoginFills item={item} />
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  return { sent, toasts, root }
}

test('the site, the field and what is typed first; the master password masked and quiet; one POST, then empty', async () => {
  const { sent, toasts, root } = await mount([view()], () => Response.json({ ok: true, result: 'ok' }))
  const text = q('form.login-fill')?.textContent ?? ''
  expect(text).toContain('In its browser, on login.acme.test')
  expect(text).toContain('Sign in · Acme')
  expect(text).toContain('The field with the focus: an e-mail field')
  expect(text).toContain('Types: username → Tab → password → Return')
  expect(text).toContain('looked up in your vault once you unlock it')
  const inputs = qa('form.login-fill input')
  expect(inputs.map(i => [i.getAttribute('aria-label') ?? i.type, i.type])).toEqual([
    ['Vault master password', 'password'],
    ['checkbox', 'checkbox'],
  ])
  const pw = inputs[0] as HTMLInputElement
  expect(pw.getAttribute('spellcheck')).toBe('false')
  expect(pw.getAttribute('autocomplete')).toBe('off')
  expect(pw.hasAttribute('data-1p-ignore')).toBe(true)
  const fill = q('button[type="submit"]')
  expect(fill.disabled).toBe(true)
  await setValue(pw, 'master-pw')
  await click(inputs[1] ?? null)
  await click(fill)
  expect(sent).toEqual([
    { url: '/api/vault/fill/abcdef012345', body: { op: 'approve', password: 'master-pw', keep: true } },
  ])
  expect(toasts).toEqual(['Filled in on login.acme.test'])
  expect((qa('form.login-fill input')[0] as HTMLInputElement).value).toBe('')
  await act(async () => root.unmount())
})

test('a wrong password: said, and asked again (never kept); the first sign-in shows the code field', async () => {
  const { sent, root } = await mount([view({ firstLogin: true })], () =>
    Response.json({ ok: false, error: 'The vault did not open: wrong master password?' }, { status: 400 }),
  )
  const inputs = qa('form.login-fill input')
  expect(inputs.map(i => i.getAttribute('aria-label') ?? i.type)).toEqual([
    'Vault master password',
    'Two-step code of the vault account, if it has one',
    'checkbox',
  ])
  await setValue(inputs[0] as HTMLInputElement, 'nope')
  await setValue(inputs[1] as HTMLInputElement, ' 123456 ')
  await click(q('button[type="submit"]'))
  expect(sent).toEqual([
    { url: '/api/vault/fill/abcdef012345', body: { op: 'approve', password: 'nope', code: '123456', keep: false } },
  ])
  expect(q('form.login-fill [role="alert"]')?.textContent).toBe('The vault did not open: wrong master password?')
  expect((qa('form.login-fill input')[0] as HTMLInputElement).value).toBe('')
  await act(async () => root.unmount())
})

test('several matches: picked by name and username, the item’s id sent; kept unlocked: no password asked', async () => {
  const matches = [
    { id: 'i1', name: 'Acme work', username: 'bot@acme.test', totp: false },
    { id: 'i2', name: '', username: '', totp: true },
  ]
  const { sent, root } = await mount([view({ stage: 'pick', matches })], () =>
    Response.json({ ok: true, result: 'ok' }),
  )
  const text = q('form.login-fill')?.textContent ?? ''
  expect(text).toContain('Several logins match')
  expect(text).toContain('Acme work · bot@acme.test')
  expect(text).toContain('(no name) · (no username)')
  expect(qa('form.login-fill input[type="password"]').length).toBe(0)
  await click(qa('form.login-fill input[type="radio"]')[1] ?? null)
  await click(q('button[type="submit"]'))
  expect(sent).toEqual([{ url: '/api/vault/fill/abcdef012345', body: { op: 'pick', item: 'i2' } }])
  await act(async () => root.unmount())
  const kept = await mount([view({ unlockedUntil: Date.now() + 600_000, matches: [matches[0] as never] })], () =>
    Response.json({ ok: true, result: 'ok' }),
  )
  expect(q('form.login-fill')?.textContent).toContain('The vault is unlocked until')
  expect(q('form.login-fill')?.textContent).toContain('From your vault: Acme work · bot@acme.test')
  expect(qa('form.login-fill input').length).toBe(0)
  await click(q('button[type="submit"]'))
  expect(kept.sent).toEqual([{ url: '/api/vault/fill/abcdef012345', body: { op: 'approve', keep: false } }])
  await act(async () => kept.root.unmount())
})

test('Decline answers without a password', async () => {
  const { sent, toasts, root } = await mount([view()], () => Response.json({ ok: true, result: 'declined' }))
  await setValue(qa('form.login-fill input')[0] as HTMLInputElement, 'typed-but-declined')
  const decline = qa('form.login-fill button').find(b => b.textContent === 'Decline') ?? null
  await click(decline)
  expect(sent).toEqual([{ url: '/api/vault/fill/abcdef012345', body: { op: 'decline' } }])
  expect(toasts).toEqual(['Declined'])
  await act(async () => root.unmount())
})
