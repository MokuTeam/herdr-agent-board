// A node's env file (#507, core/node-env.ts): what the env sink writes is read back as written,
// and the names the board sets itself are left out.
import { expect, test } from 'bun:test'
import { boardOwnsName, parseEnvFile } from '../../src/core/node-env.ts'

test('values as the env sink writes them: plain, in single or double quotes; comments and odd lines left out', () => {
  const text = [
    '# made by the board',
    'PLAIN=abc.def:1/2',
    'QUOTED=\'a b "c" $HOME\'',
    'DOUBLE="it\'s"',
    'export EXPORTED=1',
    '  SPACED = x  ',
    'EMPTY=',
    'not a line',
    '1BAD=x',
    'PLAIN=last wins',
    '__proto__=own',
    'Имя=x',
  ].join('\r\n')
  const { vars, refused } = parseEnvFile(`\uFEFF${text}\n`)
  expect(vars).toEqual({
    PLAIN: 'last wins',
    QUOTED: 'a b "c" $HOME',
    DOUBLE: "it's",
    EXPORTED: '1',
    SPACED: 'x',
    EMPTY: '',
    ['__proto__']: 'own',
  })
  expect(Object.getPrototypeOf(vars)).toBe(Object.prototype)
  expect(refused).toEqual([])
})

test('the board owns CLAUDE_CONFIG_DIR, PATH, HOME and HERDR_*: left out, each named once, whatever its case', () => {
  const { vars, refused } = parseEnvFile(
    'CLAUDE_CONFIG_DIR=/x\nPath=/evil\nHOME=/h\nHERDR_PANE_ID=p\nherdr_env=1\nPATH=/again\nKEEP=1\n',
  )
  expect(vars).toEqual({ KEEP: '1' })
  expect(refused).toEqual(['CLAUDE_CONFIG_DIR', 'Path', 'HOME', 'HERDR_PANE_ID', 'herdr_env', 'PATH'])
  for (const name of ['MCP_DOCS_AUTHORIZATION', 'GITHUB_TOKEN', 'HOMEBREW_PREFIX', 'PATHS'])
    expect([name, boardOwnsName(name)]).toEqual([name, false])
})
