// The terminal's texts are upstream's own (web/i18n.js at the terminal's merge), word for word.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { STRINGS } from '../../src/core/i18n/strings.ts'
import { TERMINAL_STRINGS } from '../../src/core/i18n/terminal-strings.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { oldSource } from '../web/support/old-app.ts'

const TERMINAL_MERGE = '1a1b270'
const isDictionaries = (v: unknown): v is Record<string, Record<string, unknown>> => typeof v === 'object' && v !== null

/** Upstream's STRINGS object literal (from `const STRINGS = {` to its closing line), evaluated. */
function upstreamStrings(): unknown {
  const lines = oldSource('web/i18n.js', TERMINAL_MERGE).split(/\r?\n/)
  const start = lines.indexOf('const STRINGS = {')
  const end = lines.indexOf('}', start)
  if (start < 0 || end < 0) throw new Error('no STRINGS in upstream web/i18n.js')
  return new Function(
    `return ${lines
      .slice(start, end + 1)
      .join('\n')
      .replace('const STRINGS = ', '')}`,
  )()
}

test('the terminal’s texts in English and Russian, as upstream wrote them', () => {
  const upstream = upstreamStrings()
  if (!isDictionaries(upstream)) throw new Error('no STRINGS in upstream web/i18n.js')
  for (const lang of ['en', 'ru'] as const) {
    const theirs: Record<string, unknown> = Object.fromEntries(
      Object.entries(upstream[lang] ?? {}).filter(([key]) => key.startsWith('term.')),
    )
    assert.deepEqual(TERMINAL_STRINGS[lang], theirs, lang)
    for (const key of Object.keys(theirs)) assert.deepEqual(STRINGS[lang][key], theirs[key], key)
  }
  assert.equal(translator('ru')('term.paste', { n: 5 }), 'Вставить 5 строк? Каждая выполнится, как будто её ввели.')
  assert.equal(translator('en')('term.paste', { n: 1 }), 'Paste 1 line? It runs as if typed.')
})
