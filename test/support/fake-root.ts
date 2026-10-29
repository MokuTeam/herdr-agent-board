// A server's root for the backup's root scripts (core/backup-server.ts Look, Apply, Undo), in a
// temp folder: shims for id, getent, useradd, usermod, userdel, chown, install, systemctl and
// sshd, an /etc/ssh with sshd_config (and sshd_config.d, or none), and the scripts' paths rewritten
// into it. The shims prove the scripts' own flow (steps, rollback, the record, what Undo leaves),
// not sshd's semantics: their sshd reads the config's Match block for the backup user and answers
// -t and -T -C from it. SWALLOW: another block takes the user's ForceCommand; LEAK: the fence leaks
// into root's settings; ALLOWUSERS: an AllowUsers that leaves the backup user out; BROKEN in the
// config: sshd -t refuses it. Brought over from the review of #234 (its sim/setup.sh and prep.sh).
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
   else
     echo "authorizedkeysfile .ssh/authorized_keys"
     if [ -n "\${LEAK:-}" ] && eff | grep -q '^Match User agent-board-backup'; then echo "forcecommand leaked"; fi
   fi
   exit 0;;
esac
exit 0
`,
}

export interface FakeRoot {
  /** The root, with forward slashes (what the rewritten scripts name). */
  R: string
  /** A root script rewritten into this root, run as sshd's admin would run it; its output lines and code. */
  run(script: string, env?: Record<string, string>): { lines: string[]; code: number | null; err: string }
  /** The same, its output read by a connection that goes after `after` lines (an admin's ssh that dropped). */
  runCut(script: string, after: number, env?: Record<string, string>): Promise<number | null>
  /** Every file under the root's etc/, with its contents: what a run left there. */
  etc(): Record<string, string>
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

export function fakeRoot(mode: 'include' | 'plain'): FakeRoot {
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
      .replace(/^PATH=\/usr\/local\/sbin.*export PATH$/gm, `PATH=${R}/bin:/usr/bin:/bin; export PATH`)
  let n = 0
  const file = (script: string): string => {
    const f = join(dir, `script-${++n}.sh`)
    writeFileSync(f, prep(script))
    return f
  }
  const env = (extra: Record<string, string>) => ({ ...process.env, FAKE: R, SUDO_USER: 'admin', ...extra })
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
    passwd: () => readFileSync(join(dir, 'state', 'passwd'), 'utf8'),
    log: () => readFileSync(join(dir, 'state', 'log'), 'utf8'),
    path: serverPath => join(dir, serverPath),
  }
}

export const exists = existsSync
