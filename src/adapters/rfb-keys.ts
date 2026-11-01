// Keys typed into an agent's display by the board itself (a login fill, services/login-fill.ts):
// a VNC connection of its own to the display's Xvnc, on its Unix socket (the board's user's alone,
// core/desktop.ts xvncArgs: security type None), shared with the views, that sends each key down
// and up by its X keysym, as the owner's own view does (web/src/models/desk-input.ts), and goes.
// No clipboard, no picture asked for; what the server sends meanwhile is read and dropped. Nothing
// of what is typed is kept or logged here.
import { createConnection, type Socket } from 'node:net'

export interface TypeOptions {
  /** Between one key and the next: Chrome reads each as typed. */
  pauseMs?: number
  /** The whole of it, the handshake too. */
  timeoutMs?: number
}

/** A KeyEvent (RFB 6.4.4): down or up, the keysym. */
export function keyEvent(keysym: number, down: boolean): Uint8Array {
  const b = new Uint8Array(8)
  b[0] = 4
  b[1] = down ? 1 : 0
  new DataView(b.buffer).setUint32(4, keysym >>> 0)
  return b
}

/** Reads a socket's bytes as they are needed. */
function reader(sock: Socket): { take(n: number): Promise<Buffer>; stop(): void } {
  let buf = Buffer.alloc(0)
  let want: { n: number; done: (b: Buffer) => void; fail: (e: Error) => void } | null = null
  let failed: Error | null = null
  let reading = true
  const pump = (): void => {
    if (want && buf.length >= want.n) {
      const w = want
      want = null
      const out = buf.subarray(0, w.n)
      buf = buf.subarray(w.n)
      w.done(Buffer.from(out))
    }
  }
  sock.on('data', (chunk: Buffer) => {
    // past the handshake what the server sends is no use here: dropped
    if (!reading) return
    buf = Buffer.concat([buf, chunk])
    pump()
  })
  const fail = (e: Error): void => {
    failed = e
    if (want) {
      const w = want
      want = null
      w.fail(e)
    }
  }
  sock.on('error', err => fail(err))
  sock.on('close', () => fail(new Error('closed')))
  return {
    take: n =>
      new Promise((done, failNow) => {
        if (failed) return failNow(failed)
        want = { n, done, fail: failNow }
        pump()
      }),
    stop() {
      reading = false
      buf = Buffer.alloc(0)
    },
  }
}

const write = (sock: Socket, bytes: Uint8Array): Promise<void> =>
  new Promise((done, fail) => sock.write(bytes, err => (err ? fail(err) : done())))

/** The RFB handshake as a viewer that asks for nothing: the version, security None, a shared ClientInit, ServerInit read. */
async function handshake(sock: Socket, take: (n: number) => Promise<Buffer>): Promise<void> {
  const version = (await take(12)).toString('latin1')
  const m = /^RFB 003\.(\d{3})\n$/.exec(version)
  if (!m) throw new Error('no RFB server')
  const minor = Math.min(Number(m[1]), 8)
  await write(sock, Buffer.from(`RFB 003.00${minor >= 8 ? 8 : minor >= 7 ? 7 : 3}\n`, 'latin1'))
  if (minor >= 7) {
    const n = (await take(1))[0] ?? 0
    if (n === 0) throw new Error('refused')
    const types = await take(n)
    if (!types.includes(1)) throw new Error('no security type None')
    await write(sock, Uint8Array.of(1))
    if (minor >= 8 && (await take(4)).readUInt32BE(0) !== 0) throw new Error('refused')
  } else if ((await take(4)).readUInt32BE(0) !== 1) throw new Error('no security type None')
  // shared: the owner's views stay connected
  await write(sock, Uint8Array.of(1))
  const init = await take(24)
  const nameLength = init.readUInt32BE(20)
  if (nameLength > 4096) throw new Error('server init')
  if (nameLength) await take(nameLength)
}

/**
 * Types `keysyms` on the display whose VNC listens on `socketPath`: each key down then up, in their
 * order, `pauseMs` apart. Rejects when the display does not take them (it is not there, or speaks
 * no RFB); keys sent before a failure stay typed.
 */
export async function typeKeysyms(socketPath: string, keysyms: readonly number[], o: TypeOptions = {}): Promise<void> {
  const pauseMs = o.pauseMs ?? 12
  const timeoutMs = o.timeoutMs ?? 15_000 + keysyms.length * (pauseMs + 20)
  const sock = createConnection({ path: socketPath })
  const r = reader(sock)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error('timed out')), timeoutMs)
  })
  try {
    await Promise.race([
      (async () => {
        await new Promise<void>((done, fail) => {
          sock.once('connect', done)
          sock.once('error', fail)
        })
        await handshake(sock, r.take)
        r.stop()
        for (const k of keysyms) {
          await write(sock, keyEvent(k, true))
          await write(sock, keyEvent(k, false))
          if (pauseMs) await Bun.sleep(pauseMs)
        }
        // what was written reaches Xvnc before the socket goes
        await Bun.sleep(50)
      })(),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
    sock.end()
    sock.destroy()
  }
}
