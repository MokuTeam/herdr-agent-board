// The probe through the domain, against a local Bun.serve standing in for the domain.
import { expect, onTestFinished, test } from 'bun:test'
import { fetchProbe, probeOrigin, probeOriginAt } from '../../src/adapters/probe.ts'
import { tunnelConfig } from '../../src/core/tunnel.ts'

const NONCE = '0123456789abcdef0123456789abcdef'

/** A server on 127.0.0.1 answering every request so, stopped after the test; its port. */
function serving(answer: (req: Request) => Response | Promise<Response>): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: answer })
  onTestFinished(() => server.stop(true))
  return server.port ?? 0
}
const origin = (port: number): string => `http://127.0.0.1:${port}`

test('the board’s answer to its nonce: ok; asked with a GET of /api/probe/<nonce>', async () => {
  const seen: string[] = []
  const port = serving(req => {
    seen.push(`${req.method} ${new URL(req.url).pathname}`)
    return Response.json({ board: 'agent-board', probe: NONCE })
  })
  expect(await fetchProbe(origin(port), NONCE)).toEqual({ ok: true })
  expect(await fetchProbe(`${origin(port)}/`, NONCE)).toEqual({ ok: true })
  expect(seen).toEqual([`GET /api/probe/${NONCE}`, `GET /api/probe/${NONCE}`])
})

test('another status: its number; a redirect is not followed', async () => {
  const port = serving(req =>
    new URL(req.url).pathname.startsWith('/elsewhere')
      ? Response.json({ board: 'agent-board', probe: NONCE })
      : new Response('Bad Gateway', { status: 502 }),
  )
  expect(await fetchProbe(origin(port), NONCE)).toEqual({ ok: false, kind: 'status', status: 502, detail: '502' })
  const moved = serving(() => Response.redirect(`${origin(port)}/elsewhere`, 302))
  expect(await fetchProbe(origin(moved), NONCE)).toEqual({ ok: false, kind: 'status', status: 302, detail: '302' })
})

test('a 200 with another body: answer', async () => {
  const bodies = [
    () => Response.json({ board: 'agent-board', probe: 'f'.repeat(32) }),
    () => Response.json({ board: 'another', probe: NONCE }),
    () => new Response('<!DOCTYPE html><html><body>Welcome to nginx!</body></html>'),
    () => new Response(''),
    () => new Response('x'.repeat(1 << 20)),
  ]
  for (const body of bodies) {
    const r = await fetchProbe(origin(serving(body)), NONCE)
    expect(r).toMatchObject({ ok: false, kind: 'answer' })
    if (!r.ok) expect(r.detail.length).toBeLessThanOrEqual(200)
  }
  const page = await fetchProbe(origin(serving(bodies[2] ?? (() => new Response('')))), NONCE)
  expect(page).toMatchObject({ detail: expect.stringContaining('Welcome to nginx!') })
})

test('a closed port: network; TLS spoken to a server without it: tls; no answer in time: network', async () => {
  const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = closed.port ?? 0
  closed.stop(true)
  expect(await fetchProbe(origin(port), NONCE)).toMatchObject({ ok: false, kind: 'network' })

  const plain = serving(() => Response.json({ board: 'agent-board', probe: NONCE }))
  expect(await fetchProbe(`https://127.0.0.1:${plain}`, NONCE)).toMatchObject({ ok: false, kind: 'tls' })

  const silent = serving(() => new Promise<Response>(() => {}))
  const started = Date.now()
  expect(await fetchProbe(origin(silent), NONCE, 200)).toMatchObject({ ok: false, kind: 'network' })
  expect(Date.now() - started).toBeLessThan(5000)
})

test('probeOrigin: https://<domain>, with the public port unless it is 443; or BOARD_TUNNEL_PROBE_ORIGIN', () => {
  const conf = tunnelConfig({ domain: 'board.example.com' })
  const conf8443 = { ...conf, publicPort: 8443 }
  expect(probeOrigin(conf, {})).toBe('https://board.example.com')
  expect(probeOrigin({ ...conf, publicPort: 443 }, {})).toBe('https://board.example.com')
  expect(probeOrigin(conf8443, {})).toBe('https://board.example.com:8443')
  for (const c of [conf, conf8443]) {
    expect(probeOrigin(c, { BOARD_TUNNEL_PROBE_ORIGIN: 'http://127.0.0.1:40123' })).toBe('http://127.0.0.1:40123')
    expect(probeOrigin(c, { BOARD_TUNNEL_PROBE_ORIGIN: '' })).toBe(probeOrigin(c, {}))
  }
})

test('probeOriginAt (a Test that finds the public port): https://<domain> on 443, with the port on another; or BOARD_TUNNEL_PROBE_ORIGIN', () => {
  const conf = tunnelConfig({ domain: 'board.example.com', publicPort: 8443 })
  expect(probeOriginAt(conf, 443, {})).toBe('https://board.example.com')
  expect(probeOriginAt(conf, 8443, {})).toBe('https://board.example.com:8443')
  expect(probeOriginAt(conf, 8443, { BOARD_TUNNEL_PROBE_ORIGIN: 'http://127.0.0.1:40123' })).toBe(
    'http://127.0.0.1:40123',
  )
})

test('with a Host given, that Host goes; without, the origin’s, as before', async () => {
  const hosts: string[] = []
  const port = serving(req => {
    hosts.push(req.headers.get('host') ?? '')
    return Response.json({ board: 'agent-board', probe: NONCE })
  })
  expect(await fetchProbe(origin(port), NONCE, 5000, 'board.example.com')).toEqual({ ok: true })
  expect(await fetchProbe(origin(port), NONCE)).toEqual({ ok: true })
  expect(hosts).toEqual(['board.example.com', `127.0.0.1:${port}`])
})
