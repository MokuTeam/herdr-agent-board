import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { choiceDialog, inputDraft, promptScreen } from '../../src/core/dialogs/input-box.ts'
import { trustScreen } from '../support/trust-screen.ts'

const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const ESC = '\x1b'

// Claude Code 2.1.330 read through herdr 0.9.5 (agent read --source visible --ansi) in a scratch
// profile against a stub API: its prompt once a start is over (startup-prompt), the API key and
// project MCP server dialogs it asks before it (startup-api-key, startup-mcp-server). The Code Mode
// notice and the fullscreen renderer one could not be drawn there (Claude keeps Code Mode off behind
// ANTHROPIC_BASE_URL, and the renderer one comes when it likes): those two are its own words (the
// owner's screen in #602, the strings in that build) laid out as the two captured dialogs are.
const PROMPT = screen('startup-prompt')
// Claude draws its prompt's ❯ and the cursor after it on a line of their own.
const typedInto = (text: string): string => PROMPT.replace(/^❯.*$/m, `❯\u00a0${text}${ESC}[7m ${ESC}[0m`)
const SUGGESTION = typedInto(`${ESC}[0m${ESC}[2mTry "fix the failing test"${ESC}[0m`)
const TYPED = typedInto('half a thought the owner typed')

test('the screens every setup meets read as before: the prompt empty, with its suggestion, with text typed', () => {
  // inputDraft, which every launch asks first, gives what it gave before this change.
  expect(inputDraft(PROMPT)).toBe('')
  expect(inputDraft(SUGGESTION)).toBe('')
  expect(inputDraft(TYPED)).toBe('half a thought the owner typed')
  expect(inputDraft(trustScreen('C:\\work\\probe'))).toBeNull()
  // The prompt is a box, never a dialog, whatever it holds.
  expect(promptScreen(PROMPT)).toEqual({ kind: 'box', draft: '' })
  expect(promptScreen(SUGGESTION)).toEqual({ kind: 'box', draft: '' })
  expect(promptScreen(TYPED)).toEqual({ kind: 'box', draft: 'half a thought the owner typed' })
})

test('a dialog is told by its shape, a choice under ❯ and how to answer it, not by its words', () => {
  const dialogs = {
    trust: trustScreen('C:\\work\\probe'),
    trustPlain: trustScreen('C:\\work\\probe', { ansi: false, selected: 'yes' }),
    permissionBash: screen('permission-bash'),
    permissionWrite: screen('permission-write'),
    apiKey: screen('startup-api-key'),
    mcpServer: screen('startup-mcp-server'),
    codeMode: screen('startup-code-mode'),
    fullscreen: screen('startup-fullscreen'),
    question: screen('question-single'),
    questionNarrow: screen('question-cut-typed'),
    teachAutoMode: screen('teach-auto-mode'),
  }
  for (const [name, text] of Object.entries(dialogs)) {
    expect([name, promptScreen(text)]).toEqual([name, { kind: 'dialog' }])
    expect([name, inputDraft(text)]).toEqual([name, null])
  }
  // The Code Mode notice: its chosen answer is an option, never text typed into a prompt.
  expect(inputDraft(screen('startup-code-mode'))).toBeNull()
})

test('neither a box nor a dialog: a shell, a screen cut short, a list with no line on how to answer it', () => {
  expect(promptScreen('PS C:\\work> ')).toBeNull()
  expect(promptScreen('')).toBeNull()
  expect(promptScreen(null)).toBeNull()
  // The prompt's lower rule not drawn yet.
  expect(promptScreen(PROMPT.split('\n').slice(0, -3).join('\n'))).toBeNull()
  // A list, its answer line missing; an answer line with nothing marked to answer.
  expect(choiceDialog('Pick one\n❯ 1. Yes\n  2. No\n')).toBe(false)
  expect(choiceDialog('Something happened\n\n  Enter to continue\n')).toBe(false)
  // How to answer must be the last line: a ❯ and words about Enter far above it are something else.
  expect(choiceDialog('❯ run it\nPress Enter to confirm\nthen the output\n')).toBe(false)
  // A working Claude's "esc to interrupt" is not how to answer a dialog.
  expect(choiceDialog('❯ do the thing\n✻ Working… (esc to interrupt)\n')).toBe(false)
})
