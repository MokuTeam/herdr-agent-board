// A stand-in for the pi program, put on PATH as `pi` (fakePiOn): writes down its arguments, its
// CLAUDE_CONFIG_DIR and its folder to FAKE_PI_LOG, and exits with FAKE_PI_EXIT. The real pi is
// never run by a test.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (import.meta.main) {
  writeFileSync(
    process.env.FAKE_PI_LOG ?? '',
    JSON.stringify({
      args: process.argv.slice(2),
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      cwd: process.cwd(),
    }),
  )
  process.exit(Number(process.env.FAKE_PI_EXIT ?? 0))
}

/** `pi` in `dir` that runs this stand-in: a .cmd for Windows, a sh script elsewhere. */
export function fakePiOn(dir: string): void {
  const script = fileURLToPath(import.meta.url)
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'pi.cmd'), `@"${process.execPath}" "${script}" %*\r\n@exit /b %errorlevel%\r\n`)
  } else {
    const file = join(dir, 'pi')
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(file, 0o755)
  }
}
