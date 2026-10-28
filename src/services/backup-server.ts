// Setting up the owner's server as a backup target (#233), through the owner's admin connection
// as the tunnel's setup does (core/server-admin.ts): Look (the admin's sudo, then a script as root
// that changes nothing), Apply and Undo (core/backup-server.ts), and "Do it myself" (the Apply
// script to run by hand, then Test). The admin logs in with a key (ssh's own, the agent's, or the
// one named), as the tunnel's does without a password; sudo's password, when sudo asks one, comes
// with the request, goes to ssh's stdin once, and is kept nowhere. The board's own drop key is
// made on the first Look (adapters/backup-store.ts dropKey). Only the local board reaches this.
import { existsSync, readFileSync } from 'node:fs'
import { dropKey } from '../adapters/backup-store.ts'
import { editBackup } from '../adapters/config-file.ts'
import { generateKey, hostKeyPinned, knownHostsReady, type spawnRemote, sshBin } from '../adapters/ssh.ts'
import { backupConfig, type ServerTarget } from '../core/backup.ts'
import {
  applyScript,
  type BackupLook,
  doItMyself,
  lookScript,
  lookVerdict,
  RUN_TIMEOUT_MS,
  type RunOutcome,
  readLook,
  readRun,
  undoScript,
} from '../core/backup-server.ts'
import { t } from '../core/lang.ts'
import { adminHint, adminProblems, adminSshArgs, PROBE_SCRIPT, readProbe, remoteCommand } from '../core/server-admin.ts'
import type { SudoMode } from '../core/server-view.ts'
import type { Config } from '../core/types.ts'
import { resetTarget, type TestReport, testTarget } from './backup.ts'

export interface BackupServerDeps {
  cfg: () => Config
  spawn: typeof spawnRemote
  ssh?: () => string | null
  pinned?: (host: string, port: number) => Promise<boolean>
}

export type ServerAnswer =
  | { ok: true; look?: BackupLook; run?: RunOutcome; test?: TestReport }
  | { ok: false; error: string; look?: BackupLook; run?: RunOutcome }

const PROBE_MS = 30_000
const MASK = '••••'

/** The drop key's public half, made on first need. */
export async function dropPublicKey(): Promise<{ ok: true; publicKey: string } | { ok: false; error: string }> {
  if (!existsSync(dropKey()) || !existsSync(`${dropKey()}.pub`)) {
    const made = await generateKey('agent-board backup', dropKey())
    if (!made.ok) return made
    return made
  }
  return { ok: true, publicKey: readFileSync(`${dropKey()}.pub`, 'utf8').trim() }
}

export function createBackupServer(d: BackupServerDeps) {
  let busy = false
  const server = (): ServerTarget | null => backupConfig(d.cfg().backup).server

  /** One ssh as the admin: its stdout and stderr lines, and how it ended. */
  async function hear(s: ServerTarget, command: string, stdin: string | null, ms: number, pin: boolean) {
    const bin = (d.ssh ?? sshBin)()
    if (!bin)
      return { code: null as number | null, error: 'ENOENT' as string | null, out: [] as string[], err: [] as string[] }
    const args = adminSshArgs({
      conf: { host: s.host, sshPort: s.port },
      admin: s.admin,
      knownHosts: knownHostsReady(),
      command,
      ...(pin && { pin }),
    })
    const run = d.spawn(bin, args, stdin, ms)
    const out: string[] = []
    const err: string[] = []
    run.onLine((line, from) => (from === 'err' ? err : out).push(line))
    const end = await run.done
    return { code: end.code, error: end.error, out, err }
  }

  /** Why an ssh failed, in the admin hints' words (server.hint.*), else its last lines; a password masked. */
  function why(
    h: { code: number | null; error: string | null; err: string[]; out: string[] },
    s: ServerTarget,
    secret: string | null,
  ): string {
    if (h.error === 'ENOENT') return t('backup.err.noSsh')
    const hint = adminHint(h.err)
    const lines = [...h.err, ...h.out.filter(l => l.startsWith('@@fail '))].slice(-4)
    const said = lines.map(l => (secret ? l.replaceAll(secret, MASK) : l)).join('\n')
    const timeout = h.error === 'timeout' ? t('server.err.timeout') : ''
    const hinted =
      hint && hint !== 'changed' && hint !== 'busy' ? t(`server.hint.${hint}`, { admin: s.admin.user }) : ''
    return [hinted, timeout, said].filter(Boolean).join('\n') || t('backup.err.sshFailed', { code: String(h.code) })
  }

  /** The admin's sudo (the probe, which also pins the server's key on the first login), or why not. */
  async function sudoOf(
    s: ServerTarget,
    sudoPassword: string | null,
  ): Promise<{ mode: SudoMode; stdin: string | null } | { error: string }> {
    const problems = adminProblems(s.admin)
    if (problems.length) return { error: problems.map(p => p.message).join('\n') }
    const pinned = await (d.pinned ?? hostKeyPinned)(s.host, s.port)
    const probe = await hear(s, remoteCommand(PROBE_SCRIPT, 'root'), null, PROBE_MS, !pinned)
    const read = probe.code === 0 ? readProbe(probe.out) : null
    if (!read) return { error: why(probe, s, null) }
    if (read.mode === 'requiretty' || read.mode === 'none')
      return { error: t(`server.hint.${read.mode === 'none' ? 'notSudoer' : 'requiretty'}`, { admin: s.admin.user }) }
    if (read.mode === 'password' && !sudoPassword)
      return { error: t('server.hint.needPassword', { admin: s.admin.user }) }
    return { mode: read.mode, stdin: read.mode === 'password' ? `${sudoPassword}\n` : null }
  }

  /** A script as root through the admin, its lines; the one at a time rule held by the caller. */
  async function asRoot(s: ServerTarget, script: string, sudoPassword: string | null) {
    const sudo = await sudoOf(s, sudoPassword)
    if ('error' in sudo) return { error: sudo.error }
    const h = await hear(s, remoteCommand(script, sudo.mode), sudo.stdin, RUN_TIMEOUT_MS, false)
    return { h }
  }

  async function once<T>(fn: () => Promise<T>): Promise<T | ServerAnswer> {
    if (busy) return { ok: false, error: t('backup.err.busy') }
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  return {
    /** Look: what the server has of the board's backup, and whether Apply can go on; changes nothing there. */
    look: (sudoPassword: string | null = null): Promise<ServerAnswer> =>
      once(async (): Promise<ServerAnswer> => {
        const s = server()
        if (!s) return { ok: false, error: t('backup.err.noServer') }
        const key = await dropPublicKey()
        if (!key.ok) return { ok: false, error: t('backup.err.keygen', { detail: key.error }) }
        const r = await asRoot(s, lookScript(key.publicKey), sudoPassword)
        if ('error' in r) return { ok: false, error: r.error }
        const look = r.h.code === 0 ? readLook(r.h.out) : null
        if (!look) return { ok: false, error: why(r.h, s, sudoPassword) }
        const verdict = lookVerdict(look)
        return verdict.ok ? { ok: true, look } : { ok: false, look, error: t(verdict.key, verdict.vars) }
      }),

    /** Apply, then a Test of the drop with a real snapshot; the target is set once both went through. */
    apply: (sudoPassword: string | null = null): Promise<ServerAnswer> =>
      once(async (): Promise<ServerAnswer> => {
        const s = server()
        if (!s) return { ok: false, error: t('backup.err.noServer') }
        const key = await dropPublicKey()
        if (!key.ok) return { ok: false, error: t('backup.err.keygen', { detail: key.error }) }
        const r = await asRoot(s, applyScript(key.publicKey), sudoPassword)
        if ('error' in r) return { ok: false, error: r.error }
        const run = readRun(r.h.out)
        if (!run.ok) return { ok: false, run, error: run.fail ?? why(r.h, s, sudoPassword) }
        resetTarget('server')
        const test = await testTarget('server', d.cfg())
        if (!test.ok) return { ok: false, run, error: t('backup.err.testAfterApply', { detail: test.error ?? '' }) }
        const set = editBackup({ serverSet: new Date().toISOString() })
        if (!set.ok) return { ok: false, run, error: set.error }
        return { ok: true, run, test }
      }),

    /** Undo of what Apply's record says it made; the snapshots stay on the server. */
    undo: (sudoPassword: string | null = null): Promise<ServerAnswer> =>
      once(async (): Promise<ServerAnswer> => {
        const s = server()
        if (!s) return { ok: false, error: t('backup.err.noServer') }
        const r = await asRoot(s, undoScript(), sudoPassword)
        if ('error' in r) return { ok: false, error: r.error }
        const run = readRun(r.h.out)
        if (!run.ok) return { ok: false, run, error: run.fail ?? why(r.h, s, sudoPassword) }
        editBackup({ serverSet: null })
        resetTarget('server')
        return { ok: true, run }
      }),

    /** "Do it myself": the Apply script with the board's key in it, to run as root by hand. */
    async manual(): Promise<{ ok: true; file: string; script: string; run: string } | { ok: false; error: string }> {
      const key = await dropPublicKey()
      if (!key.ok) return { ok: false, error: t('backup.err.keygen', { detail: key.error }) }
      return { ok: true, ...doItMyself(key.publicKey) }
    },

    /** After "Do it myself": a Test, and the target set when it went through. */
    confirmManual: (): Promise<ServerAnswer> =>
      once(async (): Promise<ServerAnswer> => {
        if (!server()) return { ok: false, error: t('backup.err.noServer') }
        resetTarget('server')
        const test = await testTarget('server', d.cfg())
        if (!test.ok) return { ok: false, error: test.error ?? t('backup.err.sshFailed', { code: '?' }) }
        const set = editBackup({ serverSet: new Date().toISOString() })
        return set.ok ? { ok: true, test } : { ok: false, error: set.error }
      }),

    isBusy: () => busy,
  }
}

export type BackupServer = ReturnType<typeof createBackupServer>
