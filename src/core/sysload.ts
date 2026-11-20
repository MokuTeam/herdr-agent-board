// What a node says of its machine's load (#498, docs/design/nodes 6.3), read from what each system
// gives: memory available from /proc/meminfo on Linux and `vm_stat` on macOS, and the system's own
// figure on Windows. Facts only: the master holds the thresholds. No I/O: adapters/sysload.ts reads.

const MB = 1024 * 1024

/** `MemAvailable` of /proc/meminfo, in MB; null when the text has none (a kernel before 3.14). */
export function meminfoAvailableMb(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(text)
  return m ? Math.floor(Number(m[1]) / 1024) : null
}

/**
 * Free, inactive and purgeable pages of `vm_stat`, in MB, at the page size its first line gives
 * (16384 on Apple silicon, 4096 on Intel); null when a count or the size is missing.
 */
export function vmStatAvailableMb(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text)
  const count = (name: string): number | null => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const pages = [count('free'), count('inactive'), count('purgeable')]
  if (!size || pages.some(p => p === null)) return null
  const total = pages.reduce<number>((sum, p) => sum + (p ?? 0), 0)
  return Math.floor((total * Number(size[1])) / MB)
}

/** Bytes, in whole MB; null for anything but a count of bytes. */
export function bytesToMb(bytes: number): number | null {
  return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes / MB) : null
}

/**
 * The load averages of 1, 5 and 15 minutes, rounded to two places; null on Windows, which has none
 * (Node gives zeros there).
 */
export function loadOf(platform: string, averages: readonly number[]): [number, number, number] | null {
  if (platform === 'win32' || averages.length < 3 || averages.some(a => !Number.isFinite(a))) return null
  const r = (a: number | undefined): number => Math.round((a ?? 0) * 100) / 100
  return [r(averages[0]), r(averages[1]), r(averages[2])]
}
