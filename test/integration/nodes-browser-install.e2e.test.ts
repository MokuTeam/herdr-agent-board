// docs/design/nodes/browser/install.sh, the pieces a reinstall must not lose (#861): the native host
// wrapper hands the mokutab bridge the vault (BW_SESSION from the unlock unit's file, bw's own data
// folder), and each profile's default-profile.json names the default profile from the settings, not a
// stale one. The script is sourced with INSTALL_SH_FUNCTIONS_ONLY=1, so nothing of its root part runs.
// The wrapper runs on the server's /bin/sh as Chrome would start it. A Linux node's script: its
// wrappers hold Linux paths, so the file does not run on Windows.
import { onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../../docs/design/nodes/browser/install.sh')
const sh = Bun.which('dash') ?? Bun.which('sh') ?? 'sh'
const bash = Bun.which('bash') ?? 'bash'
// A fake value, never a real session.
const FAKE_SESSION = 'fakeSessionForTest+/AbC=='

type Node = { root: string; env: Record<string, string> }

/** A node user's home in a temp folder with a space in its path, and the variables the functions read. */
function node(): Node {
  const root = mkdtempSync(join(tmpdir(), 'ab-browser-install-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home dir')
  const pkg = join(home, 'browser/mokutab/bridge/node_modules/@mokuhub/mokutab-bridge')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  // The bridge's launcher, faked: it prints what it was started with.
  writeFileSync(
    join(pkg, 'dist/run_host.sh'),
    '#!/bin/sh\nprintf "session=%s\\nappdata=%s\\nconfig=%s\\nargs=%s\\n" "$BW_SESSION" "$BITWARDENCLI_APPDATA_DIR" "$XDG_CONFIG_HOME" "$*"\n',
  )
  chmodSync(join(pkg, 'dist/run_host.sh'), 0o755)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // default_profile_json runs node; where there is none, Bun stands in.
  if (!Bun.which('node')) {
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
    chmodSync(join(bin, 'node'), 0o755)
  }
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    INSTALL_SH_FUNCTIONS_ONLY: '1',
    B: join(home, 'browser'),
    BWDIR: join(home, '.config/agent-board-bw'),
    BW_APPDATA: join(home, '.config/Bitwarden CLI'),
    PKG: pkg,
  }
  return { root, env }
}

/** Sources install.sh for its functions and runs one of them. */
function fn(n: Node, call: string, args: string[]): string {
  const r = spawnSync(bash, ['-c', `. "$0"; ${call} "$@"`, SCRIPT, ...args], { env: n.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

/** Writes the profile's wrapper the way install.sh does and starts it as Chrome would, with no BW_SESSION of its own. */
function startWrapper(n: Node, profile: string): Record<string, string> {
  const wrapper = join(n.root, `mokutab-host-${profile}`)
  writeFileSync(wrapper, fn(n, 'host_wrapper', [profile]))
  chmodSync(wrapper, 0o755)
  const env: Record<string, string | undefined> = { ...process.env, PATH: n.env.PATH }
  delete env.BW_SESSION
  const r = spawnSync(sh, [wrapper, 'chrome-extension://x/'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return Object.fromEntries(
    r.stdout
      .trim()
      .split('\n')
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
}

test.skipIf(process.platform === 'win32')(
  "the wrapper gives the bridge the unlock unit's BW_SESSION and bw's own data folder",
  () => {
    const n = node()
    mkdirSync(n.env.BWDIR as string, { recursive: true })
    writeFileSync(join(n.env.BWDIR as string, 'session.env'), `BW_SESSION=${FAKE_SESSION}\n`)
    const got = startWrapper(n, 'work')
    assert.equal(got.session, FAKE_SESSION)
    assert.equal(got.appdata, n.env.BW_APPDATA)
    // the per-profile state folders stay as they were
    assert.equal(got.config, join(n.env.B as string, 'state/work/config'))
    assert.ok(existsSync(join(n.env.B as string, 'state/work/state')))
    assert.equal(got.args, 'chrome-extension://x/')
  },
)

test.skipIf(process.platform === 'win32')(
  'with the vault not unlocked yet (no session file) the bridge still starts, without a session',
  () => {
    const n = node()
    const got = startWrapper(n, 'personal')
    assert.equal(got.session, '')
    assert.equal(got.appdata, n.env.BW_APPDATA)
    assert.equal(got.config, join(n.env.B as string, 'state/personal/config'))
  },
)

test.skipIf(process.platform === 'win32')(
  'default-profile.json gets the default profile where it names another one',
  () => {
    const n = node()
    const file = join(n.root, 'default-profile.json')
    // none yet
    assert.equal(JSON.parse(fn(n, 'default_profile_json', [file, 'work'])).profile, 'work')
    // the old literal that made the first profile to reconnect the default
    writeFileSync(file, JSON.stringify({ profile: 'default', set_at: '2026-11-23T11:03:41.657Z' }))
    const fresh = JSON.parse(fn(n, 'default_profile_json', [file, 'work']))
    assert.equal(fresh.profile, 'work')
    assert.ok(!Number.isNaN(Date.parse(fresh.set_at)))
    // unreadable
    writeFileSync(file, '{not json')
    assert.equal(JSON.parse(fn(n, 'default_profile_json', [file, 'work'])).profile, 'work')
  },
)

test.skipIf(process.platform === 'win32')(
  'default-profile.json that already names it is kept: a second run writes nothing',
  () => {
    const n = node()
    const file = join(n.root, 'default-profile.json')
    const kept = JSON.stringify({ profile: 'work', set_at: '2026-11-26T14:20:00.000Z' })
    writeFileSync(file, kept)
    assert.equal(fn(n, 'default_profile_json', [file, 'work']), '')
    assert.equal(readFileSync(file, 'utf8'), kept)
  },
)

test.skipIf(process.platform === 'win32')(
  'fix_bridge_scripts marks dist/*.sh executable even when npm --ignore-scripts left them 0644',
  () => {
    const n = node()
    const dist = join(n.env.PKG as string, 'dist')
    const runHost = join(dist, 'run_host.sh')
    const helper = join(dist, 'helper.sh')
    const nodePath = join(dist, 'node_path.txt')
    writeFileSync(helper, '#!/bin/sh\necho ok\n')
    writeFileSync(nodePath, '/usr/bin/node\n')
    chmodSync(runHost, 0o644)
    chmodSync(helper, 0o644)
    chmodSync(nodePath, 0o644)

    fn(n, 'fix_bridge_scripts', [n.env.PKG as string])

    assert.notEqual(statSync(runHost).mode & 0o111, 0)
    assert.notEqual(statSync(helper).mode & 0o111, 0)
    assert.equal(statSync(nodePath).mode & 0o111, 0)

    // The native host wrapper can now execute run_host.sh.
    const got = startWrapper(n, 'work')
    assert.equal(got.args, 'chrome-extension://x/')

    // An empty dist/ with no *.sh files does not trip set -euo pipefail.
    const emptyPkg = join(n.root, 'empty-pkg')
    mkdirSync(join(emptyPkg, 'dist'), { recursive: true })
    const emptyRes = spawnSync(bash, ['-euo', 'pipefail', '-c', '. "$0"; fix_bridge_scripts "$1"', SCRIPT, emptyPkg], {
      env: n.env,
      encoding: 'utf8',
    })
    assert.equal(emptyRes.status, 0, emptyRes.stderr)
  },
)
