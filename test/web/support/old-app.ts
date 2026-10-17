// The old page's own code, for the expected side of markup parity: declarations of web/app.js
// (and the modules it uses) picked by name and run with the dependencies a test hands them, so
// the React markup is compared with what the old functions themselves build, not with a copy.
// The old page is gone from the working tree (the server serves the React board since Task 27):
// every file is read from the parity baseline in git, web/index.html too.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dir, '..', '..', '..')
const BASELINE = '94fdde6'

const fromGit = new Map<string, string>()

/** A file of the old page as it was at the parity baseline. */
export function oldSource(file: string): string {
  const known = fromGit.get(file)
  if (known !== undefined) return known
  const git = Bun.spawnSync(['git', 'show', `${BASELINE}:${file}`], { cwd: ROOT })
  if (git.exitCode !== 0) throw new Error(`git show ${BASELINE}:${file} failed`)
  const text = git.stdout.toString()
  fromGit.set(file, text)
  return text
}

/**
 * A declaration to pick: its name, and its indentation when it is nested (inside an init function);
 * or a top-level statement by how its first line starts (`catsList.addEventListener('click'`),
 * through its line `})` — it registers listeners and gives nothing back.
 */
export type Wanted = string | { name: string; indent: string } | { statement: string }

const STARTS = ['function ', 'async function ', 'export function ', 'const ', 'export const ']
const balanced = (line: string) => line.split('{').length === line.split('}').length

/** One top-level statement: its line, or (when its brackets stay open) through the line `})`. */
function statement(lines: string[], file: string, starts: string): string {
  const start = lines.findIndex(line => line.startsWith(starts))
  const first = lines[start]
  if (first === undefined) throw new Error(`no ${starts} in ${file}`)
  let end = start
  if (!balanced(first) || first.split('(').length !== first.split(')').length)
    while (end < lines.length - 1 && lines[end] !== '})') end++
  return lines.slice(start, end + 1).join('\n')
}

/** One declaration: a function to its closing brace, a const while its lines go on deeper. */
function declaration(lines: string[], file: string, wanted: Wanted): string {
  if (typeof wanted !== 'string' && 'statement' in wanted) return statement(lines, file, wanted.statement)
  const { name, indent } = typeof wanted === 'string' ? { name: wanted, indent: '' } : wanted
  const start = lines.findIndex(line =>
    STARTS.some(s => line.startsWith(`${indent}${s}${name}(`) || line.startsWith(`${indent}${s}${name} =`)),
  )
  const first = lines[start]
  if (first === undefined) throw new Error(`no ${name} in ${file}`)
  let end = start
  if (first.includes(`function ${name}(`)) {
    if (!balanced(first)) while (end < lines.length - 1 && lines[end] !== `${indent}}`) end++
  } else {
    const deeper = new RegExp(`^${indent}(\\s+\\S|[}\\])])`)
    while (deeper.test(lines[end + 1] ?? '')) end++
  }
  return lines
    .slice(start, end + 1)
    .map(line => line.slice(indent.length).replace(/^export /, ''))
    .join('\n')
}

const names = (wanted: Wanted[]) =>
  wanted.flatMap(w => (typeof w === 'string' ? [w] : 'statement' in w ? [] : [w.name]))

export type OldFunction = (...args: unknown[]) => unknown

/**
 * The declarations `wanted` of `file` (as it was at the parity baseline), run with `deps` in
 * scope; returns them by name, functions callable.
 */
export function oldCode(file: string, wanted: Wanted[], deps: Record<string, unknown>): Map<string, unknown> {
  const lines = oldSource(file).split(/\r?\n/)
  const body = `${wanted.map(w => declaration(lines, file, w)).join('\n')}\nreturn [${names(wanted).join(', ')}]`
  const run = new Function(...Object.keys(deps), body)
  const values: unknown = run(...Object.values(deps))
  if (!Array.isArray(values)) throw new Error('the old code returned no list')
  return new Map(names(wanted).map((name, i) => [name, values[i]]))
}

/** One function of `oldCode`'s result, callable with any arguments. */
export function oldFunction(code: Map<string, unknown>, name: string): OldFunction {
  const fn = code.get(name)
  if (typeof fn !== 'function') throw new Error(`${name} is not a function`)
  return (...args) => Reflect.apply(fn, undefined, args)
}

/**
 * A module of the old page that imports nothing (markdown.js, when.js, live.js…), loaded as it
 * was at the parity baseline: its exports by name (`oldFunction` calls one). For the old side's
 * own imports, so that side runs the baseline's code and not the ported module the React side runs.
 */
export async function oldModule(file: string): Promise<Map<string, unknown>> {
  const source = oldSource(file)
  if (/^import /m.test(source)) throw new Error(`${file} imports other modules`)
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-old-'))
  try {
    const path = join(dir, file.split('/').pop() ?? 'module.js')
    writeFileSync(path, source)
    const mod: unknown = await import(pathToFileURL(path).href)
    if (typeof mod !== 'object' || mod === null) throw new Error(`${file} did not load`)
    return new Map(Object.entries(mod))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The baseline's when.js, attention.js, markdown.js and live.js: what app.js imported from them. */
export const OLD_WHEN = await oldModule('web/when.js')
export const OLD_ATTENTION = await oldModule('web/attention.js')
export const OLD_MARKDOWN = await oldModule('web/markdown.js')
export const OLD_LIVE = await oldModule('web/live.js')
