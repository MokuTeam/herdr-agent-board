import { expect, test } from 'bun:test'
import { createBroadcaster } from '../../src/server/sse.ts'
import { until } from '../support/sandbox.ts'

const decoder = new TextDecoder()

function serve(events: ReturnType<typeof createBroadcaster>) {
  return Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: req => events.response(req) })
}

async function open(url: string, signal?: AbortSignal) {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.body) throw new Error('no stream')
  return { res, reader: res.body.getReader() }
}

test('50 connections opened and aborted leave no client behind and no unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  const events = createBroadcaster(() => '{"n":0}')
  const server = serve(events)
  try {
    for (let i = 0; i < 50; i++) {
      const controller = new AbortController()
      const { res, reader } = await open(`http://127.0.0.1:${server.port}/`, controller.signal)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      expect(decoder.decode((await reader.read()).value)).toBe('retry: 2000\ndata: {"n":0}\n\n')
      controller.abort()
    }
    await until(() => events.size() === 0)
    // Nobody listens any more: sending goes nowhere and throws nothing.
    events.send('{"n":1}')
    await Bun.sleep(50)
    expect(events.size()).toBe(0)
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    events.close()
    server.stop(true)
  }
})

test('a live client gets the headers, each payload as one data event, and comment pings', async () => {
  const events = createBroadcaster(() => '{"first":true}', { pingMs: 30 })
  const server = serve(events)
  try {
    const { res, reader } = await open(`http://127.0.0.1:${server.port}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('connection')).toBe('keep-alive')
    let text = ''
    const read = async (until: string): Promise<void> => {
      while (!text.includes(until)) text += decoder.decode((await reader.read()).value, { stream: true })
    }
    await read('{"first":true}\n\n')
    expect(events.size()).toBe(1)
    // A string is JSON already and goes as it is; anything else is serialised.
    events.send('{"a":1}')
    events.send({ b: 2 })
    await read('data: {"b":2}\n\n')
    await read(': ping\n\n')
    const data = text.replaceAll(': ping\n\n', '')
    expect(data.startsWith('retry: 2000\ndata: {"first":true}\n\ndata: {"a":1}\n\ndata: {"b":2}\n\n')).toBe(true)
    await reader.cancel()
    await until(() => events.size() === 0)
  } finally {
    events.close()
    server.stop(true)
  }
})
