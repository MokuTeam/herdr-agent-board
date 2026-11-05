// A process of its own that writes to the board's database, for the tests of several processes at
// once (test/adapters/db.test.ts): bun db-writer.ts <file> <count> <name>. Each change is one
// journal row; it prints "ok <n>" or the error.
import { openDb } from '../../src/adapters/db.ts'

const [path = '', count = '10', name = 'w'] = process.argv.slice(2)
try {
  const db = openDb({ path })
  if (!db) throw new Error('no database')
  let n = 0
  for (let i = 0; i < Number(count); i++) {
    db.write(name, tx => {
      // read, then write in the same transaction: the case a plain BEGIN would fail with SQLITE_BUSY
      const before = db.lastChange().seq
      tx.journal({ store: 'test', op: 'add', ref: `${name}-${i}`, after: { before } })
    })
    n++
  }
  db.close()
  console.log(`ok ${n}`)
} catch (err) {
  console.log(`error ${(err as Error).message}`)
  process.exitCode = 1
}
