// The unix socket the NanoClaw module connects to (#384, design 3.3): one connection at a time
// (a new one replaces the old), one JSON frame per line. The socket file is made mode 0600 and
// only NanoClaw's user, which the bridge runs as, can open it.
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { type BridgeFrame, encodeFrame, type ModuleFrame, parseModuleFrame, takeLines } from './protocol.ts'

export interface ModuleSocket {
  /** Sends a frame to the module; false when none is connected. */
  send(f: BridgeFrame): boolean
  connected(): boolean
  close(): Promise<void>
}

export interface ModuleSocketOptions {
  path: string
  log: (line: string) => void
  /** A frame from the module; `hello` comes first on each connection. */
  onFrame: (f: ModuleFrame) => void
  onClose: () => void
}

export function listenModule(o: ModuleSocketOptions): Promise<ModuleSocket> {
  // A socket file left by a bridge that did not stop cleanly would make listen fail.
  if (process.platform !== 'win32' && existsSync(o.path)) unlinkSync(o.path)
  let current: Socket | null = null
  let helloSeen = false

  const server: Server = createServer(sock => {
    if (current) current.destroy()
    current = sock
    helloSeen = false
    let rest = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      const got = takeLines(rest, chunk)
      if (!got) {
        o.log('module: a line past the limit; closing the connection')
        sock.destroy()
        return
      }
      rest = got.rest
      for (const line of got.lines) {
        const f = parseModuleFrame(line)
        if (!f) {
          o.log('module: dropped a frame it could not read')
          continue
        }
        if (!helloSeen && f.t !== 'hello') continue
        if (f.t === 'hello') helloSeen = true
        if (sock === current) o.onFrame(f)
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      if (sock !== current) return
      current = null
      helloSeen = false
      o.onClose()
    })
  })

  return new Promise((resolve, reject) => {
    const umask = process.platform === 'win32' ? undefined : process.umask(0o177)
    server.once('error', err => {
      if (umask !== undefined) process.umask(umask)
      reject(err)
    })
    server.listen(o.path, () => {
      if (umask !== undefined) process.umask(umask)
      if (process.platform !== 'win32') chmodSync(o.path, 0o600)
      resolve({
        send: f => {
          if (!current || !helloSeen) return false
          current.write(encodeFrame(f))
          return true
        },
        connected: () => current !== null && helloSeen,
        close: () =>
          new Promise<void>(res => {
            current?.destroy()
            current = null
            server.close(() => res())
          }),
      })
    })
  })
}
