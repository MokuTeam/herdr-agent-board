// Where a MokuPilot call starts (core/mokupilot-mode.ts): the mode config.json asks for, the older
// `link: true` read as `link`, and under `auto` who looks, by the request: a peer on loopback says
// nothing alone (tailscale serve and the tunnel's Caddy reach the board on 127.0.0.1), the proxy's
// X-Forwarded-For does.
import { expect, test } from 'bun:test'
import {
  isLoopback,
  MOKUPILOT_MODES,
  mokupilotMode,
  plainAddress,
  resolveMode,
  type Viewer,
  viewerPlace,
} from '../../src/core/mokupilot-mode.ts'

// This computer: its LAN address, its Tailscale ones (IPv4 and IPv6).
const OWN = ['192.168.1.20', '100.101.102.103', 'fd7a:115c:a1e0::1234']
const PHONE = '100.64.0.7'

const direct = (peer: string): Viewer => ({ peer, forwardedFor: null })
const proxied = (forwardedFor: string, peer = '127.0.0.1'): Viewer => ({ peer, forwardedFor })

test('the mode: `mode` when it is one, the older `link: true` as link, else auto', () => {
  expect(MOKUPILOT_MODES).toEqual(['auto', 'local', 'link'])
  expect(mokupilotMode(undefined)).toBe('auto')
  expect(mokupilotMode(null)).toBe('auto')
  expect(mokupilotMode(false)).toBe('auto')
  expect(mokupilotMode({})).toBe('auto')
  expect(mokupilotMode({ dir: '~/MokuPilot' })).toBe('auto')
  expect(mokupilotMode({ command: ['meet'] })).toBe('auto')
  // Backward compatible: the hidden key of the link mode.
  expect(mokupilotMode({ link: true })).toBe('link')
  expect(mokupilotMode({ link: false })).toBe('auto')
  expect(mokupilotMode({ link: 'yes' })).toBe('auto')
  for (const mode of MOKUPILOT_MODES) expect(mokupilotMode({ mode })).toBe(mode)
  // The panel's `mode` beside an older `link`: the mode wins.
  expect(mokupilotMode({ link: true, mode: 'local' })).toBe('local')
  expect(mokupilotMode({ link: true, mode: 'auto' })).toBe('auto')
  // A mode the board does not know: as if none were written.
  expect(mokupilotMode({ mode: 'remote' })).toBe('auto')
  expect(mokupilotMode({ mode: 'remote', link: true })).toBe('link')
  expect(mokupilotMode({ mode: 'LINK' })).toBe('auto')
})

test('loopback and plain addresses', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1'])
    expect([a, isLoopback(a)]).toEqual([a, true])
  for (const a of ['', '10.0.0.1', '100.64.0.7', '::ffff:10.0.0.1', 'fe80::1', '128.0.0.1', 'localhost'])
    expect([a, isLoopback(a)]).toEqual([a, false])
  expect(plainAddress('::ffff:100.64.0.7')).toBe('100.64.0.7')
  expect(plainAddress('[FD7A:115C:A1E0::1234]')).toBe('fd7a:115c:a1e0::1234')
  expect(plainAddress('fe80::1%eth0')).toBe('fe80::1')
})

test('mode local: always here, whoever asks and from wherever', () => {
  for (const viewer of [
    null,
    direct('127.0.0.1'),
    direct(PHONE),
    proxied(PHONE),
    proxied('203.0.113.9, 100.64.0.7'),
    proxied('garbage'),
  ])
    expect(resolveMode('local', viewer, OWN)).toEqual({ mode: 'local', resolved: 'local', why: 'mode-local' })
})

test('mode link: always the viewer’s computer, even at this one', () => {
  for (const viewer of [null, direct('127.0.0.1'), direct('192.168.1.20'), direct(PHONE), proxied(PHONE)])
    expect(resolveMode('link', viewer, OWN)).toEqual({ mode: 'link', resolved: 'link', why: 'mode-link' })
})

test('auto, a loopback peer with no proxy in front: the board’s own computer (a visit to http://127.0.0.1)', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    for (const forwardedFor of [null, '', '  '])
      expect(resolveMode('auto', { peer, forwardedFor }, OWN)).toEqual({
        mode: 'auto',
        resolved: 'local',
        why: 'loopback-direct',
        viewer: plainAddress(peer),
      })
})

test('auto, a loopback peer behind a proxy here (tailscale serve, the tunnel): the forwarded address decides', () => {
  // A phone on the tailnet, through `tailscale serve`: its call goes to it, by the link.
  expect(resolveMode('auto', proxied(PHONE), OWN)).toEqual({
    mode: 'auto',
    resolved: 'link',
    why: 'forwarded-other',
    viewer: PHONE,
  })
  // The same on ::1 and as IPv4-mapped, and an IPv6 tailnet address.
  expect(resolveMode('auto', proxied(PHONE, '::1'), OWN).resolved).toBe('link')
  expect(resolveMode('auto', proxied('::ffff:100.64.0.7', '::ffff:127.0.0.1'), OWN).viewer).toBe(PHONE)
  expect(resolveMode('auto', proxied('fd7a:115c:a1e0::99'), OWN).resolved).toBe('link')
  // The last entry is the proxy's own: what the caller wrote before it does not count.
  expect(resolveMode('auto', proxied('127.0.0.1, 100.64.0.7'), OWN)).toMatchObject({
    resolved: 'link',
    why: 'forwarded-other',
    viewer: PHONE,
  })
  expect(resolveMode('auto', proxied('100.64.0.7, 192.168.1.20'), OWN)).toMatchObject({
    resolved: 'local',
    why: 'forwarded-own',
  })
  // This very computer through its own tailnet name: its Tailscale address is its own.
  expect(resolveMode('auto', proxied('100.101.102.103'), OWN)).toEqual({
    mode: 'auto',
    resolved: 'local',
    why: 'forwarded-own',
    viewer: '100.101.102.103',
  })
  expect(resolveMode('auto', proxied('FD7A:115C:A1E0::1234'), OWN).why).toBe('forwarded-own')
  // A proxy that says the caller is on loopback: this computer.
  expect(resolveMode('auto', proxied('127.0.0.1'), OWN)).toMatchObject({ resolved: 'local', why: 'forwarded-loopback' })
  expect(resolveMode('auto', proxied('::1'), OWN)).toMatchObject({ resolved: 'local', why: 'forwarded-loopback' })
  // Something that is no address: someone we cannot place, so nothing starts here for them.
  for (const header of ['unknown', '100.64.0.7, nonsense', ','])
    expect(resolveMode('auto', proxied(header), OWN)).toEqual({
      mode: 'auto',
      resolved: 'link',
      why: 'forwarded-unreadable',
      viewer: '',
    })
})

test('auto, a peer elsewhere (the remote listener on the tailnet address): the peer decides, its header not', () => {
  expect(resolveMode('auto', direct(PHONE), OWN)).toEqual({
    mode: 'auto',
    resolved: 'link',
    why: 'peer-other',
    viewer: PHONE,
  })
  expect(resolveMode('auto', direct('192.168.1.20'), OWN)).toMatchObject({ resolved: 'local', why: 'peer-own' })
  expect(resolveMode('auto', direct('::ffff:100.101.102.103'), OWN)).toMatchObject({
    resolved: 'local',
    why: 'peer-own',
  })
  // Only a loopback peer is a proxy we trust: a phone that sends the header itself is still the phone.
  expect(resolveMode('auto', proxied('127.0.0.1', PHONE), OWN)).toMatchObject({ resolved: 'link', why: 'peer-other' })
  expect(resolveMode('auto', proxied(PHONE, '192.168.1.20'), OWN)).toMatchObject({ resolved: 'local', why: 'peer-own' })
})

test('auto with no request to look at, or no addresses of this computer known', () => {
  // A call with no request (a test, the CLI) or a peer the listener cannot say: here, as before the modes.
  expect(resolveMode('auto', null, OWN)).toEqual({ mode: 'auto', resolved: 'local', why: 'no-peer', viewer: '' })
  expect(resolveMode('auto', undefined, OWN).why).toBe('no-peer')
  expect(resolveMode('auto', { peer: '', forwardedFor: PHONE }, OWN).why).toBe('no-peer')
  // Unreadable interfaces: loopback still counts, a forwarded address is someone else.
  expect(viewerPlace(direct('127.0.0.1'), []).local).toBe(true)
  expect(viewerPlace(proxied('100.101.102.103'), [])).toEqual({
    local: false,
    address: '100.101.102.103',
    why: 'forwarded-other',
  })
})
