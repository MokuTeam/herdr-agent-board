// The server target's ssh (#233): the board's own key to the backup user, whose only program is
// the drop script (core/backup-server.ts). A snapshot goes on stdin and comes back on stdout as
// bytes; what the script and ssh say goes to stderr. No user config, the server's key as the
// board's known_hosts pins it (strictly: a changed key is refused), no forwarding, no prompt.
import { spawn } from 'node:child_process'
import type { ServerTarget } from '../core/backup.ts'
import { BACKUP_USER, DROP_TIMEOUT_MS } from '../core/backup-server.ts'
import { sshPathArg } from '../core/tunnel.ts'
import { killTreePid } from './process.ts'

export function dropArgs(o: {
  server: Pick<ServerTarget, 'host' | 'port'>
  key: string
  knownHosts: string
  command: string
  platform?: string
}): string[] {
  const options = [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile="${sshPathArg(o.knownHosts, o.platform)}"`,
    'IdentitiesOnly=yes',
    'ConnectTimeout=15',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=4',
    'ForwardAgent=no',
    'ForwardX11=no',
    'ClearAllForwardings=yes',
  ]
  return [
    '-F',
    'none',
    '-T',
    '-i',
    sshPathArg(o.key, o.platform),
    ...options.flatMap(x => ['-o', x]),
    '-p',
    String(o.server.port),
    `${BACKUP_USER}@${o.server.host}`,
    o.command,
  ]
}

export interface Exchange {
  /** ssh's exit code (null: a signal, or it did not run). */
  code: number | null
  out: Buffer
  /** ssh's and the drop script's words. */
  err: string
  /** Why it did not run ('ENOENT'…) or was ended ('timeout'); null otherwise. */
  error: string | null
}

/** The most stdout kept: a snapshot the drop takes is at most 64 MB. */
const OUT_LIMIT = 80 * 1024 * 1024

/** ssh with these arguments, no shell: `input` on its stdin (then closed), stdout as bytes. */
export function exchange(
  bin: string,
  args: string[],
  input: Uint8Array | null,
  timeoutMs = DROP_TIMEOUT_MS,
): Promise<Exchange> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: null, out: Buffer.alloc(0), err: '', error: String((err as NodeJS.ErrnoException).code ?? err) })
      return
    }
    const out: Buffer[] = []
    let size = 0
    let err = ''
    let why: string | null = null
    let done = false
    const finish = (code: number | null, error: string | null = why): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out: Buffer.concat(out), err: err.replaceAll('\r\n', '\n'), error })
    }
    const timer = setTimeout(() => {
      why = 'timeout'
      if (child.pid) killTreePid(child.pid)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= OUT_LIMIT) out.push(chunk)
      else if (child.pid) {
        why = 'too much output'
        killTreePid(child.pid)
      }
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (err.length < 64_000) err += chunk
    })
    // ssh may end before it reads stdin (a refused key): that write's EPIPE is no error of ours
    child.stdin?.on('error', () => {})
    if (input) child.stdin?.end(Buffer.from(input))
    else child.stdin?.end()
    child.on('error', e => finish(null, String((e as NodeJS.ErrnoException).code ?? e.message)))
    child.on('close', code => finish(code))
  })
}

/** The drop's own error line (`@@error …`), else ssh's last words, else why it did not run. */
export function dropError(x: Exchange): string {
  const lines = x.err.split('\n').map(l => l.trim())
  const own = lines.find(l => l.startsWith('@@error '))
  if (own) return own.slice(8)
  const said = lines.filter(Boolean).slice(-3).join(' ')
  if (said) return said
  if (x.error) return x.error
  return `exit code ${String(x.code)}`
}
