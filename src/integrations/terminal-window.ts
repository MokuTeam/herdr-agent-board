// Bringing a window to the front. Windows only: on macOS and Linux nothing is raised.
import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import type { Config } from '../core/types.ts'

// Finds a visible top-level window by title (a -like pattern, or a case-sensitive regex, then of one
// window class only when one is named) and brings it to the front. Every
// window is enumerated because a browser keeps all its windows in one process. Windows only
// lets the foreground app hand focus over; a tapped Alt key lifts that lock.
const RAISE_PS = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class BoardWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public class Win { public IntPtr Key; public string Value; public string Class; }
  public static List<Win> List() {
    var all = new List<Win>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      if (GetWindowText(h, sb, 512) > 0) {
        var cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        all.Add(new Win { Key = h, Value = sb.ToString(), Class = cls.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return all;
  }
}
'@
$re = $env:BOARD_TITLE_RE; $cls = $env:BOARD_CLASS
$w = [BoardWin]::List() | Where-Object {
  if ($re) { ($_.Value -cmatch $re) -and (-not $cls -or ($_.Class -ceq $cls)) } else { $_.Value -like $env:BOARD_TITLE }
} | Select-Object -First 1
if (-not $w) { 'none'; exit }
$h = $w.Key
if ([BoardWin]::IsIconic($h)) { [BoardWin]::ShowWindow($h, 9) | Out-Null }
[BoardWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [BoardWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[BoardWin]::SetForegroundWindow($h) | Out-Null
'ok'
`

/**
 * Bring the first window whose title matches the -like pattern to the front. Resolves true when
 * one was found (always false off Windows). Callers that don't care may ignore the promise.
 */
export async function raiseWindow(pattern: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return new Promise(res =>
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', RAISE_PS],
      {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, BOARD_TITLE: pattern, BOARD_TITLE_RE: '', BOARD_CLASS: '' },
      },
      (err, stdout) => res(!err && String(stdout).trim().endsWith('ok')),
    ),
  )
}

/**
 * Bring the first window whose title matches `match` (a regex, case-sensitive, read by .NET as
 * JavaScript reads it: keep to the syntax both share) and, when `windowClass` is named, whose window
 * class is that one, to the front. As raiseWindow.
 */
export async function raiseWindowMatching(match: string, windowClass = ''): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return new Promise(res =>
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', RAISE_PS],
      {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, BOARD_TITLE_RE: match, BOARD_CLASS: windowClass },
      },
      (err, stdout) => res(!err && String(stdout).trim().endsWith('ok')),
    ),
  )
}

/** Bring the terminal window herdr runs in to the front (its title starts with the machine name). */
export function raiseTerminal(cfg: Partial<Config>): Promise<boolean> {
  const title = typeof cfg.terminalTitle === 'string' ? cfg.terminalTitle : ''
  return raiseWindow(title || `${(process.env.COMPUTERNAME || hostname()).toUpperCase()}:*`)
}
