// The setup page of the board on its own server (core/on-server.ts): the one page the login
// listener serves while no login is set. A page of its own, its script and style inline, so that
// nothing else answers before the login is set. It reads the code from the link's fragment, takes
// it out of the address bar and the history at once, and posts it (POST /api/setup/start); the
// answer is a TOTP secret to scan (drawn as a QR code, as the Remote access panel does) and a
// setup token kept in the page's memory only. The password and the app's first code then go
// together (POST /api/setup/finish), and the page sends the browser to the board's sign-in, which
// offers a passkey for this device after the first sign-in. Every POST carries X-Board, as the
// listener asks of each. The texts are the board's language's.
import { randomBytes } from 'node:crypto'
import { lang, t } from '../core/lang.ts'

const KEYS = [
  'title',
  'checking',
  'noCode',
  'link',
  'scan',
  'key',
  'password',
  'code',
  'submit',
  'expired',
  'limited',
  'failed',
  'done',
  'signIn',
] as const

/** Text for the page's script inside <script>: `<` never closes it. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c')

/** Text as HTML, its markup characters escaped. */
const html = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #5b6475; --line: #d6dae2; --accent: #3b6fd8; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171d; --card: #1d2129; --text: #e6e9ef; --muted: #9aa3b2; --line: #2f3542; --accent: #6b9bff; --bad: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
main { width: 100%; max-width: 24rem; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
h1 { font-size: 1.25rem; margin: 0 0 12px; }
p { margin: 0 0 12px; color: var(--muted); }
#note { color: var(--text); }
#note.bad { color: var(--bad); }
svg { display: block; width: 200px; height: 200px; margin: 4px auto 12px; background: #fff; border-radius: 8px; }
code { display: block; font: 0.95rem ui-monospace, monospace; word-break: break-all; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin: 0 0 16px; user-select: all; }
label { display: block; margin: 0 0 12px; }
label span { display: block; font-size: 0.9rem; color: var(--muted); margin-bottom: 4px; }
input { width: 100%; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
button, a.button { display: block; width: 100%; font: inherit; font-weight: 600; text-align: center; text-decoration: none; color: #fff; background: var(--accent); border: 0; border-radius: 8px; padding: 11px 12px; margin-top: 4px; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
[hidden] { display: none !important; }
`

// The page's script: no library, nothing from elsewhere.
const SCRIPT = `
const T = JSON.parse(document.getElementById('texts').textContent)
const $ = id => document.getElementById(id)
const note = (text, bad) => { $('note').textContent = text; $('note').className = bad ? 'bad' : '' }
const code = new URLSearchParams(location.hash.slice(1)).get('code')
// The code out of the address bar and the history before anything else.
history.replaceState(null, '', location.pathname)
let setup = null
const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body), cache: 'no-store' })
const answer = async res => ({ status: res.status, body: await res.json().catch(() => ({})) })
function drawQr(qr) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 ' + qr.size + ' ' + qr.size)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', T.key)
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', qr.d)
  path.setAttribute('fill', '#000')
  svg.append(path)
  $('qr').replaceChildren(svg)
}
async function start() {
  if (!code) return note(T.noCode, true)
  note(T.checking)
  let r
  try { r = await answer(await post('/api/setup/start', { code })) } catch { return note(T.failed, true) }
  if (r.status === 429) return note(T.limited, true)
  if (r.status !== 200 || !r.body.ok) return note(r.status === 401 ? T.link : T.failed, true)
  setup = r.body.setup
  drawQr(r.body.qr)
  $('secret').textContent = r.body.secret
  note(T.scan)
  $('form').hidden = false
  $('password').focus()
}
$('form').addEventListener('submit', async e => {
  e.preventDefault()
  $('submit').disabled = true
  let r
  try {
    r = await answer(await post('/api/setup/finish', { setup, password: $('password').value, code: $('code').value.replace(/\\s+/g, '') }))
  } catch { r = null }
  $('submit').disabled = false
  if (!r) return note(T.failed, true)
  if (r.status === 200 && r.body.ok) {
    setup = null
    $('form').hidden = true
    $('password').value = ''
    $('done').hidden = false
    return note(T.done)
  }
  if (r.status === 429) return note(T.limited, true)
  if (r.status === 401) { $('form').hidden = true; return note(T.expired, true) }
  note(typeof r.body.message === 'string' ? r.body.message : T.failed, true)
})
start()
`

/** The setup page, with the script's nonce for its Content-Security-Policy. */
export function setupPage(): Response {
  const nonce = randomBytes(16).toString('base64')
  const texts = Object.fromEntries(KEYS.map(k => [k, t(`firstLogin.${k}`)]))
  /** A text of the page's own, as HTML. */
  const text = (key: (typeof KEYS)[number]): string => html(texts[key] ?? '')
  const page = `<!doctype html>
<html lang="${lang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${text('title')}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
  <h1>${text('title')}</h1>
  <p id="note" role="status"></p>
  <form id="form" method="post" hidden>
    <div id="qr"></div>
    <label><span>${text('key')}</span><code id="secret"></code></label>
    <input type="text" name="username" autocomplete="username" value="owner" hidden>
    <label><span>${text('password')}</span><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required></label>
    <label><span>${text('code')}</span><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required></label>
    <button id="submit" type="submit">${text('submit')}</button>
  </form>
  <div id="done" hidden><a class="button" href="/">${text('signIn')}</a></div>
</main>
<script type="application/json" id="texts">${scriptJson(texts)}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`
  return new Response(page, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  })
}
