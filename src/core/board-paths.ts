// The `board` words that are a file or a folder (#532). Under Git Bash the board's sh shim keeps
// every argument as typed (core/install-plan.ts GIT_BASH_PATHS), so a text that starts with /
// ("/review is done") stays itself; these words alone are converted, as Git Bash did.

/**
 * Options whose value is a file, in any command: `--ref` too, `board todo add`'s ticket, file or
 * link, as a ticket or a link never starts with /.
 */
const PATH_VALUES: ReadonlySet<string> = new Set(['--file', '--passphrase-file', '--pi-session', '--ref'])
/** Options cli.ts reads before the command, with a value that is no path. */
const NAME_VALUES: ReadonlySet<string> = new Set(['--session', '--name'])
/** Commands whose words after the subcommand are a file or a folder: `time import <file>`, ... */
const PATH_WORDS: Readonly<Record<string, string>> = { time: 'import', thread: 'import', backup: 'folder' }

/**
 * Where in the board's arguments the paths that start with / are, in order. Nothing after the
 * first `--`, those are the command's own words (#404), but in the commands that take a file or a
 * folder (PATH_WORDS), where they can be nothing else.
 */
export function boardPathIndexes(argv: readonly string[]): number[] {
  const dashes = argv.indexOf('--')
  const end = dashes < 0 ? argv.length : dashes
  const found: number[] = []
  const words: number[] = []
  for (let i = 0; i < end; i++) {
    const a = String(argv[i])
    if (PATH_VALUES.has(a)) {
      if (i + 1 < end) found.push(i + 1)
      i++
    } else if (NAME_VALUES.has(a)) i++
    else if (!a.startsWith('-')) words.push(i)
  }
  const [cmd, sub, ...more] = words
  // Every word after the subcommand, not only the file: the values of their other options (a time
  // zone, a lane, a client=lane map) do not start with /, and Git Bash converted them all before.
  if (cmd !== undefined && sub !== undefined && PATH_WORDS[String(argv[cmd])] === argv[sub]) {
    for (let i = end + 1; i < argv.length; i++) more.push(i)
    found.push(...more)
  }
  return found.filter(i => String(argv[i]).startsWith('/')).sort((a, b) => a - b)
}

/**
 * The board's arguments with their paths that start with / converted by `convert` (one call, the
 * paths in order; it returns them in the same order). The same array when there is none, so no
 * call is made; a path it gives nothing back for stays as typed.
 */
export function withBoardPaths(argv: string[], convert: (paths: string[]) => string[]): string[] {
  const at = boardPathIndexes(argv)
  if (at.length === 0) return argv
  const converted = convert(at.map(i => String(argv[i])))
  const out = [...argv]
  at.forEach((i, n) => {
    const v = converted[n]
    if (v) out[i] = v
  })
  return out
}
