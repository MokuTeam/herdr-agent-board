// How long the computer has gone without input, and whether its screen is locked: what presence
// detection reads (services/presence.ts), best effort on each system. herdr says nothing of when
// a pane last got input, so the system's own idle time stands for it: it counts every key and
// mouse move, the ones in herdr's panes too. Each reader answers null when it cannot tell (the
// tool is not there, a desktop that does not say), and the step then decides nothing on it.
//   Windows: GetLastInputInfo through PowerShell; locked while LogonUI runs.
//   macOS: IOHIDSystem's HIDIdleTime (ioreg); no lock reading.
//   Linux: xprintidle on X11, GNOME's Mutter IdleMonitor, logind's IdleHint/LockedHint
//   (loginctl), GNOME's screensaver, and a running screen locker (hyprlock, swaylock, i3lock...).
// The board asks only while presence detection is on (mode 'auto' or 'suggest').
import type { Observation } from '../core/presence.ts'
import { type RunResult, run } from './process.ts'

export type Exec = (file: string, args: string[]) => Promise<RunResult>
type Env = Record<string, string | undefined>

const exec: Exec = (file, args) => run(file, args, { timeout: 10_000 })
const ok = (r: RunResult): boolean => r.code === 0 && !r.error

const WINDOWS_SCRIPT = [
  "Add-Type @'",
  'using System; using System.Runtime.InteropServices;',
  'public static class AgentBoardIdle {',
  '  [StructLayout(LayoutKind.Sequential)] struct LII { public uint size; public uint time; }',
  '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII l);',
  '  public static uint Ms() { LII l = new LII(); l.size = 8; GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.time; }',
  '}',
  "'@",
  '"$([AgentBoardIdle]::Ms()) $([int][bool](Get-Process LogonUI -ErrorAction SilentlyContinue))"',
].join('\n')

/** PowerShell's "<idle ms> <0|1>". */
export function parseWindows(out: string): Observation {
  const m = /(\d+)\s+([01])/.exec(out)
  return m ? { idleSec: Number(m[1]) / 1000, locked: m[2] === '1' } : { idleSec: null, locked: null }
}

/** ioreg's `"HIDIdleTime" = <ns>`, in seconds. */
export function parseIoreg(out: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out)
  return m ? Number(m[1]) / 1e9 : null
}

/** xprintidle's milliseconds, in seconds. */
export function parseXprintidle(out: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(out)
  return m ? Number(m[1]) / 1000 : null
}

/** gdbus's `(uint64 12345,)` (Mutter's idle time in ms), in seconds. */
export function parseMutter(out: string): number | null {
  const m = /\(uint64\s+(\d+),?\)/.exec(out)
  return m ? Number(m[1]) / 1000 : null
}

/** gdbus's `(true,)` from GNOME's screensaver. */
export function parseScreensaver(out: string): boolean | null {
  const m = /\((true|false),?\)/.exec(out)
  return m ? m[1] === 'true' : null
}

/**
 * loginctl's `IdleHint=yes`, `IdleSinceHint=<µs since the epoch>`, `LockedHint=no`. IdleHint=no
 * says nothing (many desktops never set it), so only a yes gives an idle time.
 */
export function parseLoginctl(out: string, now: number): Observation {
  const field = (name: string): string | null => new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? null
  const since = Number(field('IdleSinceHint'))
  const idleSec =
    field('IdleHint') === 'yes' && Number.isFinite(since) && since > 0 ? Math.max(0, (now - since / 1000) / 1000) : null
  const locked = field('LockedHint')
  return { idleSec, locked: locked === 'yes' ? true : locked === 'no' ? false : null }
}

const LOCKERS = ['hyprlock', 'swaylock', 'i3lock', 'gtklock', 'waylock', 'xsecurelock', 'slock']

/** The first idle time any reader gave; locked when any says so, unlocked when one says that. */
export function combine(parts: Observation[]): Observation {
  const idle = parts.find(p => p.idleSec !== null)?.idleSec ?? null
  const locks = parts.map(p => p.locked)
  const locked = locks.includes(true) ? true : locks.includes(false) ? false : null
  return { idleSec: idle, locked }
}

async function linux(env: Env, x: Exec, now: () => number): Promise<Observation> {
  const parts: Observation[] = []
  const desktop = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase()
  // X11 only: under Wayland xprintidle sees XWayland's input alone and would call the user idle.
  if (env.DISPLAY && !env.WAYLAND_DISPLAY) {
    const r = await x('xprintidle', [])
    if (ok(r)) parts.push({ idleSec: parseXprintidle(r.stdout), locked: null })
  }
  if (desktop.includes('gnome')) {
    const gdbus = (dest: string, path: string, method: string) =>
      x('gdbus', ['call', '--session', '--dest', dest, '--object-path', path, '--method', method])
    const [idle, saver] = await Promise.all([
      gdbus(
        'org.gnome.Mutter.IdleMonitor',
        '/org/gnome/Mutter/IdleMonitor/Core',
        'org.gnome.Mutter.IdleMonitor.GetIdletime',
      ),
      gdbus('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver.GetActive'),
    ])
    parts.push({
      idleSec: ok(idle) ? parseMutter(idle.stdout) : null,
      locked: ok(saver) ? parseScreensaver(saver.stdout) : null,
    })
  }
  const session = env.XDG_SESSION_ID || 'auto'
  const [logind, locker] = await Promise.all([
    x('loginctl', ['show-session', session, '-p', 'IdleHint', '-p', 'IdleSinceHint', '-p', 'LockedHint']),
    x('pgrep', ['-x', LOCKERS.join('|')]),
  ])
  if (ok(logind)) parts.push(parseLoginctl(logind.stdout, now()))
  // pgrep: 0 found one, 1 none; anything else (not there) says nothing.
  if (locker.code === 0) parts.push({ idleSec: null, locked: true })
  // A locker not running says the screen is not locked only where one is the way to lock it.
  else if (locker.code === 1 && /hyprland|sway|i3/.test(desktop)) parts.push({ idleSec: null, locked: false })
  return combine(parts)
}

/** What the computer says now. */
export async function observe(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  x: Exec = exec,
  now: () => number = Date.now,
): Promise<Observation> {
  try {
    if (platform === 'win32') {
      const r = await x('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT])
      return ok(r) ? parseWindows(r.stdout) : { idleSec: null, locked: null }
    }
    if (platform === 'darwin') {
      const r = await x('ioreg', ['-c', 'IOHIDSystem', '-d', '4'])
      return { idleSec: ok(r) ? parseIoreg(r.stdout) : null, locked: null }
    }
    return await linux(env, x, now)
  } catch {
    return { idleSec: null, locked: null }
  }
}
