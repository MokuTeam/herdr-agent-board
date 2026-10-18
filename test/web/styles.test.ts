// The stylesheets are upstream's own at the newest merge ported, rule for rule: web/styles/*.css
// against web/*.css there, comments aside (ours name the TS files). The setup note's rules live in
// a sheet of their own here (styles/setup.css, Task 31d): upstream's app.css carries them inline.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { oldSource } from './support/old-app.ts'

/** The newest upstream merge whose stylesheets are ported. */
const STYLES_REF = '72151c3'
const SHEETS = ['app.css', 'menu.css', 'launch.css', 'questions.css', 'terminal.css', 'helpers.css']
const ROOT = join(import.meta.dir, '..', '..')

/** The rules of a sheet, line by line, without comments and blank lines. */
const rules = (css: string): string[] =>
  css
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')

const ours = (sheet: string) => rules(readFileSync(join(ROOT, 'web', 'styles', sheet), 'utf8'))

const isSetupRule = (line: string) => /^\.(setup-|sr-only)/.test(line)

describe(`the stylesheets are upstream’s at ${STYLES_REF}`, () => {
  for (const sheet of SHEETS)
    test(sheet, () => {
      const theirs = rules(oldSource(`web/${sheet}`, STYLES_REF))
      if (sheet !== 'app.css') return void expect(ours(sheet)).toEqual(theirs)
      // The setup note's rules went to setup.css, its own sheet; the rest is upstream's app.css.
      const rest = theirs
        .filter(line => !isSetupRule(line) && line !== '  .setup-pop { transition: opacity 160ms ease; }')
        .map(line => line.replace(', .setup-pop {', ' {'))
      expect(ours(sheet)).toEqual(rest)
      expect(ours('setup.css').filter(isSetupRule)).toEqual(theirs.filter(isSetupRule))
    })
})
