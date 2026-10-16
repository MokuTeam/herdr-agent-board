import { createHash } from 'node:crypto'
import { type FSWatcher, readdirSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'

export interface WebBundle {
  /** Last good bundle of the web entry. */
  js(): string
  /** Hash of the bundle, every web/**\/*.css and web/index.html: changes whenever the page does. */
  version(): string
  rebuild(): Promise<void>
  /** Stop watching. */
  close(): void
}

interface Options {
  root: string
  entry: string
  log: (text: string) => void
  watch?: boolean
}

function cssFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...cssFiles(path))
    else if (entry.name.endsWith('.css')) found.push(path)
  }
  return found.sort()
}

function hashOf(js: string, webDir: string): string {
  const hash = createHash('sha1').update(js)
  try {
    for (const path of [...cssFiles(webDir), join(webDir, 'index.html')]) {
      try {
        hash.update(path).update(readFileSync(path))
      } catch {}
    }
  } catch {}
  return hash.digest('hex').slice(0, 12)
}

/** Bundles the web entry in memory with Bun.build; a failed build keeps the previous bundle. */
export async function createWebBundle(opts: Options): Promise<WebBundle> {
  const webDir = join(opts.root, 'web')
  let js = ''
  let version = ''

  async function build(): Promise<void> {
    try {
      const result = await Bun.build({
        entrypoints: [opts.entry],
        target: 'browser',
        format: 'esm',
        minify: false,
        sourcemap: 'inline',
      })
      const output = result.outputs.find(o => o.kind === 'entry-point') ?? result.outputs[0]
      if (!result.success || !output) {
        opts.log(`web bundle: ${result.logs[0]?.message ?? 'build failed'}`)
        return
      }
      js = await output.text()
    } catch (err) {
      // Bun.build throws an AggregateError of the build messages when it fails.
      const first = err instanceof AggregateError ? err.errors[0] : err
      opts.log(`web bundle: ${first instanceof Error ? first.message : String(first)}`)
      return
    }
    version = hashOf(js, webDir)
  }

  // CSS and HTML changes also move the version even when the script did not build.
  async function rebuild(): Promise<void> {
    const before = js
    await build()
    if (js === before) version = hashOf(js, webDir)
  }

  await build()

  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  if (opts.watch) {
    try {
      watcher = watch(webDir, { recursive: true }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void rebuild(), 100)
      })
      watcher.on('error', () => watcher?.close())
    } catch {}
  }

  return {
    js: () => js,
    version: () => version,
    rebuild,
    close() {
      if (timer) clearTimeout(timer)
      watcher?.close()
    },
  }
}
