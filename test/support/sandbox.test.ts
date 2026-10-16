import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './sandbox.ts'

let dirs: string[] = []

test('sandbox() lays out the env and the compiled fake herdr answers a canned reply', async () => {
  const box = await sandbox()
  dirs.push(box.dir)
  expect(box.env.HOME).toBe(join(box.dir, 'home'))
  expect(existsSync(box.env.LOCALAPPDATA as string)).toBe(true)
  expect(existsSync(box.env.HERDR_BIN_PATH as string)).toBe(true)

  box.state({
    'agent list': { result: { agents: [] } },
    'agent read': { text: 'two args' },
    'agent read p1': { text: 'three args' },
    'agent send': { seq: [{ result: 1 }, { result: 2 }] },
    'pane close': { error: 'nope', code: 'bad' },
  })
  const herdr = (...args: string[]) => Bun.spawnSync([box.env.HERDR_BIN_PATH as string, ...args], { env: box.env })
  const list = herdr('agent', 'list')
  expect(JSON.parse(list.stdout.toString())).toEqual({ result: { agents: [] } })
  expect(herdr('agent', 'read', 'p9').stdout.toString()).toBe('two args')
  expect(herdr('agent', 'read', 'p1', '--ansi').stdout.toString()).toBe('three args')
  expect(JSON.parse(herdr('agent', 'send').stdout.toString()).result).toBe(1)
  expect(JSON.parse(herdr('agent', 'send').stdout.toString()).result).toBe(2)
  expect(JSON.parse(herdr('agent', 'send').stdout.toString()).result).toBe(2)
  const failed = herdr('pane', 'close')
  expect(failed.exitCode).toBe(1)
  expect(JSON.parse(failed.stderr.toString())).toEqual({ error: { code: 'bad', message: 'nope' } })
  expect(box.calls()[0]).toEqual(['agent', 'list'])
  expect(box.calls()).toHaveLength(7)

  expect(readFileSync(box.env.FAKE_HERDR_LOG as string, 'utf8')).toContain('"agent","list"')
})

afterAll(() => {
  // Registered by onTestFinished: the directory is gone once the test ended.
  expect(dirs.length).toBe(1)
  for (const dir of dirs) expect(existsSync(dir)).toBe(false)
  dirs = []
})
