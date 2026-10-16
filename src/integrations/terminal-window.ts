// Bringing a window to the front. Windows only: on macOS and Linux nothing is raised.
import { hostname } from 'node:os'
import { run } from '../adapters/process.ts'
import type { Config } from '../core/types.ts'

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

/**
 * Bring the first window whose title matches the -like pattern to the front. Resolves true when
 * one was found (always false off Windows). Callers that don't care may ignore the promise.
 */
export async function raiseWindow(pattern: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', RAISE_PS], {
    timeout: 15_000,
    env: { ...process.env, BOARD_TITLE: pattern },
  })
  return !r.error && r.stdout.trim().endsWith('ok')
}

/** Bring the terminal window herdr runs in to the front (its title starts with the machine name). */
export function raiseTerminal(cfg: Partial<Config>): Promise<boolean> {
  const title = typeof cfg.terminalTitle === 'string' ? cfg.terminalTitle : ''
  return raiseWindow(title || `${(process.env.COMPUTERNAME || hostname()).toUpperCase()}:*`)
}
