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
//
// The admin's line (-T and no -R; core/server-admin.ts) is a server of its own, `admin` in the state:
//   { uid?: number,                                 0: root (default 1000)
//     sudo?: 'nopasswd' | 'password' | 'requiretty' | 'notSudoer',   default nopasswd
//     flavor?: 'sudo' | 'sudo-rs',                  whose lines it prints (default sudo)
//     password?: string,                            sudo -S takes this one only (none set: any)
//     publickey?: boolean,                          the admin's key refused
//     login?: { password: string,                   with the key refused: the login's password the server takes
//               kbdint?: string[],                  asked by keyboard-interactive instead (the first is the
//                                                   password's prompt, then more: a one-time code)
//               alsoPassword?: boolean },           after keyboard-interactive failed, the password method too
//     fixture?: string,                             a folder: look-1 prints its round1.txt, look-2 its round2.txt
//     run?: { lines: string[], dropAfter?: number } a launch prints these, cut after dropAfter (exit 255)
//     wrong?: string[] }                            a wrong password's lines instead of the flavour's (a sudo in another language)
// No line for its server key in the quoted UserKnownHostsFile: `Host key verification failed.`, 255;
// with StrictHostKeyChecking=accept-new the key is pinned then (another key for the host there:
// refused). The login's password is asked as ssh 8.4+ asks it with SSH_ASKPASS_REQUIRE=force: the
// SSH_ASKPASS program run with the prompt as its one argument, its first line of output the
// answer, a failure no answer; each prompt (never the answer) appended to `<FAKE_SSH_LOG>.askpass`
// as a JSON line; BatchMode, or no askpass forced: refused as ssh would, or `fake: a prompt on the
// terminal`, 254. `sshVersion` in the state is what `ssh -V` says (default Windows' 9.5).
// It decodes the script in the remote command, reads its `# agent-board: <kind>` line and answers
// as the server would: `probe` (no sudo) the `@@` lines PROBE_SCRIPT prints; the others behind the
// sudo the admin's mode needs, exactly (`sh -c '…'` for root, `env LC_ALL=C sudo -n -- ` NOPASSWD,
// `env LC_ALL=C sudo -S -p '' -- ` with a password), else `fake: unexpected command`, 2. It reads
// stdin to its end first (a stdin left open keeps it waiting); sudo -S's is appended to
// `<FAKE_SSH_LOG>.stdin` as a JSON line, and a wrong one gets the flavour's recorded lines (or
// `wrong`) and exit 1 (spec, "Checked by the spike").
// `hang` stays up silent.
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

type Mode = 'forward' | 'refuse' | 'publickey' | 'hostkey' | 'hang'
type Admin = {
  uid?: number
  sudo?: 'nopasswd' | 'password' | 'requiretty' | 'notSudoer'
  flavor?: 'sudo' | 'sudo-rs'
  password?: string
  publickey?: boolean
  login?: { password: string; kbdint?: string[]; alsoPassword?: boolean }
  fixture?: string
  run?: { lines: string[]; dropAfter?: number }
  wrong?: string[]
}
type State = {
  keygen?: 'unprotected' | 'passphrase'
  ssh?: { mode?: Mode; seq?: Mode[]; exitAfterMs?: number; proxyPort?: number; domain?: string }
  admin?: Admin
  sshVersion?: string
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

/** What sudo (Debian 13, 1.9.16p2) and sudo-rs (Ubuntu 26.04, 0.2.13) print, as the spike recorded it. */
const SUDO = {
  sudo: {
    version: 'Sudo version 1.9.16p2',
    need: ['sudo: a password is required'],
    wrong: ['Sorry, try again.', '', 'sudo: no password was provided', 'sudo: 1 incorrect password attempt'],
    notSudoer: (user: string) => [`${user} is not in the sudoers file.`],
    // -n says a password is required before it knows
    notSudoerN: (_user: string) => ['sudo: a password is required'],
    tty: ['sudo: sorry, you must have a tty to run sudo'],
    right: [] as string[],
  },
  'sudo-rs': {
    version: 'sudo-rs 0.2.13-0ubuntu1.2',
    need: ['sudo: interactive authentication is required'],
    wrong: ['', 'sudo: Authentication failed, try again.', '', 'sudo: Authentication required but not attempted'],
    notSudoer: (user: string) => [`sudo: I'm sorry ${user}. I'm afraid I can't do that`],
    notSudoerN: (user: string) => [`sudo: I'm sorry ${user}. I'm afraid I can't do that`],
    // sudo-rs only warns of requiretty, then goes on
    tty: ["/etc/sudoers.d/admin:1:10: unknown setting: 'requiretty'", 'Defaults requiretty', '         ^~~~~~~~~~'],
    right: [''],
  },
}

/** All of it to stdout before the fake exits: a pipe can take part of a write. */
function writeAll(text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  for (let at = 0; at < bytes.length; ) at += writeSync(1, bytes, at)
}
const out = (...lines: string[]): void => {
  for (const line of lines) writeAll(`${line}\n`)
}

/** The server's key as the admin's line checks it: pinned, or pinned now with accept-new; else refused. */
function adminHostKey(): void {
  const file = knownHosts()
  const text = file && existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (file && options.includes('StrictHostKeyChecking=accept-new')) {
    if (text.split(/\r?\n/).some(l => l.startsWith(`${HOST} `) && l !== HOST_LINE)) {
      say('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@')
      say('@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @')
      say('Host key verification failed.')
      end(255)
    }
    if (text.includes(HOST_LINE)) return
    if (!existsSync(dirname(file))) say(`Failed to add the host to the list of known hosts (${file}).`)
    else {
      appendFileSync(file, `${HOST_LINE}\n`)
      say(`Warning: Permanently added '${HOST}' (ED25519) to the list of known hosts.`)
    }
    return
  }
  if (!text.includes(HOST_LINE)) {
    say('Host key verification failed.')
    end(255)
  }
}

/** The SSH_ASKPASS program's answer to the prompt (its first line), null when it failed; the prompt logged. */
async function askpass(prompt: string): Promise<string | null> {
  if (logPath) appendFileSync(`${logPath}.askpass`, `${JSON.stringify(prompt)}\n`)
  const p = Bun.spawn([process.env.SSH_ASKPASS ?? '', prompt], {
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? (out.split(/\r?\n/)[0] ?? '') : null
}

/** The admin's key refused: the login's password, as ssh asks it and the server checks it; refused, as ssh says so. */
async function passwordLogin(a: Admin, target: string): Promise<void> {
  const l = a.login
  const methods = [
    'publickey',
    ...(l?.kbdint ? ['keyboard-interactive'] : []),
    ...(l && (!l.kbdint || l.alsoPassword) ? ['password'] : []),
  ]
  const denied = (): never => {
    say(`${target}: Permission denied (${methods.join(',')}).`)
    return end(255)
  }
  const preferred = options
    .find(o => o.startsWith('PreferredAuthentications='))
    ?.split('=')[1]
    ?.split(',')
  const offers = (method: string): boolean => methods.includes(method) && (!preferred || preferred.includes(method))
  if (!l || options.includes('BatchMode=yes') || (!offers('password') && !offers('keyboard-interactive'))) denied()
  if (!process.env.SSH_ASKPASS || process.env.SSH_ASKPASS_REQUIRE !== 'force') {
    say('fake: a prompt on the terminal')
    end(254)
  }
  // what leads ssh to the askpass, for the tests to look for the password in
  const leads = Object.entries(process.env).filter(([k]) => /^(SSH_ASKPASS|BUN_OPTIONS$|BOARD_ASKPASS)/.test(k))
  if (logPath) appendFileSync(`${logPath}.env`, `${JSON.stringify(Object.fromEntries(leads))}\n`)
  const tries = Number(options.find(o => o.startsWith('NumberOfPasswordPrompts='))?.split('=')[1] ?? 3)
  if (l?.kbdint && offers('keyboard-interactive')) {
    const [first = 'Password: ', ...more] = l.kbdint
    if ((await askpass(`(${target}) ${first}`)) === l.password) {
      for (const p of more) if ((await askpass(`(${target}) ${p}`)) === null) denied()
      return
    }
  }
  if (!offers('password')) denied()
  for (let n = 0; n < tries; n++) {
    if (n > 0) say('Permission denied, please try again.')
    if ((await askpass(`${target}'s password: `)) === l?.password) return
  }
  denied()
}

async function admin(): Promise<void> {
  const a = state.admin ?? {}
  adminHostKey()
  const target = args.at(-2) ?? ''
  const user = target.slice(0, target.indexOf('@'))
  if (a.publickey) await passwordLogin(a, target)
  // a stdin the board left open keeps this waiting, as it would keep sudo -S
  const input = await Bun.stdin.text()
  const m =
    /^(env LC_ALL=C sudo -n -- |env LC_ALL=C sudo -S -p '' -- )?sh -c 'eval "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/.exec(
      args.at(-1) ?? '',
    )
  const unexpected = (): never => {
    say('fake: unexpected command')
    return end(2)
  }
  if (!m) return unexpected()
  const prefix = m[1] ?? ''
  const script = Buffer.from(m[2] ?? '', 'base64').toString('utf8')
  const kind = /^# agent-board: (\S+)$/m.exec(script)?.[1] ?? ''
  const words = SUDO[a.flavor ?? 'sudo']
  const uid = a.uid ?? 1000
  const mode = uid === 0 ? 'root' : (a.sudo ?? 'nopasswd')
  if (kind === 'probe') {
    if (prefix) return unexpected()
    out(`@@uid ${uid}`)
    const sudoSays =
      mode === 'root' || mode === 'nopasswd'
        ? ['ok']
        : mode === 'password'
          ? words.need
          : mode === 'notSudoer'
            ? words.notSudoerN(user)
            : a.flavor === 'sudo-rs'
              ? [...words.tty, ...SUDO['sudo-rs'].need]
              : words.tty
    out(...sudoSays.filter(Boolean).map(l => `@@sudo ${l}`), `@@flavor ${words.version}`)
    return end(0)
  }
  const wanted =
    mode === 'root' ? '' : mode === 'nopasswd' ? 'env LC_ALL=C sudo -n -- ' : "env LC_ALL=C sudo -S -p '' -- "
  if (prefix !== wanted) return unexpected()
  if (prefix.includes('sudo -S')) {
    if (logPath) appendFileSync(`${logPath}.stdin`, `${JSON.stringify(input)}\n`)
    if (a.password !== undefined && input !== `${a.password}\n`) {
      say(...(a.wrong ?? words.wrong))
      end(1)
    }
    if (mode === 'notSudoer') {
      say(...words.notSudoer(user))
      end(1)
    }
    if (mode === 'requiretty') {
      say(...words.tty)
      if (a.flavor !== 'sudo-rs') end(1)
    }
    say(...words.right)
  }
  const print = (name: string): void => {
    const path = join(a.fixture ?? '', name)
    if (existsSync(path)) writeAll(readFileSync(path, 'utf8'))
  }
  switch (kind) {
    case 'look-1':
      print('round1.txt')
      return end(0)
    case 'look-2':
      print('round2.txt')
      return end(0)
    case 'launch': {
      const lines = a.run?.lines ?? []
      const drop = a.run?.dropAfter
      for (const [n, line] of lines.entries()) {
        if (drop !== undefined && n >= drop) {
          say(`Connection to ${HOST} closed by remote host.`)
          end(255)
        }
        out(line)
        await Bun.sleep(10)
      }
      return end(0)
    }
    case 'hang':
      setInterval(() => {}, 1 << 30)
      return
    default:
      return unexpected()
  }
}

if (args.includes('-R')) await ssh()
else if (args.includes('-V')) {
  say(state.sshVersion ?? 'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2')
  end(0)
} else if (args.includes('-T')) await admin()
else keygen()
