// A process of its own that opens an existing board database with one more step than the code
// ships (test/adapters/db.test.ts): bun db-migrator.ts <file>. Prints "ok" or the error.
import { openDb } from '../../src/adapters/db.ts'
import { LATEST, MIGRATIONS } from '../../src/adapters/db-schema.ts'

const [path = ''] = process.argv.slice(2)
try {
  const db = openDb({
    path,
    steps: [...MIGRATIONS, { version: LATEST + 1, store: 'test', sql: 'CREATE TABLE extra (v TEXT) STRICT' }],
  })
  if (!db) throw new Error('no database')
  db.close()
  console.log('ok')
} catch (err) {
  console.log(`error ${(err as Error).message}`)
  process.exitCode = 1
}
