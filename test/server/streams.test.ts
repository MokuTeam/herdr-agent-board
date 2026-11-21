// What a desk may ask of /api/remote (server/streams.ts deskOpRefusal), past remoteRefusal: the
// listener on the Tailscale address and serve's run it for a desk; pwa.test.ts drives it end to end.
import { expect, test } from 'bun:test'
import { deskOpRefusal } from '../../src/server/streams.ts'

const post = (body: string, path = '/api/remote') =>
  new Request(`http://box${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

const refusal = async (req: Request) => {
  const res = await deskOpRefusal(req, new URL(req.url).pathname)
  return res && [res.status, await res.json()]
}

test('a desk answers the phones that ask and unpairs; every other op of /api/remote is refused', async () => {
  for (const op of ['approve', 'deny', 'revoke'])
    expect([op, await refusal(post(JSON.stringify({ op, id: 'x' })))]).toEqual([op, null])
  for (const op of ['on', 'off', 'pwa-on', 'pwa-off', 'desk', 'undesk', 'APPROVE', '', 1, null])
    expect([op, await refusal(post(JSON.stringify({ op, id: 'x' })))]).toEqual([op, [403, { error: 'local' }]])
})

test('a body that is no JSON object, or one too big, is no op: refused, never thrown', async () => {
  for (const body of ['null', '"approve"', '42', '["approve"]', '[{"op":"approve"}]', 'not json', ''])
    expect([body, await refusal(post(body))]).toEqual([body, [403, { error: 'local' }]])
  const big = JSON.stringify({ op: 'approve', id: 'x', pad: 'x'.repeat(2_000_000) })
  expect(await refusal(post(big))).toEqual([403, { error: 'local' }])
})

test('anything but a POST to /api/remote itself is not its business', async () => {
  expect(await refusal(new Request('http://box/api/remote'))).toBeNull()
  expect(await refusal(post('{"op":"off"}', '/api/remote/x'))).toBeNull()
  expect(await refusal(post('{"op":"off"}', '/api/board'))).toBeNull()
})

test('the request it read stays readable for the route', async () => {
  const req = post(JSON.stringify({ op: 'approve', id: 'x' }))
  expect(await refusal(req)).toBeNull()
  expect(await req.json()).toEqual({ op: 'approve', id: 'x' })
})
