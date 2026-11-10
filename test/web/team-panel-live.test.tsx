// The Team panel's view in a page whose effects run (react-dom in support/mini-dom.ts): without the
// payload's teamRev, or on a remote page, /api/team is never asked, even with the panel open; with
// it, it is asked once on opening and again when teamRev changes.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { BoardPayload } from '../../src/core/payload.ts'
import { board, payload } from './support/board.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { miniWindow } from './support/mini-dom.ts'

type Dom = ReturnType<typeof miniWindow>
let dom: Dom
let show: (data: BoardPayload, open?: boolean) => Promise<void>
let root: { unmount(): void }
let flush: (fn: () => void) => void

const VIEW = {
  state: 'online',
  me: { peer: null, fingerprint: '', name: null },
  hub: 'wss://h.example.com',
  roster: [],
}

beforeAll(async () => {
  dom = miniWindow(800)
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const { useTeam } = await import('../../web/src/hooks/useTeam.ts')
  const { I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx')
  const { BoardContext } = await import('../../web/src/state/BoardProvider.tsx')
  const container = dom.document.body.appendChild(dom.document.createElement('div'))
  const r = createRoot(container as unknown as HTMLElement)
  root = r
  flush = flushSync
  function Probe({ open }: { open: boolean }) {
    useTeam(open)
    return null
  }
  show = async (data, open = true) => {
    flushSync(() =>
      r.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board({ data })}>
            <Probe open={open} />
          </BoardContext.Provider>
        </I18nProvider>,
      ),
    )
    await new Promise(done => setTimeout(done, 10))
  }
})

afterEach(() => {
  restoreFetch()
  dom.document.documentElement.removeAttribute('data-remote')
})

afterAll(async () => {
  flush(() => root.unmount())
  await new Promise(done => setTimeout(done, 20))
  dom.uninstall()
})

test('no teamRev: nothing is asked, open or not', async () => {
  const calls = answers([200, VIEW])
  await show(payload())
  expect(calls).toHaveLength(0)
})

test('teamRev on a remote page: nothing is asked', async () => {
  const calls = answers([200, VIEW])
  dom.document.documentElement.setAttribute('data-remote', '')
  await show(payload({ teamRev: 1 }))
  expect(calls).toHaveLength(0)
})

test('teamRev on the local page: asked on opening, again on a new revision', async () => {
  const calls = answers([200, VIEW], [200, VIEW])
  await show(payload({ teamRev: 1 }))
  expect(calls.map(c => c.url)).toEqual(['/api/team'])
  await show(payload({ teamRev: 2 }))
  expect(calls.map(c => c.url)).toEqual(['/api/team', '/api/team'])
})
