// Nodes (#496, #497), their pure rules: config.json's `nodes` and `node`, device ids, the
// `@<device>:` key prefix and the thresholds a device starts with. A board without either key
// gets null from both readers, so nothing that reads them goes anywhere new.
import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../../src/core/categories.ts'
import {
  configuredNodeAddresses,
  DEVICE_ID,
  type DeviceConfig,
  defaultThresholds,
  deviceIdFromHost,
  LOCAL,
  laneMayLeave,
  markRevoked,
  NODE_PORT,
  type NodesConfig,
  nodeConfig,
  nodeKey,
  nodeProblems,
  nodesConfig,
  parseNodeKey,
} from '../../src/core/nodes.ts'

const ssh = { kind: 'ssh', host: '203.0.113.10', user: 'agent-board-link' }
/** A device with its bare maps as plain objects, for deepEqual. */
const plain = (d: DeviceConfig | undefined) => d && { ...d, profiles: { ...d.profiles }, mcp: { ...d.mcp } }
const conf = (raw: unknown, host = 'LAPTOP'): NodesConfig => {
  const c = nodesConfig(raw, host)
  assert.ok(c)
  return c
}

describe('Without nodes or node', () => {
  test('no key, false, or anything but an object is null', () => {
    for (const raw of [undefined, null, false, true, 0, 'laptop', [], [{ id: 'x' }]]) {
      assert.equal(nodesConfig(raw, 'LAPTOP'), null)
      assert.equal(nodeConfig(raw), null)
      assert.deepEqual(nodeProblems(raw), [])
    }
  })

  test('a config without them gains no key of theirs', () => {
    const cfg = normalizeConfig({ language: 'en' })
    assert.equal('nodes' in cfg, false)
    assert.equal('node' in cfg, false)
    assert.equal(nodesConfig(cfg.nodes, 'LAPTOP'), null)
    assert.equal(nodeConfig(cfg.node), null)
  })
})

describe('nodesConfig', () => {
  test('the example of the design, read whole', () => {
    const c = conf({
      id: 'laptop',
      order: ['server-1', 'server-2', 'local'],
      whenFull: 'local',
      lanes: ['atlas', 'tools'],
      relay: { host: 'relay.example.com', sshPort: 22, user: 'agent-board-relay-m' },
      devices: {
        'server-1': {
          title: 'Server 1',
          link: { ...ssh, sshPort: 22, port: 12430 },
          maxSessions: 4,
          minFreeMemMb: 1200,
          maxLoad: 0.9,
          tags: ['linux', 'tests'],
          profiles: { work: 'work' },
          paused: false,
          drain: false,
          sinks: {},
          mcp: { 'some-server': false },
          accept: ['hook:notify-toast'],
        },
        'server-2': { link: { kind: 'relay', socket: 'server-2.sock' } },
        local: { maxSessions: 20, minFreeMemMb: 4800 },
      },
    })
    assert.deepEqual(c.problems, [])
    assert.equal(c.id, 'laptop')
    assert.deepEqual(c.order, ['server-1', 'server-2', 'local'])
    assert.equal(c.whenFull, 'local')
    assert.deepEqual(c.lanes, ['atlas', 'tools'])
    assert.deepEqual(c.relay, { host: 'relay.example.com', sshPort: 22, user: 'agent-board-relay-m' })
    assert.deepEqual(plain(c.devices['server-1']), {
      id: 'server-1',
      title: 'Server 1',
      link: { kind: 'ssh', host: '203.0.113.10', sshPort: 22, user: 'agent-board-link', port: 12430 },
      maxSessions: 4,
      minFreeMemMb: 1200,
      maxLoad: 0.9,
      tags: ['linux', 'tests'],
      profiles: { work: 'work' },
      paused: false,
      drain: false,
      sinks: {},
      mcp: { 'some-server': false },
      accept: ['hook:notify-toast'],
    })
    assert.deepEqual(c.devices['server-2']?.link, { kind: 'relay', socket: 'server-2.sock' })
    assert.equal(c.devices['server-2']?.title, 'server-2')
    assert.equal(c.devices.local?.link, null)
    assert.equal(c.devices.local?.maxSessions, 20)
    assert.equal(c.devices.local?.minFreeMemMb, 4800)
  })

  test('an empty section: this computer alone, nothing leaves, defaults', () => {
    const c = conf({})
    assert.equal(c.id, 'laptop')
    assert.deepEqual(c.order, [LOCAL])
    assert.deepEqual(Object.keys(c.devices), [LOCAL])
    assert.deepEqual(plain(c.devices.local), {
      id: 'local',
      title: 'laptop',
      link: null,
      maxSessions: null,
      minFreeMemMb: null,
      maxLoad: null,
      tags: [],
      profiles: {},
      paused: false,
      drain: false,
      sinks: {},
      mcp: {},
      accept: [],
    })
    assert.equal(c.whenFull, 'local')
    assert.deepEqual(c.lanes, [])
    assert.equal(c.relay, null)
    assert.deepEqual(c.problems, [])
  })

  test('local device title defaults to nodes.id (or hostName) and never resolves to "local" (#752)', () => {
    const named = conf({ id: 'server-2', devices: {} })
    assert.equal(named.devices.local?.title, 'server-2')

    const fromHost = nodesConfig({ devices: {} }, 'Atlas-Box')
    assert.equal(fromHost?.id, 'atlas-box')
    assert.equal(fromHost?.devices.local?.title, 'atlas-box')

    const custom = conf({ id: 'server-2', devices: { local: { title: 'Офис 50%' } } })
    assert.equal(custom.devices.local?.title, 'Офис 50%')

    const legacyLocalTitle = conf({ id: 'server-2', devices: { local: { title: 'local' } } })
    assert.equal(legacyLocalTitle.devices.local?.title, 'server-2')

    const mixedCaseLocalTitle = conf({
      id: 'server-2',
      devices: {
        local: { title: ' Local ' },
        laptop: { link: ssh, title: 'LOCAL' },
      },
    })
    assert.equal(mixedCaseLocalTitle.devices.local?.title, 'server-2')
    assert.equal(mixedCaseLocalTitle.devices.laptop?.title, 'laptop')
  })

  test('link defaults: ssh port 22, the door 12430', () => {
    const c = conf({ devices: { a: { link: ssh }, b: { link: { kind: 'tailnet', address: '100.64.0.9' } } } })
    assert.deepEqual(c.devices.a?.link, { ...ssh, sshPort: 22, port: NODE_PORT })
    assert.deepEqual(c.devices.b?.link, { kind: 'tailnet', address: '100.64.0.9', port: NODE_PORT })
    const d = conf({ devices: { t: { link: { kind: 'direct', url: 'http://127.0.0.1:45001' } } } })
    assert.deepEqual(d.devices.t?.link, { kind: 'direct', url: 'http://127.0.0.1:45001' })
  })

  test('the order: listed first as given, the rest in key order, local last when not listed', () => {
    const devices = { c: { link: ssh }, a: { link: ssh }, b: { link: ssh } }
    assert.deepEqual(conf({ devices }).order, ['c', 'a', 'b', 'local'])
    assert.deepEqual(conf({ order: ['b'], devices }).order, ['b', 'c', 'a', 'local'])
    assert.deepEqual(conf({ order: ['local', 'b'], devices }).order, ['local', 'b', 'c', 'a'])
    assert.deepEqual(conf({ order: ['a', 'local', 'c', 'b'], devices }).order, ['a', 'local', 'c', 'b'])
  })

  test('the order: a name twice, a device not there, not a list', () => {
    const devices = { a: { link: ssh } }
    const c = conf({ order: ['a', 'a', 'ghost', 7], devices })
    assert.deepEqual(c.order, ['a', 'local'])
    assert.deepEqual(c.problems, [
      { key: 'order', why: 'duplicate', device: 'a' },
      { key: 'order', why: 'missing', device: 'ghost' },
      { key: 'order', why: 'type' },
    ])
    const d = conf({ order: 'a', devices })
    assert.deepEqual(d.order, ['a', 'local'])
    assert.deepEqual(d.problems, [{ key: 'order', why: 'type' }])
  })

  test('a device with an unknown key is left out of devices and order, and named', () => {
    const c = conf({
      order: ['bad', 'good'],
      devices: { bad: { link: ssh, maxSesions: 3 }, good: { link: ssh } },
    })
    assert.deepEqual(Object.keys(c.devices).sort(), ['good', 'local'])
    assert.deepEqual(c.order, ['good', 'local'])
    // named once, under the device, not again under order
    assert.deepEqual(c.problems, [{ device: 'bad', key: 'maxSesions', why: 'unknown' }])
  })

  test('bad values switch the device off, never guessed at, and say no value', () => {
    const cases: [unknown, string, string][] = [
      [{}, 'link', 'required'],
      [{ link: 'ssh://x' }, 'link', 'type'],
      [{ link: { kind: 'carrier-pigeon' } }, 'link.kind', 'kind'],
      [{ link: { host: 'h' } }, 'link.kind', 'required'],
      [{ link: { ...ssh, user: undefined } }, 'link.user', 'required'],
      [{ link: { ...ssh, host: 'two words' } }, 'link.host', 'type'],
      [{ link: { ...ssh, sshPort: 0 } }, 'link.sshPort', 'port'],
      [{ link: { ...ssh, port: '12430' } }, 'link.port', 'port'],
      [{ link: { ...ssh, password: 'hunter2' } }, 'link.password', 'unknown'],
      [{ link: { kind: 'direct', url: 'file:///etc/passwd' } }, 'link.url', 'url'],
      [{ link: { kind: 'direct', url: 'http://203.0.113.9:12430' } }, 'link.url', 'url'],
      [{ link: { kind: 'direct', url: 'https://user:hunter2@node.example.com' } }, 'link.url', 'url'],
      [{ link: { ...ssh, host: '-oProxyCommand=x' } }, 'link.host', 'type'],
      [{ link: { ...ssh, user: '-oFoo=bar' } }, 'link.user', 'type'],
      [{ link: { kind: 'tailnet', address: 'a\u202eb' } }, 'link.address', 'type'],
      [{ link: ssh, title: 'a\u001b[2Jb' }, 'title', 'type'],
      [{ link: ssh, title: 'x'.repeat(201) }, 'title', 'type'],
      [{ link: { kind: 'relay', socket: 's' } }, 'link.kind', 'relay'],
      [{ link: ssh, maxSessions: 0 }, 'maxSessions', 'number'],
      [{ link: ssh, maxSessions: 2.5 }, 'maxSessions', 'number'],
      [{ link: ssh, minFreeMemMb: -1 }, 'minFreeMemMb', 'number'],
      [{ link: ssh, maxLoad: '0.9' }, 'maxLoad', 'number'],
      [{ link: ssh, tags: 'linux' }, 'tags', 'type'],
      [{ link: ssh, paused: 'yes' }, 'paused', 'type'],
      [{ link: ssh, title: '' }, 'title', 'type'],
      [{ link: ssh, profiles: { work: 3 } }, 'profiles.work', 'type'],
      [{ link: ssh, mcp: { x: true } }, 'mcp.x', 'type'],
      [{ link: ssh, sinks: [] }, 'sinks', 'type'],
      ['server', 'id', 'type'],
    ]
    for (const [dev, key, why] of cases) {
      const c = conf({ devices: { s1: dev } })
      assert.equal(c.devices.s1, undefined, JSON.stringify(dev))
      assert.deepEqual(c.order, ['local'], JSON.stringify(dev))
      assert.deepEqual(c.problems, [{ device: 's1', key, why }], JSON.stringify(dev))
      assert.ok(!JSON.stringify(c.problems).includes('hunter2'))
    }
  })

  test('device ids: the rule, local reserved for this computer, not the master itself', () => {
    const c = conf({
      id: 'laptop',
      devices: { 'Server-1': { link: ssh }, 'a:b': { link: ssh }, '@x': { link: ssh }, laptop: { link: ssh } },
    })
    assert.deepEqual(Object.keys(c.devices), ['local'])
    assert.deepEqual(
      c.problems.map(p => [p.device, p.key, p.why]),
      [
        ['Server-1', 'id', 'id'],
        ['a:b', 'id', 'id'],
        ['@x', 'id', 'id'],
        ['laptop', 'id', 'self'],
      ],
    )
  })

  test('local has no link: one there is a problem, and local stays with no thresholds of its own', () => {
    const c = conf({ devices: { local: { link: ssh, maxSessions: 3 } } })
    assert.deepEqual(c.problems, [{ device: 'local', key: 'link', why: 'local' }])
    assert.equal(c.devices.local?.link, null)
    assert.equal(c.devices.local?.maxSessions, null)
    assert.deepEqual(c.order, ['local'])
  })

  test('unknown keys of the section are named', () => {
    const c = conf({ id: 'laptop', devcies: {} })
    assert.deepEqual(c.problems, [{ key: 'devcies', why: 'unknown' }])
  })

  test('whenFull: local, wait, and a bad one named and read as local', () => {
    assert.equal(conf({ whenFull: 'wait' }).whenFull, 'wait')
    assert.equal(conf({ whenFull: 'local' }).whenFull, 'local')
    const c = conf({ whenFull: 'queue' })
    assert.equal(c.whenFull, 'local')
    assert.deepEqual(c.problems, [{ key: 'whenFull', why: 'type' }])
  })

  test('relay: read, and one that does not check out is named and is none', () => {
    assert.deepEqual(conf({ relay: { host: 'r', user: 'm', sshPort: 0 } }).problems, [
      { key: 'relay.sshPort', why: 'port' },
    ])
    const c = conf({ relay: { host: 'relay.example.com', user: 'm' } })
    assert.deepEqual(c.relay, { host: 'relay.example.com', sshPort: 22, user: 'm' })
    const d = conf({
      relay: { host: 'relay.example.com', user: 'm', key: 'secret' },
      devices: { s: { link: { kind: 'relay', socket: 's.sock' } } },
    })
    assert.equal(d.relay, null)
    assert.deepEqual(d.problems, [
      { key: 'relay.key', why: 'unknown' },
      { device: 's', key: 'link.kind', why: 'relay' },
    ])
    assert.deepEqual(conf({ relay: 'x' }).problems, [{ key: 'relay', why: 'type' }])
    assert.deepEqual(conf({ relay: { user: 'm' } }).problems, [{ key: 'relay.host', why: 'required' }])
  })
})

describe('nodesConfig on what JSON.parse makes', () => {
  test('__proto__ and constructor are keys like any other, never a prototype', () => {
    const c = conf(
      JSON.parse(
        '{"devices":{"s1":{"link":{"kind":"ssh","host":"h","user":"u"},"profiles":{"__proto__":"work","constructor":"x"},"mcp":{"__proto__":{"command":"evil"}}},"__proto__":{"link":{"kind":"ssh","host":"h","user":"u"}}}}',
      ),
    )
    const s1 = c.devices.s1
    assert.ok(s1)
    assert.deepEqual(Object.keys(s1.profiles), ['__proto__', 'constructor'])
    assert.equal(Object.getOwnPropertyDescriptor(s1.profiles, '__proto__')?.value, 'work')
    assert.deepEqual(Object.keys(s1.mcp), ['__proto__'])
    assert.equal((s1.mcp as { command?: unknown }).command, undefined)
    assert.deepEqual(Object.keys(c.devices).sort(), ['local', 's1'])
    assert.deepEqual(c.problems, [{ device: '__proto__', key: 'id', why: 'id' }])
  })

  test('a device id taken from a key finds only devices that were given', () => {
    const c = conf({})
    for (const id of ['constructor', 'tostring', 'valueof', 'hasownproperty']) {
      const parsed = parseNodeKey(`@${id}:pane-1`)
      assert.equal(parsed?.device, id)
      assert.equal(c.devices[id], undefined, id)
    }
    assert.equal(c.devices.local?.profiles.valueOf, undefined)
  })
})

describe('nodesConfig, the rest of the section', () => {
  test('a key set to null counts as absent', () => {
    const c = conf({ id: null, order: null, whenFull: null, lanes: null, relay: null, devices: null })
    assert.deepEqual(c.problems, [])
    assert.equal(c.id, 'laptop')
    assert.deepEqual(c.order, ['local'])
    assert.equal(c.whenFull, 'local')
    assert.deepEqual(c.lanes, [])
    assert.equal(c.relay, null)
  })

  test('devices that is not an object is named; this computer stays', () => {
    for (const devices of [[], 'server-1', 3]) {
      const c = conf({ devices })
      assert.deepEqual(c.problems, [{ key: 'devices', why: 'type' }], JSON.stringify(devices))
      assert.deepEqual(c.order, ['local'])
      assert.deepEqual(Object.keys(c.devices), ['local'])
    }
  })

  test('no host name: the id is "board"', () => {
    assert.equal(nodesConfig({})?.id, 'board')
  })

  test('a title is trimmed, tags lose their repeats', () => {
    const c = conf({ devices: { s: { link: ssh, title: '  Server 1 ', tags: ['linux', 'tests', 'linux'] } } })
    assert.equal(c.devices.s?.title, 'Server 1')
    assert.deepEqual(c.devices.s?.tags, ['linux', 'tests'])
  })

  test('a direct link to this computer over plain http, and to anywhere over https', () => {
    for (const url of [
      'http://127.0.0.1:45001',
      'http://localhost:45001/',
      'http://[::1]:45001',
      'https://node.example.com',
    ]) {
      const c = conf({ devices: { t: { link: { kind: 'direct', url } } } })
      assert.deepEqual(c.problems, [], url)
    }
  })
})

describe('nodes.id', () => {
  test('given', () => {
    assert.equal(conf({ id: 'my-laptop' }, 'WHATEVER').id, 'my-laptop')
  })

  test('derived from the host name when absent', () => {
    assert.equal(conf({}, 'DESKTOP-4F2K9QZ').id, 'desktop-4f2k9qz')
    assert.equal(conf({}).id, 'laptop')
  })

  test('a bad or reserved one is named and the host name is used', () => {
    const c = conf({ id: 'My Laptop' }, 'roma-pc')
    assert.equal(c.id, 'roma-pc')
    assert.deepEqual(c.problems, [{ key: 'id', why: 'id' }])
    const d = conf({ id: 'local' }, 'roma-pc')
    assert.equal(d.id, 'roma-pc')
    assert.deepEqual(d.problems, [{ key: 'id', why: 'reserved' }])
  })

  test('deviceIdFromHost on odd host names', () => {
    const cases: [string, string][] = [
      ['DESKTOP-ABC123', 'desktop-abc123'],
      ['roma.local', 'roma-local'],
      ['my_box.example.com', 'my-box-example-com'],
      ['--edge--', 'edge'],
      ['Roma’s MacBook Pro', 'roma-s-macbook-pro'],
      ['ноутбук-Ромы', 'board'],
      ['ноутбук2', '2'],
      ['', 'board'],
      ['LOCAL', 'board'],
      ['local', 'board'],
      ['a'.repeat(40), 'a'.repeat(32)],
      [`${'a'.repeat(31)}.b`, 'a'.repeat(31)],
      ['100%', '100'],
    ]
    for (const [host, id] of cases) {
      const got = deviceIdFromHost(host)
      assert.equal(got, id, host)
      assert.ok(DEVICE_ID.test(got) && got !== LOCAL, host)
    }
  })
})

describe('nodes.lanes', () => {
  test('absent, null or empty: no lane leaves', () => {
    for (const raw of [{}, { lanes: null }, { lanes: [] }]) {
      const c = conf(raw)
      assert.deepEqual(c.lanes, [])
      assert.equal(laneMayLeave(c, 'atlas'), false)
      assert.equal(laneMayLeave(c, 'other'), false)
    }
  })

  test('a list: those lanes, compared lower-cased', () => {
    const c = conf({ lanes: ['Atlas', ' tools '] })
    assert.deepEqual(c.lanes, ['atlas', 'tools'])
    assert.equal(laneMayLeave(c, 'atlas'), true)
    assert.equal(laneMayLeave(c, 'ATLAS'), true)
    assert.equal(laneMayLeave(c, 'tools'), true)
    assert.equal(laneMayLeave(c, 'centium'), false)
  })

  test('"all": every lane', () => {
    const c = conf({ lanes: 'all' })
    assert.equal(c.lanes, 'all')
    for (const lane of ['atlas', 'other', 'something-new']) assert.equal(laneMayLeave(c, lane), true)
  })

  test('a lane that no longer exists lets nothing else leave and breaks nothing', () => {
    const c = conf({ lanes: ['removed-lane'] })
    assert.deepEqual(c.problems, [])
    assert.equal(laneMayLeave(c, 'atlas'), false)
    assert.equal(laneMayLeave(c, 'removed-lane'), true)
  })

  test('a bad value is named and lets nothing leave', () => {
    for (const lanes of ['atlas', 7, [1], [''], { atlas: true }]) {
      const c = conf({ lanes })
      assert.deepEqual(c.lanes, [], JSON.stringify(lanes))
      assert.deepEqual(c.problems, [{ key: 'lanes', why: 'type' }], JSON.stringify(lanes))
    }
  })
})

describe('nodeConfig', () => {
  test('the least: an id, the rest by default', () => {
    assert.deepEqual(nodeConfig({ id: 'server-1' }), {
      id: 'server-1',
      port: NODE_PORT,
      workRoot: '~/work',
      listen: 'loopback',
      tls: false,
      relay: null,
    })
  })

  test('all of it, behind NAT', () => {
    const raw = {
      id: 'home-pc',
      port: 12431,
      workRoot: '/srv/work',
      listen: 'tailnet',
      tls: true,
      relay: { host: 'relay.example.com', sshPort: 2222, user: 'agent-board-relay-n', socket: 'home-pc.sock' },
    }
    assert.deepEqual(nodeConfig(raw), raw)
    assert.deepEqual(nodeProblems(raw), [])
  })

  test('anything that does not check out opens no door, and says why', () => {
    const cases: [unknown, { key: string; why: string }][] = [
      [{}, { key: 'id', why: 'required' }],
      [{ id: 'local' }, { key: 'id', why: 'reserved' }],
      [{ id: 'Server 1' }, { key: 'id', why: 'id' }],
      [
        { id: 's', port: 70000 },
        { key: 'port', why: 'port' },
      ],
      [
        { id: 's', workRoot: '' },
        { key: 'workRoot', why: 'type' },
      ],
      [
        { id: 's', listen: 'all' },
        { key: 'listen', why: 'type' },
      ],
      [
        { id: 's', tls: 'yes' },
        { key: 'tls', why: 'type' },
      ],
      [
        { id: 's', token: 'abc' },
        { key: 'token', why: 'unknown' },
      ],
      [
        { id: 's', relay: { host: 'r', user: 'u' } },
        { key: 'relay.socket', why: 'required' },
      ],
      [
        { id: 's', relay: { host: 'r', user: 'u', socket: 's', key: 'k' } },
        { key: 'relay.key', why: 'unknown' },
      ],
      [
        { id: 's', relay: { host: 'r', user: 'u', socket: 's', sshPort: 'x' } },
        { key: 'relay.sshPort', why: 'port' },
      ],
      [
        { id: 's', workRoot: '/a\n[Service]' },
        { key: 'workRoot', why: 'type' },
      ],
      [
        { id: 's', relay: { host: 'r', user: 'u', socket: 's' } },
        { key: 'tls', why: 'required' },
      ],
      [
        { id: 's', tls: false, relay: { host: 'r', user: 'u', socket: 's' } },
        { key: 'tls', why: 'required' },
      ],
      [
        { id: 's', pilotBridge: 'yes' },
        { key: 'pilotBridge', why: 'type' },
      ],
    ]
    for (const [raw, problem] of cases) {
      assert.equal(nodeConfig(raw), null, JSON.stringify(raw))
      assert.deepEqual(nodeProblems(raw), [problem], JSON.stringify(raw))
    }
    assert.equal(nodeConfig({ id: 's' })?.pilotBridge, undefined)
    assert.equal(nodeConfig({ id: 's', pilotBridge: true })?.pilotBridge, undefined)
    assert.equal(nodeConfig({ id: 's', pilotBridge: false })?.pilotBridge, false)
  })
})

describe('configuredNodeAddresses (#730, #738)', () => {
  test('includes routable non-private addresses of non-revoked nodes unless pilotBridge is false', () => {
    const c = conf({
      devices: {
        'tailnet-default': { link: { kind: 'tailnet', address: '100.64.0.12', port: 12430 } },
        'tailnet-optout': { pilotBridge: false, link: { kind: 'tailnet', address: '100.64.0.13', port: 12430 } },
        'tailnet-revoked': {
          revoked: true,
          link: { kind: 'tailnet', address: '100.64.0.14', port: 12430 },
        },
        'lan-ssh': { link: { kind: 'ssh', host: '192.168.1.50', user: 'anna' } },
        'pub-ssh': { link: { kind: 'ssh', host: '203.0.113.10', user: 'anna' } },
        'direct-loopback': { link: { kind: 'direct', url: 'http://127.0.0.1:45001' } },
        'direct-https': { link: { kind: 'direct', url: 'https://100.64.0.15:12430' } },
      },
    })
    assert.deepEqual(configuredNodeAddresses(c), ['100.64.0.12', '203.0.113.10', '100.64.0.15'])
  })
})

describe('defaultThresholds', () => {
  test('2, 8 and 32 GB', () => {
    assert.deepEqual(defaultThresholds({ memTotalMb: 2048, cpus: 2 }), {
      maxSessions: 1,
      minFreeMemMb: 1024,
      maxLoad: 0.9,
    })
    assert.deepEqual(defaultThresholds({ memTotalMb: 8192, cpus: 4 }), {
      maxSessions: 4,
      minFreeMemMb: 1229,
      maxLoad: 0.9,
    })
    assert.deepEqual(defaultThresholds({ memTotalMb: 32768, cpus: 8 }), {
      maxSessions: 20,
      minFreeMemMb: 4915,
      maxLoad: 0.9,
    })
  })

  test('the cores cap the sessions; never below one', () => {
    assert.equal(defaultThresholds({ memTotalMb: 32768, cpus: 2 }).maxSessions, 8)
    assert.equal(defaultThresholds({ memTotalMb: 512, cpus: 1 }).maxSessions, 1)
    assert.equal(defaultThresholds({ memTotalMb: 32768, cpus: 0 }).maxSessions, 4)
  })

  test('a status figure that is not a number counts as the least', () => {
    const least = { maxSessions: 1, minFreeMemMb: 1024, maxLoad: 0.9 }
    assert.deepEqual(defaultThresholds({ memTotalMb: Number.NaN, cpus: 4 }), least)
    assert.deepEqual(defaultThresholds({ memTotalMb: 8192, cpus: Number.NaN }), {
      ...least,
      maxSessions: 4,
      minFreeMemMb: 1229,
    })
    assert.deepEqual(defaultThresholds({ memTotalMb: Number.POSITIVE_INFINITY, cpus: 1 }), least)
  })
})

describe('the key prefix', () => {
  const keys = [
    '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
    'pane-12',
    'C:\\Users\\Roma\\.pi\\agent\\sessions\\--C--Work--\\2026-11-21_s.jsonl',
    '/home/roma/.pi/agent/sessions/--home-roma--/2026-11-21_s.jsonl',
    '/home/roma/my work/session one.jsonl',
    'C:\\Работа\\сессия.jsonl',
    '/tmp/100%/a%20b.jsonl',
    '@already:prefixed',
  ]

  test('both ways, for every key shape', () => {
    for (const key of keys) {
      const prefixed = nodeKey('server-1', key)
      assert.equal(prefixed, `@server-1:${key}`)
      assert.deepEqual(parseNodeKey(prefixed), { device: 'server-1', key }, key)
    }
  })

  test('no local key shape parses as a prefixed one', () => {
    const local = [
      '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
      '019a6c2e-7f1b-7c3d-9e4f-a5b6c7d8e9f0',
      'pane-12',
      'pane-wP:pMP',
      'C:\\Users\\Roma\\.pi\\agent\\sessions\\s.jsonl',
      'C:/Users/Roma/.pi/agent/sessions/s.jsonl',
      '\\\\server\\share\\s.jsonl',
      '/home/roma/.pi/agent/sessions/s.jsonl',
      '/home/roma/my work/сессия 100%.jsonl',
      '',
    ]
    for (const key of local) assert.equal(parseNodeKey(key), null, key)
  })

  test('a prefix that is not a device is no prefix', () => {
    for (const key of [
      '@:x',
      '@server-1:',
      '@server-1',
      '@Server-1:x',
      '@local:x',
      '@a b:x',
      '@-a:x',
      `@${'a'.repeat(33)}:x`,
    ])
      assert.equal(parseNodeKey(key), null, key)
  })

  test('a device id that could not be told from a key is refused', () => {
    for (const device of ['', 'local', 'Server', 'a:b', '@a', 'a b', 'сервер', '-a', 'a'.repeat(33)])
      assert.throws(() => nodeKey(device, 'pane-1'), /not a device id/, device)
    assert.throws(() => nodeKey('server-1', ''), /empty key/)
  })
})

describe('a revoked device (#510)', () => {
  const link = { kind: 'direct', url: 'http://127.0.0.1:12430' }
  test('revoked: true is read and kept with the device; absent or false it is not there; another type is named', () => {
    const c = conf({ devices: { a: { link, revoked: true }, b: { link, revoked: false }, c: { link } } })
    assert.equal(c.devices.a?.revoked, true)
    assert.equal('revoked' in (c.devices.b ?? {}), false)
    assert.equal('revoked' in (c.devices.c ?? {}), false)
    assert.deepEqual(conf({ devices: { a: { link, revoked: 'yes' } } }).problems, [
      { device: 'a', key: 'revoked', why: 'type' },
    ])
  })

  test('markRevoked writes it once, on a device the section holds, never on this computer', () => {
    const nodes: Record<string, unknown> = { devices: { a: { link }, local: {} } }
    assert.equal(markRevoked(nodes, 'a'), true)
    assert.deepEqual(nodes, { devices: { a: { link, revoked: true }, local: {} } })
    assert.equal(markRevoked(nodes, 'a'), false)
    assert.equal(markRevoked(nodes, 'b'), false)
    assert.equal(markRevoked(nodes, 'local'), false)
    assert.equal(markRevoked({}, 'a'), false)
    assert.deepEqual(nodes, { devices: { a: { link, revoked: true }, local: {} } })
  })
})
