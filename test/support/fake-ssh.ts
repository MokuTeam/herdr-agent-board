// Compiled to an executable (see fake-ssh-bin.ts) and used as both BOARD_SSH_BIN_PATH and
// BOARD_SSH_KEYGEN_BIN_PATH: an argument list with `-R` is ssh, any other ssh-keygen. It contacts
// no server and never runs the real ones. Every call is appended to FAKE_SSH_LOG as a JSON line
// (its argv), and each ssh's pid to `<FAKE_SSH_LOG>.pids`, one a line; FAKE_SSH_STATE (a JSON
// file, missing = {}) picks the answers:
//   { keygen?: 'unprotected' | 'passphrase',      ssh-keygen -y refuses the key so
//     ssh?: { mode?: Mode, seq?: Mode[],          one mode, or one per call in turn (the last repeats)
//             exitAfterMs?: number,               forward drops after that long (else: until killed)
//             proxyPort?: number,                 forward: Caddy's stand-in on 127.0.0.1:<proxyPort>
//             domain?: string } }                 the Host it sends on
// Modes (none: forward): forward holds the -R forward; refuse, publickey and hostkey exit 255 as
// ssh does for a refused forward, a refused key, a changed server key; hang stays up silent.
// ssh prints what Windows' ssh 9.5 printed in the spike (spec, "Checked by the spike"): with -v,
// the version banner, the known-hosts warning on the first connection and `Authenticated to …`
// without `debug1:`, then the forward's `debug1:` lines; the errors (with or without -v) as ssh
// words them.
// With `proxyPort`, a forward also does what Caddy does on the server: what comes to that port goes
// on to the -R target (127.0.0.1:<port>), its body streamed, with `Host: <domain>`,
// `X-Forwarded-Proto: https` and the caller's address in X-Forwarded-For; 502 while nothing answers
// there. It listens before it says the forward is taken. A port still taken (a stray fake about to
// be ended) is tried again for 2 s; after that the forward goes on without it.
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

type Mode = 'forward' | 'refuse' | 'publickey' | 'hostkey' | 'hang'
type State = {
  keygen?: 'unprotected' | 'passphrase'
  ssh?: { mode?: Mode; seq?: Mode[]; exitAfterMs?: number; proxyPort?: number; domain?: string }
}

const HOST = 'ssh.example.com'
const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n'
const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY'
const HOST_LINE = `${HOST} ssh-ed25519 AAAAFAKEHOST`
/** The caller Caddy names in X-Forwarded-For (test/support/tunnel-board.ts's CALLER). */
const CALLER = '203.0.113.9'
/** How long a taken proxy port is tried again. */
const PROXY_WAIT_MS = 2000

const args = process.argv.slice(2)
const logPath = process.env.FAKE_SSH_LOG
const statePath = process.env.FAKE_SSH_STATE
if (logPath) appendFileSync(logPath, `${JSON.stringify(args)}\n`)
if (logPath && args.includes('-R')) appendFileSync(`${logPath}.pids`, `${process.pid}\n`)
const state: State = statePath && existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as State) : {}

const say = (...lines: string[]): void => {
  for (const line of lines) writeSync(2, `${line}\r\n`)
}
const end = (code: number): never => process.exit(code)
const argAfter = (flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const options = args.flatMap((arg, i) => (arg === '-o' && args[i + 1] !== undefined ? [args[i + 1] as string] : []))

function keygen(): void {
  const file = argAfter('-f') ?? ''
  if (args.includes('-t')) {
    if (existsSync(file)) {
      // ssh-keygen asks, and a prompt nobody answers is a no.
      say(`${file} already exists.`, 'Overwrite (y/n)? ')
      end(1)
    }
    try {
      writeFileSync(file, PRIVATE)
      writeFileSync(`${file}.pub`, `${PUBLIC} ${argAfter('-C') ?? ''}\n`)
    } catch (err) {
      say(`Saving key "${file}" failed: ${(err as Error).message}`)
      end(1)
    }
    end(0)
  }
  if (args.includes('-y')) {
    if (state.keygen === 'unprotected') {
      say(`Permissions for '${file}' are too open.`, 'UNPROTECTED PRIVATE KEY FILE!')
      end(1)
    }
    if (state.keygen === 'passphrase') {
      say(`Load key "${file}": incorrect passphrase supplied to decrypt private key`)
      end(1)
    }
    if (!existsSync(file)) {
      say(`${file}: No such file or directory`)
      end(1)
    }
    const pub = `${file}.pub`
    process.stdout.write(existsSync(pub) ? readFileSync(pub, 'utf8') : `${PUBLIC}\n`)
    end(0)
  }
  if (args.includes('-l')) {
    if (!existsSync(file)) {
      say(`${file}: No such file or directory`)
      end(1)
    }
    process.stdout.write(`256 SHA256:FAKEfingerprint ${HOST} (ED25519)\n`)
    end(0)
  }
  say(`fake ssh-keygen: unexpected arguments ${JSON.stringify(args)}`)
  end(1)
}

/** `ssh.mode`, or `ssh.seq`'s next (the last one repeating), counted in a file beside the state. */
function mode(): Mode {
  const seq = state.ssh?.seq
  if (!seq?.length || !statePath) return state.ssh?.mode ?? 'forward'
  const counter = `${statePath}.ssh.n`
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(n + 1))
  return seq[Math.min(n, seq.length - 1)] as Mode
}

/** The quoted, %-doubled UserKnownHostsFile as ssh reads it. */
function knownHosts(): string | null {
  const option = options.find(o => o.startsWith('UserKnownHostsFile='))
  if (!option) return null
  return option
    .slice('UserKnownHostsFile='.length)
    .replace(/^"(.*)"$/, '$1')
    .replaceAll('%%', '%')
}

/** accept-new: the server's key is added on the first connection (when its folder exists, as ssh). */
function pinHostKey(verbose: boolean): void {
  if (!options.includes('StrictHostKeyChecking=accept-new')) return
  const file = knownHosts()
  if (!file || (existsSync(file) && readFileSync(file, 'utf8').includes(HOST_LINE))) return
  if (!existsSync(dirname(file))) {
    say(`Failed to add the host to the list of known hosts (${file}).`)
    return
  }
  appendFileSync(file, `${HOST_LINE}\n`)
  if (verbose) say(`Warning: Permanently added '${HOST}' (ED25519) to the list of known hosts.`)
}

/**
 * Caddy's stand-in: 127.0.0.1:<proxyPort> passed on to <target>:<port>, as Caddy passes the domain on
 * through the socket. Taken while the port is free within PROXY_WAIT_MS; else not at all.
 */
async function proxy(proxyPort: number, domain: string, target: string, port: string): Promise<void> {
  const pass = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const headers = new Headers(req.headers)
    headers.set('host', domain)
    headers.set('x-forwarded-proto', 'https')
    headers.set('x-forwarded-for', CALLER)
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
      redirect: 'manual',
      ...(req.body && { body: req.body, duplex: 'half' }),
    }
    try {
      return await fetch(`http://${target}:${port}${url.pathname}${url.search}`, init)
    } catch {
      return new Response('', { status: 502 })
    }
  }
  for (const deadline = Date.now() + PROXY_WAIT_MS; ; ) {
    try {
      Bun.serve({ hostname: '127.0.0.1', port: proxyPort, idleTimeout: 0, reusePort: false, fetch: pass })
      return
    } catch {
      if (Date.now() > deadline) return
      await Bun.sleep(50)
    }
  }
}

async function ssh(): Promise<void> {
  const verbose = args.includes('-v')
  // -R <socket>:<host>:<port>
  const [, socket = '', target = '', port = ''] = /^(.*):([^:]*):(\d+)$/.exec(argAfter('-R') ?? '') ?? []
  const stayUp = (): void => {
    const after = state.ssh?.exitAfterMs
    if (after !== undefined)
      setTimeout(() => {
        say(`Connection to ${HOST} closed by remote host.`)
        end(255)
      }, after)
    else setInterval(() => {}, 1 << 30)
  }
  const now = mode()
  if (now === 'hang') {
    // Silent until killed: exitAfterMs is the forward's alone.
    setInterval(() => {}, 1 << 30)
    return
  }
  if (verbose) say('OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2')
  if (now === 'hostkey') {
    say('Host key verification failed.')
    end(255)
  }
  pinHostKey(verbose)
  if (now === 'publickey') {
    say(`boardtunnel@${HOST}: Permission denied (publickey).`)
    end(255)
  }
  if (verbose) say(`Authenticated to ${HOST} ([203.0.113.5]:22) using "publickey".`)
  if (now === 'refuse') {
    if (verbose) say(`debug1: remote forward failure for: listen ${socket}:-2, connect ${target}:${port}`)
    say(`Error: remote port forwarding failed for listen path ${socket}`)
    end(255)
  }
  const proxyPort = state.ssh?.proxyPort
  if (proxyPort) await proxy(proxyPort, state.ssh?.domain ?? '', target, port)
  if (verbose)
    say(
      `debug1: remote forward success for: listen ${socket}:-2, connect ${target}:${port}`,
      'debug1: forwarding_success: all expected forwarding replies received',
    )
  stayUp()
}

if (args.includes('-R')) await ssh()
else keygen()
