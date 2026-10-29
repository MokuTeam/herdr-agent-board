// A stand-in for ssh to the backup user (adapters/backup-ssh.ts), compiled into an executable
// (fake-herdr-bin.ts compileFake) for BOARD_SSH_BIN_PATH: it runs the real drop script
// (core/backup-server.ts) here, under FAKE_DROP_SH, as sshd's ForceCommand would on the server,
// with the remote command (ssh's last argument) in SSH_ORIGINAL_COMMAND and stdin, stdout and
// stderr passed through. Each call's arguments go to FAKE_DROP_LOG, one JSON line each.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.FAKE_DROP_LOG
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`)
if (process.env.FAKE_DROP_REFUSE) {
  process.stderr.write('agent-board-backup@example.org: Permission denied (publickey).\n')
  process.exit(255)
}
const command = args.at(-1) ?? ''
let input: Buffer
try {
  input = readFileSync(0)
} catch {
  input = Buffer.alloc(0)
}
const r = spawnSync(process.env.FAKE_DROP_SH ?? 'sh', [process.env.FAKE_DROP_SCRIPT ?? ''], {
  input,
  env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
  maxBuffer: 128 * 1024 * 1024,
})
// synchronously: an exit right after an async write may cut a snapshot short
const out = (fd: number, b: Buffer | null): void => {
  for (let at = 0; b && at < b.length; ) at += writeSync(fd, b, at)
}
out(1, r.stdout)
out(2, r.stderr)
process.exit(r.status ?? 255)
