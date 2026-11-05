// A process of its own that adds projects to a lane's list in config.json (test/adapters/config-file.test.ts):
// bun config-writer.ts <lane> <project>... Prints "ready" just before it does, then "ok" or the error.
import { addTimeProjects } from '../../src/adapters/config-file.ts'

const [lane = '', ...projects] = process.argv.slice(2)
console.log('ready')
try {
  const r = addTimeProjects(lane, projects)
  console.log(r.ok ? 'ok' : `error ${r.error}`)
} catch (err) {
  console.log(`error ${(err as Error).message}`)
  process.exitCode = 1
}
