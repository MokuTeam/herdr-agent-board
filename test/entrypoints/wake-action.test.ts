// `bun src/entrypoints/wake-action.ts sleep|wake [pane]`, herdr's "Put this Claude session to sleep"
// and "Wake the Claude session in this pane": the focused pane (herdr's plugin context, else the
// pane it runs in) goes to the wake's API on wake.port; with wake off nothing is sent.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox } from '../support/sandbox.ts'
import { endWithSandbox, wakeOnConfig, wakeSandbox, writeBoardConfig } from '../support/wake-process.ts'

setDefaultTimeout(30_000)

const ACTION_ENTRY = join(root, 'src', 'entrypoints', 'wake-action.ts')

async function runAction(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, ACTION_ENTRY, ...args], {
    cwd: root,
    env: { ...box.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  endWithSandbox(proc)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

/** A wake's API on the port that records what it is asked, answering `answer` to each sleep or wake. */
function fakeWake(port: number, answer: (path: string, target: unknown) => unknown) {
  const asked: { method: string; path: string; body: unknown }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: async req => {
      const path = new URL(req.url).pathname
      const body = req.method === 'POST' ? await req.json() : null
      asked.push({ method: req.method, path, body })
      return Response.json(answer(path, (body as { target?: unknown } | null)?.target))
    },
  })
  return { asked, stop: () => server.stop(true) }
}

const context = (focused: string): string => JSON.stringify({ focused_pane_id: focused, workspace_id: 'w1' })

test('wake-action: the focused pane goes to the wake’s API; wake off sends nothing', async () => {
  const box = await wakeSandbox()
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  const wake = fakeWake(port, (path, target) =>
    target === 'w1:p3'
      ? { ok: false, error: 'Ledger is not idle' }
      : { ok: true, name: 'Billing 100%', pane: target, ...(path === '/wake' && { already: true }) },
  )
  try {
    // The focused pane from herdr's context, over the pane the action runs in.
    const slept = await runAction(box, ['sleep'], {
      HERDR_PLUGIN_CONTEXT_JSON: context('w1:p2'),
      HERDR_PANE_ID: 'w9:p9',
    })
    expect(slept).toMatchObject({ code: 0, stdout: 'asleep: Billing 100% (w1:p2)\n' })
    // No context: the pane it runs in.
    const woke = await runAction(box, ['wake'], { HERDR_PANE_ID: 'w1:p4' })
    expect(woke).toMatchObject({ code: 0, stdout: 'awake: Billing 100% (w1:p4)\n' })
    // A pane given wins; wake's error is printed, and the exit is 1.
    const refused = await runAction(box, ['sleep', 'w1:p3'], { HERDR_PLUGIN_CONTEXT_JSON: context('w1:p2') })
    expect(refused).toMatchObject({ code: 1, stdout: 'Ledger is not idle\n' })
    expect(wake.asked).toEqual([
      { method: 'POST', path: '/sleep', body: { target: 'w1:p2' } },
      { method: 'POST', path: '/wake', body: { target: 'w1:p4' } },
      { method: 'POST', path: '/sleep', body: { target: 'w1:p3' } },
    ])

    // Wake off: nothing sent.
    for (const off of [{ ...wakeOnConfig(port), wake: false }, '{ "wake": tr']) {
      writeBoardConfig(box, off)
      const out = await runAction(box, ['sleep'], { HERDR_PLUGIN_CONTEXT_JSON: context('w1:p2') })
      expect(out).toMatchObject({ code: 1, stdout: 'wake is off\n' })
    }
    expect(wake.asked).toHaveLength(3)
  } finally {
    await wake.stop()
  }
})

test('wake-action: no wake answering, or no pane, is an error, never a hang', async () => {
  const box = await wakeSandbox()
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  const down = await runAction(box, ['wake'], { HERDR_PANE_ID: 'w1:p4' })
  expect(down.code).toBe(1)
  expect(down.stdout).toContain(`wake does not answer on 127.0.0.1:${port}`)
  const nowhere = await runAction(box, ['wake'], { HERDR_PANE_ID: '' })
  expect(nowhere.code).toBe(2)
  expect(nowhere.stderr).toContain('usage: bun src/entrypoints/wake-action.ts sleep|wake [pane id]')
  expect((await runAction(box, ['nap'], { HERDR_PANE_ID: 'w1:p4' })).code).toBe(2)
})
