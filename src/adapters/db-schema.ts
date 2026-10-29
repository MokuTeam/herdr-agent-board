// The board's database's tables (#233), as one ordered list of steps: the file's `user_version`
// is the last step it went through. A store that moves in adds its steps at the end, each naming
// the store it is for; a step is never changed once it shipped, a later one changes what it made.

export interface Migration {
  /** The `user_version` the file has once this step ran: 1, 2, 3… with no gap. */
  version: number
  /** The store the step is for ('db': the database's own tables, shared by every store). */
  store: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    store: 'db',
    // Every change of every store, with the row before and after it as JSON (null: none), who
    // made it and when: written in the change's own transaction (db.ts write). Its last seq is the
    // database's change counter, which the backup and an open panel watch.
    sql: `
      CREATE TABLE journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        by TEXT NOT NULL,
        store TEXT NOT NULL,
        op TEXT NOT NULL,
        ref TEXT NOT NULL,
        before TEXT,
        after TEXT
      ) STRICT;
      CREATE INDEX journal_ref ON journal (store, ref);
    `,
  },
]

/** The version the code makes a file: the last step's. */
export const LATEST = MIGRATIONS.at(-1)?.version ?? 0
