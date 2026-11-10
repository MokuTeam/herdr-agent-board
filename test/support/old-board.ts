// An old board server for #356's tests: a process of its own, run from a folder that is not this
// checkout (`<tmp>/old-checkout/src/entrypoints/server.ts`), that answers /api/hello as a board does
// and knows nothing else (no /api/team, no /api/process), as a board from before #232 would.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = `const s = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === '/api/hello') return Response.json({ board: 'agent-board', version: '0.1.0' })
    return Response.json({ error: 'not found' }, { status: 404 })
  },
})
console.log(s.port)
`

export interface OldBoard {
  pid: number
  port: number
  /** The folder it runs from: <tmp>/old-checkout. */
  checkout: string
  stop(): Promise<void>
}

export async function startOldBoard(): Promise<OldBoard> {
  const dir = mkdtempSync(join(tmpdir(), 'old-board-'))
  const checkout = join(dir, 'old-checkout')
  const script = join(checkout, 'src', 'entrypoints', 'server.ts')
  mkdirSync(join(checkout, 'src', 'entrypoints'), { recursive: true })
  writeFileSync(script, SERVER)
  const child = Bun.spawn([process.execPath, script], { cwd: checkout, stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  let out = ''
  while (!/\d+\s*\n/.test(out)) {
    const { done, value } = await reader.read()
    if (done) {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`the old board did not start: ${out}`)
    }
    out += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return {
    pid: child.pid,
    port: Number(out.trim()),
    checkout,
    async stop() {
      child.kill()
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
