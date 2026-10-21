// What went wrong on the page, for the board's log. Nobody at the computer sees the console of a
// phone's browser, so there a render error (components/ErrorBoundary.tsx), an uncaught error and
// an unhandled rejection go to the board's log (phone-app.ts), each once: the message, where it
// was thrown, the components around it, which build of the page's script ran, and the browser.

export type PageErrorKind = 'render' | 'error' | 'rejection'

/** At most this many lines from one page: a loop of errors does not fill the board's log. */
const MOST = 5
/** The board's log takes 500 characters of a line (server/routes/page-log.ts). */
const MESSAGE_MOST = 200

export interface PageErrorFacts {
  userAgent: string
  /** Which build of app.js ran (buildOf). */
  build: string
}

/** What was thrown, as one line: "TypeError: x is undefined". */
export function errorMessage(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message ? `${thrown.name}: ${thrown.message}` : thrown.name
  if (typeof thrown === 'string') return thrown
  try {
    return JSON.stringify(thrown) ?? String(thrown)
  } catch {
    return String(thrown)
  }
}

/** Where an Error was thrown, the first frame of its stack: "Sheet (app.js:120:7)". */
export function thrownAt(thrown: unknown): string {
  const lines = (thrown instanceof Error ? (thrown.stack ?? '') : '').split('\n')
  // V8: "    at Sheet (https://host/app.js?v=…:120:7)"; Safari and Firefox: "Sheet@https://host/app.js:120:7".
  const v8 = lines.find(l => /^\s+at\s/.test(l))
  if (v8) return shortUrl(v8.trim().replace(/^at\s+/, ''))
  const other = lines.find(l => /^[^\s@]*@\S+:\d+/.test(l))
  return other
    ? shortUrl(other.trim().replace(/^([^@]*)@(.*)$/, (_, name, url) => (name ? `${name} (${url})` : url)))
    : ''
}

/** A script's address without its origin and version: "app.js:120:7". */
const shortUrl = (text: string): string => text.replace(/[a-z]+:\/\/[^/\s)]+\//gi, '').replace(/\?v=[\w-]*/g, '')

/** The components around a render error, innermost first and only the page's own: "Sheet < SidePanels < App". */
export function shortStack(componentStack: string, most = 4): string {
  const names = componentStack
    .split('\n')
    .map(line => /^\s*(?:at|in)\s+([\w$.]+)/.exec(line)?.[1] ?? /^\s*([\w$.]+)@/.exec(line)?.[1])
    .filter((name): name is string => !!name && /^[A-Z]/.test(name))
  return names.slice(0, most).join(' < ')
}

/** The build of the page's script from its address (app.js?v=<build>); "unversioned" without one. */
export function buildOf(src: string | null | undefined): string {
  const match = /[?&]v=([\w-]+)/.exec(src ?? '')
  return match?.[1] ?? 'unversioned'
}

/** One line for the board's log. */
export function pageErrorLine(
  kind: PageErrorKind,
  thrown: unknown,
  facts: PageErrorFacts,
  componentStack?: string,
): string {
  let message = errorMessage(thrown).replace(/\s+/g, ' ').trim()
  if (message.length > MESSAGE_MOST) message = `${message.slice(0, MESSAGE_MOST - 1)}…`
  const at = thrownAt(thrown)
  const within = componentStack ? shortStack(componentStack) : ''
  return [
    `${kind === 'render' ? 'render error' : kind === 'error' ? 'uncaught error' : 'unhandled rejection'}: ${message || 'no message'}`,
    at && `at ${at}`,
    within && `in ${within}`,
    `build ${facts.build}`,
    facts.userAgent,
  ]
    .filter(Boolean)
    .join(' · ')
}

export type ReportError = (kind: PageErrorKind, thrown: unknown, componentStack?: string) => void

/** Sends each error once (the same kind and message), and at most a few from one page. */
export function errorReporter(send: (line: string) => void, facts: () => PageErrorFacts): ReportError {
  const sent = new Set<string>()
  return (kind, thrown, componentStack) => {
    const key = `${kind}\n${errorMessage(thrown)}`
    if (sent.has(key) || sent.size >= MOST) return
    sent.add(key)
    send(pageErrorLine(kind, thrown, facts(), componentStack))
  }
}

/** Chrome's own note that a resize observer skipped a frame: nothing went wrong. */
const HARMLESS = /^ResizeObserver loop/

/** The window's uncaught errors and unhandled rejections go to `report`; returns how to stop. */
export function watchPageErrors(target: EventTarget, report: ReportError): () => void {
  const onError = (event: Event) => {
    const { error, message } = event as ErrorEvent
    if (HARMLESS.test(message ?? '')) return
    report('error', error ?? message)
  }
  const onRejection = (event: Event) => report('rejection', (event as PromiseRejectionEvent).reason)
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
