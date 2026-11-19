// Codex CLI's "Would you like to run the following command?" as the board reads it (#426):
// core/dialogs/questions.ts, only for panes herdr says run Codex. Screens: codex-permission-3 is
// Codex 0.169's, read from a pane; codex-permission-2 is the same without its "don't ask again".
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseDialog } from '../../src/core/dialogs/questions.ts'

const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const THREE = screen('codex-permission-3')
const TWO = screen('codex-permission-2')
const permission = (text: string, agent: string | null = 'codex') => {
  const d = parseDialog(text, agent)
  return d?.kind === 'permission' ? d : null
}

test('three choices: the command, allow once and deny; "don’t ask again" is never offered', () => {
  const d = permission(THREE)
  expect(d).toMatchObject({
    title: 'Codex',
    prompt: 'Would you like to run the following command?',
    body: ['  Environment: local', '  Reason: Allow running pwd outside the sandbox?', '  $ pwd'],
    cursor: 1,
  })
  expect(d?.options.map(o => [o.n, o.label, o.cursor])).toEqual([
    [1, 'Yes', true],
    [3, 'No, cancel (esc)', false],
  ])
})

test('two choices: deny is 2', () => {
  expect(permission(TWO)?.options.map(o => o.n)).toEqual([1, 2])
})

test('the cursor on deny is read; the fingerprint is the request’s, not the cursor’s', () => {
  const moved = THREE.replace('› 1. Yes, proceed (y)', '  1. Yes, proceed (y)').replace(
    '  3. No, and tell Codex',
    '› 3. No, and tell Codex',
  )
  const d = permission(moved)
  expect(d?.cursor).toBe(3)
  expect(d?.fingerprint).toBe(permission(THREE)?.fingerprint)
  expect(permission(THREE.replace('$ pwd', '$ ls'))?.fingerprint).not.toBe(permission(THREE)?.fingerprint)
  expect(permission(TWO)?.fingerprint).not.toBe(permission(THREE)?.fingerprint)
})

test('read only in a Codex pane, and only when all of it is there', () => {
  // A Claude or pi pane, or one herdr names no agent for: not read as Codex's.
  for (const agent of ['claude', 'pi', null]) expect(permission(THREE, agent)?.title).not.toBe('Codex')
  // Claude's own permission prompt in a Codex pane is not Codex's.
  expect(permission(screen('permission-bash'))).toBeNull()
  // Cut off: no footer, no command, no Environment line, a third choice that is not "don't ask again".
  expect(permission(THREE.replace('Press enter to confirm or esc to cancel', ''))).toBeNull()
  expect(permission(THREE.replace('  $ pwd', ''))).toBeNull()
  expect(permission(THREE.replace('  Environment: local', ''))).toBeNull()
  expect(permission(THREE.replace(/2\. Yes, and don't ask again[^\n]*/, '2. Something else (x)'))).toBeNull()
  // A command too long for the card: the user answers it in the terminal.
  expect(permission(THREE.replace('$ pwd', `$ echo ${'x'.repeat(700)}`))).toBeNull()
  expect(
    permission(THREE.replace('  $ pwd', Array.from({ length: 90 }, (_, i) => `  $ step ${i}`).join('\n'))),
  ).toBeNull()
})
