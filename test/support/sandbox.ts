import { onTestFinished } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeHerdrBin } from './fake-herdr-bin.ts'
import type { RunnerMode } from './runner.ts'

export type { RunnerMode }

export const root = fileURLToPath(new URL('../../', import.meta.url))
const runner = fileURLToPath(new URL('./runner.ts', import.meta.url))

export type ChildResult = { code: number | null; stdout: string; stderr: string }
export type Child = {
  messages: unknown[]
  exited: Promise<ChildResult>
  send(message: unknown): void
  kill(): void
}
export type Sandbox = {
  dir: string
  env: Record<string, string>
  state(value: unknown): void
  calls(): string[][]
  run(mode: RunnerMode, input?: unknown, extra?: Record<string, string>): Child
  open(background?: boolean): Child
  cards: string
}
/** What node:test passes as `t`: somewhere to register cleanup. */
export type Registrar = { after(fn: () => void | Promise<void>): void }

/**
 * A temp HOME with the fake herdr wired in. Cleanup (kill live children, wait for them, remove
 * the dir) runs after the test: through `t.after` for a node:test test, through bun:test's
 * onTestFinished when called without `t`.
 */
export async function sandbox(t?: Registrar): Promise<Sandbox> {
  const herdr = await fakeHerdrBin()
  const dir = mkdtempSync(join(tmpdir(), 'board-regression-'))
  const children: { proc: Bun.Subprocess; child: Child }[] = []
  const home = join(dir, 'home')
  const config = join(dir, 'config')
  const localState = join(dir, 'state')
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: config,
    LOCALAPPDATA: localState,
    TMPDIR: dir,
    TMP: dir,
    TEMP: dir,
    PATH: dirname(process.execPath),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HERDR_BIN_PATH: herdr,
    FAKE_HERDR_STATE: join(dir, 'fake.json'),
    FAKE_HERDR_LOG: join(dir, 'calls.jsonl'),
  }
  for (const path of [home, config, localState]) mkdirSync(path, { recursive: true })
  writeFileSync(env.FAKE_HERDR_LOG as string, '')

  const cleanup = async (): Promise<void> => {
    for (const { proc } of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill()
    await Promise.all(children.map(({ child }) => child.exited))
    // A herdr call the server started just before it was stopped outlives it by a moment and can
    // write its log here again while the folder goes (ENOTEMPTY): remove the whole tree again
    // until that call is done. (rmSync's own maxRetries only retries the last rmdir.)
    for (let tries = 1; ; tries++) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        break
      } catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : null
        if (code !== 'ENOTEMPTY' || tries >= 40) throw err
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }
  if (t) t.after(cleanup)
  else onTestFinished(cleanup)

  // `extra`: environment a test needs on top (git on PATH for a worktree, say).
  function spawnChild(args: string[], input?: unknown, extra: Record<string, string> = {}): Child {
    const messages: unknown[] = []
    const signals = join(dir, `signals-${children.length}.jsonl`)
    const childEnv: Record<string, string> = { ...env, ...extra, TEST_SIGNALS: signals }
    if (input !== undefined) childEnv.TEST_INPUT = JSON.stringify(input)
    const proc = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      env: childEnv,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ipc: message => {
        messages.push(message)
      },
    })
    // Messages a blocked child wrote to its signal file (see runner.ts) join the IPC ones.
    let read = 0
    const drain = (): void => {
      if (!existsSync(signals)) return
      const lines = readFileSync(signals, 'utf8').split('\n').filter(Boolean)
      for (; read < lines.length; read++) messages.push(JSON.parse(lines[read] as string))
    }
    const poll = setInterval(drain, 5)
    const exited = (async (): Promise<ChildResult> => {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      clearInterval(poll)
      drain()
      return { code: proc.exitCode, stdout, stderr }
    })()
    const child: Child = {
      messages,
      exited,
      send: message => proc.send(message),
      kill: () => proc.kill(),
    }
    children.push({ proc, child })
    return child
  }

  return {
    dir,
    env,
    state(value) {
      writeFileSync(env.FAKE_HERDR_STATE as string, JSON.stringify(value))
    },
    calls() {
      return readFileSync(env.FAKE_HERDR_LOG as string, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as string[])
    },
    run(mode, input, extra) {
      return spawnChild([runner, mode], input, extra)
    },
    open(background = false) {
      return spawnChild([runner, 'open', ...(background ? ['--background'] : [])])
    },
    cards: join(localState, 'herdr/plugins/agent-board/cards'),
  }
}

export async function until(fn: () => unknown, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test fixture')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
