// A process of its own that adds the same time entry (test/adapters/time-store.test.ts): bun
// time-writer.ts <db file> <name>. Prints "new <id>" or "existing <id>", or the error.
import { openDb } from '../../src/adapters/db.ts'
import { addEntry } from '../../src/adapters/time-store.ts'
import { timeConfig } from '../../src/core/time.ts'

const [path = '', name = 'w'] = process.argv.slice(2)
try {
  const db = openDb({ path })
  if (!db) throw new Error('no database')
  const conf = timeConfig({ zone: 'America/New_York' })
  if (!conf) throw new Error('no config')
  const r = addEntry(
    db,
    conf,
    {
      client: 'a',
      project: 'Support',
      description: 'Case 10001 X: the same work, logged by two at once',
      start: Date.parse('2026-10-28T13:00:00Z'),
      stop: Date.parse('2026-10-28T14:00:00Z'),
      startGiven: true,
    },
    { key: name, name },
  )
  db.close()
  console.log(`${r.existing ? 'existing' : 'new'} ${r.entry.id}`)
} catch (err) {
  console.log(`error ${(err as Error).message}`)
  process.exitCode = 1
}
