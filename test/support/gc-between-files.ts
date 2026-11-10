// Preloaded by `bun run test` and `bun run test:fast` (package.json): a full garbage collection at
// the end of each test file, which frees what the files before it left (the file's own objects go
// at the next one's end). Bun's workers give every file a fresh global, and the old ones were
// collected late: a worker grew to about 850 MB; with this, about 430 MB at four workers, so six
// fit where four did (#358). Only under the workers: a plain `bun test` does not load it.
import { afterAll } from 'bun:test'

afterAll(() => {
  Bun.gc(true)
})
