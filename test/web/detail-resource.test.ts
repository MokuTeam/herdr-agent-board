import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { detailResource } from '../../web/src/models/detail-resource.ts'

type Detail = { conversation?: string[]; name?: string }
type Resolve = (value: Detail) => void

test('error ends loading; explicit retry is deduplicated and restores identical data', async () => {
  let calls = 0
  let resolve: Resolve = () => {}
  const changes: unknown[] = []
  const resource = detailResource<Detail>({
    read: () =>
      ++calls === 1
        ? Promise.reject(new Error('offline'))
        : new Promise<Detail>(r => {
            resolve = r
          }),
    changed: v => changes.push(v),
    now: () => 42,
  })
  resource.reset('a')
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'error')
  assert.equal(resource.snapshot().error, 'offline')
  const retry = resource.load('a')
  assert.equal(resource.load('a'), retry)
  await Promise.resolve()
  resolve({ conversation: [] })
  await retry
  assert.equal(calls, 2)
  assert.equal(resource.snapshot().status, 'ready')
  assert.equal(resource.snapshot().at, 42)
})

test('refresh errors retain the last read and a missing session rejects late replies', async () => {
  let mode = 'ok'
  let resolve: Resolve = () => {}
  const resource = detailResource<Detail>({
    read: () =>
      mode === 'ok'
        ? Promise.resolve({ conversation: ['cached'] })
        : mode === 'error'
          ? Promise.reject(new Error('failed'))
          : new Promise<Detail>(r => {
              resolve = r
            }),
    changed() {},
  })
  await resource.load('a')
  mode = 'error'
  await resource.load('a')
  assert.deepEqual(resource.snapshot().data?.conversation, ['cached'])
  assert.equal(resource.snapshot().status, 'error')
  mode = 'late'
  const late = resource.load('a')
  await Promise.resolve()
  resource.missing()
  resolve({ conversation: ['obsolete'] })
  await late
  assert.equal(resource.snapshot().status, 'missing')
  assert.deepEqual(resource.snapshot().data?.conversation, ['cached'])
})

test('a reply from the previous selection cannot replace the new one', async () => {
  const replies: Record<string, Resolve> = {}
  const resource = detailResource<Detail>({
    read: key =>
      new Promise<Detail>(r => {
        replies[key] = r
      }),
    changed() {},
  })
  const a = resource.load('a')
  await Promise.resolve()
  const b = resource.load('b')
  await Promise.resolve()
  replies.b?.({ name: 'b' })
  await b
  replies.a?.({ name: 'a' })
  await a
  assert.equal(resource.snapshot().key, 'b')
  assert.equal(resource.snapshot().data?.name, 'b')
})

test('a stalled read reaches an actionable error rather than loading forever', async () => {
  const resource = detailResource<Detail>({ read: () => new Promise(() => {}), changed() {}, timeoutMs: 10 })
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'error')
  assert.match(resource.snapshot().error, /timed out/)
})

test('a missing response can be read again when the selected session returns', async () => {
  let present = false
  const resource = detailResource<Detail>({
    read: async () => {
      if (!present) throw Object.assign(new Error('gone'), { missing: true })
      return { conversation: ['returned'] }
    },
    changed() {},
  })
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'missing')
  present = true
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'ready')
})

test('a read again of what was read fine is heard only once done, unless it takes quietMs (#169)', async () => {
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
  let mode = 'ok'
  let resolve: Resolve = () => {}
  const heard: string[] = []
  const resource = detailResource<Detail>({
    read: () =>
      mode === 'ok'
        ? Promise.resolve({ conversation: [mode] })
        : mode === 'error'
          ? Promise.reject(new Error('failed'))
          : new Promise<Detail>(r => {
              resolve = r
            }),
    changed: v => heard.push(v.status),
    quietMs: 40,
  })
  // The first read says it loads, at once.
  await resource.load('a')
  assert.deepEqual(heard.splice(0), ['loading', 'ready'])
  // A quick one again: only done.
  mode = 'wait'
  const quick = resource.load('a')
  await pause(5)
  resolve({ conversation: ['quick'] })
  await quick
  assert.deepEqual(heard.splice(0), ['ready'])
  // A slow one says it loads once it took quietMs.
  const slow = resource.load('a')
  await pause(10)
  assert.deepEqual(heard, [])
  await pause(60)
  assert.deepEqual(heard.splice(0), ['loading'])
  resolve({ conversation: ['slow'] })
  await slow
  assert.deepEqual(heard.splice(0), ['ready'])
  // After an error (Retry), at once.
  mode = 'error'
  await resource.load('a')
  heard.length = 0
  mode = 'wait'
  const retry = resource.load('a')
  assert.deepEqual(heard.splice(0), ['loading'])
  await Promise.resolve()
  resolve({ conversation: ['back'] })
  await retry
  assert.deepEqual(heard.splice(0), ['ready'])
  // Another session opened while one waits: the old read says nothing later.
  void resource.load('a')
  resource.reset('b')
  await pause(60)
  assert.deepEqual(heard, [])
})
