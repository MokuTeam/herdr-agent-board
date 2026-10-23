// What went wrong on the page (#116): a part that fails to draw shows a note with Reload instead of
// nothing, the session panel on its own; in a phone's browser the error, an uncaught one and an
// unhandled rejection go to the board's log, each once, with where, which build and the browser.
// On the computer nothing is sent.
import { afterEach, describe, expect, test } from 'bun:test'
import type { ErrorInfo } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { translator } from '../../src/core/i18n/translator.ts'
import { ErrorBoundary, ErrorScreen } from '../../web/src/components/ErrorBoundary.tsx'
import {
  buildOf,
  errorReporter,
  pageErrorLine,
  shortStack,
  thrownAt,
  watchPageErrors,
} from '../../web/src/models/page-errors.ts'

const t = translator('en')
const ANDROID =
  'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const facts = () => ({ userAgent: ANDROID, build: 'a1b2c3d4e5f6' })

/** An error thrown in the bundle, as Chrome gives its stack. */
function thrown(message = 'Cannot read properties of undefined (reading "cwd")'): TypeError {
  const error = new TypeError(message)
  error.stack = [
    `TypeError: ${message}`,
    '    at SheetHead (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:48211:31)',
    '    at renderWithHooks (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:9120:22)',
  ].join('\n')
  return error
}
// React's component stack in production: the page's components and the elements between them.
const COMPONENTS = [
  '',
  '    at SheetHead (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:48100:1)',
  '    at div',
  '    at Panel (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:47000:1)',
  '    at Sheet (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:47500:1)',
  '    at ErrorBoundary (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:500:1)',
  '    at SidePanels (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:46000:1)',
  '    at App (https://board.example.ts.net/app.js?v=a1b2c3d4e5f6:100:1)',
].join('\n')

describe('a line for the board’s log', () => {
  test('the message, where it was thrown, the components around it, the build and the browser', () => {
    const line = pageErrorLine('render', thrown(), facts(), COMPONENTS)
    expect(line).toBe(
      [
        'render error: TypeError: Cannot read properties of undefined (reading "cwd")',
        'at SheetHead (app.js:48211:31)',
        'in SheetHead < Panel < Sheet < ErrorBoundary',
        'build a1b2c3d4e5f6',
        ANDROID,
      ].join(' · '),
    )
    // The board's log keeps 500 characters of a line (server/routes/page-log.ts).
    expect(line.length).toBeLessThan(500)
  })

  test('a long message is cut, so the build and the browser still fit', () => {
    // Thrown in the bundle, as on a phone: a stack Bun makes here would name this file by the
    // checkout's own path, as long as the folder it is in.
    const line = pageErrorLine('error', thrown('x'.repeat(2000)), facts())
    expect(line).toContain(' · at SheetHead (app.js:48211:31) · ')
    expect(line.length).toBeLessThan(500)
    expect(line).toContain('build a1b2c3d4e5f6')
    expect(line.endsWith(ANDROID)).toBe(true)
  })

  test('what is thrown need not be an Error; Safari and Firefox write their stacks their way', () => {
    expect(pageErrorLine('rejection', 'offline', facts())).toBe(
      `unhandled rejection: offline · build a1b2c3d4e5f6 · ${ANDROID}`,
    )
    expect(pageErrorLine('rejection', { status: 502 }, facts())).toStartWith('unhandled rejection: {"status":502} · ')
    const safari = new Error('boom')
    safari.stack =
      'useBoard@https://board.example.ts.net/app.js?v=abc:120:7\n@https://board.example.ts.net/app.js?v=abc:9:1'
    expect(thrownAt(safari)).toBe('useBoard (app.js:120:7)')
    const anonymous = new Error('boom')
    anonymous.stack = 'Error: boom from a@b.c\n    at https://board.example.ts.net/app.js:1:2'
    expect(thrownAt(anonymous)).toBe('app.js:1:2')
    expect(shortStack('\n    in Sheet\n    in div\n    in SidePanels')).toBe('Sheet < SidePanels')
  })

  test('which build ran: the version in the script’s name', () => {
    expect(buildOf('https://board.example.ts.net/app.js?v=a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6')
    expect(buildOf('http://127.0.0.1:12422/app.js')).toBe('unversioned')
    expect(buildOf(undefined)).toBe('unversioned')
  })
})

describe('each error once', () => {
  test('the same error again is not sent again; a few at most from one page', () => {
    const sent: string[] = []
    const report = errorReporter(line => sent.push(line), facts)
    report('render', thrown(), COMPONENTS)
    report('render', thrown(), COMPONENTS)
    report('error', thrown())
    expect(sent).toHaveLength(2)
    for (let i = 0; i < 20; i++) report('error', new Error(`loop ${i}`))
    expect(sent).toHaveLength(5)
  })

  test('the window’s uncaught errors and unhandled rejections, until stopped; a resize observer’s note is not one', () => {
    const sent: string[] = []
    const target = new EventTarget()
    const stop = watchPageErrors(
      target,
      errorReporter(line => sent.push(line), facts),
    )
    const error = (fields: object) => Object.assign(new Event('error'), fields)
    target.dispatchEvent(error({ message: 'Uncaught TypeError: boom', error: new TypeError('boom') }))
    target.dispatchEvent(error({ message: 'Uncaught TypeError: boom', error: new TypeError('boom') }))
    target.dispatchEvent(error({ message: 'ResizeObserver loop completed with undelivered notifications.' }))
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('fetch failed') }))
    expect(sent.map(line => line.split(' · ')[0])).toEqual([
      'uncaught error: TypeError: boom',
      'unhandled rejection: Error: fetch failed',
    ])
    stop()
    target.dispatchEvent(error({ message: 'later', error: new Error('later') }))
    expect(sent).toHaveLength(2)
  })
})

describe('the note in place of what failed', () => {
  test('the page: what went wrong and Reload', () => {
    const html = renderToStaticMarkup(<ErrorScreen scope="page" error={thrown('boom')} />)
    expect(html).toContain('class="error-screen page" role="alert"')
    expect(html).toContain(`<h1 class="error-title">${t('error.title')}</h1>`)
    expect(html).toContain('<pre class="error-detail">TypeError: boom</pre>')
    expect(html).toContain(`<button type="button" class="error-button primary">${t('error.reload')}</button>`)
    expect(html).not.toContain(t('error.close'))
  })

  test('the session panel: its own note, with Close besides Reload', () => {
    const html = renderToStaticMarkup(<ErrorScreen scope="panel" error={thrown('boom')} onClose={() => {}} />)
    expect(html).toContain('class="error-screen panel"')
    expect(html).toContain(`<h2 class="error-title">${t('error.panel')}</h2>`)
    expect(html).toContain(`>${t('error.close')}</button>`)
    expect(html).toContain(`>${t('error.reload')}</button>`)
  })

  test('the boundary draws its part while it works, the note once it failed, and the part again for another session', () => {
    const boundary = (resetKey: string) => new ErrorBoundary({ scope: 'panel', resetKey, children: 'the sheet' })
    const b = boundary('a')
    expect(b.render()).toBe('the sheet')
    b.state = { ...b.state, ...ErrorBoundary.getDerivedStateFromError(thrown('boom')) }
    expect(renderToStaticMarkup(b.render())).toContain('TypeError: boom')
    expect(ErrorBoundary.getDerivedStateFromProps({ scope: 'panel', resetKey: 'a' }, b.state)).toBeNull()
    b.state = { ...b.state, ...ErrorBoundary.getDerivedStateFromProps({ scope: 'panel', resetKey: 'b' }, b.state) }
    expect(b.render()).toBe('the sheet')
  })
})

describe('where a render error goes', () => {
  const realFetch = globalThis.fetch
  const realDocument = globalThis.document
  afterEach(() => {
    globalThis.fetch = realFetch
    globalThis.document = realDocument
  })
  /** A page as the board serves it: marked for a phone or not, its script named by build. */
  function page(remote: boolean): { text: string }[] {
    globalThis.document = {
      documentElement: { lang: 'en', hasAttribute: (name: string) => remote && name === 'data-remote' },
      querySelector: () => ({ src: 'https://board.example.ts.net/app.js?v=a1b2c3d4e5f6' }),
    } as unknown as Document
    const sent: { text: string }[] = []
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/log') sent.push(JSON.parse(String(init?.body)))
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    }
    globalThis.fetch = Object.assign(fake, { preconnect: realFetch.preconnect })
    return sent
  }
  const info: ErrorInfo = { componentStack: COMPONENTS }

  test('in a phone’s browser: the board’s log, once', () => {
    const sent = page(true)
    const boundary = new ErrorBoundary({ scope: 'page' })
    boundary.componentDidCatch(thrown('the phone fails'), info)
    boundary.componentDidCatch(thrown('the phone fails'), info)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toStartWith('render error: TypeError: the phone fails · at SheetHead (app.js:48211:31) · ')
    expect(sent[0]?.text).toContain(' · build a1b2c3d4e5f6 · ')
    expect(sent[0]?.text).toEndWith(navigator.userAgent)
  })

  test('on the computer: nothing is sent', () => {
    const sent = page(false)
    new ErrorBoundary({ scope: 'page' }).componentDidCatch(thrown('the computer fails'), info)
    expect(sent).toEqual([])
  })
})
