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
  {
    version: 4,
    store: 'calendar',
    // The board's own calendar (#328, adapters/calendar-store.ts): events agents and the owner put
    // on it. A timed event's `start` and `end` are UTC instants (2026-11-02T13:00:00Z), an all-day
    // one's dates with `end` the day after its last; a removed one stays with `deleted`. Nothing
    // reads the table while the calendar is off. A provider's events are not kept here: they are
    // a copy in the state folder (adapters/calendar-cache.ts), out of the journal and the backups.
    sql: `
      CREATE TABLE cal_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        location TEXT,
        join_url TEXT,
        note TEXT,
        by TEXT NOT NULL,
        at INTEGER NOT NULL,
        changed INTEGER NOT NULL,
        changed_by TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER
      ) STRICT;
      CREATE INDEX cal_by_start ON cal_events (start);
    `,
  },
  {
    version: 5,
    store: 'threads',
    // Threads (#379, adapters/work-thread-store.ts): one row per thread, its head, which is what
    // applying its entries' `set` in order gives (core/work-threads.ts applyEntry); parties, scope
    // and origin as JSON. The feed: entries are never changed or removed; `seq` is the journal row
    // an entry was written with, what a session's cursor counts in; `fields` its `set`; `out` a
    // shared entry's state (phase 4). The per-lane counter for keys. Watches: which session hears
    // of which thread, lane or `mine`, how much, whether only while free, whether it wakes it, and
    // the threads revision when it began (it hears only what came after). A
    // session's cursor: `seq` the last change an event was queued for, `at` when that event was
    // due (the gap counts from it), `asked` the last change `board thread changes` showed. Watches
    // and cursors are bookkeeping of who was told what: no journal row. Nothing reads the tables
    // while threads are off.
    sql: `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        lane TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        waiting_on TEXT NOT NULL DEFAULT '',
        proposed TEXT,
        assignee TEXT,
        parent TEXT,
        scope TEXT NOT NULL DEFAULT '"local"',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER,
        rev INTEGER NOT NULL DEFAULT 0,
        origin TEXT
      ) STRICT;
      CREATE INDEX threads_by_lane ON threads (lane, status);
      CREATE INDEX threads_by_parent ON threads (parent) WHERE parent IS NOT NULL;
      CREATE TABLE thread_entries (
        id TEXT PRIMARY KEY,
        thread TEXT NOT NULL REFERENCES threads (id),
        n INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        author TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        fields TEXT,
        links TEXT,
        files TEXT,
        reply_to TEXT,
        private INTEGER NOT NULL DEFAULT 0,
        closed INTEGER,
        out TEXT
      ) STRICT;
      CREATE INDEX thread_entries_by_n ON thread_entries (thread, n);
      CREATE INDEX thread_entries_by_seq ON thread_entries (seq);
      CREATE TABLE thread_seq (
        lane TEXT PRIMARY KEY,
        n INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE thread_watch (
        session TEXT NOT NULL,
        target TEXT NOT NULL,
        what TEXT NOT NULL,
        idle INTEGER NOT NULL DEFAULT 0,
        wake INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL,
        since INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session, target)
      ) STRICT;
      CREATE INDEX thread_watch_by_target ON thread_watch (target);
      CREATE TABLE thread_cursor (
        session TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        asked INTEGER NOT NULL
      ) STRICT;
    `,
  },
]

/** The version the code makes a file: the last step's. */
export const LATEST = MIGRATIONS.at(-1)?.version ?? 0
