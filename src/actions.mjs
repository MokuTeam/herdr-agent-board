// What the board can do to a session, shared by the terminal board and the web board. Each
// returns { ok: true } or { ok: false, error } with a message for the user.
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { liveSessions } from './claude.mjs'
import { herdr, herdrText } from './herdr.mjs'
import { t } from './lang.mjs'
import { inputDraft } from './screen.mjs'

/**
 * Whether herdr-wake answers, which a restart needs: { ok } or { ok: false, why, error }, why the
 * reason as it came (empty when wakeUrl is not set) and error a message for the user.
 */
export async function wakeAnswers(cfg) {
  if (!cfg.wakeUrl) return { ok: false, why: '', error: t('err.restart.noWake') }
  let why
  try {
    const res = await fetch(`${String(cfg.wakeUrl).replace(/\/+$/, '')}/sleeping`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) return { ok: true }
    why = `HTTP ${res.status}`
  } catch (err) {
    why = err.cause?.code || err.message
  }
  return { ok: false, why, error: t('err.restart.wakeDown', { url: cfg.wakeUrl, why }) }
}

/**
 * Whether a session can be put to sleep now, for a restart: { ok, status } (herdr's status as just
 * read) or { ok: false, why }, why being 'gone' (another session in its pane), 'busy' (herdr or
 * Claude says it works), 'dialog', 'draft' (the user's unsent text in its input box), 'tasks' (its
 * turn is over but a background command or a Monitor still runs: Claude's own registry says
 * `shell`, and herdr-wake keeps such a session up), or herdr's error.
 */
export async function readyToSleep(item) {
  try {
    const agent = (await herdr(['agent', 'get', item.pane]))?.agent
    if (!agent || (agent.agent_session?.value ?? null) !== (item.session ?? null)) return { ok: false, why: 'gone' }
    if (agent.agent_status === 'blocked') return { ok: false, why: 'dialog' }
    if (agent.agent_status === 'working') return { ok: false, why: 'busy' }
    const reg = liveSessions().get(item.session)?.status
    if (reg === 'busy') return { ok: false, why: 'busy' }
    if (reg === 'shell') return { ok: false, why: 'tasks' }
    const draft = inputDraft(await herdrText(['agent', 'read', item.pane, '--source', 'recent', '--lines', '40', '--ansi'], 10_000))
    if (draft === null) return { ok: false, why: 'dialog' }
    return draft === '' ? { ok: true, status: agent.agent_status } : { ok: false, why: 'draft' }
  } catch (err) {
    return { ok: false, why: t('err.restart.herdr', { why: err.message }) }
  }
}

/** Wake a session herdr-wake put to sleep (takes 10 to 30 s). */
export async function wake(cfg, item) {
  try {
    const res = await fetch(`${cfg.wakeUrl}/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: item.pane }),
      signal: AbortSignal.timeout(180_000),
    })
    const r = await res.json()
    return r.ok ? { ok: true } : { ok: false, error: t('err.wake', { name: item.name, why: r.error ?? t('err.noAnswer') }) }
  } catch (err) {
    return { ok: false, error: t('err.wakeDown', { why: err.message }) }
  }
}

/**
 * Put a session to sleep through herdr-wake, as its reaper does after an idle hour: Claude exits,
 * the pane stays as "💤 <name>". Only an idle session; herdr-wake refuses one that works, has
 * background tasks or text in its input box.
 */
export async function sleepSession(cfg, item) {
  if (item.sleeping) return { ok: true }
  if (!item.session || !item.pane) return { ok: false, error: t('err.notClaude', { name: item.name }) }
  if (item.status === 'working' || item.status === 'blocked') return { ok: false, error: t(item.status === 'working' ? 'err.sleepWorking' : 'err.sleepBlocked', { name: item.name }) }
  try {
    const res = await fetch(`${cfg.wakeUrl}/sleep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: item.pane }),
      signal: AbortSignal.timeout(60_000),
    })
    const r = await res.json()
    if (r.ok) return { ok: true }
    const why = String(r.error ?? '')
    const text = /not idle/.test(why)
      ? t('err.sleep.busy')
      : /did not go to sleep/.test(why)
        ? t('err.sleep.stayed')
        : /no running session/.test(why)
          ? t('err.sleep.unknown')
          : why || t('err.noAnswer')
    return { ok: false, error: t('err.sleep', { name: item.name, why: text }) }
  } catch (err) {
    return { ok: false, error: t('err.wakeDown', { why: err.message }) }
  }
}

/** Focus the session's pane in herdr, waking it first; `raise` also brings the terminal window up. */
export async function focus(cfg, item, { raise = false } = {}) {
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  if (item.sleeping) {
    const r = await wake(cfg, item)
    if (!r.ok) return r
  }
  try {
    await herdr(['agent', 'focus', item.pane])
  } catch (err) {
    return { ok: false, error: t('err.focus', { name: item.name, why: err.message }) }
  }
  if (raise) raiseTerminal(cfg)
  return { ok: true }
}

/**
 * Type a message into the session's prompt, waking it first. Refused while it waits for a
 * decision; with `free`, also while it works (instead of queueing into its turn); with `draft`,
 * also while the user has unsent text in its input box (the scheduler's guards). Those refusals
 * say `busy`, plus `dialog` or `draft` for those two.
 */
export async function send(cfg, item, text, { free = false, draft: guardDraft = false } = {}) {
  text = String(text ?? '').trim()
  if (!text) return { ok: false, error: t('err.emptyMessage') }
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  const expectedSession = item.session ?? null
  if (item.sleeping) {
    const r = await wake(cfg, item)
    if (!r.ok) return r
  }
  try {
    const agent = (await herdr(['agent', 'get', item.pane]))?.agent
    // Recheck after wake too: the pane may now host a different session.
    if (!agent || (agent.agent_session?.value ?? null) !== expectedSession) {
      return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    }
    if (agent.agent_status === 'blocked') return { ok: false, busy: true, dialog: true, error: t('err.blocked', { name: item.name }) }
    if (free && agent.agent_status === 'working') return { ok: false, busy: true, error: t('err.working', { name: item.name }) }
    if (guardDraft && agent.agent === 'claude') {
      // Typed after what the user started in the input box, Enter would send both.
      const draft = inputDraft(await herdrText(['agent', 'read', item.pane, '--source', 'recent', '--lines', '40', '--ansi'], 10_000))
      if (draft !== '') return { ok: false, busy: true, draft: draft !== null, dialog: draft === null, error: t(draft === null ? 'err.blocked' : 'err.draft', { name: item.name }) }
    }
    // This read and prompt are separate CLI calls, not an atomic identity check and send.
    // A leading dash would be read as an option by the herdr CLI.
    await herdr(['agent', 'prompt', item.pane, /^-/.test(text) ? ` ${text}` : text])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: t('err.send', { name: item.name, why: err.message }) }
  }
}

// Finds a visible top-level window by title (-like pattern) and brings it to the front. Every
// window is enumerated because a browser keeps all its windows in one process. Windows only
// lets the foreground app hand focus over; a tapped Alt key lifts that lock.
const RAISE_PS = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class BoardWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static List<KeyValuePair<IntPtr, string>> List() {
    var all = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      if (GetWindowText(h, sb, 512) > 0) all.Add(new KeyValuePair<IntPtr, string>(h, sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return all;
  }
}
'@
$w = [BoardWin]::List() | Where-Object { $_.Value -like $env:BOARD_TITLE } | Select-Object -First 1
if (-not $w) { 'none'; exit }
$h = $w.Key
if ([BoardWin]::IsIconic($h)) { [BoardWin]::ShowWindow($h, 9) | Out-Null }
[BoardWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [BoardWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[BoardWin]::SetForegroundWindow($h) | Out-Null
'ok'
`

/** Bring the first window whose title matches the -like pattern to the front. Resolves true when one was found. */
export function raiseWindow(pattern) {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', RAISE_PS], { windowsHide: true, timeout: 15_000, env: { ...process.env, BOARD_TITLE: pattern } }, (err, stdout) =>
      resolve(!err && String(stdout).trim().endsWith('ok')),
    )
  })
}

/** Bring the terminal window herdr runs in to the front (its title starts with the machine name). */
export function raiseTerminal(cfg) {
  return raiseWindow(cfg.terminalTitle || `${(process.env.COMPUTERNAME || hostname()).toUpperCase()}:*`)
}
