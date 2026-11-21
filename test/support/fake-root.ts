// A server's root for the backup's root scripts (core/backup-server.ts Look, Apply, Undo), in a
// temp folder: shims for id, getent, useradd, usermod, userdel, chown, install, systemctl and
// sshd, an /etc/ssh with sshd_config (and sshd_config.d, or none), and the scripts' paths rewritten
// into it. The shims prove the scripts' own flow (steps, rollback, the record, what Undo leaves),
// not sshd's semantics: their sshd reads the config's Match block for the backup user and answers
// -t and -T -C from it. SWALLOW: another block takes the user's ForceCommand; LEAK: the fence leaks
// into root's settings; ALLOWUSERS: an AllowUsers that leaves the backup user out; BROKEN in the
// config: sshd -t refuses it. Brought over from the review of #234 (its sim/setup.sh and prep.sh).
// For the node's install (core/node-plan.ts) also loginctl, runuser, curl (the installers and the
// door's hello from the root, nothing fetched), ss, apt-get and flock, sshd -T for the link user
// (LINK_LEAK, LINK_ALLOWUSERS as LEAK and ALLOWUSERS are for the backup's), and with
// `node` the files that install reads; the backup's scripts call none of these.
import { onTestFinished } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The scripts run on the server's /bin/sh (dash on Debian and Ubuntu): dash where it is, else a POSIX sh. */
export const sh = Bun.which('dash') ?? Bun.which('sh')

const SHIMS: Record<string, string> = {
  id: `#!/bin/sh
case "$1" in -u) echo 0;; -gn) echo "$2";; *) exec /usr/bin/id "$@";; esac
`,
  getent: `#!/bin/sh
f="$FAKE/state/$1"; [ -f "$f" ] || exit 2
grep "^$2:" "$f" || exit 2
`,
  useradd: `#!/bin/sh
echo "useradd $*" >> "$FAKE/state/log"
c=; h=; m=
while [ $# -gt 1 ]; do
  case $1 in
    --comment) c=$2; shift;; --home-dir) h=$2; shift;; --shell) shift;;
    --create-home) m=1;;
  esac; shift
done
u=$1
if grep -q "^$u:" "$FAKE/state/group"; then echo "useradd: group $u exists" >&2; exit 9; fi
echo "$u:x:900:900:$c:$h:/bin/sh" >> "$FAKE/state/passwd"
echo "$u:x:900:" >> "$FAKE/state/group"
[ -n "$m" ] && mkdir -p "$h"
exit 0
`,
  usermod: `#!/bin/sh
echo "usermod $*" >> "$FAKE/state/log"; exit 0
`,
  userdel: `#!/bin/sh
echo "userdel $*" >> "$FAKE/state/log"
u=$1
grep -v "^$u:" "$FAKE/state/passwd" > "$FAKE/state/passwd.n"; mv "$FAKE/state/passwd.n" "$FAKE/state/passwd"
grep -v "^$u:" "$FAKE/state/group" > "$FAKE/state/group.n"; mv "$FAKE/state/group.n" "$FAKE/state/group"
exit 0
`,
  chown: `#!/bin/sh
echo "chown $*" >> "$FAKE/state/log"; exit 0
`,
  // the record's writes counted; FAIL_RECORD_AT=<n>: the nth of them fails
  mv: `#!/bin/sh
for last in "$@"; do :; done
case $last in
  */record)
    n=$(( $(cat "$FAKE/state/records" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE/state/records"
    [ "$n" = "\${FAIL_RECORD_AT:-0}" ] && { echo "mv: cannot move to $last" >&2; exit 1; } ;;
esac
for m in /usr/bin/mv /bin/mv; do [ -x "$m" ] && exec "$m" "$@"; done
exit 127
`,
  install: `#!/bin/sh
args=; skip=
for a in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  case $a in -o|-g|-m) skip=1;; *) args="$args '$a'";; esac
done
eval exec /usr/bin/install $args
`,
  systemctl: `#!/bin/sh
echo "systemctl $*" >> "$FAKE/state/log"; exit \${SYSTEMCTL_RC:-0}
`,
  // the node's install (core/node-plan.ts): lingering by a file and the user's runtime folder
  loginctl: `#!/bin/sh
echo "loginctl $*" >> "$FAKE/state/log"
case $1 in
  enable-linger)
    uid=$(grep "^$2:" "$FAKE/state/passwd" | cut -d: -f3)
    [ -n "$uid" ] || { echo "Failed to look up user $2" >&2; exit 1; }
    mkdir -p "$FAKE/var/lib/systemd/linger" "$FAKE/run/user/$uid/systemd"; : > "$FAKE/var/lib/systemd/linger/$2" ;;
  disable-linger)
    grep -q "^$2:" "$FAKE/state/passwd" || { echo "Failed to look up user $2" >&2; exit 1; }
    rm -f "$FAKE/var/lib/systemd/linger/$2" ;;
esac
exit 0
`,
  // the command runs as the caller; the user must exist
  runuser: `#!/bin/sh
u=
while [ $# -gt 0 ]; do case $1 in -u) u=$2; shift;; --) shift; break;; esac; shift; done
known=
while IFS=: read -r name rest; do [ "$name" = "$u" ] && known=1; done < "$FAKE/state/passwd"
[ -n "$known" ] || { echo "runuser: user $u does not exist" >&2; exit 1; }
exec "$@"
`,
  // the installers from $FAKE/installers, the door's hello from $FAKE/state/hello; nothing leaves the machine
  curl: `#!/bin/sh
url=
for a in "$@"; do case $a in http://*|https://*) url=$a;; esac; done
echo "curl $url" >> "$FAKE/state/log"
case $url in
  https://bun.sh/install) cat "$FAKE/installers/bun" ;;
  https://herdr.dev/install.sh) cat "$FAKE/installers/herdr" ;;
  https://claude.ai/install.sh) cat "$FAKE/installers/claude" ;;
  http://127.0.0.1:*/api/hello) if [ -f "$FAKE/state/hello" ]; then cat "$FAKE/state/hello"; else echo "curl: (7) Failed to connect" >&2; exit 7; fi ;;
  *) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
`,
  ss: `#!/bin/sh
if [ -f "$FAKE/state/listen" ]; then cat "$FAKE/state/listen"; fi
exit 0
`,
  // the node's run lock: always free, held with FLOCK_BUSY
  flock: `#!/bin/sh
[ -z "\${FLOCK_BUSY:-}" ] || exit 1
exit 0
`,
  // only looked for: the node's Bun installer needs it
  unzip: `#!/bin/sh
exit 0
`,
  'apt-get': `#!/bin/sh
echo "apt-get $*" >> "$FAKE/state/log"; exit \${APT_RC:-0}
`,
  sshd: `#!/bin/sh
echo "sshd $*" >> "$FAKE/state/log"
mode=; file=$FAKE/etc/ssh/sshd_config; conn=
while [ $# -gt 0 ]; do case $1 in -t) mode=t;; -T) mode=T;; -f) file=$2; shift;; -C) conn=$2; shift;; esac; shift; done
eff() { cat "$file"; awk 'tolower($1)=="include"{print $2}' "$file" | while read -r g; do for f in $g; do [ -f "$f" ] && cat "$f"; done; done; }
case $mode in
t) if eff | grep -q BROKEN; then echo "$file: line 3: Bad configuration option: BROKEN" >&2; exit 255; fi; exit 0;;
T) user=\${conn#user=}; user=\${user%%,*}
   echo "port 22"; echo "permitrootlogin without-password"
   fence() { eff | awk '/^Match User agent-board-backup/{on=1;next} /^Match all/{on=0} on{ $1=tolower($1); print }'; }
   if [ "$user" = agent-board-backup ] && eff | grep -q '^Match User agent-board-backup'; then
     if [ -n "\${SWALLOW:-}" ]; then echo "forcecommand internal-sftp"; else fence; fi
     if [ -n "\${ALLOWUSERS:-}" ]; then echo "allowusers $ALLOWUSERS"; fi
   elif [ "$user" = agent-board-link ] && eff | grep -q '^Match User agent-board-link'; then
     eff | awk '/^Match User agent-board-link/{on=1;next} /^Match all/{on=0} on{ $1=tolower($1); print }'
     if [ -n "\${LINK_ALLOWUSERS:-}" ]; then echo "allowusers $LINK_ALLOWUSERS"; fi
   else
     echo "authorizedkeysfile .ssh/authorized_keys"
     if [ -n "\${LEAK:-}" ] && eff | grep -q '^Match User agent-board-backup'; then echo "forcecommand leaked"; fi
     if [ -n "\${LINK_LEAK:-}" ] && eff | grep -q '^Match User agent-board-link'; then echo "forcecommand leaked $(eff | awk '$1 == "PermitOpen" { print $2; exit }')"; fi
   fi
   exit 0;;
esac
exit 0
`,
}

/** The installers the node's plan fetches (the fake curl serves them): each puts a stand-in for its program in the user's home. */
const INSTALLERS: Record<string, string> = {
  bun: `v=\${1#bun-v}
mkdir -p "$HOME/.bun/bin"
printf '%s\\n' '#!/bin/sh' 'case "$1" in' "  --version) echo \${FAKE_BUN_VERSION:-$v} ;;" '  -e) exec "$REAL_BUN" "$@" ;;' '  *) echo "bun $*" >> "$FAKE/state/log" ;;' 'esac' > "$HOME/.bun/bin/bun"
chmod 755 "$HOME/.bun/bin/bun"
echo "installer bun $v" >> "$FAKE/state/log"
`,
  herdr: `mkdir -p "$HOME/.local/bin"
printf '%s\\n' '#!/bin/sh' 'case "$1" in' '  --version) echo "herdr \${FAKE_HERDR_VERSION:-0.9.5}" ;;' '  *) echo "herdr $*" >> "$FAKE/state/log" ;;' 'esac' > "$HOME/.local/bin/herdr"
chmod 755 "$HOME/.local/bin/herdr"
echo "installer herdr" >> "$FAKE/state/log"
`,
  claude: `[ -z "\${FAKE_CLAUDE_FAIL:-}" ] || { echo "claude: the install failed" >&2; exit 1; }
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/claude"
printf '%s\\n' '#!/bin/sh' 'echo "2.1.0 (Claude Code)"' > "$HOME/.local/share/claude/claude"
chmod 755 "$HOME/.local/share/claude/claude"
cp "$HOME/.local/share/claude/claude" "$HOME/.local/bin/claude"
echo "installer claude" >> "$FAKE/state/log"
`,
}

export interface FakeRoot {
  /** The root, with forward slashes (what the rewritten scripts name). */
  R: string
  /** A root script rewritten into this root, run as sshd's admin would run it; its output lines and code. */
  run(script: string, env?: Record<string, string>): { lines: string[]; code: number | null; err: string }
  /** The same without blocking, so runs in separate roots go on side by side (sh is slow to start processes on Windows). */
  runAsync(script: string, env?: Record<string, string>): Promise<{ lines: string[]; code: number | null; err: string }>
  /** The same, its output read by a connection that goes after `after` lines (an admin's ssh that dropped). */
  runCut(script: string, after: number, env?: Record<string, string>): Promise<number | null>
  /** Every file under the root's etc/, with its contents: what a run left there. */
  etc(): Record<string, string>
  /** The same under home/ (the node's install). */
  home(): Record<string, string>
  passwd(): string
  log(): string
  /** How many times a run wrote Apply's record. */
  records(): number
  /** A file of the root, by its path on the server (/etc/ssh/sshd_config…). */
  path(serverPath: string): string
}

const STOCK_INCLUDE = (R: string) =>
  `# stock\nInclude ${R}/etc/ssh/sshd_config.d/*.conf\n\nPort 22\nPasswordAuthentication no\nUsePAM yes\n\nMatch Group sftponly\n    ForceCommand internal-sftp\n`
const STOCK_PLAIN =
  '# stock\nPort 22\nPasswordAuthentication no\nUsePAM yes\n\nMatch Group sftponly\n    ForceCommand internal-sftp\n'

/**
 * `node`: also what the node's install reads and fetches (core/node-plan.ts): /etc/os-release of an
 * Ubuntu 24.04, /proc/meminfo of 8 GB, /home, a running systemd, and the installers.
 */
export function fakeRoot(mode: 'include' | 'plain', opts: { node?: boolean } = {}): FakeRoot {
  const dir = mkdtempSync(join(tmpdir(), 'board-fake-root-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  // the scripts' own spelling of the root: /c/Users/… on Windows (sh's PATH splits at the colon of C:/)
  const R = dir.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, d: string) => `/${d.toLowerCase()}/`)
  for (const d of ['bin', 'state', 'etc/ssh', 'var/lib', 'run']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'state', 'log'), '')
  writeFileSync(join(dir, 'state', 'passwd'), 'admin:x:1000:1000:Admin:/home/admin:/bin/bash\n')
  writeFileSync(join(dir, 'state', 'group'), '')
  for (const [name, text] of Object.entries(SHIMS)) {
    writeFileSync(join(dir, 'bin', name), text)
    chmodSync(join(dir, 'bin', name), 0o755)
  }
  if (opts.node) {
    for (const d of [
      'home',
      'proc',
      'var/tmp',
      'installers',
      'run/systemd/system',
      'run/user',
      'var/lib/systemd/linger',
    ])
      mkdirSync(join(dir, d), { recursive: true })
    writeFileSync(join(dir, 'etc', 'os-release'), 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n')
    writeFileSync(
      join(dir, 'proc', 'meminfo'),
      'MemTotal:        8148000 kB\nMemAvailable:    7300000 kB\nSwapTotal:       0 kB\n',
    )
    for (const [name, text] of Object.entries(INSTALLERS)) writeFileSync(join(dir, 'installers', name), text)
  }
  if (mode === 'include') {
    mkdirSync(join(dir, 'etc', 'ssh', 'sshd_config.d'))
    writeFileSync(join(dir, 'etc', 'ssh', 'sshd_config'), STOCK_INCLUDE(R))
    writeFileSync(join(dir, 'etc', 'ssh', 'sshd_config.d', '50-cloud-init.conf'), 'PasswordAuthentication yes\n')
  } else writeFileSync(join(dir, 'etc', 'ssh', 'sshd_config'), STOCK_PLAIN)
  const prep = (script: string): string =>
    script
      .replaceAll('/etc/', `${R}/etc/`)
      .replaceAll('/var/lib/agent-board-backup', `${R}/var/lib/agent-board-backup`)
      .replaceAll('/run/sshd', `${R}/run/sshd`)
      .replaceAll('/home/agent-board', `${R}/home/agent-board`)
      .replaceAll('/var/lib/systemd/', `${R}/var/lib/systemd/`)
      .replaceAll('/run/systemd/', `${R}/run/systemd/`)
      .replaceAll('/run/user/', `${R}/run/user/`)
      .replaceAll('/proc/meminfo', `${R}/proc/meminfo`)
      .replaceAll('/var/tmp/', `${R}/var/tmp/`)
      .replaceAll('/run/agent-board-node.lock', `${R}/run/agent-board-node.lock`)
      .replace(/^PATH=\/usr\/local\/sbin.*export PATH$/gm, `PATH=${R}/bin:/usr/bin:/bin; export PATH`)
  let n = 0
  const file = (script: string): string => {
    const f = join(dir, `script-${++n}.sh`)
    writeFileSync(f, prep(script))
    return f
  }
  // REAL_BUN: the node's stand-in Bun runs `bun -e` with this one
  const env = (extra: Record<string, string>) => ({
    ...process.env,
    FAKE: R,
    SUDO_USER: 'admin',
    REAL_BUN: process.execPath.replaceAll('\\', '/'),
    ...extra,
  })
  const walk = (d: string, out: Record<string, string>): Record<string, string> => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else out[p.slice(dir.length).replaceAll('\\', '/')] = readFileSync(p, 'utf8')
    }
    return out
  }
  return {
    R,
    run(script, extra = {}) {
      const r = spawnSync(sh as string, [file(script)], { env: env(extra), encoding: 'utf8' })
      return { lines: r.stdout.split(/\r?\n/), code: r.status, err: r.stderr }
    },
    runAsync(script, extra = {}) {
      return new Promise(resolve => {
        const child = spawn(sh as string, [file(script)], { env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] })
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => void out.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => void err.push(chunk))
        child.on('error', e => resolve({ lines: [], code: null, err: String(e) }))
        child.on('close', code =>
          resolve({ lines: Buffer.concat(out).toString().split(/\r?\n/), code, err: Buffer.concat(err).toString() }),
        )
      })
    },
    runCut(script, after, extra = {}) {
      return new Promise(resolve => {
        const child = spawn(sh as string, [file(script)], { env: env(extra), stdio: ['ignore', 'pipe', 'ignore'] })
        let lines = 0
        child.stdout.on('data', (chunk: Buffer) => {
          lines += chunk.toString().split('\n').length - 1
          if (lines >= after) child.stdout.destroy()
        })
        child.on('close', code => resolve(code))
      })
    },
    records: () => {
      try {
        return Number(readFileSync(join(dir, 'state', 'records'), 'utf8').trim()) || 0
      } catch {
        return 0
      }
    },
    etc: () => walk(join(dir, 'etc'), {}),
    home: () => (existsSync(join(dir, 'home')) ? walk(join(dir, 'home'), {}) : {}),
    passwd: () => readFileSync(join(dir, 'state', 'passwd'), 'utf8'),
    log: () => readFileSync(join(dir, 'state', 'log'), 'utf8'),
    path: serverPath => join(dir, serverPath),
  }
}

export const exists = existsSync
