// NetSuite Sessions view under Settings > Devices (#897, components/devices/NsSessionsSection.tsx):
// metadata only (never cookie values, at most 8-char fp), live/dying/dead states, no-TOTP hint,
// Notify toggle (optimistic + rollback), Forget action (owner only), SSE updates, and DevicesPanel
// integration. Placeholder accounts and fake values only.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { NsSessionsSection } from '../../web/src/components/devices/NsSessionsSection.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import {
  type NsSessionEntry,
  type NsSessionsSnapshot,
  sanitizeNsSessionsSnapshot,
} from '../../web/src/models/ns-sessions.ts'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { findAll, hasClass, serializeNodes } from './support/markup.ts'

const NOW = Date.UTC(2026, 10, 26, 18, 0, 0)
const MIN = 60_000
const VP = { w: 1200, h: 900 }

const ENTRY_LIVE: NsSessionEntry = {
  account: '1234567_SB1',
  user: 'agent@example.com',
  host: '1234567-sb1.app.netsuite.com',
  role: 'Administrator',
  fp: '0a1b2c3d',
  state: 'live',
  generation: 2,
  login_at: NOW - 90 * MIN,
  first_seen: NOW - 90 * MIN,
  abs_expiry: NOW + 630 * MIN,
  abs_expiry_estimated: false,
  idle_expiry: NOW + 150 * MIN,
  last_activity: NOW - 5 * MIN,
  last_where: { machine: 'server-2', profile: 'main' },
  origin: { machine: 'laptop', profile: 'work' },
  holders: ['laptop', 'server-2'],
  dead_at: null,
  dead_reason: null,
  auto_renew: true,
  last_event: { kind: 'imported', at: NOW - 10 * MIN, where: { machine: 'server-2', profile: 'main' } },
  lock: null,
}

const ENTRY_DYING_NO_TOTP: NsSessionEntry = {
  account: '7654321',
  user: 'owner@example.com',
  host: '7654321.app.netsuite.com',
  role: null,
  fp: 'deadbeef',
  state: 'dying',
  generation: 1,
  login_at: NOW - 705 * MIN,
  first_seen: NOW - 705 * MIN,
  abs_expiry: NOW + 15 * MIN,
  abs_expiry_estimated: false,
  idle_expiry: NOW + 90 * MIN,
  last_activity: NOW - 30 * MIN,
  last_where: { machine: 'laptop', profile: 'work' },
  origin: { machine: 'laptop', profile: 'work' },
  holders: ['laptop'],
  dead_at: null,
  dead_reason: null,
  auto_renew: false,
  last_event: { kind: 'published', at: NOW - 705 * MIN, where: { machine: 'laptop', profile: 'work' } },
  lock: { holder: { machine: 'server-2', profile: 'main', run_id: 'r1' }, until: NOW + 60_000 },
}

const ENTRY_DEAD: NsSessionEntry = {
  account: '9876543',
  user: null,
  host: '9876543.app.netsuite.com',
  role: null,
  fp: '11223344',
  state: 'dead',
  generation: 3,
  login_at: NOW - 400 * MIN,
  first_seen: NOW - 400 * MIN,
  abs_expiry: NOW + 320 * MIN,
  abs_expiry_estimated: false,
  idle_expiry: NOW - 20 * MIN,
  last_activity: NOW - 200 * MIN,
  last_where: { machine: 'server-2', profile: 'main' },
  origin: { machine: 'server-2', profile: 'main' },
  holders: ['server-2'],
  dead_at: NOW - 10 * MIN,
  dead_reason: 'login_redirect',
  auto_renew: false,
  last_event: {
    kind: 'dead',
    at: NOW - 10 * MIN,
    where: { machine: 'server-2', profile: 'main' },
    reason: 'login_redirect',
  },
  lock: null,
}

describe('NsSessionsSection (#897)', () => {
  test('sanitizes any stray cookie fields out of snapshots', () => {
    const dirty = {
      ok: true,
      entries: [
        {
          ...ENTRY_LIVE,
          fp: '0a1b2c3d99999999',
          cookies: [{ name: 'JSESSIONID', value: 'fake-leaked-secret-value' }],
        },
      ],
      notify: { '1234567_SB1': true, bad: 'nope' },
    }
    const clean = sanitizeNsSessionsSnapshot(dirty)
    expect(clean.entries).toHaveLength(1)
    expect(clean.entries[0]?.fp).toBe('0a1b2c3d')
    expect(JSON.stringify(clean)).not.toContain('fake-leaked-secret-value')
    expect(JSON.stringify(clean)).not.toContain('cookies')
    expect(clean.notify).toEqual({ '1234567_SB1': true })
  })

  test('renders metadata rows, no-TOTP hint, lock, holders, and integrates inside DevicesPanel', () => {
    const snap: NsSessionsSnapshot = { entries: [ENTRY_LIVE, ENTRY_DYING_NO_TOTP, ENTRY_DEAD], notify: {} }
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <DevicesPanel open onClose={() => {}} nsSessions={snap} />
      </PanelProvider>,
      board({ data: payload({}), canEdit: true, now: NOW }),
    )
    const section = findAll(nodes, el => hasClass(el, 'ns-sessions'))
    expect(section).toHaveLength(1)
    const rendered = serializeNodes(section)
    expect(rendered).toContain('NetSuite sessions')
    expect(rendered).toContain('1 live · 1 ending soon · 1 ended')
    expect(rendered).toContain('1234567_SB1')
    expect(rendered).toContain('agent@example.com')
    expect(rendered).toContain('fp 0a1b2c3d')
    expect(rendered).toContain('7654321')
    expect(rendered).toContain('No TOTP auto-renew configured for this account')
    expect(rendered).toContain('Login lock: server-2/main')
    expect(rendered).toContain('9876543')
    expect(rendered).toContain('User unknown')
    expect(rendered).toContain('Ended · login redirect')
  })

  test('renders unknown login_at and marks estimated abs_expiry with about', () => {
    const unknownLogin: NsSessionEntry = {
      ...ENTRY_DYING_NO_TOTP,
      login_at: null,
      first_seen: NOW - 120 * MIN,
      abs_expiry_estimated: true,
    }
    const clean = sanitizeNsSessionsSnapshot({ ok: true, entries: [unknownLogin], notify: {} })
    expect(clean.entries[0]?.login_at).toBeNull()
    expect(clean.entries[0]?.abs_expiry_estimated).toBe(true)
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <DevicesPanel open onClose={() => {}} nsSessions={clean} />
      </PanelProvider>,
      board({ data: payload({}), canEdit: true, now: NOW }),
    )
    const rendered = serializeNodes(findAll(nodes, el => hasClass(el, 'ns-sessions')))
    expect(rendered).toContain('Unknown (seen')
    expect(rendered).toContain('about ')
  })

  describe('interactive DOM behavior (fetch, SSE, notify toggle, forget, read-only)', () => {
    let dom: JSDOM
    const saved = new Map<string, PropertyDescriptor | undefined>()
    const globals = [
      'window',
      'document',
      'navigator',
      'Node',
      'Element',
      'HTMLElement',
      'HTMLButtonElement',
      'Event',
      'MouseEvent',
      'CustomEvent',
      'EventSource',
    ]

    class FakeEventSource {
      static instances: FakeEventSource[] = []
      url: string
      private listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
      closed = false
      constructor(url: string) {
        this.url = url
        FakeEventSource.instances.push(this)
      }
      addEventListener(type: string, fn: (ev: MessageEvent) => void) {
        const list = this.listeners.get(type) ?? []
        list.push(fn)
        this.listeners.set(type, list)
      }
      removeEventListener(type: string, fn: (ev: MessageEvent) => void) {
        const list = this.listeners.get(type) ?? []
        this.listeners.set(
          type,
          list.filter(x => x !== fn),
        )
      }
      emit(type: string, data: unknown) {
        for (const fn of this.listeners.get(type) ?? []) {
          fn({ data: JSON.stringify(data) } as MessageEvent)
        }
      }
      close() {
        this.closed = true
      }
    }

    beforeAll(() => {
      dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:12422/' })
      const g = globalThis as Record<string, unknown>
      for (const k of globals) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
      Object.assign(g, {
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        Node: dom.window.Node,
        Element: dom.window.Element,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        Event: dom.window.Event,
        MouseEvent: dom.window.MouseEvent,
        CustomEvent: dom.window.CustomEvent,
        EventSource: FakeEventSource,
      })
    })

    afterEach(() => {
      restoreFetch()
      FakeEventSource.instances.length = 0
    })

    afterAll(() => {
      const g = globalThis as Record<string, unknown>
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(g, k, d)
        else delete g[k]
      }
      dom.window.close()
    })

    test('fetches list with X-Board, handles SSE updates, notify toggle + rollback, and forget', async () => {
      const calls = answers(
        [200, { ok: true, entries: [ENTRY_LIVE, ENTRY_DYING_NO_TOTP], notify: {} }],
        [200, { ok: true, account: '1234567_SB1', notify: true, prefs: { '1234567_SB1': true } }],
        [500, { ok: false, error: 'disk' }],
        [200, { ok: true, removed: true }],
      )
      const toasts: [string, boolean | undefined][] = []
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)

      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContextWrapper now={NOW} canEdit={true} toast={(m, b) => toasts.push([m, b])}>
              <NsSessionsSection open={true} canEdit={true} />
            </BoardContextWrapper>
          </I18nProvider>,
        )
      })

      expect(calls[0]?.url).toBe('/api/ns-sessions/list')
      expect((calls[0]?.init?.headers as Record<string, string>)?.['x-board']).toBe('1')
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(FakeEventSource.instances[0]?.url).toBe('/api/ns-sessions/events')
      expect(host.querySelectorAll('.ns-row')).toHaveLength(2)

      // Toggle Notify ON for ENTRY_LIVE (auto_renew: true -> default was OFF).
      const liveSwitch = host.querySelector('[data-switch="ns-notify-1234567_SB1"]') as HTMLButtonElement
      expect(liveSwitch.getAttribute('aria-checked')).toBe('false')
      await act(async () => {
        liveSwitch.click()
      })
      expect(liveSwitch.getAttribute('aria-checked')).toBe('true')

      // Toggle Notify OFF for ENTRY_DYING_NO_TOTP, server errors 500 -> rolls back & toasts.
      const dyingSwitch = host.querySelector('[data-switch="ns-notify-7654321"]') as HTMLButtonElement
      expect(dyingSwitch.getAttribute('aria-checked')).toBe('true')
      await act(async () => {
        dyingSwitch.click()
      })
      expect(dyingSwitch.getAttribute('aria-checked')).toBe('true')
      expect(toasts.at(-1)?.[1]).toBe(true)

      // Forget ENTRY_LIVE -> POST /forget & row removed.
      const forgetBtn = host.querySelector('[data-account="1234567_SB1"] .ns-forget') as HTMLButtonElement
      await act(async () => {
        forgetBtn.click()
      })
      expect(host.querySelectorAll('.ns-row')).toHaveLength(1)
      expect(sent(calls.slice(1))).toEqual([
        ['/api/ns-sessions/notify', 'POST', '1', { account: '1234567_SB1', notify: true }],
        ['/api/ns-sessions/notify', 'POST', '1', { account: '7654321', notify: false }],
        ['/api/ns-sessions/forget', 'POST', '1', { account: '1234567_SB1', user: 'agent@example.com' }],
      ])

      // SSE update replaces entries and drops any stray cookie values.
      await act(async () => {
        FakeEventSource.instances[0]?.emit('sessions', {
          entries: [{ ...ENTRY_DEAD, cookies: [{ name: 'JSESSIONID', value: 'fake-sse-secret' }] }],
          notify: {},
        })
      })
      expect(host.querySelectorAll('.ns-row')).toHaveLength(1)
      expect(host.textContent).toContain('9876543')
      expect(host.textContent).not.toContain('fake-sse-secret')

      await act(async () => root.unmount())
      expect(FakeEventSource.instances[0]?.closed).toBe(true)
      host.remove()
    })

    test('503 shows unavailable note; !canEdit disables controls', async () => {
      answers([503, { ok: false, code: 'store_unavailable' }])
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)

      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContextWrapper now={NOW} canEdit={false} toast={() => {}}>
              <NsSessionsSection open={true} canEdit={false} />
            </BoardContextWrapper>
          </I18nProvider>,
        )
      })
      expect(host.textContent).toContain('NetSuite session store is unavailable')

      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContextWrapper now={NOW} canEdit={false} toast={() => {}}>
              <NsSessionsSection open={true} canEdit={false} initial={{ entries: [ENTRY_LIVE], notify: {} }} />
            </BoardContextWrapper>
          </I18nProvider>,
        )
      })
      expect((host.querySelector('.ns-forget') as HTMLButtonElement).disabled).toBe(true)
      expect((host.querySelector('[data-switch="ns-notify-1234567_SB1"]') as HTMLButtonElement).disabled).toBe(true)

      await act(async () => root.unmount())
      host.remove()
    })
  })
})

function BoardContextWrapper({
  children,
  now,
  canEdit,
  toast,
}: {
  children: ReactNode
  now: number
  canEdit: boolean
  toast: (msg: string, bad?: boolean) => void
}) {
  return (
    <BoardContext.Provider value={board({ data: payload({}), canEdit, now, toast })}>{children}</BoardContext.Provider>
  )
}
