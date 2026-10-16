import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export interface WebBundle {
  /** Last good bundle of the web entry. */
  js(): string
  /** Hash of the bundle and every other file under web/ the page loads: changes whenever the page does. */
  version(): string
  /** Builds again; calls run one after another, so the newest files make the bundle that stays. */
  rebuild(): Promise<void>
}

interface Options {
  root: string
  entry: string
  log: (text: string) => void
}

// What the page loads besides the bundle (the static route serves these types).
const ASSETS = new Set(['.html', '.css', '.svg', '.png', '.webmanifest'])

function assetFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...assetFiles(path))
    else if (ASSETS.has(extname(entry.name))) found.push(path)
  }
  return found.sort()
}

function hashOf(js: string, webDir: string): string {
  const hash = createHash('sha1').update(js)
  try {
    for (const path of assetFiles(webDir)) {
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

  // Style, page and icon changes also move the version even when the script did not build.
  async function buildAndHash(): Promise<void> {
    const before = js
    await build()
    if (js === before) version = hashOf(js, webDir)
  }

  await build()

  // One build at a time: an older one finishing last would put back an older bundle.
  let queue = Promise.resolve()
  return {
    js: () => js,
    version: () => version,
    rebuild() {
      queue = queue.then(buildAndHash)
      return queue
    },
  }
}
