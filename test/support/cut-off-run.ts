// A test run that is cut off midway (sandbox.test.ts): a sandbox, and a child of it that started a
// program of its own, detached, that would run for good. Their pids and the sandbox's folder go to
// the file named first; then the run waits to be stopped.
import { renameSync, writeFileSync } from 'node:fs'
import { sandbox, until } from './sandbox.ts'

const out = process.argv[2] ?? ''
const box = await sandbox({ after: () => {} })
const child = box.run('detached')
await until(() => child.messages.length > 0, 15_000)
writeFileSync(`${out}.part`, JSON.stringify({ dir: box.dir, ...(child.messages[0] as object) }))
renameSync(`${out}.part`, out)
setInterval(() => {}, 1000)
