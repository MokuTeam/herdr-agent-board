// A stand-in for Claude Code, put on PATH as `claude` (fakeClaudeOn): writes down its arguments,
// its CLAUDE_CONFIG_DIR, its folder and the variables FAKE_CLAUDE_SHOW names to FAKE_CLAUDE_LOG, and exits with FAKE_CLAUDE_EXIT. The
// real Claude is never run by a test.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (import.meta.main) {
  writeFileSync(
    process.env.FAKE_CLAUDE_LOG ?? '',
    JSON.stringify({
      args: process.argv.slice(2),
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      cwd: process.cwd(),
      // FAKE_CLAUDE_SHOW: names, comma-separated, whose values it writes down too (null when unset).
      ...(process.env.FAKE_CLAUDE_SHOW && {
        env: Object.fromEntries(process.env.FAKE_CLAUDE_SHOW.split(',').map(n => [n, process.env[n] ?? null])),
      }),
    }),
  )
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0))
}

/** `claude` in `dir` that runs this stand-in: a .cmd for Windows, a sh script elsewhere. */
export function fakeClaudeOn(dir: string): void {
  const script = fileURLToPath(import.meta.url)
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n@exit /b %errorlevel%\r\n`)
  } else {
    const file = join(dir, 'claude')
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(file, 0o755)
  }
}
