// A process of its own that opens an existing board database (test/adapters/db.test.ts): with one
// more step than the code ships, `bun db-migrator.ts <file>`; with the code's own steps,
// `bun db-migrator.ts <file> shipped`. Prints "ok" or the error.
import { openDb } from '../../src/adapters/db.ts'
import { LATEST, MIGRATIONS } from '../../src/adapters/db-schema.ts'

const [path = '', which = 'extra'] = process.argv.slice(2)
try {
  const db = openDb({
    path,
    steps:
      which === 'shipped'
        ? MIGRATIONS
        : [...MIGRATIONS, { version: LATEST + 1, store: 'test', sql: 'CREATE TABLE extra (v TEXT) STRICT' }],
  })
  if (!db) throw new Error('no database')
  db.close()
  console.log('ok')
} catch (err) {
  console.log(`error ${(err as Error).message}`)
  process.exitCode = 1
}
