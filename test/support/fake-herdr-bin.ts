// The fake herdr as a real executable: Bun has no preload for a non-script argv, and
// HERDR_BIN_PATH is run with execFile on every OS. Compiled once per source hash and kept in
// the temp dir, so repeated runs skip both the build and the antivirus scan of a new exe.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('./fake-herdr.ts', import.meta.url))
let building: Promise<string> | undefined

async function build(): Promise<string> {
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12)
  const ext = process.platform === 'win32' ? '.exe' : ''
  const cache = join(tmpdir(), 'agent-board-test')
  const target = join(cache, `fake-herdr-${hash}${ext}`)
  if (existsSync(target)) return target
  mkdirSync(cache, { recursive: true })
  // Built under a private name, then renamed: a parallel run never sees a half-written exe.
  const part = join(cache, `fake-herdr-${hash}.${process.pid}.${Date.now()}${ext}`)
  const proc = Bun.spawn([process.execPath, 'build', '--compile', source, '--outfile', part], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`Compiling the fake herdr failed (${code}): ${stdout}${stderr}`)
  try {
    renameSync(part, target)
  } catch (err) {
    rmSync(part, { force: true })
    if (!existsSync(target)) throw err
  }
  return target
}

export function fakeHerdrBin(): Promise<string> {
  building ??= build().catch(err => {
    building = undefined
    throw err
  })
  return building
}
