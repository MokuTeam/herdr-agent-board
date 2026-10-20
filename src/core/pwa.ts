// The board in a phone's browser, installable as an app (a PWA), on top of the remote mode
// (core/remote.ts). A browser gives a page a service worker and "Install" over HTTPS only, so
// `tailscale serve` puts this computer's Tailscale name, with its real *.ts.net certificate, in
// front of a listener of the board's own on 127.0.0.1. Off unless `remote.pwa` turns it on.
//
// Who calls: serve tells the board the caller's Tailscale address (X-Forwarded-For, which it sets
// itself, over anything the caller sent) and the board asks `tailscale whois`, as on the remote
// listener. The listener for serve is on 127.0.0.1 only, so what reaches it comes from serve or
// from a program on this computer, and a program here can use the web board itself anyway.
//
// A paired browser keeps its token in a cookie the page's scripts cannot read (an EventSource
// sends no headers). The rules here; the listener is server/remote.ts, setting serve up
// services/pwa.ts.
import type { PwaConfig, ServeUse } from './remote.ts'
import type { SetupCheck } from './setup.ts'
import type { Translator } from './types.ts'

/** `__Host-`: the browser takes it over HTTPS only, for this name only, never set by another one. */
export const COOKIE = '__Host-board'
/** 400 days, the most a browser keeps a cookie. */
const COOKIE_AGE = 400 * 24 * 3600

/** The port on 127.0.0.1 that serve forwards to. */
export const pwaPort = (conf: PwaConfig, webPort: number): number => conf.port ?? webPort + 1

/** What serve forwards to. */
export const pwaTarget = (port: number): string => `http://127.0.0.1:${port}`

/** Where a phone opens the board: the computer's Tailscale name, with the port unless it is 443. */
export const pwaUrl = (dnsName: string, https: number): string =>
  `https://${dnsName}${https === 443 ? '' : `:${https}`}`

/** The Host a request through serve carries: the name, and the port unless the browser left 443 out. */
export function pwaHosts(dnsName: string, https: number): Set<string> {
  const name = dnsName.toLowerCase()
  return new Set(https === 443 ? [name, `${name}:443`] : [`${name}:${https}`])
}

/** An IPv4 or IPv6 address, as a proxy writes it in X-Forwarded-For. */
export const IP = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.]+)$/i

/** The caller's address as serve gives it (X-Forwarded-For): exactly one address, else null. */
export function forwardedFor(header: string | null): string | null {
  const value = (header ?? '').trim().replace(/^::ffff:/i, '')
  return IP.test(value) ? value : null
}

/** The token in a Cookie header's cookie `name` (the device token by default), when it has `shape`; else null. */
export function cookieToken(header: string | null, name = COOKIE, shape = /^[\w-]{20,200}$/): string | null {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== name) continue
    const token = part.slice(at + 1).trim()
    return shape.test(token) ? token : null
  }
  return null
}

/** Set-Cookie for a paired browser (or a login): over HTTPS only, never to the page's scripts, never from another site. */
export const tokenCookie = (token: string, name = COOKIE, maxAgeS = COOKIE_AGE): string =>
  `${name}=${token}; Path=/; Max-Age=${maxAgeS}; Secure; HttpOnly; SameSite=Strict`

/** Set-Cookie that drops a token that no longer works. */
export const clearCookie = (name = COOKIE): string => `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`

/** What a phone's browser needs to install the board and show it full screen; colors as web/styles/app.css. */
const HEAD = [
  '<link rel="manifest" href="manifest.webmanifest">',
  '<meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-title" content="Board">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<link rel="stylesheet" href="styles/pwa.css">',
]

/**
 * The board's page as serve gives it to a phone: marked remote (`data-remote` on <html>, which
 * the page reads) and with what installs it. The page on 127.0.0.1 stays as it is.
 */
export function pwaPage(html: string): string {
  return html.replace(/<html\b/, '<html data-remote').replace('</head>', `  ${HEAD.join('\n  ')}\n</head>`)
}

/** Which way serve's port goes, from what `tailscale serve status` says of it. */
export function serveUse(port: { proxy: string | null } | undefined, target: string): ServeUse {
  if (!port) return 'free'
  return port.proxy === target ? 'ours' : 'other'
}

export const ADMIN_DNS = 'https://login.tailscale.com/admin/dns'

export interface PhoneFacts {
  /** Tailscale on this computer: connected, or why not. */
  tailscale: { ok: true; dnsName: string } | { ok: false; why: string }
  certs: boolean
  conf: PwaConfig
  serve: ServeUse | null
  url: string | null
}

/** `board doctor`'s checks of the remote mode, while it is on. */
export function phoneChecks(f: PhoneFacts, t: Translator): SetupCheck[] {
  const check = (c: Partial<SetupCheck> & Pick<SetupCheck, 'id' | 'level' | 'title'>): SetupCheck => ({
    detail: '',
    fix: '',
    code: '',
    ...c,
  })
  if (!f.tailscale.ok)
    return [
      check({
        id: 'remote-tailscale',
        level: 'error',
        title: t('pwa.check.noTailscale'),
        detail: f.tailscale.why,
        fix: t('pwa.check.noTailscaleFix'),
      }),
    ]
  const checks = [check({ id: 'remote-tailscale', level: 'ok', title: 'Tailscale', detail: f.tailscale.dnsName })]
  checks.push(
    f.certs
      ? check({ id: 'remote-certs', level: 'ok', title: t('pwa.check.certs') })
      : check({
          id: 'remote-certs',
          level: f.conf.on ? 'error' : 'off',
          title: t('pwa.check.noCerts'),
          detail: t('pwa.noCertsWhy'),
          fix: t('pwa.noCertsFix'),
          code: ADMIN_DNS,
        }),
  )
  if (!f.conf.on)
    checks.push(check({ id: 'remote-pwa', level: 'off', title: t('pwa.check.off'), code: 'board remote pwa on' }))
  else if (f.serve === 'ours')
    checks.push(check({ id: 'remote-pwa', level: 'ok', title: t('pwa.check.on'), detail: f.url ?? '' }))
  else
    checks.push(
      check({
        id: 'remote-pwa',
        level: 'warn',
        title: f.serve === 'other' ? t('pwa.serveOther', { port: f.conf.https }) : t('pwa.check.notServed'),
        fix: f.serve === 'other' ? t('pwa.serveOtherFix') : '',
        code: f.serve === 'other' ? 'tailscale serve status' : 'board remote pwa on',
      }),
    )
  return checks
}
