// The board's own keys on an agent's display (adapters/rfb-keys.ts), against an RFB server of the
// test's own on a Unix socket, as Xvnc listens (core/desktop.ts xvncArgs): the 3.8 handshake with
// security None and a shared ClientInit, then each key down and up in its order; a server that
// offers no None, or speaks no RFB, gets nothing typed.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyEvent, typeKeysyms } from '../../src/adapters/rfb-keys.ts'

const dir = mkdtempSync(join(tmpdir(), 'rfb-keys-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** An RFB server: its version, its security types; what the client sent after ServerInit. */
function fakeXvnc(
  name: string,
  o: { version?: string; types?: number[] } = {},
): Promise<{ path: string; got: Promise<{ init: number; keys: [number, number][] }>; server: Server }> {
  const path = join(dir, name)
  const { promise, resolve } = Promise.withResolvers<{ init: number; keys: [number, number][] }>()
  const server = createServer(sock => {
    let buf = Buffer.alloc(0)
    let step = 0
    let init = -1
    const keys: [number, number][] = []
    sock.write(o.version ?? 'RFB 003.008\n')
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (step === 0 && buf.length >= 12) {
          buf = buf.subarray(12)
          const types = o.types ?? [1]
          sock.write(Buffer.from([types.length, ...types]))
          step = 1
        } else if (step === 1 && buf.length >= 1) {
          buf = buf.subarray(1)
          sock.write(Buffer.from([0, 0, 0, 0]))
          step = 2
        } else if (step === 2 && buf.length >= 1) {
          init = buf[0] ?? -1
          buf = buf.subarray(1)
          const name = Buffer.from('test')
          const head = Buffer.alloc(24)
          head.writeUInt16BE(1440, 0)
          head.writeUInt16BE(900, 2)
          head.writeUInt32BE(name.length, 20)
          sock.write(Buffer.concat([head, name]))
          step = 3
        } else if (step === 3 && buf.length >= 8) {
          if (buf[0] === 4) keys.push([buf.readUInt32BE(4), buf[1] ?? 0])
          buf = buf.subarray(8)
        } else break
      }
    })
    sock.on('close', () => resolve({ init, keys }))
  })
  return new Promise(res => server.listen(path, () => res({ path, got: promise, server })))
}

describe('typeKeysyms', () => {
  test('a KeyEvent: 4, down, padding, the keysym', () => {
    expect([...keyEvent(0xff09, true)]).toEqual([4, 1, 0, 0, 0, 0, 0xff, 0x09])
    expect([...keyEvent(0x01000430, false)]).toEqual([4, 0, 0, 0, 0x01, 0, 0x04, 0x30])
  })

  test('the handshake as a shared viewer, then every key down and up in its order', async () => {
    const x = await fakeXvnc('ok.sock')
    await typeKeysyms(x.path, [0x61, 0xff09, 0x31, 0xff0d], { pauseMs: 1 })
    const { init, keys } = await x.got
    x.server.close()
    expect(init).toBe(1)
    expect(keys).toEqual([
      [0x61, 1],
      [0x61, 0],
      [0xff09, 1],
      [0xff09, 0],
      [0x31, 1],
      [0x31, 0],
      [0xff0d, 1],
      [0xff0d, 0],
    ])
  })

  test('no security None, or no RFB at all: refused, nothing typed', async () => {
    const vnc = await fakeXvnc('auth.sock', { types: [2] })
    await expect(typeKeysyms(vnc.path, [0x61], { pauseMs: 0 })).rejects.toThrow('None')
    expect((await vnc.got).keys).toEqual([])
    vnc.server.close()
    const http = await fakeXvnc('http.sock', { version: 'HTTP/1.1 400\r\n' })
    await expect(typeKeysyms(http.path, [0x61], { pauseMs: 0, timeoutMs: 2000 })).rejects.toThrow()
    expect((await http.got).keys).toEqual([])
    http.server.close()
    await expect(typeKeysyms(join(dir, 'none.sock'), [0x61], { timeoutMs: 2000 })).rejects.toThrow()
  })
})
