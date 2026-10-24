// The two-proxies proof (the server-setup spec's "The two-proxies proof", the owner's requirement),
// off unless BOARD_DOCKER_IT=1: plain containers on Docker Desktop, the board's own images, flags
// and texts (core/server-texts.ts), "their" proxy beside the board's, both serving at once.
//
//   A (case 3a): their Caddy on a user network, the board's marked block in their Caddyfile, the
//     board's helper (socat) on that network;
//   B (case 4): their nginx on 443 and 80, the board's Caddy on 8443;
//   C (case 1): the board's Caddy alone on 443.
//
// The socket: a volume as the tunnel's folder (2750, its group 999), where a socat container
// (the stand-in for sshd's end of the tunnel) makes the socket `srw-rw----` and passes what comes to
// the stand-in board on this PC (standin.ts) through host.docker.internal. The proof is about
// serving, not certificates: the board's Caddyfile gets `local_certs`, their proxies `tls internal`
// or a certificate from a local CA, and the test trusts those roots. What a PC is not, the board's
// argv says differently here: ports on 127.0.0.1 of this PC (Docker picks them), the socket's
// folder a volume, the board's config folder a folder of the test's, names and volumes of the run's.
//
//   BOARD_DOCKER_IT=1 bun test test/integration/two-proxies.test.ts --timeout 1800000
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Wanted } from '../../src/core/server-plan.ts'
import {
  boardCaddyfile,
  CADDY_IMAGE,
  caddyRunArgs,
  markedBlock,
  type OwnCaddy,
  SOCAT_IMAGE,
  socatRunArgs,
} from '../../src/core/server-texts.ts'
import {
  type ConnectProxy,
  connectProxy,
  docker,
  dockerUp,
  LABEL_KEY,
  note,
  publishedPort,
  RUN,
  removeRun,
  removeStale,
  until,
  work,
} from './server/harness.ts'
import { type Echo, readEcho, rightmost, type Standin, startStandin, TICK_MS } from './standin.ts'

const ON = process.env.BOARD_DOCKER_IT === '1'
const LABEL = `${LABEL_KEY}=${RUN}`
const SITE = 'site.test'
const W: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.test',
  publicPort: null,
}
const FOLDER = '/var/lib/boardtunnel'
/** The socket folder's group: the tunnel user's own on a server. */
const GID = 999
const STREAM_S = 30
const MANY = 200

const results: string[] = []
const names = (what: string): string => `abit-${RUN}-${what}`

/** `docker run` with the run's label (removed by it at the end). */
const runContainer = (args: string[]): Promise<unknown> => docker(['run', '--label', LABEL, ...args.slice(1)])

/**
 * The board's `docker run` argv on this PC: its name and volumes the run's; the socket's folder
 * the volume; its config folder `config` (when it has one); each published port on 127.0.0.1, its
 * host port Docker's choice. Every other flag, the image and the command as the board has them.
 */
function onThisPc(
  argv: string[],
  o: { name: string; socketVolume: string; config?: string; volumes?: string[] },
): string[] {
  const out = [...argv]
  for (let i = 0; i < out.length - 1; i++) {
    const flag = out[i]
    const value = out[i + 1] as string
    if (flag === '--name') out[i + 1] = o.name
    if (flag === '-p') out[i + 1] = `127.0.0.1::${value.split(':').at(-1)}`
    if (flag === '-v') {
      const [from, to, mode] = value.split(':')
      if (from === FOLDER) out[i + 1] = `${o.socketVolume}:${to}:${mode ?? 'ro'}`
      else if (to === '/etc/caddy' && o.config) out[i + 1] = `${o.config}:/etc/caddy:ro`
      else if (from?.startsWith('agent-board-caddy-'))
        out[i + 1] = `${o.volumes?.[from.endsWith('data') ? 0 : 1]}:${to}`
    }
  }
  return out
}

/** The board's Caddyfile for a case, with `local_certs`; a site's own ACME issuer (1b, 4a, 4b) becomes `tls internal`. */
function localCaddyfile(c: OwnCaddy): string {
  const text = boardCaddyfile(c, W).replace(/\ttls \{\n\t\tissuer acme \{\n\t\t\t\w+\n\t\t\}\n\t\}/, '\ttls internal')
  return text.startsWith('{\n')
    ? text.replace('{\n', '{\n\tlocal_certs\n\tskip_install_trust\n')
    : `{\n\tlocal_certs\n\tskip_install_trust\n}\n${text}`
}

/** The tunnel's end on the server: the socket in the folder, `srw-rw----`, made by group 999, to the stand-in. */
async function startTunnel(socketVolume: string, standin: Standin): Promise<string> {
  const name = names(`tunnel-${Math.random().toString(16).slice(2, 6)}`)
  await runContainer([
    'run',
    '-d',
    '--name',
    name,
    '--user',
    `${GID}:${GID}`,
    '-v',
    `${socketVolume}:${FOLDER}`,
    SOCAT_IMAGE,
    // sshd listens on a forward's socket with a backlog of 128 (SSH_LISTEN_BACKLOG); socat's own is 5
    `UNIX-LISTEN:${W.socket},fork,unlink-early,perm=0660,backlog=128`,
    `TCP:host.docker.internal:${standin.port}`,
  ])
  await until('the socket is there', async () => (await socketStat(socketVolume)).startsWith('660 '), 30_000)
  return name
}

/** The socket's mode, owner, group, type, inode and change time, as `stat` in a container sees them ('' when it is not there). */
async function socketStat(socketVolume: string): Promise<string> {
  const out = await docker(
    [
      'run',
      '--rm',
      '--label',
      LABEL,
      '--entrypoint',
      'stat',
      '-v',
      `${socketVolume}:${FOLDER}:ro`,
      SOCAT_IMAGE,
      '-c',
      '%a %u %g %F %i %Z',
      W.socket,
    ],
    { check: false, quiet: true },
  )
  return out.code === 0 ? out.stdout.trim() : ''
}

/** A Caddy's local CA root (its data volume). */
async function caddyRoot(container: string): Promise<string> {
  let root = ''
  await until(`${container}'s local CA`, async () => {
    root = (
      await docker(['exec', container, 'cat', '/data/caddy/pki/authorities/local/root.crt'], {
        check: false,
        quiet: true,
      })
    ).stdout
    return root.includes('BEGIN CERTIFICATE')
  })
  return root
}

/** Requests from this PC as a browser would make them: names through the proxy's routes, these roots trusted. */
function browser(proxy: ConnectProxy, roots: string[]) {
  const get = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetch(url, { ...init, proxy: proxy.url, tls: { ca: roots } } as RequestInit)
  return {
    get,
    async text(url: string): Promise<{ status: number; text: string }> {
      const r = await get(url, { signal: AbortSignal.timeout(10_000) })
      return { status: r.status, text: await r.text() }
    },
    async echo(url: string): Promise<Echo | null> {
      const r = await get(url, { signal: AbortSignal.timeout(10_000) })
      return readEcho(await r.text())
    },
  }
}

type Browser = ReturnType<typeof browser>

/** An event stream: when its first event came (ms after the request), and each tick's time. */
async function openStream(b: Browser, url: string) {
  const start = Date.now()
  const ac = new AbortController()
  const res = await b.get(url, { signal: ac.signal })
  const ticks: number[] = []
  const reader = res.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ended = false
  const reading = (async () => {
    if (!reader) return
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
        if (buffer.slice(0, at).startsWith('data: tick')) ticks.push(Date.now() - start)
        buffer = buffer.slice(at + 2)
      }
    }
    ended = true
  })()
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    ticks,
    ended: () => ended,
    async close(): Promise<void> {
      ac.abort()
      await reading.catch(() => {})
    },
  }
}

/** The longest wait between two ticks (and from the start to the first). */
const longestGap = (ticks: number[]): number => Math.max(...ticks.map((t, i) => t - (i ? (ticks[i - 1] as number) : 0)))

/** `count` requests at once, every other one to each URL; what did not answer as `ok` says. */
async function interleaved(
  b: Browser,
  urls: [string, (s: number, t: string) => boolean][],
  count: number,
): Promise<string[]> {
  const bad: string[] = []
  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const [url, ok] = urls[i % urls.length] as [string, (s: number, t: string) => boolean]
      try {
        const r = await b.text(url)
        if (!ok(r.status, r.text)) bad.push(`${url} ${r.status} ${r.text.slice(0, 80)}`)
      } catch (err) {
        bad.push(`${url} ${String(err)}`)
      }
    }),
  )
  return bad
}

/** Their site answered every time while `during` ran (fetched every 100 ms). */
async function keepsAnswering(b: Browser, url: string, body: string, during: () => Promise<void>): Promise<string[]> {
  const bad: string[] = []
  let going = true
  const loop = (async () => {
    while (going) {
      try {
        const r = await b.text(url)
        if (r.status !== 200 || !r.text.includes(body)) bad.push(`${r.status} ${r.text.slice(0, 60)}`)
      } catch (err) {
        bad.push(String(err))
      }
      await Bun.sleep(100)
    }
  })()
  await during()
  await Bun.sleep(2000)
  going = false
  await loop
  return bad
}

/** How a container started: its id and start time (unchanged means it was neither restarted nor recreated). */
const startedAt = async (container: string): Promise<string> =>
  (await docker(['inspect', '-f', '{{.Id}} {{.State.StartedAt}}', container])).stdout.trim()

describe.skipIf(!ON)('two proxies serve side by side (the board’s images, flags and texts)', () => {
  const net = names('proxies')
  const socketVolume = names('socket')
  let proxy: ConnectProxy
  let standin: Standin
  let tunnel = ''
  /** Their nginx's certificate for site.test, its key and its CA's root (from a Caddy's local CA). */
  let siteCert = { crt: '', key: '', root: '' }
  /** The docker default bridge's gateway: the address a container there sees this PC's requests come from. */
  let gateway = ''

  beforeAll(async () => {
    if (!(await dockerUp())) throw new Error('Docker does not answer: start Docker Desktop')
    await removeStale()
    note(`two-proxies: run ${RUN}`)
    await docker(['network', 'create', '--label', LABEL, net])
    await docker(['volume', 'create', '--label', LABEL, socketVolume])
    // the tunnel's folder: 2750, its group the tunnel user's own (step 1)
    await docker([
      'run',
      '--rm',
      '--label',
      LABEL,
      '--entrypoint',
      'sh',
      '-v',
      `${socketVolume}:${FOLDER}`,
      SOCAT_IMAGE,
      '-c',
      `chown ${GID}:${GID} ${FOLDER} && chmod 2750 ${FOLDER}`,
    ])
    standin = startStandin()
    tunnel = await startTunnel(socketVolume, standin)
    proxy = await connectProxy()
    gateway = (await docker(['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'])).stdout.trim()
    // a certificate for their nginx: what a Caddy with local_certs makes for site.test
    const maker = names('certs')
    const dir = join(work(), 'certs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Caddyfile'), `{\n\tlocal_certs\n\tskip_install_trust\n}\n${SITE} {\n\trespond "x"\n}\n`)
    await runContainer(['run', '-d', '--name', maker, '-v', `${dir}:/etc/caddy:ro`, CADDY_IMAGE])
    const at = `/data/caddy/certificates/local/${SITE}/${SITE}`
    await until('the certificate for site.test', async () => {
      const crt = await docker(['exec', maker, 'cat', `${at}.crt`], { check: false, quiet: true })
      const key = await docker(['exec', maker, 'cat', `${at}.key`], { check: false, quiet: true })
      siteCert = { crt: crt.stdout, key: key.stdout, root: '' }
      return crt.stdout.includes('BEGIN CERTIFICATE') && key.stdout.includes('PRIVATE KEY')
    })
    siteCert.root = await caddyRoot(maker)
    await docker(['rm', '-f', '-v', maker])
  }, 10 * 60_000)

  afterAll(async () => {
    proxy?.close()
    standin?.stop()
    console.log(`two-proxies results:\n${results.join('\n')}`)
    await removeRun()
  }, 10 * 60_000)

  test('the socket the stand-in tunnel makes is the tunnel’s: srw-rw----, the folder’s group', async () => {
    const [mode, uid, gid, type] = (await socketStat(socketVolume)).split(' ')
    expect({ mode, uid, gid, type }).toEqual({ mode: '660', uid: String(GID), gid: String(GID), type: 'socket' })
  })

  /**
   * The checks every topology goes through, both proxies at once: their site (when there is one)
   * and the board through the socket; an event stream; many requests interleaved; the tunnel
   * down and up again on a new socket file. `disturb` reloads or restarts their proxy while a
   * board stream is open.
   */
  async function bothAtOnce(o: {
    name: string
    roots: string[]
    site: string | null
    board: string
    boardHost: string
    /** The address the proxy in front of the board sees this PC's requests come from. */
    caller: () => Promise<string>
    proxies: string[]
    /**
     * Their proxy reloaded (their site answers throughout) or restarted (down a moment, then back);
     * a board stream that does not pass their proxy goes on untouched.
     */
    disturb?: { what: string; run: () => Promise<void>; siteThroughout: boolean; boardStreamUntouched: boolean }
  }): Promise<void> {
    const b = browser(proxy, o.roots)
    const lines: string[] = [`${o.name}:`]
    // 1. their site and the board, the board with the Host, the scheme and the caller
    if (o.site) expect(await b.text(o.site)).toEqual({ status: 200, text: 'site page' })
    const echo = await b.echo(`${o.board}/echo`)
    expect(echo?.host).toBe(o.boardHost)
    expect(echo?.proto).toBe('https')
    const caller = await o.caller()
    expect(rightmost(echo?.forwardedFor ?? null)).toBe(caller)
    lines.push(
      `board: Host ${echo?.host}, X-Forwarded-Proto ${echo?.proto}, X-Forwarded-For ${echo?.forwardedFor} (the caller as the proxy saw it: ${caller})`,
    )

    // 2. an event stream: its first event at once, then ticking for 30 s, nothing buffered
    const stream = await openStream(b, `${o.board}/events`)
    expect(stream.status).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')
    await Bun.sleep(STREAM_S * 1000)
    await stream.close()
    const first = stream.ticks[0] ?? Number.POSITIVE_INFINITY
    expect(first).toBeLessThan(1000)
    expect(stream.ticks.length).toBeGreaterThanOrEqual((STREAM_S * 1000) / TICK_MS - 4)
    expect(longestGap(stream.ticks)).toBeLessThan(3 * TICK_MS)
    lines.push(
      `stream: first event after ${first} ms, ${stream.ticks.length} ticks in ${STREAM_S} s, longest gap ${longestGap(stream.ticks)} ms`,
    )

    // 3. many requests at once, interleaved
    const checks: [string, (s: number, t: string) => boolean][] = [
      [`${o.board}/echo`, (s, t) => s === 200 && readEcho(t)?.host === o.boardHost],
      ...(o.site
        ? [
            [o.site, (s: number, t: string) => s === 200 && t === 'site page'] as [
              string,
              (s: number, t: string) => boolean,
            ],
          ]
        : []),
    ]
    const before = standin.count()
    expect(await interleaved(b, checks, MANY)).toEqual([])
    expect(standin.count() - before).toBe(o.site ? MANY / 2 : MANY)
    lines.push(`${MANY} requests at once, interleaved: all answered right`)

    // 4. their proxy reloaded or restarted while a board stream is open
    if (o.disturb && o.site) {
      const d = o.disturb
      const open = await openStream(b, `${o.board}/events`)
      await Bun.sleep(1500)
      const ticksBefore = open.ticks.length
      const bad = await keepsAnswering(b, o.site, 'site page', d.run)
      await Bun.sleep(3000)
      const ticksAfter = open.ticks.length
      await open.close()
      const lasted = ticksAfter > ticksBefore + 4 && longestGap(open.ticks) < 3 * TICK_MS
      if (d.boardStreamUntouched) expect(lasted).toBe(true)
      if (d.siteThroughout) expect(bad).toEqual([])
      expect(await b.text(o.site)).toEqual({ status: 200, text: 'site page' })
      lines.push(
        `${d.what} during a board stream: their site ${d.siteThroughout ? `answered throughout (${bad.length} misses)` : `was down ${bad.length} of its fetches (100 ms apart) while it restarted, then answered`}; the board stream ${lasted ? `went on ticking (longest gap ${longestGap(open.ticks)} ms)` : `ended (${open.ticks.length} ticks)`}`,
      )
    }

    // 5. the tunnel down: the board 502, their site fine; up on a new socket file: the board again, no proxy touched
    const started = await Promise.all(o.proxies.map(startedAt))
    const file = (await socketStat(socketVolume)).split(' ').slice(4).join(' at ')
    await docker(['rm', '-f', tunnel])
    const down = await b.text(`${o.board}/echo`)
    expect(down.status).toBe(502)
    if (o.site) expect(await b.text(o.site)).toEqual({ status: 200, text: 'site page' })
    tunnel = await startTunnel(socketVolume, standin)
    const fileAfter = (await socketStat(socketVolume)).split(' ').slice(4).join(' at ')
    expect(fileAfter).not.toBe(file)
    let again: Echo | null = null
    await until(
      'the board answers on the new socket',
      async () => {
        again = await b.echo(`${o.board}/echo`)
        return again !== null
      },
      15_000,
      300,
    )
    expect((again as Echo | null)?.host).toBe(o.boardHost)
    expect(await Promise.all(o.proxies.map(startedAt))).toEqual(started)
    lines.push(
      `tunnel down: the board ${down.status}${o.site ? ', their site 200' : ''}; up again on a new socket file (inode ${file} → ${fileAfter}): the board answers, no proxy restarted`,
    )
    results.push(lines.join('\n  '))
  }

  test(
    'A: their Caddy on a user network with the marked block, the board’s helper on that network (3a)',
    async () => {
      const dir = join(work(), 'a')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'Caddyfile'),
        [
          '{',
          '\tlocal_certs',
          '\tskip_install_trust',
          '}',
          '',
          `${SITE} {`,
          '\trespond /whoami "{remote_host}"',
          '\trespond "site page"',
          '}',
          '',
          markedBlock(W, 'agent-board-socket:8080'),
          '',
        ].join('\n'),
      )
      const theirs = names('a-their-caddy')
      await runContainer([
        'run',
        '-d',
        '--name',
        theirs,
        '--network',
        net,
        '-p',
        '127.0.0.1::443',
        '-p',
        '127.0.0.1::80',
        '-v',
        `${dir}:/etc/caddy`,
        CADDY_IMAGE,
      ])
      const helper = names('a-helper')
      await runContainer(
        onThisPc(['docker', ...socatRunArgs({ network: net }, W, GID, `it-${RUN}`)].slice(1), {
          name: helper,
          socketVolume,
        }),
      )
      const port = await publishedPort(theirs, 443)
      proxy.routes.set(`${SITE}:443`, port)
      proxy.routes.set(`${W.domain}:443`, port)
      const root = await caddyRoot(theirs)
      const b = browser(proxy, [root])
      await until(
        'their Caddy serves both',
        async () =>
          (await b.text(`https://${SITE}/`)).status === 200 && (await b.echo(`https://${W.domain}/echo`)) !== null,
        60_000,
        1000,
      )
      try {
        await bothAtOnce({
          name: 'A (case 3a: their Caddy, the board’s helper)',
          roots: [root],
          site: `https://${SITE}/`,
          board: `https://${W.domain}`,
          boardHost: W.domain,
          caller: async () => (await b.text(`https://${SITE}/whoami`)).text,
          proxies: [theirs, helper],
          disturb: {
            what: 'their Caddy reloaded (caddy reload in their container)',
            run: async () => {
              await docker([
                'exec',
                theirs,
                'caddy',
                'reload',
                '--config',
                '/etc/caddy/Caddyfile',
                '--adapter',
                'caddyfile',
                '--force',
              ])
            },
            siteThroughout: true,
            boardStreamUntouched: false,
          },
        })
      } finally {
        await docker(['rm', '-f', '-v', theirs, helper], { check: false })
      }
    },
    10 * 60_000,
  )

  test(
    'B: their nginx on 443 and 80, the board’s Caddy on 8443 (4)',
    async () => {
      const dir = join(work(), 'b')
      mkdirSync(join(dir, 'nginx'), { recursive: true })
      mkdirSync(join(dir, 'caddy'), { recursive: true })
      writeFileSync(join(dir, 'nginx', 'site.crt'), siteCert.crt)
      writeFileSync(join(dir, 'nginx', 'site.key'), siteCert.key)
      writeFileSync(
        join(dir, 'nginx', 'default.conf'),
        [
          'server {',
          '    listen 443 ssl;',
          '    listen 80;',
          `    server_name ${SITE};`,
          '    ssl_certificate /etc/nginx/conf.d/site.crt;',
          '    ssl_certificate_key /etc/nginx/conf.d/site.key;',
          '    location = /whoami { return 200 "$remote_addr"; }',
          '    location / { return 200 "site page"; }',
          '}',
          '',
        ].join('\n'),
      )
      writeFileSync(join(dir, 'caddy', 'Caddyfile'), `${localCaddyfile('4b')}\n`)
      const nginx = names('b-their-nginx')
      // on Docker's default bridge, as the board's Caddy: both see this PC's requests from its gateway
      await runContainer([
        'run',
        '-d',
        '--name',
        nginx,
        '-p',
        '127.0.0.1::443',
        '-p',
        '127.0.0.1::80',
        '-v',
        `${join(dir, 'nginx')}:/etc/nginx/conf.d:ro`,
        'nginx:alpine',
      ])
      const caddy = names('b-board-caddy')
      const volumes = [names('b-data'), names('b-config')]
      for (const v of volumes) await docker(['volume', 'create', '--label', LABEL, v])
      await runContainer(
        onThisPc(caddyRunArgs('4b', W, GID, `it-${RUN}`), {
          name: caddy,
          socketVolume,
          config: join(dir, 'caddy'),
          volumes,
        }),
      )
      proxy.routes.set(`${SITE}:443`, await publishedPort(nginx, 443))
      proxy.routes.set(`${W.domain}:8443`, await publishedPort(caddy, 8443))
      const boardRoot = await caddyRoot(caddy)
      const roots = [siteCert.root, boardRoot]
      const b = browser(proxy, roots)
      await until(
        'both serve',
        async () =>
          (await b.text(`https://${SITE}/`)).status === 200 && (await b.echo(`https://${W.domain}:8443/echo`)) !== null,
        60_000,
        1000,
      )
      try {
        await bothAtOnce({
          name: 'B (case 4: their nginx on 443 and 80, the board’s Caddy on 8443)',
          roots,
          site: `https://${SITE}/`,
          board: `https://${W.domain}:8443`,
          boardHost: `${W.domain}:8443`,
          caller: async () => {
            const seen = (await b.text(`https://${SITE}/whoami`)).text
            expect(seen).toBe(gateway)
            return seen
          },
          proxies: [caddy],
          disturb: {
            what: 'their nginx restarted (docker restart)',
            run: async () => {
              await docker(['restart', nginx])
              // a port Docker picked is picked again at a restart
              proxy.routes.set(`${SITE}:443`, await publishedPort(nginx, 443))
              await until(
                'their nginx is back',
                async () => (await b.text(`https://${SITE}/`).catch(() => ({ status: 0 }))).status === 200,
                30_000,
                200,
              )
            },
            siteThroughout: false,
            boardStreamUntouched: true,
          },
        })
      } finally {
        await docker(['rm', '-f', '-v', nginx, caddy], { check: false })
      }
    },
    10 * 60_000,
  )

  test(
    'C: the board’s Caddy alone on 443 (1)',
    async () => {
      const dir = join(work(), 'c')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'Caddyfile'), `${localCaddyfile('1')}\n`)
      const caddy = names('c-board-caddy')
      const volumes = [names('c-data'), names('c-config')]
      for (const v of volumes) await docker(['volume', 'create', '--label', LABEL, v])
      await runContainer(
        onThisPc(caddyRunArgs('1', W, GID, `it-${RUN}`), { name: caddy, socketVolume, config: dir, volumes }),
      )
      proxy.routes.set(`${W.domain}:443`, await publishedPort(caddy, 443))
      const roots = [await caddyRoot(caddy)]
      const b = browser(proxy, roots)
      await until(
        'the board’s Caddy serves',
        async () => (await b.echo(`https://${W.domain}/echo`)) !== null,
        60_000,
        1000,
      )
      try {
        await bothAtOnce({
          name: 'C (case 1: the board’s Caddy alone on 443)',
          roots,
          site: null,
          board: `https://${W.domain}`,
          boardHost: W.domain,
          caller: async () => gateway,
          proxies: [caddy],
        })
      } finally {
        await docker(['rm', '-f', '-v', caddy], { check: false })
      }
    },
    10 * 60_000,
  )
})
