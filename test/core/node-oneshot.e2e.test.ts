// End-to-end tests of the NAT one-command script (src/core/node-oneshot.ts) under dash and sh:
// syntax checks, execution in a sandboxed HOME for both Linux and macOS (Darwin), idempotent
// re-runs, config.json preservation/corruption refusal, and strict secret hygiene (no master token).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { LAUNCHD_LABEL, launchdPlist, nodeOneLine, nodeOneshotScript } from '../../src/core/node-oneshot.ts'
import { BUN_VERSION, HERDR_MIN, herdrUnit } from '../../src/core/node-texts.ts'
import { RELAY_NODE_USER } from '../../src/core/relay-texts.ts'

const DIAL_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBTestFakeDialKeyForOneshotTests0000000000000000000000000',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

const HOST_KEY = 'relay.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeRelayHostKey'
const MASTER_TOKEN = 'MASTER_SECRET_TOKEN_SHOULD_NEVER_BE_IN_PASTE_1234567890'
const MASTER_ENROL_KEY = 'MASTER_ENROL_PRIVATE_KEY_NEVER_IN_PASTE'

const shells = [
  ['dash', Bun.which('dash')],
  ['sh', Bun.which('sh')],
].filter((x): x is [string, string] => Boolean(x[1]))

function makeBarePluginRepo(dir: string): { repoUrl: string; commit: string } {
  const work = join(dir, 'repo-work')
  const bare = join(dir, 'repo.git')
  mkdirSync(join(work, 'src', 'entrypoints'), { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'agent-board', version: '0.1.0' }))
  writeFileSync(
    join(work, 'src', 'entrypoints', 'install.ts'),
    'import { writeFileSync } from "node:fs"; import { join } from "node:path"; writeFileSync(join(process.env.HOME || "", ".installed-by-oneshot"), "ok\\n");\n',
  )
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout.trim()
  }
  git(work, ['init', '-q', '-b', 'main'])
  git(work, ['config', 'user.name', 'Anna'])
  git(work, ['config', 'user.email', 'anna@example.com'])
  git(work, ['add', '.'])
  git(work, ['commit', '-q', '-m', 'init'])
  const commit = git(work, ['rev-parse', 'HEAD'])
  git(dir, ['clone', '--bare', '-q', work, bare])
  return { repoUrl: bare, commit }
}

function makeFakeBin(dir: string, osName: 'Linux' | 'Darwin'): { binDir: string; logFile: string } {
  const binDir = join(dir, 'bin')
  const logFile = join(dir, 'calls.log')
  mkdirSync(binDir, { recursive: true })
  const writeExe = (name: string, body: string) => {
    const p = join(binDir, name)
    writeFileSync(p, body, { mode: 0o755 })
    chmodSync(p, 0o755)
  }
  writeExe('uname', `#!/bin/sh\nif [ "\${1:-}" = "-s" ]; then echo "${osName}"; else /bin/uname "$@"; fi\n`)
  writeExe('hostname', '#!/bin/sh\necho "Annas-MacBook.local"\n')
  writeExe(
    'bun',
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "${BUN_VERSION}"; exit 0; fi
if [ "\${1:-}" = "install" ]; then echo "bun $*" >> "${logFile}"; exit 0; fi
exec "${process.execPath}" "$@"
`,
  )
  writeExe(
    'herdr',
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "herdr ${HERDR_MIN}"; exit 0; fi
echo "herdr $*" >> "${logFile}"
exit 0
`,
  )
  writeExe('claude', '#!/bin/sh\necho "2.0.0"\n')
  writeExe(
    'systemctl',
    `#!/bin/sh\necho "systemctl $*" >> "${logFile}"\nif [ "\${2:-}" = "is-active" ]; then exit 1; fi\nexit 0\n`,
  )
  writeExe(
    'launchctl',
    `#!/bin/sh\necho "launchctl $*" >> "${logFile}"\nif [ "\${1:-}" = "print" ]; then exit 1; fi\nexit 0\n`,
  )
  return { binDir, logFile }
}

describe('node-oneshot script and paste (#513)', () => {
  test('one-line command decodes cleanly, passes dash -n and sh -n, and holds no master secrets', () => {
    const script = nodeOneshotScript({
      relay: { host: 'relay.example.com', sshPort: 2222, socket: 'anna-mbp-a1b2c3', hostKey: HOST_KEY },
      dialKey: DIAL_KEY,
      code: 'JoinCode_0123456789abcdef',
      expiresAt: 1800000000000,
      commit: 'c1585a769a762b77e36e71c6ceebf1bd0760bb44',
      id: 'anna-mbp',
      port: 12444,
    })
    const line = nodeOneLine(script, b => gzipSync(b, { level: 9 }))
    expect(line).toMatch(
      /^echo [A-Za-z0-9+/=]+ \| \{ case \$\(uname -s\) in Darwin\) base64 -D;; \*\) base64 -d;; esac; \} \| gunzip \| sh$/,
    )
    const decoded = gunzipSync(Buffer.from(line.split(' ')[1] ?? '', 'base64')).toString('utf8')
    expect(decoded).toBe(script)
    const decodePipeline = line.replace(/ \| sh$/, '')
    for (const [name, bin] of shells) {
      const piped = spawnSync(bin, ['-c', decodePipeline], { encoding: 'utf8' })
      expect([name, piped.status, piped.stdout]).toEqual([name, 0, script])
    }

    // Paste holds no master token or enrol/master keys
    for (const text of [line, script]) {
      expect(text).not.toContain(MASTER_TOKEN)
      expect(text).not.toContain(MASTER_ENROL_KEY)
      expect(text).not.toContain('Authorization')
      expect(text).not.toContain('masters.json')
    }
    expect(script).toContain(RELAY_NODE_USER)
    expect(script).toContain('anna-mbp-a1b2c3')
    expect(script).toContain('JoinCode_0123456789abcdef')

    for (const [name, bin] of shells) {
      const r = spawnSync(bin, ['-n'], { input: script, encoding: 'utf8' })
      expect([name, r.status, r.stderr]).toEqual([name, 0, ''])
    }
  })

  test('executes cleanly under both dash and sh on Linux and Darwin without root', () => {
    for (const [shName, shBin] of shells) {
      for (const osName of ['Linux', 'Darwin'] as const) {
        const dir = mkdtempSync(join(tmpdir(), `ab-oneshot-${shName}-${osName}-`))
        try {
          const home = join(dir, 'home')
          mkdirSync(home, { recursive: true })
          const { repoUrl, commit } = makeBarePluginRepo(dir)
          const { binDir, logFile } = makeFakeBin(dir, osName)
          const cfgDir = join(home, '.config', 'herdr', 'plugins', 'config', 'agent-board')
          mkdirSync(cfgDir, { recursive: true })
          writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', customKey: 'kept' }))

          const script = nodeOneshotScript({
            relay: { host: 'relay.example.com', sshPort: 2222, socket: 'cleo-node-112233', hostKey: HOST_KEY },
            dialKey: DIAL_KEY,
            code: 'JoinCode_0123456789abcdef',
            expiresAt: 1800000000000,
            commit,
            repoUrl,
            port: 12445,
          })

          const env = {
            HOME: home,
            PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
            TERM: 'xterm-256color',
          }
          const run = spawnSync(shBin, ['-s'], { input: script, env, encoding: 'utf8', timeout: 30_000 })
          expect([shName, osName, run.status]).toEqual([shName, osName, 0])
          expect(run.stderr).not.toContain('not found')
          expect(run.stderr).not.toContain('syntax error')

          const nodeDir = join(home, '.local', 'state', 'herdr', 'plugins', 'agent-board', 'node')
          expect(readFileSync(join(nodeDir, 'relay-key'), 'utf8')).toBe(`${DIAL_KEY}\n`)
          expect(statSync(join(nodeDir, 'relay-key')).mode & 0o777).toBe(0o600)
          expect(readFileSync(join(nodeDir, 'relay-known-hosts'), 'utf8')).toBe(`${HOST_KEY}\n`)
          expect(statSync(join(nodeDir, 'relay-known-hosts')).mode & 0o777).toBe(0o600)
          expect(JSON.parse(readFileSync(join(nodeDir, 'join.json'), 'utf8'))).toEqual({
            code: 'JoinCode_0123456789abcdef',
            expiresAt: 1800000000000,
            attempts: 0,
          })
          expect(statSync(join(nodeDir, 'join.json')).mode & 0o777).toBe(0o600)

          const cfg = JSON.parse(readFileSync(join(cfgDir, 'config.json'), 'utf8')) as {
            customKey: string
            node: Record<string, unknown>
          }
          expect(cfg.customKey).toBe('kept')
          expect(cfg.node).toEqual({
            id: 'annas-macbook',
            port: 12445,
            workRoot: '~/work',
            tls: true,
            relay: { host: 'relay.example.com', sshPort: 2222, user: RELAY_NODE_USER, socket: 'cleo-node-112233' },
          })
          expect(readFileSync(join(home, '.installed-by-oneshot'), 'utf8')).toBe('ok\n')
          expect(readFileSync(join(home, '.profile'), 'utf8')).toContain('DISABLE_AUTOUPDATER=1')

          const log = readFileSync(logFile, 'utf8')
          expect(log).toContain(`herdr plugin link ${join(home, 'agent-board')}`)
          if (osName === 'Linux') {
            const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'herdr.service'), 'utf8')
            expect(unit).toContain('ExecStart=%h/.local/bin/herdr server')
            expect(unit).toContain('# agent-board: herdr for the node\'s user. Added by "Add a computer".')
            expect(unit).not.toContain('Add a server')
            expect(unit).not.toContain('Undo')
            expect(herdrUnit()).toContain(
              '# agent-board: herdr for the node\'s user. Added by "Add a server"; its Undo removes it.',
            )
            expect(log).toContain('systemctl --user start herdr.service')
          } else {
            const plist = readFileSync(join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`), 'utf8')
            expect(plist).toBe(launchdPlist(home))
            expect(log).toContain('launchctl')
          }

          // Re-running is idempotent and does not duplicate .profile blocks
          const run2 = spawnSync(shBin, ['-s'], { input: script, env, encoding: 'utf8', timeout: 30_000 })
          expect(run2.status).toBe(0)
          expect(readFileSync(join(home, '.profile'), 'utf8').match(/# >>> agent-board node/g)).toHaveLength(1)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    }
  }, 60_000)

  test('strips CR from Windows keys, protects stdin via main </dev/null, preserves existing unit/plist, and avoids Done when service fails to start', () => {
    for (const osName of ['Linux', 'Darwin'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `ab-oneshot-hardening-${osName}-`))
      try {
        const home = join(dir, 'home')
        mkdirSync(home, { recursive: true })
        const { repoUrl, commit } = makeBarePluginRepo(dir)
        const { binDir } = makeFakeBin(dir, osName)
        // Make herdr swallow stdin (`cat >/dev/null`) and systemctl/launchctl fail to start
        writeFileSync(
          join(binDir, 'herdr'),
          `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "herdr ${HERDR_MIN}"; exit 0; fi
cat >/dev/null
exit 0
`,
          { mode: 0o755 },
        )
        chmodSync(join(binDir, 'herdr'), 0o755)
        writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
        chmodSync(join(binDir, 'systemctl'), 0o755)
        writeFileSync(join(binDir, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
        chmodSync(join(binDir, 'launchctl'), 0o755)

        const unitOrPlist =
          osName === 'Linux'
            ? join(home, '.config', 'systemd', 'user', 'herdr.service')
            : join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
        mkdirSync(join(unitOrPlist, '..'), { recursive: true })
        writeFileSync(unitOrPlist, '# custom existing service file\n')

        const script = nodeOneshotScript({
          relay: {
            host: 'relay.example.com',
            sshPort: 2222,
            socket: 'cleo-node-112233',
            hostKey: `${HOST_KEY}\r\n`,
          },
          dialKey: `${DIAL_KEY.replaceAll('\n', '\r\n')}\r\n`,
          code: 'JoinCode_0123456789abcdef',
          expiresAt: 1800000000000,
          commit,
          repoUrl,
          id: 'cleo-node',
        })
        const r = spawnSync('dash', ['-s'], {
          input: script,
          env: { HOME: home, PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`, TERM: 'xterm-256color' },
          encoding: 'utf8',
          timeout: 30_000,
        })
        expect(r.status).toBe(0)
        // Existing service file untouched
        expect(readFileSync(unitOrPlist, 'utf8')).toBe('# custom existing service file\n')
        // Stdin-eating herdr did not eat the rest of the script; failed start must NOT print Done
        expect(r.stdout).not.toContain('Done:')
        expect(r.stdout).toContain('Start it with: herdr server')
        // Windows CR stripped cleanly from written keys
        const nodeDir = join(home, '.local', 'state', 'herdr', 'plugins', 'agent-board', 'node')
        expect(readFileSync(join(nodeDir, 'relay-key'), 'utf8')).not.toContain('\r')
        expect(readFileSync(join(nodeDir, 'relay-known-hosts'), 'utf8')).not.toContain('\r')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 60_000)

  test('refuses corrupt config.json without overwriting it, and falls back gracefully on unpublished commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-oneshot-badcfg-'))
    try {
      const home = join(dir, 'home')
      mkdirSync(home, { recursive: true })
      const { repoUrl } = makeBarePluginRepo(dir)
      const { binDir } = makeFakeBin(dir, 'Linux')
      const cfgDir = join(home, '.config', 'herdr', 'plugins', 'config', 'agent-board')
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(join(cfgDir, 'config.json'), '{ broken json')

      const script = nodeOneshotScript({
        relay: { host: 'relay.example.com', sshPort: 22, socket: 'ben-pc-112233', hostKey: HOST_KEY },
        dialKey: DIAL_KEY,
        code: 'JoinCode_0123456789abcdef',
        expiresAt: 1800000000000,
        commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        repoUrl,
        id: 'ben-pc',
      })
      const r = spawnSync('sh', ['-s'], {
        input: script,
        env: { HOME: home, PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`, TERM: 'xterm-256color' },
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(r.status).toBe(3)
      expect(r.stdout).toContain('not published on origin')
      expect(readFileSync(join(cfgDir, 'config.json'), 'utf8')).toBe('{ broken json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('validates inputs strictly against injection and bad shapes', () => {
    const base = {
      relay: { host: 'relay.example.com', sshPort: 22, socket: 'atlas-1', hostKey: HOST_KEY },
      dialKey: DIAL_KEY,
      code: 'JoinCode_0123456789abcdef',
      expiresAt: 1800000000000,
    }
    expect(() => nodeOneshotScript({ ...base, relay: { ...base.relay, host: '-oProxyCommand=id' } })).toThrow()
    expect(() => nodeOneshotScript({ ...base, relay: { ...base.relay, socket: '../evil' } })).toThrow()
    expect(() => nodeOneshotScript({ ...base, code: 'bad' })).toThrow()
    expect(() => nodeOneshotScript({ ...base, id: 'local' })).toThrow()
    expect(() => nodeOneshotScript({ ...base, port: 12422 })).toThrow()
    expect(() => nodeOneshotScript({ ...base, dialKey: `${DIAL_KEY}\nAGENT_BOARD_RELAY_KEY\n` })).toThrow()
  })
})
