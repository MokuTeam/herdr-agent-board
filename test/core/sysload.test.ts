// What a node says of its machine's load (core/sysload.ts), from what each system gives: fixtures of
// /proc/meminfo (Linux), `vm_stat` (macOS on Apple silicon and Intel) and the figures Node has on
// Windows.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bytesToMb, loadOf, meminfoAvailableMb, vmStatAvailableMb } from '../../src/core/sysload.ts'

const fixture = (name: string): string => readFileSync(join(import.meta.dir, '..', 'fixtures', 'sysload', name), 'utf8')

describe('memory available', () => {
  test('Linux: MemAvailable of /proc/meminfo, in MB', () => {
    expect(meminfoAvailableMb(fixture('meminfo-linux.txt'))).toBe(21480)
    // MemFree is not MemAvailable: a kernel before 3.14 has none, and nothing is guessed.
    expect(meminfoAvailableMb(fixture('meminfo-old-kernel.txt'))).toBeNull()
    expect(meminfoAvailableMb('')).toBeNull()
    expect(meminfoAvailableMb(fixture('meminfo-linux.txt').replaceAll('\n', '\r\n'))).toBe(21480)
  })

  test('macOS: free, inactive and purgeable pages of vm_stat, at the page size it names', () => {
    // (5000 + 380000 + 15000) pages of 16384 bytes
    expect(vmStatAvailableMb(fixture('vm_stat-arm64.txt'))).toBe(6250)
    // (262144 + 524288 + 262144) pages of 4096 bytes
    expect(vmStatAvailableMb(fixture('vm_stat-intel.txt'))).toBe(4096)
    // speculative, wired and compressed pages are not counted
    const arm = fixture('vm_stat-arm64.txt')
    expect(
      vmStatAvailableMb(arm.replace('Pages speculative:                         2000.', 'Pages speculative: 999999.')),
    ).toBe(6250)
    expect(vmStatAvailableMb(arm.replace(/^Pages purgeable:.*$/m, ''))).toBeNull()
    expect(vmStatAvailableMb(arm.replace('(page size of 16384 bytes)', ''))).toBeNull()
  })

  test('Windows: the free physical memory the system gives, in MB', () => {
    const win = JSON.parse(fixture('windows.json')) as { freemem: number; totalmem: number; loadavg: number[] }
    expect(bytesToMb(win.freemem)).toBe(8704)
    expect(bytesToMb(win.totalmem)).toBe(32651)
    expect(bytesToMb(-1)).toBeNull()
    expect(bytesToMb(Number.NaN)).toBeNull()
  })
})

describe('load averages', () => {
  test('rounded to two places; null on Windows, whose zeros are no load', () => {
    expect(loadOf('linux', [0.4234, 0.6149, 0.58])).toEqual([0.42, 0.61, 0.58])
    expect(loadOf('darwin', [2, 1.5, 1])).toEqual([2, 1.5, 1])
    const win = JSON.parse(fixture('windows.json')) as { loadavg: number[] }
    expect(loadOf('win32', win.loadavg)).toBeNull()
    expect(loadOf('linux', [1, 2])).toBeNull()
  })
})
