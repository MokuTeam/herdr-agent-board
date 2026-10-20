// The board in a phone's browser on the page's side (models/remote-page.ts): what the request to
// pair calls the browser, how pairing goes from the board's answers, what hello says; and the
// menus, which leave out what acts on the computer's screen there and only there.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { cardMenu, chipMenu, launchMenu, type MenuEntry, type MenuItem } from '../../web/src/models/menu-model.ts'
import { gateAfter, helloOf, nextRetryMs, pairName, pollStep, remotePage } from '../../web/src/models/remote-page.ts'

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
  })
  expect(helloOf({ board: 'agent-board', host: 'BOX' })).toEqual({
    name: null,
    host: 'BOX',
    paired: false,
    language: null,
  })
  expect(helloOf({ error: 'user' })).toBeNull()
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

test('the board on show stays through a check with no answer or a refusal; only "not paired" takes it away (#108)', () => {
  // A 502 from serve while the board's listener is down, or a whois Tailscale could not answer.
  expect(gateAfter('board', 'unreachable')).toBe('board')
  expect(gateAfter('board', 'refused')).toBe('board')
  expect(gateAfter('board', 'unpaired')).toBe('pair')
  expect(gateAfter('board', 'paired')).toBe('board')
  // Before the board: the screens as they were.
  expect(gateAfter('checking', 'unreachable')).toBe('offline')
  expect(gateAfter('checking', 'refused')).toBe('refused')
  expect(gateAfter('offline', 'paired')).toBe('board')
  expect(gateAfter('pair', 'unreachable')).toBe('offline')
  // The stream opened again: 2 s, then doubling, at most 15.
  expect([nextRetryMs(null), nextRetryMs(2000), nextRetryMs(4000), nextRetryMs(8000), nextRetryMs(15_000)]).toEqual([
    2000, 4000, 8000, 15_000, 15_000,
  ])
})
