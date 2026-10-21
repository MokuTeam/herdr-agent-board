// The wake process (src/entrypoints/wake.ts) in a child process, against a sandbox's fake herdr:
// the board's config.json written with a wake section on a port of the test's, never wake's own
// (12421) nor the web board's (12422). wakeSandbox() ends every such process before the sandbox's
// folder goes, so none writes there while it is removed.
import { onTestFinished } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { root, type Sandbox, sandbox } from './sandbox.ts'

export const WAKE_ENTRY = join(root, 'src', 'entrypoints', 'wake.ts')

/** How long a wake process has to answer GET /status. */
const UP_WITHIN_MS = 10_000

/** The stops of the processes running in this test, ended before its sandbox goes. */
const running = new Set<() => Promise<void>>()

/** A sandbox whose cleanup first ends what startWakeProcess (or endWithSandbox) started in the test. */
export async function wakeSandbox(): Promise<Sandbox> {
  let removeDir: (() => void | Promise<void>) | undefined
  onTestFinished(async () => {
    for (const stop of [...running]) await stop()
    await removeDir?.()
  })
  return sandbox({
    after: fn => {
      removeDir = fn
    },
  })
}

/** A process the test started (the old router, say), ended before the sandbox goes. */
export function endWithSandbox(proc: Bun.Subprocess): () => Promise<void> {
  const stop = async (): Promise<void> => {
    running.delete(stop)
    if (proc.exitCode === null && proc.signalCode === null) proc.kill()
    await proc.exited
  }
  running.add(stop)
  return stop
}

/** The board's config.json in the sandbox: an object as JSON, or the text as it is (a broken file). */
export function writeBoardConfig(box: Sandbox, raw: Record<string, unknown> | string): void {
  const file = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))
}

/** The board's config with wake on at `port`: the web board on port 9, English, then `config`, then the wake section. */
export function wakeOnConfig(
  port: number,
  o: { wake?: Record<string, unknown>; config?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return { language: 'en', port: 9, ...o.config, wake: { enabled: true, ...o.wake, port } }
}

/** A child with its output read as it comes, so a full pipe never holds it up. */
export interface Spawned {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  /** What it printed so far. */
  output(): { stdout: string; stderr: string }
  /** Its IPC messages. */
  messages: unknown[]
}

/** `bun src/entrypoints/wake.ts …args` with the sandbox's env (and `env` on top), with an IPC channel. */
export function spawnWake(box: Sandbox, args: string[] = [], env: Record<string, string> = {}): Spawned {
  const messages: unknown[] = []
  const proc = Bun.spawn([process.execPath, WAKE_ENTRY, ...args], {
    cwd: root,
    env: { ...box.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ipc: message => {
      messages.push(message)
    },
  })
  const out = { stdout: '', stderr: '' }
  const drain = async (stream: ReadableStream<Uint8Array>, key: 'stdout' | 'stderr'): Promise<void> => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) out[key] += decoder.decode(chunk, { stream: true })
  }
  void drain(proc.stdout, 'stdout')
  void drain(proc.stderr, 'stderr')
  return { proc, output: () => ({ ...out }), messages }
}

/** Whether something answers GET <url>/status with a 200 within a second. */
async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/status`, { signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

/**
 * The wake process on `o.port` (refused: 12421, 12422), the board's config.json written first with
 * the wake section on (`o.wake` over `enabled: true`, the port always `o.port`) and `o.config`'s
 * fields; resolves once GET /status answers (10 s at most), throws with its output when it ends or
 * does not answer by then. `env`: the test's own on top of the sandbox's (BOARD_WAKE_ROUND_MS, say).
 */
export async function startWakeProcess(
  box: Sandbox,
  o: {
    port: number
    wake?: Record<string, unknown>
    config?: Record<string, unknown>
    env?: Record<string, string>
  },
): Promise<{
  url: string
  proc: Bun.Subprocess
  messages: unknown[]
  output(): { stdout: string; stderr: string }
  stop(): Promise<void>
}> {
  if (o.port === 12421 || o.port === 12422)
    throw new Error(`port ${o.port} is wake's or the board's own: a test takes an unused one (unusedPort)`)
  writeBoardConfig(box, wakeOnConfig(o.port, o))
  const child = spawnWake(box, [], o.env)
  const stop = endWithSandbox(child.proc)
  onTestFinished(stop)
  const url = `http://127.0.0.1:${o.port}`
  const deadline = Date.now() + UP_WITHIN_MS
  while (!(await answers(url))) {
    if (child.proc.exitCode !== null || Date.now() > deadline) {
      await stop()
      const { stdout, stderr } = child.output()
      throw new Error(`the wake process did not answer on ${url} (exit ${child.proc.exitCode}):\n${stdout}${stderr}`)
    }
    await Bun.sleep(25)
  }
  return { url, proc: child.proc, messages: child.messages, output: child.output, stop }
}
