import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

export interface WebBundle {
  /** Last good bundle of the web entry, naming its source map (served beside it as app.js.map). */
  js(): string
  /** The source map of that bundle: devtools load it, the page does not. */
  map(): string
  /** Last good bundle of the script the page runs before it paints (`early`), empty without one. */
  early(): string
  /**
   * A file the page loads only when it needs it, by its served name: a viewer's script or its map,
   * or a copy from a package (`viewers`, `copies`), as its last good build has it. Undefined for
   * one that never built.
   */
  file(name: string): string | Buffer<ArrayBuffer> | undefined
  /** Hash of the bundle and every other file under web/ the page loads: changes whenever the page does. */
  version(): string
  /** Builds again; calls run one after another, so the newest files make the bundle that stays. */
  rebuild(): Promise<void>
}

interface Options {
  root: string
  entry: string
  /** A classic script the page loads before its styles (the viewer's light or dark), built apart from the entry. */
  early?: string
  /**
   * Modules the page imports only when it opens such a file (the quick look's viewers: served name
   * to entry), each bundled apart: the page's own script stays as small as it was, and a viewer
   * that does not build (its package not installed) leaves the page as it is.
   */
  viewers?: Record<string, string>
  /** Files served as their package has them (a viewer's worker): served name to module. */
  copies?: Record<string, string>
  log: (text: string) => void
}

const stem = (file: string): string => basename(file, extname(file))

// The page's script names its map, served beside it (routes/static.ts), rather than carrying it:
// the map is twice the size of the script, and a phone would download it with every new build.
const mapLink = (name: string): string => `\n//# sourceMappingURL=${name}.map\n`

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

function hashOf(parts: (string | Buffer)[], webDir: string): string {
  const hash = createHash('sha1')
  for (const part of parts) hash.update(part)
  try {
    for (const path of assetFiles(webDir)) {
      try {
        hash.update(path).update(readFileSync(path))
      } catch {}
    }
  } catch {}
  return hash.digest('hex').slice(0, 12)
}

/**
 * One entry bundled in memory: a module for the page's own script, or (`iife`) a classic script
 * whose names stay inside it, nothing put on `window`. Its source map apart, or (`inline`) in it.
 * Null when it did not build (logged).
 */
async function bundle(
  entry: string,
  format: 'esm' | 'iife',
  sourcemap: 'external' | 'inline',
  log: (text: string) => void,
  names: 'kept' | 'short' = 'kept',
): Promise<{ js: string; map: string } | null> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format,
    // Spaces and syntax only, and the names kept (syntax alone drops a function expression's,
    // memo(function Card…)): the component stacks a phone sends to the board's log
    // (ErrorBoundary.tsx) still say which component failed. Identifiers stay as they are: renamed,
    // they lose the names even with keepNames. A viewer draws no components: its names go short,
    // which takes a third off a library.
    minify:
      names === 'kept'
        ? { whitespace: true, syntax: true, identifiers: false, keepNames: true }
        : { whitespace: true, syntax: true, identifiers: true },
    sourcemap,
    // React's production build: without it the page gets the development one (slower, larger,
    // and with its warnings in the console).
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const entries = result.outputs.filter(o => o.kind === 'entry-point')
  const output = entries.find(o => stem(o.path) === stem(entry)) ?? entries[0] ?? result.outputs[0]
  if (!result.success || !output) {
    log(`web bundle: ${result.logs[0]?.message ?? 'build failed'}`)
    return null
  }
  const map = result.outputs.find(o => o.kind === 'sourcemap')
  return { js: await output.text(), map: map ? await map.text() : '' }
}

// Bun.build throws an AggregateError of the build messages when it fails.
function buildMessage(err: unknown): string {
  const first = err instanceof AggregateError ? err.errors[0] : err
  return first instanceof Error ? first.message : String(first)
}

/** Bundles the web entry in memory with Bun.build; a failed build keeps the previous bundle. */
export async function createWebBundle(opts: Options): Promise<WebBundle> {
  const webDir = join(opts.root, 'web')
  let js = ''
  let map = ''
  let early = ''
  let version = ''
  // The viewers' scripts and maps, and the copies (as their bytes), by their served names.
  let files = new Map<string, string | Buffer<ArrayBuffer>>()

  /**
   * The viewers and the copies as they are now. One that fails is logged and keeps its last good
   * build, as the page's own script does; the others are built as they are.
   */
  async function buildFiles(): Promise<Map<string, string | Buffer<ArrayBuffer>>> {
    const next = new Map<string, string | Buffer<ArrayBuffer>>()
    const keep = (...names: string[]) => {
      for (const name of names) {
        const before = files.get(name)
        if (before !== undefined) next.set(name, before)
      }
    }
    for (const [name, entry] of Object.entries(opts.viewers ?? {})) {
      try {
        const viewer = await bundle(entry, 'esm', 'external', text => opts.log(`${text} (${name})`), 'short')
        if (!viewer) {
          keep(name, `${name}.map`)
          continue
        }
        next.set(name, viewer.js + mapLink(name))
        next.set(`${name}.map`, viewer.map)
      } catch (err) {
        opts.log(`web bundle: ${buildMessage(err)} (${name})`)
        keep(name, `${name}.map`)
      }
    }
    for (const [name, module] of Object.entries(opts.copies ?? {})) {
      try {
        next.set(name, readFileSync(Bun.resolveSync(module, opts.root)))
      } catch (err) {
        opts.log(`web bundle: ${buildMessage(err)} (${name})`)
        keep(name)
      }
    }
    return next
  }

  const hashNow = (): string => hashOf([js, early, ...files.values()], webDir)

  async function build(): Promise<void> {
    try {
      const main = await bundle(opts.entry, 'esm', 'external', opts.log)
      if (main === null) return
      // A few kilobytes: its map stays in it.
      const before = opts.early ? await bundle(opts.early, 'iife', 'inline', opts.log) : { js: '' }
      if (before === null) return
      js = main.js + mapLink('app.js')
      map = main.map
      early = before.js
    } catch (err) {
      opts.log(`web bundle: ${buildMessage(err)}`)
      return
    }
    files = await buildFiles()
    version = hashNow()
  }

  // Style, page and icon changes also move the version even when the script did not build.
  async function buildAndHash(): Promise<void> {
    const before = js
    await build()
    if (js === before) version = hashNow()
  }

  await build()

  // One build at a time: an older one finishing last would put back an older bundle.
  let queue = Promise.resolve()
  return {
    js: () => js,
    map: () => map,
    early: () => early,
    file: name => files.get(name),
    version: () => version,
    rebuild() {
      queue = queue.then(buildAndHash)
      return queue
    },
  }
}
