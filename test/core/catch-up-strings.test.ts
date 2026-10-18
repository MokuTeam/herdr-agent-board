// The texts upstream's later merges added, changed or dropped are ours word for word, in English
// and Russian: each merge's web/i18n.js (and the setup check's web/i18n-setup.js) against its
// first parent, read from git.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { STRINGS } from '../../src/core/i18n/strings.ts'
import { oldSource } from '../web/support/old-app.ts'

/** The merges ported since #41, oldest first. */
const MERGES = [
  { merge: '72151c3', pr: '#42 zoom' },
  { merge: '8c4b987', pr: '#43 compact toolbar and settings' },
  { merge: '75e9c61', pr: '#44 call in MokuPilot' },
]

type Dictionaries = Record<string, Record<string, unknown>>
const isDictionaries = (v: unknown): v is Dictionaries => typeof v === 'object' && v !== null

/** A dictionaries object literal of `file` at `ref` (from `opening` to its closing line), evaluated. */
function upstream(file: string, ref: string, opening: string): Dictionaries {
  let lines: string[]
  try {
    lines = oldSource(file, ref).split(/\r?\n/)
  } catch {
    return {}
  }
  const start = lines.indexOf(opening)
  const end = lines.indexOf('}', start)
  if (start < 0 || end < 0) throw new Error(`no ${opening} in ${file} at ${ref}`)
  const body = lines
    .slice(start, end + 1)
    .join('\n')
    .replace(opening, '{')
  const value: unknown = new Function(`return ${body}`)()
  if (!isDictionaries(value)) throw new Error(`no dictionaries in ${file} at ${ref}`)
  return value
}

const FILES = [
  { file: 'web/i18n.js', opening: 'const STRINGS = {' },
  { file: 'web/i18n-setup.js', opening: 'export const SETUP_STRINGS = {' },
]

for (const { merge, pr } of MERGES)
  test(`the texts ${pr} added, changed or dropped, as upstream wrote them`, () => {
    let checked = 0
    for (const { file, opening } of FILES) {
      const before = upstream(file, `${merge}^1`, opening)
      const after = upstream(file, merge, opening)
      for (const lang of ['en', 'ru'] as const) {
        const was = before[lang] ?? {}
        const now = after[lang] ?? {}
        for (const [key, value] of Object.entries(now))
          if (!(key in was) || JSON.stringify(was[key]) !== JSON.stringify(value)) {
            assert.deepEqual(STRINGS[lang][key], value, `${lang} ${key}`)
            checked++
          }
        for (const key of Object.keys(was))
          if (!(key in now)) {
            assert.equal(STRINGS[lang][key], undefined, `${lang} ${key}`)
            checked++
          }
      }
    }
    assert.ok(checked > 0, 'the merge changed no text')
  })
