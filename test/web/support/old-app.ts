// The old page's own code, for the expected side of markup parity: declarations of web/app.js
// (and the modules it uses) picked by name and run with the dependencies a test hands them, so
// the React markup is compared with what the old functions themselves build, not with a copy.
// Once a file is gone (web/app.js goes in Task 27) it is read from the parity baseline in git.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..', '..')
const BASELINE = '94fdde6'

function source(file: string): string {
  const path = join(ROOT, ...file.split('/'))
  if (existsSync(path)) return readFileSync(path, 'utf8')
  const git = Bun.spawnSync(['git', 'show', `${BASELINE}:${file}`], { cwd: ROOT })
  if (git.exitCode !== 0) throw new Error(`${file} is gone and git show ${BASELINE}:${file} failed`)
  return git.stdout.toString()
}

/** A declaration to pick: its name, and its indentation when it is nested (inside an init function). */
export type Wanted = string | { name: string; indent: string }

const STARTS = ['function ', 'async function ', 'export function ', 'const ', 'export const ']
const balanced = (line: string) => line.split('{').length === line.split('}').length

/** One declaration: a function to its closing brace, a const while its lines go on deeper. */
function declaration(lines: string[], file: string, wanted: Wanted): string {
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

const names = (wanted: Wanted[]) => wanted.map(w => (typeof w === 'string' ? w : w.name))

export type OldFunction = (...args: unknown[]) => unknown

/** The declarations `wanted` of `file`, run with `deps` in scope; returns them by name, functions callable. */
export function oldCode(file: string, wanted: Wanted[], deps: Record<string, unknown>): Map<string, unknown> {
  const lines = source(file).split(/\r?\n/)
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
