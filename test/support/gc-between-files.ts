// Preloaded by `bun run test` and `bun run test:fast` (package.json): a full garbage collection once
// each test file is done. Bun's workers give every file a fresh global, and what the files before
// left was collected late: a worker grew to about 850 MB. With this one, about 450 MB, so six
// workers fit where four did (#358).
import { afterAll } from 'bun:test'

afterAll(() => {
  Bun.gc(true)
})
