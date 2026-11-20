// The machine's load as a node reports it (#498, core/sysload.ts parses): memory available, load
// averages, cores and total memory. Linux reads /proc/meminfo, macOS runs `vm_stat`, Windows takes
// the free physical memory the system gives Node (GlobalMemoryStatusEx), so no PowerShell starts
// for a status asked every 30 s.
import { readFile } from 'node:fs/promises'
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import { bytesToMb, loadOf, meminfoAvailableMb, vmStatAvailableMb } from '../core/sysload.ts'

export interface SysLoad {
  cpus: number
  memTotalMb: number
  /** null when the system did not say. */
  memAvailableMb: number | null
  /** 1, 5 and 15 minutes; null on Windows. */
  load: [number, number, number] | null
}

async function vmStat(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['vm_stat'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const timer = setTimeout(() => proc.kill(), 5000)
    const text = await new Response(proc.stdout).text()
    clearTimeout(timer)
    return (await proc.exited) === 0 ? text : null
  } catch {
    return null
  }
}

/** Memory available in MB on `platform` (this one), or null when it cannot be read. */
export async function memAvailableMb(platform: string = process.platform): Promise<number | null> {
  if (platform === 'linux') {
    const text = await readFile('/proc/meminfo', 'utf8').catch(() => null)
    return text === null ? null : meminfoAvailableMb(text)
  }
  if (platform === 'darwin') {
    const text = await vmStat()
    return text === null ? null : vmStatAvailableMb(text)
  }
  return bytesToMb(freemem())
}

export async function sysLoad(platform: string = process.platform): Promise<SysLoad> {
  return {
    cpus: availableParallelism(),
    memTotalMb: bytesToMb(totalmem()) ?? 0,
    memAvailableMb: await memAvailableMb(platform),
    load: loadOf(platform, loadavg()),
  }
}
