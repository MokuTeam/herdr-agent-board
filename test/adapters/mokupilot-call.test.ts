// MokuPilot's call in progress as the board reads it (#276): call.json in its state folder while
// a call runs; no file, a file of a process that is gone, one older than a day or not of MokuPilot's
// shape is no call; one that cannot be read says nothing.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callFile, callInProgress, mokupilotHere } from '../../src/adapters/mokupilot-call.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = 1_800_000_000_000
const write = (file: string, value: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

test('a call: its process and start; none without the file or its process', () => {
  const home = isolatedHome()
  const file = callFile(home)
  expect(file).toBe(join(home, '.meeting-copilot', 'call.json'))
  const read = (alive = true) => callInProgress({ file, now: () => NOW, alive: () => alive })
  expect(mokupilotHere(home)).toBe(false)
  expect(read()).toBeNull()
  write(file, { pid: 4242, started: NOW / 1000 - 600 })
  expect(mokupilotHere(home)).toBe(true)
  expect(read()).toEqual({ id: `4242:${NOW / 1000 - 600}`, started: NOW - 600_000 })
  expect(read(false)).toBeNull()
  // The process it names, asked for real: this one runs.
  write(file, { pid: process.pid, started: Date.now() / 1000 })
  expect(callInProgress({ file })?.id).toMatch(new RegExp(`^${process.pid}:`))
})

test('a file that cannot be read is no answer, not the end of a call', () => {
  const home = isolatedHome()
  const file = callFile(home)
  // A folder where the file should be: reading it fails as a file held by another program does.
  mkdirSync(file, { recursive: true })
  expect(callInProgress({ file, now: () => NOW, alive: () => true })).toBeUndefined()
})

test('a stale or foreign file is no call', () => {
  const home = isolatedHome()
  const file = callFile(home)
  const read = () => callInProgress({ file, now: () => NOW, alive: () => true })
  for (const bad of [
    { pid: 4242, started: NOW / 1000 - 25 * 3600 },
    { pid: 4242, started: NOW / 1000 + 3600 },
    { pid: 0, started: NOW / 1000 },
    { pid: -3, started: NOW / 1000 },
    { pid: '4242', started: NOW / 1000 },
    { pid: 4242.5, started: NOW / 1000 },
    { pid: 4242, started: '2026-10-30' },
    { pid: 4242 },
    [],
    null,
    'not json',
  ]) {
    write(file, bad === 'not json' ? bad : JSON.stringify(bad))
    expect(read()).toBeNull()
  }
})
