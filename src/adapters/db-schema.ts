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
  {
    version: 2,
    store: 'time',
    // Time entries (core/time.ts TimeEntry): `date` is the work date stamped when written; a
    // removed entry stays with `deleted` (its Toggl id keeps the import from bringing it back). Two
    // live entries alike in client, project, description, start and stop are one: the index makes
    // a repeated `board time add` find the first, whatever process writes it.
    sql: `
      CREATE TABLE time_entries (
        id TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        project TEXT NOT NULL,
        description TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        start TEXT NOT NULL,
        stop TEXT NOT NULL,
        date TEXT NOT NULL,
        by TEXT NOT NULL,
        at INTEGER NOT NULL,
        changed INTEGER NOT NULL,
        changed_by TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER,
        toggl TEXT
      ) STRICT;
      CREATE INDEX time_by_date ON time_entries (date, client);
      CREATE UNIQUE INDEX time_live_same ON time_entries (client, project, description, start, stop) WHERE deleted IS NULL;
      CREATE UNIQUE INDEX time_toggl ON time_entries (toggl) WHERE toggl IS NOT NULL;
    `,
  },
  {
    version: 3,
    store: 'time',
    // An entry billable or not as set on it (1 or 0; NULL: as the config says, which every entry
    // written before this step is). An entry entered into one of its client's systems (an ERP's
    // time records, a tracker's worklog): one mark per entry and system, with when, by whom, that
    // system's own id for the record, and the entry's revision then (a later one: changed after
    // it was entered). A mark is no change of the entry: its revision stays.
    sql: `
      ALTER TABLE time_entries ADD COLUMN billable INTEGER;
      CREATE TABLE time_marks (
        entry TEXT NOT NULL,
        system TEXT NOT NULL,
        at INTEGER NOT NULL,
        by TEXT NOT NULL,
        record TEXT,
        rev INTEGER NOT NULL,
        PRIMARY KEY (entry, system)
      ) STRICT;
    `,
  },
]

/** The version the code makes a file: the last step's. */
export const LATEST = MIGRATIONS.at(-1)?.version ?? 0
