// The holder of a desktop's Chrome (services/cdp-pipe.ts): `bun cdp-pipe.ts <socket> <chrome>
// <args…>`. The board runs it in a session of its own (services/desktop.ts), so a restart of the
// board leaves it and its Chrome running, the pipe held: Chrome ends when its pipe closes. It runs
// Chrome with its DevTools on fds 3 (in) and 4 (out), and once Chrome answers there, serves the
// pipe on the Unix socket `socket` (0600, in the desktop's 0700 folder) to one client at a time;
// the socket's being there says Chrome is up. It ends with Chrome, its socket removed; a SIGTERM
// (the board's, to the whole session) ends Chrome too.
import { spawn } from 'node:child_process'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { createCdpMux, nulFrames } from '../services/cdp-pipe.ts'

/** Chrome not answering on its pipe for this long after it started: ended. */
const READY_MS = 60_000

const [socket, bin, ...args] = process.argv.slice(2)
if (!socket || !bin) {
  console.error('usage: cdp-pipe <socket> <chrome> [<argument>…]')
  process.exit(2)
}

const chrome = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] })
const toChrome = chrome.stdio[3] as Writable
const fromChrome = chrome.stdio[4] as Readable
toChrome.on('error', () => {})
const mux = createCdpMux(text => {
  toChrome.write(`${text}\0`)
})
const frames = nulFrames()
fromChrome.on('data', (chunk: Buffer) => {
  for (const f of frames(chunk)) mux.fromChrome(f)
})

let server: Server | null = null
function end(code: number): never {
  server?.close()
  rmSync(socket as string, { force: true })
  process.exit(code)
}
chrome.on('exit', (code, signal) => {
  console.error(`cdp-pipe: Chrome ended (${signal ?? code})`)
  end(code ?? 1)
})
chrome.on('error', err => {
  console.error(`cdp-pipe: ${err.message}`)
  end(1)
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => chrome.kill('SIGTERM'))

const late = setTimeout(() => {
  console.error('cdp-pipe: Chrome did not answer on its pipe')
  chrome.kill('SIGKILL')
}, READY_MS)
const product = await mux.ready
clearTimeout(late)
rmSync(socket, { force: true })
server = createServer(conn => {
  const cut = nulFrames()
  const client = mux.connect(
    text => {
      conn.write(`${text}\0`)
    },
    () => conn.destroy(),
  )
  conn.on('data', (chunk: Buffer) => {
    for (const f of cut(chunk)) client.send(f)
  })
  conn.on('close', () => client.close())
  conn.on('error', () => {})
})
server.listen(socket, () => {
  chmodSync(socket, 0o600)
  console.error(`cdp-pipe: ${product} on ${socket}`)
})
