// A process of its own that holds the board database's write lock while it adds an entry, as an
// agent's `board time add` does (test/adapters/time-store.test.ts, Raise under the lock):
// bun time-holder.ts <file> <entry JSON> <ms>. Prints "held" once the lock is its, commits after
// <ms>, then prints "done".
import { Database } from 'bun:sqlite'

const [path = '', entry = '{}', ms = '500'] = process.argv.slice(2)
const e = JSON.parse(entry) as Record<string, string | number | null>
const db = new Database(path)
db.exec('PRAGMA busy_timeout = 5000')
db.exec('BEGIN IMMEDIATE')
db.query(
  'INSERT INTO time_entries (id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
).run(
  e.id ?? '',
  e.client ?? '',
  e.project ?? '',
  e.description ?? '',
  '[]',
  e.start ?? '',
  e.stop ?? '',
  e.date ?? '',
  'user',
  Date.now(),
  Date.now(),
  'user',
)
console.log('held')
await Bun.sleep(Number(ms))
db.exec('COMMIT')
db.close()
console.log('done')
