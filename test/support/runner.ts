// Invoked only by tests with an explicit temporary HOME and the compiled fake herdr
// (HERDR_BIN_PATH, set by the sandbox).
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Config, Item } from '../../src/core/types.ts'

export type RunnerMode = 'open' | 'send' | 'answer' | 'server' | 'cli' | 'scheduler' | 'write'

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
  await import('../../src/open.mjs')
} else if (mode === 'send') {
  const { send: sendText } = await import('../../src/services/actions.ts')
  const { defaultDeps } = await import('../../src/services/deps.ts')
  const { item, cfg, text } = input()
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
  const { startServer } = await import('../../src/server.mjs')
  const cfg = input<{ language?: string }>()
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  if (cfg.language) (await import('../../src/core/lang.ts')).useLanguage(cfg.language)
  const server = await startServer({ cfg, log: (...args: unknown[]) => send({ log: args[0] }) } as Parameters<
    typeof startServer
  >[0])
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
  process.argv = [process.argv[0] ?? '', fileURLToPath(new URL('../../src/cli.mjs', import.meta.url)), ...args]
  await import('../../src/cli.mjs')
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
} else {
  throw new Error(`Unknown test mode: ${mode}`)
}
