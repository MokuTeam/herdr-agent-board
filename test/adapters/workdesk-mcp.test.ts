import { expect, test } from 'bun:test'
import { withWorkdeskMcp } from '../../src/adapters/workdesk-mcp.ts'

// Answers the handshake, then leaves on the first tool call, the way an adapter crashes mid-call.
const crashing = `
for await (const line of require('node:readline').createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line)
  if (id === undefined) continue
  if (method === 'tools/call') process.exit(1)
  const result = method === 'initialize' ? { protocolVersion: '2024-11-05' } : { tools: [] }
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
}
`

// On Windows a write to the gone adapter rejects later (EPIPE); left unawaited, the runner fails
// the test on that unhandled rejection.
test('a call after the adapter has gone rejects that call and leaves no unhandled rejection behind', async () => {
  const config = { executable: process.execPath, args: ['-e', crashing], intervalSec: 120 }
  const outcomes = await withWorkdeskMcp(config, new AbortController().signal, async mcp => {
    await mcp.tools()
    const settle = (name: string) =>
      mcp.call(name, {}).then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      )
    // The next write follows the end of the adapter's output at once, as the watcher's next claim does.
    return [await settle('claim_task'), await settle('claim_task'), await settle('claim_task')]
  })
  expect(outcomes[0]).toBe('Workdesk MCP disconnected')
  expect(outcomes.every(outcome => outcome !== 'resolved')).toBe(true)
})
