// Files in Team threads, the board's side (#371): the board's service on a real socket to a hub in
// this process, and the other members played with the wire protocol and core/team-box.ts. A post
// with a file is sealed once, its blob goes up before any copy, a member whose board takes files
// opens it with its own box key, and an older board reads FILE_LINE. A file that comes in is
// fetched, checked and kept with the uploads, and the hub forgets it. A box key that changes waits
// for Trust; limits and an older hub are refused with their codes; an agent's file is a draft.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryBlobs } from '../../hub/src/blobs.ts'
import { uploadsDir } from '../../src/adapters/paths.ts'
import { changeAgents, ensureKey, readBlobs, readDrafts, readInbox, readPins } from '../../src/adapters/team-store.ts'
import {
  BLOB_CHUNK,
  b64u,
  boxBytes,
  FILE_LINE,
  type FileRef,
  generateKey,
  type KeyPair,
  type RosterPeer,
  sign,
  unb64u,
  verifyBox,
} from '../../src/core/team.ts'
import { TEAM } from '../../src/core/team-agents.ts'
import { type BoxKeyPair, generateBoxKey, unwrapSecret, wrapSecret } from '../../src/core/team-box.ts'
import { fileContext, openFile, sealFile } from '../../src/core/team-file.ts'
import { createTeam, type TeamService } from '../../src/services/team-hub.ts'
import { createTeamRouter } from '../../src/services/team-router.ts'
import { type Client, fakeClock, type Harness, msgOf, question, startHarness } from '../hub/harness.ts'
import { isolatedHome } from '../support/env.ts'
import { handshake, setup, stopAll, until } from '../support/team-service.ts'

const MB = 1024 * 1024
const FILES = ['threads', 'channels', 'files']

interface Member {
  key: KeyPair
  box: BoxKeyPair
  c: Client
}

let h: Harness
let store: ReturnType<typeof memoryBlobs>
let svc: TeamService | null = null
beforeEach(async () => {
  store = memoryBlobs()
  h = await startHarness({ blobs: store, maxFileBytes: 1 * MB, quotaBytes: 2 * MB })
})
afterEach(() => {
  svc?.stop()
  svc = null
  stopAll()
  h.stop()
})

const claimOf = async (k: KeyPair, box: BoxKeyPair) => ({
  key: box.pub,
  sig: await sign(k.pkcs8, boxBytes({ box: box.pub, peer: k.pub })),
})

async function member(name: string, caps?: string[]): Promise<Member> {
  const key = await generateKey()
  const box = await generateBoxKey()
  const c = await h.join(key, name, undefined, caps, caps ? { box: await claimOf(key, box) } : undefined)
  return { key, box, c }
}

/** The board on this computer, a member of the hub, online with ben (files) and cleo (an older board). */
async function world() {
  const home = isolatedHome()
  const me = await generateKey()
  await ensureKey(me)
  ;(await h.join(me, 'me')).close()
  await h.offline(me.pub)
  const ben = await member('ben', FILES)
  const cleo = await member('cleo')
  const logs: string[] = []
  svc = createTeam({
    cfg: { team: { hub: h.url.replace(/\/v1$/, ''), name: 'me' } },
    log: l => logs.push(l),
    onChange: () => {},
    clock: fakeClock(Date.now()),
  })
  svc.start()
  const s = svc
  await until(
    () => s.view()?.state === 'online' && !!s.view()?.roster.find(p => p.peer === ben.key.pub)?.files,
    'online, ben takes files',
    5000,
  )
  return { me, ben, cleo, svc: s, logs, home }
}

/** What a member's board does with a file it got: fetch it in windows, unwrap with its box, open. */
async function fetchAs(m: Member, ref: FileRef): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = []
  let have = 0
  while (have < ref.size) {
    m.c.send({ t: 'blob_get', id: ref.blob, at: have })
    for (let i = 0; i < 8 && have < ref.size; i++) {
      const d = await m.c.take('blob_data')
      const b = unb64u(d.data) as Uint8Array
      parts.push(b)
      have += b.length
    }
  }
  const secret = await unwrapSecret(ref.key, ref.eph, { peer: m.key.pub, box: m.box }, fileContext(ref.blob))
  if (!secret) return null
  const opened = await openFile(ref, new Uint8Array(Buffer.concat(parts)), secret)
  return opened.ok ? opened.bytes : null
}

/** A member sends the board a file, as its board would: sealed, put on the hub, then the message. */
async function sendFrom(m: Member, to: string, toBox: string, bytes: Uint8Array, name: string, tamper = false) {
  const blob = crypto.randomUUID()
  const sealed = await sealFile(bytes, { name, type: 'application/octet-stream', size: bytes.length }, blob)
  const w = await wrapSecret(sealed.secret, [{ peer: to, box: toBox }], fileContext(blob))
  m.c.send({ t: 'blob_open', id: blob, size: sealed.blob.length, hash: sealed.hash, to: [to], ttl_s: 3600 })
  let have = (await m.c.take('blob_have')).have
  while (have < sealed.blob.length) {
    m.c.send({ t: 'blob_put', id: blob, at: have, data: b64u(sealed.blob.subarray(have, have + BLOB_CHUNK)) })
    if (have + BLOB_CHUNK >= sealed.blob.length) break
    have = (await m.c.take('blob_have')).have
  }
  await m.c.take('blob_ready')
  if (tamper) {
    const held = store.bytes(blob) as Uint8Array
    held[held.length - 1] = (held[held.length - 1] as number) ^ 1
    store.remove(blob)
    store.append(blob, held)
  }
  const file = {
    blob,
    size: sealed.blob.length,
    hash: sealed.hash,
    eph: w.eph,
    key: w.keys[to] as string,
    meta: sealed.meta,
  }
  m.c.send({ t: 'send', env: await question(m.key, to, '', { id: crypto.randomUUID(), body: { text: '', file } }) })
  return blob
}

const writeTemp = (dir: string, name: string, bytes: Uint8Array | string): string => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

describe('a file that goes out', () => {
  test('sealed once; the blob is on the hub before any copy; ben opens it with his box; cleo reads FILE_LINE', async () => {
    const w = await world()
    const bytes = crypto.getRandomValues(new Uint8Array(300_000))
    const path = writeTemp(w.home, 'app.log', bytes)
    const r = await w.svc.post({ to: TEAM }, 'the log', { by: 'ui' }, { path, name: 'app.log' })
    expect(r.ok).toBe(true)
    const d = await w.ben.c.take('deliver', 5000)
    const msg = msgOf(d.env)
    const ref = msg.body.file as FileRef
    expect(msg.body.text).toBe('the log')
    expect(ref).toBeDefined()
    // The copy came after the hub had the whole blob.
    expect(h.db.blob(ref.blob)?.state).toBe('ready')
    const got = await fetchAs(w.ben, ref)
    expect(got && Buffer.from(got).equals(Buffer.from(bytes))).toBe(true)
    // Cleo's board is older: the text, then the line, and no file.
    const old = msgOf((await w.cleo.c.take('deliver', 5000)).env)
    expect(old.body.file).toBeUndefined()
    expect(old.body.text).toContain(`the log\n\n${FILE_LINE}`)
    // The hub was told the blob is for ben alone; the board's line shows its file as up, with its own copy.
    expect(JSON.parse(h.db.blob(ref.blob)?.recipients ?? '[]')).toEqual([w.ben.key.pub])
    const line = w.svc.threadLines(`${TEAM}/general`).find(l => l.dir === 'out')
    expect(line?.file).toMatchObject({ state: 'up', name: 'app.log', size: bytes.length })
    expect(
      existsSync(join(uploadsDir(), (line?.file?.url ?? '').split('/').slice(2).map(decodeURIComponent).join('/'))),
    ).toBe(true)
    expect(readBlobs()[0]?.state).toBe('up')
  })

  test('a file with no caption: ben gets an empty text and the file, cleo FILE_LINE alone', async () => {
    const w = await world()
    const path = writeTemp(w.home, 'shot.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]))
    expect((await w.svc.post({ to: TEAM }, '', { by: 'ui' }, { path, name: 'shot.png' })).ok).toBe(true)
    const msg = msgOf((await w.ben.c.take('deliver', 5000)).env)
    expect([msg.body.text, !!msg.body.file]).toEqual(['', true])
    expect(msgOf((await w.cleo.c.take('deliver', 5000)).env).body.text).toContain(FILE_LINE)
  })

  test('limits: a file over what the hub takes, no file, no name, nobody who can take one, and the quota', async () => {
    const w = await world()
    const big = writeTemp(w.home, 'big.bin', new Uint8Array(MB))
    expect(await w.svc.post({ to: TEAM }, 'x', { by: 'ui' }, { path: big, name: 'big.bin' })).toEqual({
      ok: false,
      error: 'file_big',
    })
    expect(await w.svc.post({ to: TEAM }, 'x', { by: 'ui' }, { path: join(w.home, 'none'), name: 'none' })).toEqual({
      ok: false,
      error: 'file',
    })
    const small = writeTemp(w.home, 'a.txt', 'hello')
    expect(await w.svc.post({ to: TEAM }, 'x', { by: 'ui' }, { path: small, name: 'a/b' })).toEqual({
      ok: false,
      error: 'file_name',
    })
    expect(await w.svc.post({ to: w.cleo.key.pub }, 'x', { by: 'ui' }, { path: small, name: 'a.txt' })).toEqual({
      ok: false,
      error: 'files_nobody',
    })
    // Two of 0.9 MB fill the quota of 2 MB while ben has not fetched them; the third is refused by the hub.
    const part = writeTemp(w.home, 'part.bin', crypto.getRandomValues(new Uint8Array(900_000)))
    for (let i = 0; i < 2; i++)
      expect(
        (await w.svc.post({ to: w.ben.key.pub }, `p${i}`, { by: 'ui' }, { path: part, name: 'part.bin' })).ok,
      ).toBe(true)
    await w.ben.c.take('deliver', 5000)
    await w.ben.c.take('deliver', 5000)
    const third = await w.svc.post({ to: w.ben.key.pub }, 'p2', { by: 'ui' }, { path: part, name: 'part.bin' })
    expect(third.ok).toBe(true)
    await until(() => readBlobs().some(b => b.state === 'refused'), 'the third refused', 5000)
    expect(readBlobs().find(b => b.state === 'refused')?.code).toBe('quota')
    const line = w.svc.threadLines(`${w.ben.key.pub}/general`).find(l => l.text === 'p2')
    expect(line?.state).toBe('refused')
    expect(line?.file).toMatchObject({ state: 'refused', why: 'quota' })
  })
})

describe('a file that comes in', () => {
  test('fetched, its hash checked, opened with this board box key, kept with the uploads; the hub forgets it', async () => {
    const w = await world()
    const meBox = await boxOfBoard(w.ben, w.me.pub)
    const bytes = new TextEncoder().encode('zebra-marker-7731 spec')
    const blob = await sendFrom(w.ben, w.me.pub, meBox, bytes, 'spec.txt')
    await until(() => readInbox(w.ben.key.pub)[0]?.file?.state === 'ready', 'kept', 5000)
    const f = readInbox(w.ben.key.pub)[0]?.file
    expect(f).toMatchObject({ state: 'ready', name: 'spec.txt', size: bytes.length })
    expect(f?.ref).toBeUndefined()
    expect(readFileSync(f?.path as string, 'utf8')).toBe('zebra-marker-7731 spec')
    expect(f?.url).toMatch(/^\/uploads\/\d{4}-\d{2}-\d{2}\/\d{6}-[0-9a-f]{8}-spec\.txt$/)
    await until(() => h.db.blob(blob)?.state === 'gone', 'the hub forgot it', 5000)
    expect(h.db.blob(blob)?.gone_why).toBe('fetched')
    const line = w.svc.threadLines(`${w.ben.key.pub}/general`).find(l => l.dir === 'in')
    expect(line?.file).toMatchObject({ state: 'ready', name: 'spec.txt' })
  })

  test('a byte changed on the hub fails the file with `hash`, a key for another box with `key`; nothing is kept', async () => {
    const w = await world()
    const meBox = await boxOfBoard(w.ben, w.me.pub)
    await sendFrom(w.ben, w.me.pub, meBox, new Uint8Array(5000).fill(1), 'a.bin', true)
    await until(() => readInbox(w.ben.key.pub)[0]?.file?.state === 'failed', 'failed', 5000)
    expect(readInbox(w.ben.key.pub)[0]?.file).toMatchObject({ state: 'failed', why: 'hash' })
    const other = await generateBoxKey()
    await sendFrom(w.ben, w.me.pub, other.pub, new Uint8Array(10).fill(2), 'b.bin')
    await until(() => readInbox(w.ben.key.pub)[1]?.file?.state === 'failed', 'failed', 5000)
    expect(readInbox(w.ben.key.pub)[1]?.file).toMatchObject({ state: 'failed', why: 'key' })
  })
})

describe('box keys', () => {
  test('the hello says the board box key, signed with its key', async () => {
    const s = setup()
    s.svc.start()
    const { ws, me } = await handshake(s)
    const hello = ws.of('hello')[0]
    expect(hello?.caps).toContain('files')
    expect(await verifyBox(me, hello?.box)).toBe(true)
  })

  test('an older hub (no files in its welcome): a post with a file is refused, text goes as before', async () => {
    const s = setup()
    s.svc.start()
    const ben = await generateKey()
    await handshake(s, [{ peer: ben.pub, name: 'ben', caps: FILES }])
    const dir = isolatedHome()
    const path = writeTemp(dir, 'a.txt', 'x')
    expect(await s.svc.post({ to: ben.pub }, 'x', { by: 'ui' }, { path, name: 'a.txt' })).toEqual({
      ok: false,
      error: 'files_hub',
    })
    expect((await s.svc.post({ to: ben.pub }, 'plain', { by: 'ui' })).ok).toBe(true)
  })

  test('a box key that changes makes the pin `changed`: nothing goes to it until Trust, which takes the new box', async () => {
    const w = await world()
    expect(readPins()[w.ben.key.pub]?.box).toBe(w.ben.box.pub)
    w.ben.c.close()
    await w.ben.c.closed
    await h.offline(w.ben.key.pub)
    const fresh = await generateBoxKey()
    const c = await h.login(w.ben.key, FILES, { box: await claimOf(w.ben.key, fresh) })
    const ben2: Member = { key: w.ben.key, box: fresh, c }
    await until(() => readPins()[w.ben.key.pub]?.status === 'changed', 'changed', 5000)
    const path = writeTemp(w.home, 'a.txt', 'secret plan')
    expect(await w.svc.post({ to: w.ben.key.pub }, 'x', { by: 'ui' }, { path, name: 'a.txt' })).toEqual({
      ok: false,
      error: 'changed',
    })
    expect(w.svc.trust(w.ben.key.pub)).toBe(true)
    expect(readPins()[w.ben.key.pub]).toMatchObject({ status: 'trusted', box: fresh.pub })
    expect((await w.svc.post({ to: w.ben.key.pub }, 'x', { by: 'ui' }, { path, name: 'a.txt' })).ok).toBe(true)
    const ref = msgOf((await ben2.c.take('deliver', 5000)).env).body.file as FileRef
    expect(Buffer.from((await fetchAs(ben2, ref)) ?? []).toString()).toBe('secret plan')
  })
})

describe("an agent's file", () => {
  test('a draft keeps its own copy; Send carries the file with the agent mark; Discard removes the copy', async () => {
    const w = await world()
    const path = writeTemp(w.home, 'notes.md', 'first')
    const d = w.svc.draft(w.ben.key.pub, '', {
      reason: 'file',
      session: { key: 's1', name: 'docs' },
      file: { path, name: 'notes.md' },
    })
    expect(d.ok).toBe(true)
    writeFileSync(path, 'changed later')
    const kept = readDrafts()[0]?.file
    expect(readFileSync(kept?.path as string, 'utf8')).toBe('first')
    expect(w.svc.threadLines(`${w.ben.key.pub}/general`).find(l => l.dir === 'draft')?.file).toMatchObject({
      state: 'draft',
      name: 'notes.md',
      size: 5,
    })
    expect((await w.svc.sendDraft((d as { id: string }).id)).ok).toBe(true)
    expect(existsSync(kept?.path as string)).toBe(false)
    const msg = msgOf((await w.ben.c.take('deliver', 5000)).env)
    expect(msg.body.via).toBe('agent')
    expect(Buffer.from((await fetchAs(w.ben, msg.body.file as FileRef)) ?? []).toString()).toBe('first')
    const other = w.svc.draft(w.ben.key.pub, 'again', { file: { path, name: 'notes.md' } })
    const copy = readDrafts()[0]?.file?.path as string
    expect(w.svc.discardDraft((other as { id: string }).id)).toBe(true)
    expect(existsSync(copy)).toBe(false)
  })
})

describe("an agent's file goes as its text does (#415)", () => {
  const LANES = [
    { id: 'acme', title: 'Acme Corp', color: 'blue', paths: [] },
    { id: 'globex', title: 'Globex', color: 'red', paths: [] },
  ]
  const ITEMS = [
    { key: 'sess-acme', name: 'acme-work', category: 'acme' },
    { key: 'sess-globex', name: 'globex-work', category: 'globex' },
  ]

  /** The board with its router: agents on for ben with the lane acme shared, a session in each lane. */
  async function routed() {
    const w = await world()
    changeAgents(x => {
      x.peers[w.ben.key.pub] = { on: true, lanes: ['acme'] }
    })
    const router = createTeamRouter({
      team: w.svc,
      cfg: { team: { hub: 'ws://unused', name: 'me' }, categories: LANES } as never,
      items: () => ITEMS,
      schedule: { list: () => [], add: () => {}, update: () => false },
    })
    const post = (path: string, text = 'the report', session = 'sess-acme') =>
      router.agentPost({ to: w.ben.key.pub, text, session: { key: session, name: 'acme-work' }, file: { path } })
    return { ...w, router, post }
  }

  test('a clean text file in a shared lane, agents on: sent at once, marked as an agent message; ben opens it', async () => {
    const w = await routed()
    const path = writeTemp(w.home, 'report.md', '# Report\n\nAll fine.\n')
    expect(await w.post(path)).toMatchObject({ ok: true, sent: true })
    expect(readDrafts()).toEqual([])
    const msg = msgOf((await w.ben.c.take('deliver', 5000)).env)
    expect(msg.body).toMatchObject({ text: 'the report', via: 'agent', agent: 'acme-work' })
    const ref = msg.body.file as FileRef
    expect(Buffer.from((await fetchAs(w.ben, ref)) ?? []).toString()).toBe('# Report\n\nAll fine.\n')
    // In the thread as this board's agent's message with its file, not as a draft.
    const lines = w.svc.threadLines(`${w.ben.key.pub}/general`)
    expect(lines.map(l => l.dir)).toEqual(['out'])
    expect(lines[0]?.file).toMatchObject({ name: 'report.md', size: 20 })
  })

  test('a binary file goes as it is, even with what reads like a secret in its bytes', async () => {
    const w = await routed()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, ...Buffer.from('AKIAABCDEFGHIJKLMNOP')])
    const path = join(w.home, 'shot.png')
    writeFileSync(path, bytes)
    expect(await w.post(path, '')).toMatchObject({ ok: true, sent: true })
    const ref = msgOf((await w.ben.c.take('deliver', 5000)).env).body.file as FileRef
    expect(Buffer.from((await fetchAs(w.ben, ref)) ?? []).equals(Buffer.from(bytes))).toBe(true)
  })

  test('held exactly as the same text would be: a secret in a text file, a lane not shared, agents off, the loop pause', async () => {
    const w = await routed()
    const leaky = writeTemp(w.home, 'env.txt', 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n')
    expect(await w.post(leaky)).toMatchObject({ sent: false, reason: 'secret', detail: 'a GitHub token in the file' })
    // What Windows PowerShell's `>` writes: UTF-16 with its byte order mark.
    const wide = join(w.home, 'wide.txt')
    writeFileSync(wide, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('key AKIAABCDEFGHIJKLMNOP', 'utf16le')]))
    expect(await w.post(wide)).toMatchObject({ sent: false, reason: 'secret', detail: 'an AWS key in the file' })
    const clean = writeTemp(w.home, 'clean.csv', 'a,b\n1,2\n')
    expect(await w.post(clean, 'from globex', 'sess-globex')).toMatchObject({ sent: false, reason: 'lane' })
    changeAgents(x => {
      x.peers[w.ben.key.pub] = { on: false, lanes: ['acme'] }
    })
    expect(await w.post(clean, 'agents off')).toMatchObject({ sent: false, reason: 'off' })
    changeAgents(x => {
      x.peers[w.ben.key.pub] = { on: true, lanes: ['acme'], loop: 1 }
    })
    expect(await w.router.agentPost({ to: w.ben.key.pub, text: 'hello', session: { key: 'sess-acme' } })).toMatchObject(
      {
        sent: true,
      },
    )
    expect(await w.post(clean, 'after the loop')).toMatchObject({ sent: false, reason: 'loop' })
    // Each held one keeps its file, and the drafts list says so.
    expect(w.svc.drafts().map(d => [d.reason, d.file?.name, d.key])).toEqual([
      ['secret', 'env.txt', `${w.ben.key.pub}/general`],
      ['secret', 'wide.txt', `${w.ben.key.pub}/general`],
      ['lane', 'clean.csv', `${w.ben.key.pub}/general`],
      ['off', 'clean.csv', `${w.ben.key.pub}/general`],
      ['loop', 'clean.csv', `${w.ben.key.pub}/general`],
    ])
    // The text went; no file did.
    const msg = msgOf((await w.ben.c.take('deliver', 5000)).env)
    expect(msg.body.text).toBe('hello')
    await w.ben.c.settle(100)
    expect(w.ben.c.frames.filter(f => f.t === 'deliver')).toHaveLength(0)
  })

  test('what was checked is what goes: the bytes read for the check, not the path read again', async () => {
    const w = await routed()
    const path = writeTemp(w.home, 'notes.md', 'on disk now')
    const r = await w.svc.post(
      { to: w.ben.key.pub },
      '',
      { by: 'agent' },
      { path, name: 'notes.md', bytes: Buffer.from('checked') },
    )
    expect(r.ok).toBe(true)
    const ref = msgOf((await w.ben.c.take('deliver', 5000)).env).body.file as FileRef
    expect(Buffer.from((await fetchAs(w.ben, ref)) ?? []).toString()).toBe('checked')
  })

  test('two files under no caption are no echo of each other; the same file under the same caption is', async () => {
    const w = await routed()
    const a = writeTemp(w.home, 'a.csv', '1')
    const b = writeTemp(w.home, 'b.csv', '2')
    expect(await w.post(a, '')).toMatchObject({ sent: true })
    expect(await w.post(b, '')).toMatchObject({ sent: true })
    expect(await w.post(a, '')).toEqual({ ok: false, error: 'echo' })
  })

  test('a text over the limit is refused with its length and the limit', async () => {
    const w = await routed()
    expect(
      await w.router.agentPost({ to: w.ben.key.pub, text: 'x'.repeat(4062), session: { key: 'sess-acme' } }),
    ).toEqual({ ok: false, error: 'text', detail: '4062 of 4000' })
  })
})

/** The board's box key as a member's board has it from the roster, checked as its board would. */
async function boxOfBoard(m: Member, peer: string): Promise<string> {
  const end = Date.now() + 5000
  for (;;) {
    const r = m.c.frames.filter(f => f.t === 'roster' || f.t === 'presence')
    for (const f of r.reverse()) {
      const claim =
        f.t === 'roster'
          ? (f.peers as RosterPeer[]).find(p => p.peer === peer)?.box
          : f.peer === peer
            ? f.box
            : undefined
      if (claim && (await verifyBox(peer, claim))) return claim.key
    }
    if (Date.now() > end) throw new Error('no box for the board')
    await m.c.settle(30)
  }
}

describe('what the review found (#371)', () => {
  /** A board on a fake hub that takes files up to `max`, with ben (files, `box`) on its roster. */
  async function fake(benBox: unknown, max = MB) {
    const s = setup()
    s.svc.start()
    const ben = await generateKey()
    const { ws, me } = await handshake(s, [{ peer: ben.pub, name: 'ben', caps: FILES, box: benBox }], 1, {
      files: { max, quota: 4 * MB },
    })
    const box = ws.of('hello')[0]?.box?.key as string
    return { s, ws, me, ben, box }
  }

  test('a signed box nothing can be sealed to (all zeros) is no box: no file goes, nothing throws', async () => {
    const key = await generateKey()
    const zeros = b64u(new Uint8Array(32))
    const claim = { key: zeros, sig: await sign(key.pkcs8, boxBytes({ box: zeros, peer: key.pub })) }
    expect(await verifyBox(key.pub, claim)).toBe(true)
    const { usableBox } = await import('../../src/core/team-box.ts')
    expect(await usableBox(zeros)).toBe(false)
    expect(await usableBox((await generateBoxKey()).pub)).toBe(true)
    // The hub takes no such claim.
    const c = await h.join(key, 'dora', undefined, FILES, { box: claim })
    c.close()
    expect(h.db.peer(key.pub)?.box).toBeNull()
    // A board takes none either, from whatever hub.
    const s = setup()
    s.svc.start()
    await handshake(s, [{ peer: key.pub, name: 'dora', caps: FILES, box: claim }], 1, { files: { max: MB, quota: MB } })
    await Bun.sleep(50)
    expect(s.svc.view()?.roster[0]?.files).toBeUndefined()
    const dir = isolatedHome()
    const path = writeTemp(dir, 'a.txt', 'x')
    expect(await s.svc.post({ to: key.pub }, 'x', { by: 'ui' }, { path, name: 'a.txt' })).toEqual({
      ok: false,
      error: 'files_nobody',
    })
  })

  test('a copy whose signed size is not its blob fails at once, and the next file still comes', async () => {
    const w = await world()
    const meBox = await boxOfBoard(w.ben, w.me.pub)
    const bytes = new TextEncoder().encode('one')
    const blob = crypto.randomUUID()
    const sealed = await sealFile(bytes, { name: 'a.txt', type: 'text/plain', size: 3 }, blob)
    const wr = await wrapSecret(sealed.secret, [{ peer: w.me.pub, box: meBox }], fileContext(blob))
    w.ben.c.send({ t: 'blob_open', id: blob, size: sealed.blob.length, hash: sealed.hash, to: [w.me.pub], ttl_s: 600 })
    await w.ben.c.take('blob_have')
    w.ben.c.send({ t: 'blob_put', id: blob, at: 0, data: b64u(sealed.blob) })
    await w.ben.c.take('blob_ready')
    const file = {
      blob,
      size: sealed.blob.length + 1,
      hash: sealed.hash,
      eph: wr.eph,
      key: wr.keys[w.me.pub] as string,
      meta: sealed.meta,
    }
    w.ben.c.send({
      t: 'send',
      env: await question(w.ben.key, w.me.pub, '', { id: crypto.randomUUID(), body: { text: '', file } }),
    })
    await until(() => readInbox(w.ben.key.pub)[0]?.file?.state === 'failed', 'failed', 5000)
    expect(readInbox(w.ben.key.pub)[0]?.file?.why).toBe('data')
    await sendFrom(w.ben, w.me.pub, meBox, new TextEncoder().encode('two'), 'b.txt')
    await until(() => readInbox(w.ben.key.pub)[1]?.file?.state === 'ready', 'the next one came', 5000)
  })

  test('a fetch the hub never answers fails after a minute; a file over what the board takes fails as big before any fetch', async () => {
    const { s, ws, me, ben, box } = await fake(undefined, 2000)
    const send = async (size: number) => {
      const blob = crypto.randomUUID()
      const sealed = await sealFile(
        new Uint8Array(size),
        { name: 'x.bin', type: 'application/octet-stream', size },
        blob,
      )
      const wr = await wrapSecret(sealed.secret, [{ peer: me, box }], fileContext(blob))
      const file = {
        blob,
        size: sealed.blob.length,
        hash: sealed.hash,
        eph: wr.eph,
        key: wr.keys[me] as string,
        meta: sealed.meta,
      }
      ws.recv({ t: 'deliver', env: await question(ben, me, '', { id: crypto.randomUUID(), body: { text: '', file } }) })
      return blob
    }
    const big = await send(3000)
    await until(() => readInbox(ben.pub)[0]?.file?.state === 'failed', 'big', 2000)
    expect(readInbox(ben.pub)[0]?.file?.why).toBe('big')
    expect(ws.of('blob_get').some(f => f.id === big)).toBe(false)
    const quiet = await send(100)
    await until(() => ws.of('blob_get').some(f => f.id === quiet), 'asked', 2000)
    s.clock.tick(59_000)
    expect(readInbox(ben.pub)[1]?.file?.state).toBe('pending')
    s.clock.tick(2_000)
    expect(readInbox(ben.pub)[1]?.file).toMatchObject({ state: 'failed', why: 'timeout' })
  })

  test("an agent's file over the default limit is refused while the hub has not said its own", async () => {
    const s = setup()
    s.svc.start()
    const ben = await generateKey()
    await handshake(s, [{ peer: ben.pub, name: 'ben', caps: FILES }])
    const dir = isolatedHome()
    const path = writeTemp(dir, 'disk.img', new Uint8Array(25 * MB))
    expect(s.svc.draft(ben.pub, 'x', { file: { path, name: 'disk.img' } })).toEqual({ ok: false, error: 'file_big' })
    expect(readDrafts()).toEqual([])
  })
})
