// The board in a phone's browser on the page's side (models/remote-page.ts): what the request to
// pair calls the browser, how pairing goes from the board's answers, what hello says; and the
// menus, which leave out what acts on the computer's screen there and only there.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { cardMenu, chipMenu, launchMenu, type MenuEntry, type MenuItem } from '../../web/src/models/menu-model.ts'
import { helloOf, keepAuth, keptAuth, pairName, pollStep, remotePage } from '../../web/src/models/remote-page.ts'
import { FakeWorld } from './support/fake-dom.ts'

const t = translator('en')

test('the request to pair names the browser', () => {
  const ua = {
    safari:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    chrome:
      'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    edge: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
    samsung:
      'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    firefoxIos:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15',
  }
  expect(pairName(ua.safari)).toBe('Board in Safari')
  expect(pairName(ua.chrome)).toBe('Board in Chrome')
  expect(pairName(ua.edge)).toBe('Board in Edge')
  expect(pairName(ua.samsung)).toBe('Board in Samsung Internet')
  expect(pairName(ua.firefoxIos)).toBe('Board in Firefox')
  expect(pairName('')).toBe('Board in a browser')
})

test("pairing goes by the board's answers; hello says whether this browser is paired", () => {
  expect(pollStep({ status: 'pending' })).toBeNull()
  expect(pollStep({ status: 'approved', device: 'iphone' })).toEqual({ step: 'paired' })
  expect(pollStep({ status: 'denied' })).toEqual({ step: 'denied' })
  expect(pollStep({ status: 'gone' })).toEqual({ step: 'expired' })
  expect(pollStep(null)).toBeNull()
  expect(helloOf({ board: 'agent-board', name: 'box', host: 'BOX', paired: true, language: 'ru' })).toEqual({
    name: 'box',
    host: 'BOX',
    paired: true,
    language: 'ru',
    auth: 'pair',
    signedIn: false,
  })
  expect(helloOf({ board: 'agent-board', host: 'BOX' })).toEqual({
    name: null,
    host: 'BOX',
    paired: false,
    language: null,
    auth: 'pair',
    signedIn: false,
  })
  expect(helloOf({ error: 'user' })).toBeNull()
})

test("through the owner's domain hello says to sign in, and whether this browser is; the page keeps how it gets in", () => {
  expect(helloOf({ board: 'agent-board', api: 3, auth: 'login', signedIn: true, language: 'ru' })).toEqual({
    name: null,
    host: '',
    paired: false,
    language: 'ru',
    auth: 'login',
    signedIn: true,
  })
  expect(helloOf({ board: 'agent-board', auth: 'login', signedIn: false, language: null })).toMatchObject({
    auth: 'login',
    signedIn: false,
  })
  // Without auth, or with one the page does not know: pairing, as today.
  expect(helloOf({ board: 'agent-board', host: 'BOX', paired: true })).toMatchObject({ auth: 'pair', signedIn: false })
  expect(helloOf({ board: 'agent-board', auth: 'passwordless', signedIn: 'yes' })).toMatchObject({
    auth: 'pair',
    signedIn: false,
  })

  const world = new FakeWorld({ viewport: { w: 390, h: 844 } })
  world.install()
  try {
    expect(keptAuth()).toBeNull()
    keepAuth('login')
    expect(keptAuth()).toBe('login')
    expect(world.storage.get('agent-board:phone-auth')).toBe('login')
    keepAuth('pair')
    expect(keptAuth()).toBe('pair')
    world.storage.set('agent-board:phone-auth', 'magic')
    expect(keptAuth()).toBeNull()
    // A browser that refuses storage: nothing kept, and keeping throws nothing.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage is off')
      },
    })
    expect(keptAuth()).toBeNull()
    keepAuth('login')
  } finally {
    world.uninstall()
  }
})

const isItem = (i: MenuEntry): i is MenuItem => !i.separator
const ids = (items: readonly MenuEntry[]) => items.filter(isItem).map(i => i.id)

test("in a phone's browser the menus leave out focus, open and show in folder; on the computer they stay", () => {
  const base = { t, canMutate: true, canEdit: true, categories: [], column: 'idle', category: 'other' }
  const it = {
    key: 's1',
    session: 's1',
    agent: 'claude',
    pane: 'p1',
    cwd: '/x',
    status: 'idle',
    column: 'idle',
    auto: 'idle',
  }
  const desk = ids(cardMenu(it, base))
  const phone = ids(cardMenu(it, { ...base, remote: true }))
  expect(desk).toContain('focus')
  expect(desk).toContain('reveal')
  expect(phone).toEqual(desk.filter(id => id !== 'focus' && id !== 'reveal'))
  const launch = { id: 'l1', state: 'failed', kind: 'message', pane: 'p2', cwd: '/x' }
  expect(ids(launchMenu(launch as never, base))).toContain('focus')
  expect(ids(launchMenu(launch as never, { ...base, remote: true }))).not.toContain('focus')
  expect(ids(chipMenu({ dir: false }, base))).toEqual(['look', 'open', 'reveal', 'copyPath'])
  expect(ids(chipMenu({ dir: false }, { ...base, remote: true }))).toEqual(['look', 'copyPath'])
  // The board's own page has no mark.
  expect(remotePage()).toBe(false)
})
