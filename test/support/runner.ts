// Invoked only by tests with an explicit temporary HOME and the compiled fake herdr
// (HERDR_BIN_PATH, set by the sandbox).
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Config, Item } from '../../src/core/types.ts'

export type RunnerMode = 'open' | 'send' | 'answer' | 'server' | 'cli' | 'scheduler' | 'write' | 'detached' | 'wake-io'

// The input a test handed over: each mode reads the fields its test wrote.
type RunnerInput = {
  kind: string
  item: Item & { pane: string }
  cfg: Config
  text: string
  body: unknown
  args: string[]
  env: Record<string, string>
  key: string
  patch: Record<string, unknown>
  release?: string
  failPatch?: boolean
}
const input = <T = RunnerInput>(): T => JSON.parse(process.env.TEST_INPUT ?? 'null') as T
const send = (message: unknown): void => {
  if (!process.send) throw new Error('Runner started without an IPC channel')
  process.send(message)
}

// Bun delivers process.send only once the event loop is free, so a child that blocks (the write
// mode waits on locks and gates synchronously) signals through a file the sandbox polls.
const signal = (message: unknown): void => {
  appendFileSync(process.env.TEST_SIGNALS ?? '', `${JSON.stringify(message)}\n`)
}

const mode = process.argv[2]
if (mode === 'open') {
  await import('../../src/entrypoints/open.ts')
} else if (mode === 'send') {
  const { send: sendText } = await import('../../src/services/actions.ts')
  const { defaultDeps } = await import('../../src/services/deps.ts')
  const { item, cfg, text } = input()
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  if (cfg.language) (await import('../../src/core/lang.ts')).useLanguage(cfg.language)
  console.log(JSON.stringify(await sendText(defaultDeps(cfg), item, text)))
} else if (mode === 'answer') {
  // services/answer.ts against the fake herdr: a question form, a permission prompt, or one own answer typed.
  const { answerPermission, answerQuestions, paneIO } = await import('../../src/services/answer.ts')
  const { defaultClaudeHome } = await import('../../src/adapters/claude-home.ts')
  const { useLanguage } = await import('../../src/core/lang.ts')
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  const { kind, item, body, text } = input()
  const out =
    kind === 'text'
      ? await paneIO(item.pane).text(text)
      : kind === 'permit'
        ? await answerPermission(item, body)
        : await answerQuestions({ claude: defaultClaudeHome() }, item, body)
  console.log(JSON.stringify(out ?? null))
} else if (mode === 'server') {
  const { startServer } = await import('../../src/server/app.ts')
  const { defaultDeps } = await import('../../src/services/deps.ts')
  const given = input<Config>()
  // TEST_LIVE_CONFIG: the config.json the test wrote, read again as it changes (as
  // entrypoints/server.ts has it); each reload is signalled. The port is still the one handed in.
  const live = !!process.env.TEST_LIVE_CONFIG
  const { liveConfig, readConfigFile } = await import('../../src/adapters/config-file.ts')
  // Wake stays off in the board's tests unless the test turns it on (with a port of its own): a
  // config without a `wake` key takes the one in the config.json the test wrote, else `false`, so
  // no test of the board ever asks 127.0.0.1:12421.
  const wakeKept = (c: Config): void => {
    if (Object.hasOwn(c, 'wake')) return
    const onDisk = readConfigFile()
    c.wake = onDisk && Object.hasOwn(onDisk, 'wake') ? onDisk.wake : false
  }
  let refresh = (): void => {}
  const cfg = live
    ? liveConfig(reloaded => {
        wakeKept(reloaded)
        send({ reloaded: true })
        refresh()
      })
    : given
  wakeKept(cfg)
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  if (cfg.language) (await import('../../src/core/lang.ts')).useLanguage(cfg.language)
  // TEST_PROBE_MS: herdr-wake's /status may take that long in the setup check (1.5 s by default).
  const probeMs = Number(process.env.TEST_PROBE_MS) || undefined
  const { gatherFacts } = await import('../../src/adapters/setup-facts.ts')
  const deps = defaultDeps(cfg, text => send({ log: text }))
  const server = await startServer({
    deps,
    ...(live && { port: Number(given.port) }),
    ...(probeMs && { gather: () => gatherFacts(deps.cfg, { probeMs }) }),
    // Never a real wake start: each one is told to the test.
    wakeStarter: (args = []) => send({ wakeStarted: args }),
  })
  refresh = () => void server.refresh()
  send({ ready: true })
  process.on('message', async message => {
    if (message === 'refresh') {
      await server.refresh()
      send({ refreshed: true })
    }
  })
} else if (mode === 'cli') {
  // The board command as an agent runs it: its session's env, herdr answered by the fake.
  const { args, env } = input()
  Object.assign(process.env, env)
  process.argv = [
    process.argv[0] ?? '',
    fileURLToPath(new URL('../../src/entrypoints/cli.ts', import.meta.url)),
    ...args,
  ]
  await import('../../src/entrypoints/cli.ts')
} else if (mode === 'scheduler') {
  const { useLanguage } = await import('../../src/core/lang.ts')
  const { startScheduler } = await import('../../src/services/scheduler.ts')
  const { defaultDeps } = await import('../../src/services/deps.ts')
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  startScheduler({ deps: defaultDeps(input(), (text: string) => send({ log: text })) })
  send({ ready: true })
} else if (mode === 'write') {
  const { existsSync } = await import('node:fs')
  const { writeCard } = await import('../../src/adapters/cards.ts')
  const { key, patch, release, failPatch } = input()
  if (release) {
    Object.defineProperty(patch, 'held', {
      enumerable: true,
      get() {
        signal({ held: true })
        const deadline = Date.now() + 5000
        const pause = new Int32Array(new SharedArrayBuffer(4))
        while (!existsSync(release)) {
          if (Date.now() > deadline) throw new Error('Write gate timed out')
          Atomics.wait(pause, 0, 0, 10)
        }
        return true
      },
    })
  }
  if (failPatch) {
    Object.defineProperty(patch, 'bad', {
      enumerable: true,
      get() {
        throw new Error('patch failed')
      },
    })
  }
  signal({ attempting: true })
  try {
    writeCard(key, patch)
    signal({ done: true })
  } catch (err) {
    signal({ error: err instanceof Error ? err.message : String(err) })
  }
  process.disconnect?.()
} else if (mode === 'detached') {
  // A program started on its own (detached, as a launcher or a MokuPilot call is) that would run
  // for good: both pids are told, then this one stays up beside it until it is stopped.
  const { spawn } = await import('node:child_process')
  const forever = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  send({ child: process.pid, detached: forever.pid })
  setInterval(() => {}, 1000)
} else if (mode === 'wake-io') {
  // One of wake's herdr calls (adapters/wake-herdr.ts) against the fake herdr; its result printed.
  const { cliWakeHerdr } = await import('../../src/adapters/wake-herdr.ts')
  const { method, args } = input<{ method: string; args: unknown[] }>()
  const fn: unknown = Reflect.get(cliWakeHerdr, method)
  if (typeof fn !== 'function') throw new Error(`No such wake herdr call: ${method}`)
  const out: unknown = await Reflect.apply(fn, cliWakeHerdr, args)
  console.log(JSON.stringify(out ?? null))
} else {
  throw new Error(`Unknown test mode: ${mode}`)
}
