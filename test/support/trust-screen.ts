// Claude Code's folder-trust dialog as herdr reads it from a pane (`agent read --ansi`), laid out
// as Claude draws it: the folder wrapped at the pane's width, the ❯ on the picked answer.
export type TrustOptions = { selected?: 'no' | 'yes' | null; width?: number; ansi?: boolean }

export function trustScreen(folder: string, { selected = 'no', width = 48, ansi = true }: TrustOptions = {}): string {
  const b = (s: string) => (ansi ? `\x1b[0m\x1b[1m${s}\x1b[0m` : s)
  const pick = (which: 'no' | 'yes') => (selected === which ? (ansi ? '\x1b[0m\x1b[38;2;177;185;249m❯ ' : '❯ ') : '  ')
  const lines = (folder.match(new RegExp(`.{1,${width}}`, 'g')) ?? []).map(s => ` ${b(s)}`)
  return [
    `PS ${folder}> claude`,
    `${ansi ? '\x1b[0m\x1b[38;2;255;193;7m' : ''}${'─'.repeat(80)}${ansi ? '\x1b[0m' : ''}`,
    ` ${b('Accessing workspace:')}`,
    ...lines,
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known',
    " open source project, or work from your team). If not, take a moment to review what's in this folder",
    ' first.',
    " Claude Code'll be able to read, edit, and execute files here.",
    ' Security guide',
    ` ${pick('no')}No, exit`,
    ` ${pick('yes')}Yes, I trust this folder`,
    ' Enter to confirm · Esc to cancel',
  ].join('\r\n')
}

// Claude Code's "Allow external CLAUDE.md file imports?" dialog as herdr reads it from a pane.
export type ImportsOptions = { files?: string[]; selected?: 'no' | 'yes' | null }

export function importsScreen({
  files = ['/Users/me/.claude/PROTOCOL.md', '/Users/me/.claude/RTK.md'],
  selected = 'no',
}: ImportsOptions = {}): string {
  const pick = (which: 'no' | 'yes') => (selected === which ? '❯' : ' ')
  return [
    ' me@Mac ~/Documents/x  claude',
    '────────────',
    '  Allow external CLAUDE.md file imports?',
    '',
    "  This project's CLAUDE.md or .claude/rules imports files outside the current working directory.",
    '',
    '  External imports:',
    ...files.map(f => `    ${f}`),
    '',
    '  Important: Only use Claude Code with files you trust.',
    '',
    `  ${pick('no')} No, disable external imports`,
    `  ${pick('yes')} Yes, allow external imports`,
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\r\n')
}
