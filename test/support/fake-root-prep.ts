// How the fake root (fake-root.ts) spells a server's paths, apart from it so the fake ssh
// (fake-ssh.ts), a compiled program without bun:test, runs a script on the same root the same way:
// the scripts' absolute paths rewritten into the root, PATH its shims first, and a packed node run
// (core/node-setup.ts packedRun) unpacked so its paths are rewritten too.
import { gunzipSync } from 'node:zlib'

/** The root's own spelling: /c/Users/… on Windows (sh's PATH splits at the colon of C:/). */
export const rootSpelling = (dir: string): string =>
  dir.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, d: string) => `/${d.toLowerCase()}/`)

/** A root script rewritten into the root `R` (rootSpelling). */
export function prepScript(R: string, script: string): string {
  return script
    .replaceAll('/etc/', `${R}/etc/`)
    .replaceAll('/var/lib/agent-board-backup', `${R}/var/lib/agent-board-backup`)
    .replaceAll('/var/lib/agent-board-relay', `${R}/var/lib/agent-board-relay`)
    .replaceAll('/run/sshd', `${R}/run/sshd`)
    .replaceAll('/home/agent-board', `${R}/home/agent-board`)
    .replaceAll('/var/lib/systemd/', `${R}/var/lib/systemd/`)
    .replaceAll('/run/systemd/', `${R}/run/systemd/`)
    .replaceAll('/run/user/', `${R}/run/user/`)
    .replaceAll('/proc/meminfo', `${R}/proc/meminfo`)
    .replaceAll('/var/tmp/', `${R}/var/tmp/`)
    .replaceAll('/run/agent-board-node.lock', `${R}/run/agent-board-node.lock`)
    .replaceAll('/run/agent-board-relay.lock', `${R}/run/agent-board-relay.lock`)
    .replace(/^PATH=\/usr\/local\/sbin.*export PATH$/gm, `PATH=${R}/bin:/usr/bin:/bin; export PATH`)
}

/** The script a packed node run carries (gzip, then base64, after `echo`); null when it is not one. */
export function unpackNodeRun(script: string): string | null {
  const m = /^s=\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d \| gzip -dc\)/m.exec(script)
  return m ? gunzipSync(Buffer.from(m[1] ?? '', 'base64')).toString('utf8') : null
}

/** The kind of a node script by its first comment (`# agent-board: node <kind>`), or null. */
export const nodeKind = (script: string): string | null => /^# agent-board: node (\w+)$/m.exec(script)?.[1] ?? null

/** The kind of a relay script by its first comment (`# agent-board: relay <kind>`), or null. */
export const relayKind = (script: string): string | null => /^# agent-board: relay (\w+)$/m.exec(script)?.[1] ?? null
