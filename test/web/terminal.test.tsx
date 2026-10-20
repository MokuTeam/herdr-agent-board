// The terminal window against upstream's (web/terminal.js at the terminal's merge): every scene is
// stepped through on both sides — the old window on a fake <body>, the React engine and
// <TerminalView> on another (support/terminal-sides.tsx) — with the same board, server and steps;
// after each step the two must read the same. Then the window's pure parts, the sheet's button,
// the card menu's item, Ctrl+` and the stylesheet.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translator } from '../../src/core/i18n/translator.ts'
import { herdrCalls, keyStep, textSteps } from '../../src/core/terminal/term-keys.ts'
import { caretSpot, diffLines, findLinks, fitFont, parseLine, plainText } from '../../src/core/terminal/term-model.ts'
import { boardKey } from '../../web/src/models/board-keys.ts'
import { cardMenu } from '../../web/src/models/menu-model.ts'
import { batchSize, footStatus, lineHtml, pasteOf, statePanel, termButton } from '../../web/src/models/terminal.ts'
import { item } from './support/board.tsx'
import { oldCode, oldFunction, oldModule, oldSource } from './support/old-app.ts'
import {
  newTerminal,
  oldTerminal,
  SCROLL_HEIGHT,
  TERMINAL_MERGE,
  type TermScene,
  type TermSide,
} from './support/terminal-sides.tsx'

const ESC = '\x1b'
const t = translator('en')
// Upstream's own: they import nothing.
const OLD_MODEL = await oldModule('web/term-model.js', TERMINAL_MERGE)
const OLD_KEYS = await oldModule('web/term-keys.js', TERMINAL_MERGE)
const probe = item({ key: 's1', name: 'probe', cwd: '/work/probe', pane: 'w1:p1', agent: 'claude' })

const scene = (fields: Partial<TermScene> = {}): TermScene => ({
  items: [probe],
  shells: [],
  canMutate: true,
  token: 'tok',
  lang: 'en',
  ...fields,
})

type Step = [name: string, run: (side: TermSide) => Promise<unknown> | unknown]

/** Each step on the old side, then on the new one; what each step left must read the same. */
async function both(start: TermScene, steps: Step[], { phone = false } = {}): Promise<string[]> {
  const record = async (make: typeof oldTerminal) => {
    const side = await make(structuredClone(start), { phone })
    const out: string[] = []
    try {
      for (const [name, run] of steps) {
        await run(side)
        out.push(
          [
            `## ${name}`,
            side.snapshot(),
            `open: ${side.isOpen()}`,
            `posts: ${JSON.stringify(side.server.posts)}`,
            `streams: ${JSON.stringify(side.server.streams.map(s => `${s.url}${s.closed ? ' (closed)' : ''}`))}`,
            `toasts: ${JSON.stringify(side.toasts)}`,
            `log: ${JSON.stringify(side.log)}`,
            `outside: ${side.outside()}`,
          ].join('\n'),
        )
      }
    } finally {
      await side.dispose()
    }
    return out
  }
  const old = await record(oldTerminal)
  const neu = await record(newTerminal)
  for (const [i, step] of old.entries()) expect(neu[i]).toBe(step)
  return neu
}

const frame = (lines: string[], fields: Record<string, unknown> = {}) => ({
  t: 'frame',
  drop: 0,
  keep: 0,
  lines,
  cols: 107,
  ...fields,
})
const PROMPT = [`${ESC}[32mPS${ESC}[0m C:\\work\\probe> `, 'see https://example.com/docs. and (https://x.example/a)']
const rule = '─'.repeat(40)
const CLAUDE = ['● Ready', rule, `❯ hello${ESC}[2m board${ESC}[0m`, rule, `  ${ESC}[1;38;5;208mctx${ESC}[0m 6%`]
// The guard against the click a tap leaves behind on what just opened.
const settled: Step = ['a moment later', s => s.wait(500)]

describe('the terminal window, step by step, as upstream’s', () => {
  test('a shell the board opens: starting, connecting, live with the keys; typing, links, leaving, closing', async () => {
    const out = await both(scene(), [
      [
        'opened: the shell is being opened',
        s => {
          s.server.replies['shell/open'] = 'hold'
          return s.open('s1')
        },
      ],
      [
        'herdr opened it: the stream',
        s => {
          s.server.release()
          return s.wait(0)
        },
      ],
      ['the first screen: live, and the keys go to it', s => s.message(frame(PROMPT))],
      ['the board says the shell is open', s => s.board({ shells: ['s1'] })],
      ['Enter', s => s.key({ key: 'Enter' })],
      ['typed text', s => s.input('insertText', 'ls -la')],
      ['Backspace by the field', s => s.input('deleteContentBackward')],
      ['a word from an IME: the draft is not typed, the word is', s => s.compose('日本', 'にほん')],
      ['the screen moves on', s => s.message(frame(['a.txt', 'PS C:\\work\\probe> '], { drop: 1, keep: 1 }))],
      ['the scroll the screen made, at the bottom', s => s.scroll(SCROLL_HEIGHT)],
      ['scrolled up', s => s.scroll(400)],
      ['more output: the view stays where it was', s => s.message(frame(['b.txt'], { drop: 0, keep: 3 }))],
      ['scrolled back down', s => s.scroll(SCROLL_HEIGHT - 3)],
      ['more output: the view follows it again', s => s.message(frame(['c.txt'], { drop: 0, keep: 4 }))],
      settled,
      ['a link in the output', s => s.click('link')],
      ['Ctrl+] gives the keys back', s => s.key({ key: ']', code: 'BracketRight', ctrlKey: true })],
      ['some of the screen selected', s => s.select('a.txt')],
      ['the click that selected it takes no keys', s => s.click('screen')],
      ['nothing selected', s => s.select('')],
      ['a click on the screen takes them again', s => s.click('screen')],
      ['herdr does not answer', s => s.message({ t: 'error', why: 'timed out' })],
      ['it answers again', s => s.message(frame(['b.txt'], { drop: 0, keep: 3 }))],
      ['Open in herdr', s => s.click('herdr')],
      ['Close the shell, once: it asks', s => s.click('close-shell')],
      ['twice: it goes', s => s.click('close-shell')],
      ['the board no longer has it', s => s.board({ shells: [] })],
      ['a new one', s => s.click('state')],
    ])
    expect(out.at(2)).toContain('Keys go to the shell · Ctrl+] leaves')
    expect(out.at(-2)).toContain('The shell was closed.')
  }, 30_000)

  test('the session’s own terminal: without the keys at first, a click gives them, Esc goes to Claude, then the window’s', async () => {
    const out = await both(scene(), [
      ['opened on the agent', s => s.open('s1', 'agent')],
      ['Claude’s screen', s => s.message(frame(CLAUDE))],
      settled,
      ['a click on the screen', s => s.click('screen')],
      ['Esc goes to Claude', s => s.key({ key: 'Escape' })],
      ['Ctrl+C with nothing selected', s => s.key({ key: 'c', code: 'KeyC', ctrlKey: true })],
      ['Claude’s answer selected', s => s.select('Ready')],
      ['Ctrl+C copies it: nothing goes to Claude', s => s.key({ key: 'c', code: 'KeyC', ctrlKey: true })],
      [
        'the clipboard says no',
        s => {
          s.browser.clipboardError = 'Write permission denied.'
          return s.key({ key: 'c', code: 'KeyC', ctrlKey: true })
        },
      ],
      ['nothing selected again', s => s.select('')],
      ['Shift+Tab', s => s.key({ key: 'Tab', shiftKey: true })],
      ['Ctrl+] leaves', s => s.key({ key: ']', code: 'BracketRight', ctrlKey: true })],
      ['Open in herdr: the session itself', s => s.click('herdr')],
      ['Esc now closes the window', s => s.windowKey({ key: 'Escape' })],
      ['folded away', s => s.wait(800)],
      ['the page out of sight with the window closed: nothing', s => s.pageHidden(true)],
      ['back in sight: still nothing', s => s.pageHidden(false)],
    ])
    expect(out.at(1)).toContain('Click the screen to type')
    expect(out.find(step => step.startsWith('## Ctrl+C copies it'))).toContain('"clipboard Ready"')
    expect(out.at(-1)).toContain('open: false')
  }, 30_000)

  test('a sleeping session says so and wakes; once awake its terminal connects', async () => {
    const asleep = { ...probe, sleeping: true, status: 'sleeping' as const }
    await both(scene({ items: [asleep] }), [
      ['opened on the agent', s => s.open('s1', 'agent')],
      ['Wake', s => s.click('state')],
      ['awake now', s => s.board({ items: [probe] })],
      ['its screen', s => s.message(frame(CLAUDE))],
      ['asleep again', s => s.board({ items: [asleep] })],
    ])
  }, 30_000)

  test('without fresh data: no shell to open, the agent’s screen read only', async () => {
    await both(scene({ canMutate: false }), [
      ['opened on the shell', s => s.open('s1')],
      settled,
      ['out of sight with nothing to read', s => s.pageHidden(true)],
      ['back in sight: still nothing to read', s => s.pageHidden(false)],
      ['to the agent', s => s.click('target-agent')],
      ['its screen', s => s.message(frame(CLAUDE))],
      ['a click on the screen takes no keys', s => s.click('screen')],
      ['back to the shell', s => s.click('target-shell')],
      ['the board can again', s => s.board({ canMutate: true })],
      ['Open a shell', s => s.click('state')],
      [
        'Ctrl+` closes the window, the keys elsewhere',
        s => s.windowKey({ key: '`', code: 'Backquote', ctrlKey: true }),
      ],
      ['folded away', s => s.wait(800)],
    ])
  }, 30_000)

  test('a paste of several lines asks first; one line goes as typed; too much is refused', async () => {
    const out = await both(scene({ shells: ['s1'] }), [
      ['opened on the shell the board has', s => s.open('s1')],
      ['live', s => s.message(frame(['PS> ']))],
      ['four lines pasted', s => s.paste('echo 1\r\necho 2\necho 3\necho 4\n')],
      ['Enter says yes', s => s.key({ key: 'Enter' })],
      ['one line', s => s.paste('git status')],
      ['two lines, Esc says no', s => s.paste('a\nb')],
      ['no', s => s.key({ key: 'Escape' })],
      ['too much', s => s.paste('x'.repeat(16_385))],
      ['Ctrl+` in the field closes the window', s => s.key({ key: '`', code: 'Backquote', ctrlKey: true })],
      ['folded away', s => s.wait(800)],
    ])
    expect(out.at(2)).toContain('Paste 4 lines? Each runs as if typed.')
    expect(out.at(-1)).toContain('open: false')
  }, 30_000)

  test('keys that do not reach the terminal, a slow herdr, a stream that drops and one the server ends', async () => {
    await both(scene({ shells: ['s1'] }), [
      ['opened', s => s.open('s1')],
      ['live', s => s.message(frame(['PS> ']))],
      [
        'the server refuses the keys',
        s => {
          s.server.replies['shell/input'] = { status: 409, body: { ok: false, error: 'The pane is gone' } }
          return s.key({ key: 'Enter' })
        },
      ],
      [
        'herdr too slow',
        s => {
          s.server.replies['shell/input'] = 'timeout'
          return s.key({ key: 'Tab' })
        },
      ],
      ['the stream drops for a moment', s => s.streamError(false)],
      ['the board no longer has the shell', s => s.board({ shells: [] })],
      ['the server ended the stream', s => s.streamError(true)],
    ])
  }, 30_000)

  test('a shell that cannot be opened says why and connects again; the agent’s stream refused', async () => {
    await both(scene(), [
      [
        'opened: the folder is gone',
        s => {
          s.server.replies['shell/open'] = {
            status: 409,
            body: { ok: false, error: 'The session’s folder is not there: /x' },
          }
          return s.open('s1')
        },
      ],
      [
        'Connect again: herdr is offline',
        s => {
          s.server.replies['shell/open'] = 'offline'
          return s.click('state')
        },
      ],
      settled,
      ['to the agent', s => s.click('target-agent')],
      ['the server said no to its stream', s => s.streamError(true)],
      ['Connect again', s => s.click('state')],
      ['the dimmed board closes it', s => s.click('scrim')],
      ['folded away', s => s.wait(800)],
    ])
  }, 30_000)

  test('a session off the board for a moment: the window says so, and connects again when it is back', async () => {
    await both(scene({ shells: ['s1'] }), [
      ['opened', s => s.open('s1')],
      ['live', s => s.message(frame(PROMPT))],
      ['gone from the board', s => s.board({ items: [] })],
      ['back', s => s.board({ items: [probe] })],
      ['live again', s => s.message(frame(PROMPT))],
      ['the page out of sight: the stream goes', s => s.pageHidden(true)],
      ['back in sight: it connects again', s => s.pageHidden(false)],
      ['live once more', s => s.message(frame(PROMPT))],
    ])
  }, 30_000)

  test('on a phone the row of keys a phone lacks', async () => {
    const out = await both(
      scene({ shells: ['s1'] }),
      [
        ['opened', s => s.open('s1')],
        ['live', s => s.message(frame(['PS> ']))],
        ['the keyboard comes up: the window keeps above it', s => s.viewport(520)],
        ['a keyboard that only fills the field', s => s.typeInto('pwd')],
        ['Esc from the row', s => s.click('key:esc')],
        ['⌃C from the row', s => s.click('key:ctrl+c')],
        ['without fresh data', s => s.board({ canMutate: false })],
        ['the row is gray', s => s.click('key:up')],
      ],
      { phone: true },
    )
    expect(out.at(1)).toContain('data-key="esc"')
  }, 30_000)

  test('in Russian', async () => {
    await both(scene({ lang: 'ru', shells: ['s1'] }), [
      ['opened', s => s.open('s1')],
      ['live', s => s.message(frame(['PS> ']))],
      ['a paste', s => s.paste('a\nb\nc')],
    ])
  }, 30_000)
})

describe('the window’s parts', () => {
  test('a row as upstream drew it: palette classes, inline colors, inverse, links', () => {
    const code = oldCode('web/terminal.js', ['esc', { name: 'runHTML', indent: '  ' }], {}, TERMINAL_MERGE)
    const runHTML = oldFunction(code, 'runHTML')
    const lines = [
      ...PROMPT,
      ...CLAUDE,
      `${ESC}[7mreverse${ESC}[27m ${ESC}[7;31;44mboth${ESC}[0m ${ESC}[38;2;1;2;3;48;5;200mtrue${ESC}[0m`,
      `${ESC}[2;3;4;9mall${ESC}[0m ${ESC}[8mhidden${ESC}[0m ${ESC}[9mstrike${ESC}[0m <tag> & "quotes"`,
      `${ESC}[4mhttps://claude.ai/${ESC}[0moauth?code=1&x="y" end`,
      '',
    ]
    const runsOf = (line: string): unknown[] => {
      const runs = oldFunction(OLD_MODEL, 'withLinks')(oldFunction(OLD_MODEL, 'parseLine')(line))
      return Array.isArray(runs) ? runs : []
    }
    for (const line of lines)
      expect(lineHtml(line)).toBe(
        runsOf(line)
          .map(r => String(runHTML(r)))
          .join(''),
      )
  })

  test('the screen and the keys as upstream’s own modules make them, case by case', () => {
    const was = (mod: Map<string, unknown>, name: string, ...args: unknown[]) => oldFunction(mod, name)(...args)
    const lines = [
      ...PROMPT,
      ...CLAUDE,
      `${ESC}[38:2::10:20:30mx${ESC}[48;5;3my${ESC}[38;5mz`,
      `a${ESC}]9;9;C:\\x${ESC}\\b${ESC}[2Kc${ESC}[?25ld\x07e\x00\tf`,
      `(see https://example.com/a_(b)) [https://e.example/x] "https://q.example/?a=1&b=2", http://b.example/.`,
      '',
    ]
    for (const line of lines) {
      expect<unknown>(parseLine(line)).toEqual(was(OLD_MODEL, 'parseLine', line))
      expect<unknown>(findLinks(plainText(line))).toEqual(was(OLD_MODEL, 'findLinks', plainText(line)))
    }
    const screens = [
      ['a', 'b', 'PS> '],
      ['a', 'b', 'PS> ls'],
      ['', '', 'a', ''],
      ['', 'a', '', 'b'],
      [],
      CLAUDE,
      PROMPT,
    ]
    for (const prev of screens)
      for (const next of screens)
        expect<unknown>(diffLines(prev, next)).toEqual(was(OLD_MODEL, 'diffLines', prev, next))
    for (const lines of screens)
      for (const kind of ['shell', 'claude', 'codex'])
        expect<unknown>(caretSpot(lines, kind)).toEqual(was(OLD_MODEL, 'caretSpot', lines, kind))
    for (const width of [0, 340, 760, 1000])
      for (const cols of [80, 107, 200])
        expect<unknown>(fitFont({ width, cols, ratio: 0.6, min: 9.5 })).toEqual(
          was(OLD_MODEL, 'fitFont', { width, cols, ratio: 0.6, min: 9.5 }),
        )
    const keys = [
      { key: 'Enter' },
      { key: 'Tab', shiftKey: true },
      { key: 'ArrowUp', ctrlKey: true, shiftKey: true },
      { key: 'Home', altKey: true },
      { key: 'F5' },
      { key: 'F11' },
      { key: 'с', code: 'KeyC', ctrlKey: true },
      { key: 'z', code: 'KeyY', ctrlKey: true },
      { key: 'Ф', code: 'KeyA', ctrlKey: true, altKey: true },
      { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true },
      { key: ']', code: 'BracketRight', ctrlKey: true },
      { key: 'v', code: 'KeyV', ctrlKey: true },
      { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true },
      { key: '.', code: 'Period', altKey: true },
      { key: ' ', code: 'Space', ctrlKey: true },
      { key: 'a', code: 'KeyA' },
      { key: 'Dead' },
      { key: 'c', code: 'KeyC', metaKey: true },
    ]
    for (const e of keys)
      for (const selection of [false, true])
        expect<unknown>(keyStep(e, { selection })).toEqual(was(OLD_KEYS, 'keyStep', e, { selection }))
    const requests: unknown[] = [
      [{ text: 'git st' }, { key: 'tab' }, { key: 'enter' }, { text: 'ls -la' }, { key: 'home' }, { text: 'y' }],
      [{ key: 'enter' }, { text: '--help' }],
      [{ text: '-' }, { text: '-x' }],
      [{ key: 'ctrl+shift+left' }, { key: 'shift+pageup' }, { key: 'ctrl+end' }, { key: 'alt+.' }],
      [{ key: 'constructor' }],
      [{ key: 'enter', text: 'x' }],
      [{ text: `a${ESC}]0;x\x07b` }],
      [],
      'enter',
      Array(257).fill({ key: 'up' }),
      [{ text: 'x'.repeat(16_385) }],
    ]
    for (const steps of requests) expect<unknown>(herdrCalls(steps)).toEqual(was(OLD_KEYS, 'herdrCalls', steps))
    for (const text of ['a\r\nb\nc', `a${ESC}[31mb\x07\tc`, '', 'x\n'])
      expect<unknown>(textSteps(text)).toEqual(was(OLD_KEYS, 'textSteps', text))
  })

  test('the state panel, the footer, a paste and the batches of keys', () => {
    const base = { status: 'live' as const, error: '', missing: false, target: 'shell' as const, hasLines: true }
    expect(statePanel(base, probe, t)).toBe(null)
    expect(statePanel({ ...base, status: 'connecting' }, probe, t)).toBe(null) // rows on show: no spinner
    expect(statePanel({ ...base, status: 'connecting', hasLines: false }, probe, t)).toEqual({ kind: 'connecting' })
    expect(statePanel({ ...base, status: 'error' }, probe, t)).toEqual({ kind: 'error', text: t('err.unavailable') })
    expect(statePanel({ ...base, status: 'gone', target: 'agent' }, probe, t)).toEqual({ kind: 'goneAgent' })
    const foot = { ...base, typing: true, waitingSend: false, slowNote: false, canMutate: true, coarse: true }
    expect(footStatus(foot, probe, t)).toEqual({ text: t('term.typing'), dot: true, warn: false })
    expect(footStatus({ ...foot, target: 'agent', coarse: false }, probe, t).text).toBe(
      'Keys go to Claude · Ctrl+] leaves',
    )
    expect(footStatus({ ...foot, waitingSend: true }, probe, t)).toEqual({
      text: t('term.waiting'),
      dot: true,
      warn: true,
    })
    expect(pasteOf('\n')).toEqual({ kind: 'none' })
    expect(pasteOf('one\n')).toEqual({ kind: 'type', text: 'one' })
    expect(pasteOf(`${'x'.repeat(130)}\nb`)).toEqual({
      kind: 'ask',
      text: `${'x'.repeat(130)}\nb`,
      n: 2,
      shown: `${'x'.repeat(120)}…\nb`,
    })
    expect(batchSize(Array(300).fill({ key: 'up' }))).toBe(256)
    expect(batchSize([{ text: 'x'.repeat(10_000) }, { text: 'y'.repeat(10_000) }, { key: 'enter' }])).toBe(1)
  })

  test('the sheet’s Terminal button: hidden where the board offers none, a dot while a shell is open', () => {
    expect(termButton(probe, { shells: [] }, t)).toEqual({ hidden: false, hasShell: false, title: t('term.hint') })
    expect(termButton(probe, { shells: ['s1'] }, t)).toEqual({
      hidden: false,
      hasShell: true,
      title: t('term.shellOpen'),
    })
    expect(termButton(probe, { terminal: false }, t).hidden).toBe(true)
    expect(termButton({ ...probe, cwd: '', pane: null }, {}, t).hidden).toBe(true)
  })

  test('the card menu’s Terminal: never gray, only where there is a folder or a pane', () => {
    // As upstream's own test of it (test/menu.test.mjs at the terminal's merge).
    const fresh = { t, canMutate: true, canEdit: true, column: 'idle', category: 'acme' }
    const ids = (entries: ReturnType<typeof cardMenu>) => entries.map(e => (e.separator ? '—' : e.id))
    expect(ids(cardMenu(probe, { ...fresh, terminal: true })).slice(0, 3)).toEqual(['open', 'focus', 'terminal'])
    const gray = cardMenu(probe, { ...fresh, terminal: true, canMutate: false }).find(
      e => !e.separator && e.id === 'terminal',
    )
    expect(gray && !gray.separator && gray.disabled).toBe(undefined)
    expect(ids(cardMenu({ ...probe, cwd: '', pane: null }, { ...fresh, terminal: true }))).not.toContain('terminal')
    // The same item as upstream's menu-model.js, for every state of the card: at #58's merge (the
    // card's menu as #56 left it, Archive by Clear), the terminal's item as its merge left it. In
    // no herdr workspace herdr names: upstream had no Rename workspace (the board's own), nor
    // Favorites (#64, the board's own too: test/web/menu.test.ts).
    const upstream = (entries: ReturnType<typeof cardMenu>) => entries.filter(e => e.separator || e.id !== 'favorite')
    const names = ['usable', 'tidy', 'SEP', 'PIN_COLUMNS', 'COLUMN_COLOR', 'cardMenu']
    const was = oldFunction(oldCode('web/menu-model.js', names, {}, 'b2c5afa'), 'cardMenu')
    for (const terminal of [true, false, undefined])
      for (const fields of [{}, { sleeping: true }, { cwd: '' }, { pane: null }, { cwd: '', pane: null }]) {
        const it = { ...probe, ...fields, workspace: null }
        const ctx = { ...fresh, ...(terminal === undefined ? {} : { terminal }) }
        expect<unknown>(upstream(cardMenu(it, ctx))).toEqual(was(it, ctx))
      }
  })

  test('Ctrl+` opens the terminal of the session in the sheet; not from the quick look, nor with Alt', () => {
    const press = { key: '`', code: 'Backquote', ctrlKey: true, shiftKey: false, metaKey: false, altKey: false }
    const scene = { typing: false, inSearch: false, panelOpen: true, query: '', quickLook: false, digits: false }
    expect(boardKey(press, { ...scene, sessionOpen: true })).toBe('terminal')
    expect(boardKey(press, { ...scene, sessionOpen: true, typing: true })).toBe('terminal')
    expect(boardKey(press, { ...scene, sessionOpen: false })).toBe(null)
    expect(boardKey(press, { ...scene, sessionOpen: true, quickLook: true })).toBe(null)
    expect(boardKey({ ...press, altKey: true }, { ...scene, sessionOpen: true })).toBe(null)
    expect(boardKey({ ...press, ctrlKey: false }, { ...scene, sessionOpen: true })).toBe(null)
  })

  test('the stylesheet is upstream’s, its comments pointing at the React files', () => {
    const ours = readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', 'terminal.css'), 'utf8')
    const theirs = oldSource('web/terminal.css', '8c4b987') // #43's light or dark picked in Settings
    const normal = (css: string) =>
      css
        .replace(/\r\n/g, '\n')
        .replace('(web/src/components/terminal/Terminal.tsx)', '(terminal.js)')
        .replace('(hooks/useTerminal.ts)', '(terminal.js)')
    expect(normal(ours)).toBe(normal(theirs))
  })
})
