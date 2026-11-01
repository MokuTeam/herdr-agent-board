// The quick look's viewers on the server (server/viewers.ts, #176): every worker they start runs
// under a policy of its own, served with it, and the workers that read a file are held to
// reading it from the board.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { RouteContext } from '../../src/server/http.ts'
import { staticRoute } from '../../src/server/routes/static.ts'
import { VIEWER_COPIES, viewerEntries, WORKER_POLICIES } from '../../src/server/viewers.ts'

test('every viewer’s worker is served under its own policy; the Office ones may only read from the board', async () => {
  const workers = [...Object.keys(viewerEntries('web')), ...Object.keys(VIEWER_COPIES)].filter(n =>
    /worker\.js$/.test(n),
  )
  expect(workers.sort()).toEqual(['document-worker.js', 'pdf.worker.js', 'spreadsheet-worker.js'])
  for (const name of workers) expect([name, Object.hasOwn(WORKER_POLICIES, name)]).toEqual([name, true])
  expect(WORKER_POLICIES['document-worker.js']).toBe("default-src 'none'; connect-src 'self'")
  expect(WORKER_POLICIES['spreadsheet-worker.js']).toBe("default-src 'none'; connect-src 'self'")

  const route = staticRoute(
    join(import.meta.dir, 'missing-web'),
    { js: () => '', map: () => '', early: () => '', file: name => (workers.includes(name) ? 'self.x = 1' : undefined) },
    undefined,
    { policies: WORKER_POLICIES },
  )
  for (const name of workers) {
    const res = (await route.handle(new Request(`http://127.0.0.1/${name}`), {
      path: `/${name}`,
    } as RouteContext)) as Response
    expect([name, res.headers.get('content-security-policy')]).toEqual([name, WORKER_POLICIES[name] as string])
  }
})
