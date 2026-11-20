// Files on the board's local API (#371), against a hub in this process: the panel puts a file in
// the uploads (/api/upload), its Send names it (`file: { upload }`) and the member gets it sealed
// to their box; a session's post with a file (`file: { path }`) goes as its text would (#415), so
// with the switches off it is held, and the thread list names the draft with its file; a name
// outside the uploads is refused. The board runs in a sandbox.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryBlobs } from '../../hub/src/blobs.ts'
import { boxBytes, type FileRef, generateKey, type KeyPair, sign, unb64u } from '../../src/core/team.ts'
import { generateBoxKey, unwrapSecret } from '../../src/core/team-box.ts'
import { fileContext, openFile } from '../../src/core/team-file.ts'
import { type Client, type Harness, msgOf, startHarness } from '../hub/harness.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const post = (url: string, path: string, body: unknown) =>
  fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  }).then(async r => [r.status, await r.json()] as [number, Record<string, unknown>])

const sandbox = sharedSandbox()
let box: Sandbox
let url = ''
let hub: Harness
let me: KeyPair
let anna: KeyPair
let annaBox: Awaited<ReturnType<typeof generateBoxKey>>
let annaClient: Client

beforeAll(async () => {
  hub = await startHarness({ blobs: memoryBlobs() })
  me = await generateKey()
  anna = await generateKey()
  annaBox = await generateBoxKey()
  ;(await hub.join(me, 'me')).close()
  const claim = { key: annaBox.pub, sig: await sign(anna.pkcs8, boxBytes({ box: annaBox.pub, peer: anna.pub })) }
  annaClient = await hub.join(anna, 'anna', undefined, ['threads', 'channels', 'files'], { box: claim })
  box = await sandbox()
  mkdirSync(stateOf(box), { recursive: true })
  writeFileSync(join(stateOf(box), 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
  ;({ url } = await serveBoard(box, { language: 'en', team: { hub: hub.url.replace(/\/v1$/, ''), name: 'me' } }))
  const end = Date.now() + 8000
  for (;;) {
    const v = (await (await fetch(`${url}/api/team`)).json()) as { roster: { name: string; files?: boolean }[] }
    if (v.roster.some(p => p.name === 'anna' && p.files)) break
    if (Date.now() > end) throw new Error('timed out: anna takes files')
    await Bun.sleep(25)
  }
})
afterAll(() => hub.stop())

test("the panel's Send with a file from the uploads: anna gets it sealed to her box, and opens it", async () => {
  const shot = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
  const up = (await (
    await fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-board': '1', 'x-filename': 'shot.png' },
      body: shot,
    })
  ).json()) as { ok: boolean; url: string }
  expect(up.ok).toBe(true)
  const upload = decodeURIComponent(up.url.replace(/^\/uploads\//, ''))
  expect(
    await post(url, '/api/team/send', { to: anna.pub, text: '', file: { upload, name: 'shot.png' } }),
  ).toMatchObject([200, { ok: true }])
  const d = await annaClient.take('deliver', 8000)
  const ref = msgOf(d.env).body.file as FileRef
  annaClient.send({ t: 'blob_get', id: ref.blob, at: 0 })
  const data = await annaClient.take('blob_data', 8000)
  const secret = (await unwrapSecret(
    ref.key,
    ref.eph,
    { peer: anna.pub, box: annaBox },
    fileContext(ref.blob),
  )) as Uint8Array
  const opened = await openFile(ref, unb64u(data.data) as Uint8Array, secret)
  expect(opened.ok && opened.meta.name).toBe('shot.png')
  expect(opened.ok && Buffer.from(opened.bytes).equals(Buffer.from(shot))).toBe(true)
})

test('a name outside the uploads, or a file that is not there, is refused before anything waits', async () => {
  for (const upload of ['../team-key.json', '2026-01-01/../../team-key.json', '2026-01-01/none.png', 'x'])
    expect(await post(url, '/api/team/send', { to: anna.pub, text: 'x', file: { upload } })).toEqual([
      400,
      { ok: false, error: 'file' },
    ])
  expect(await post(url, '/api/team/send', { to: anna.pub, text: '' })).toEqual([400, { ok: false, error: 'text' }])
})

test('an upload is taken by its real path (#467): a link or junction out of the uploads is refused, an upload goes', async () => {
  const uploads = join(stateOf(box), 'uploads')
  const outside = join(box.dir, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'atlas.png'), 'atlas')
  // a folder beside the uploads whose name only starts the same; it and `..` are refused by the
  // name's pattern before any file call, kept here so a looser pattern cannot let them through
  mkdirSync(join(stateOf(box), 'uploads2', '2026-01-03'), { recursive: true })
  writeFileSync(join(stateOf(box), 'uploads2', '2026-01-03', 'ben.png'), 'ben')
  // a day folder that is a junction out (a plain link off win32)
  mkdirSync(uploads, { recursive: true })
  symlinkSync(outside, join(uploads, '2026-01-02'), 'junction')
  const refused = [
    '2026-01-02/atlas.png',
    '../uploads2/2026-01-03/ben.png',
    '2026-01-03/../../uploads2/2026-01-03/ben.png',
  ]
  // a file named like an upload that links out; a file link needs a right Windows may not give
  mkdirSync(join(uploads, '2026-01-04'), { recursive: true })
  try {
    symlinkSync(join(outside, 'atlas.png'), join(uploads, '2026-01-04', 'atlas.png'), 'file')
    refused.push('2026-01-04/atlas.png')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e
  }
  for (const upload of refused)
    expect([upload, await post(url, '/api/team/send', { to: anna.pub, text: 'x', file: { upload } })]).toEqual([
      upload,
      [400, { ok: false, error: 'file' }],
    ])
  // a plain upload in the same folder still goes
  writeFileSync(join(uploads, '2026-01-04', '120000-cleo.png'), 'cleo')
  expect(
    await post(url, '/api/team/send', { to: anna.pub, text: '', file: { upload: '2026-01-04/120000-cleo.png' } }),
  ).toMatchObject([200, { ok: true }])
  const ref = msgOf((await annaClient.take('deliver', 8000)).env).body.file as FileRef
  annaClient.send({ t: 'blob_get', id: ref.blob, at: 0 })
  const data = await annaClient.take('blob_data', 8000)
  const secret = (await unwrapSecret(
    ref.key,
    ref.eph,
    { peer: anna.pub, box: annaBox },
    fileContext(ref.blob),
  )) as Uint8Array
  const opened = await openFile(ref, unb64u(data.data) as Uint8Array, secret)
  expect(opened.ok && opened.meta.name).toBe('cleo.png')
  expect(opened.ok && Buffer.from(opened.bytes).toString()).toBe('cleo')
})

test("a session's post with a file, agents off: held as a draft with the board's copy, listed with the threads; a relative path is refused", async () => {
  const file = join(box.dir, 'report.csv')
  writeFileSync(file, 'a,b\n')
  const session = { key: 'sess-1', name: 'worker' }
  const [status, reply] = await post(url, '/api/team/post', {
    to: anna.pub,
    text: 'report',
    session,
    file: { path: file },
  })
  expect(status).toBe(200)
  // The switches are off by default: held, as the same text would be.
  expect(reply).toMatchObject({ ok: true, sent: false, reason: 'off' })
  const lines = (await (await fetch(`${url}/api/team/threads/${anna.pub}/general`)).json()) as {
    lines: { dir: string; file?: unknown }[]
  }
  expect(lines.lines.find(l => l.dir === 'draft')?.file).toMatchObject({ state: 'draft', name: 'report.csv', size: 4 })
  // Every thread's drafts come with the thread list (#415): what the panel and `board team drafts` read.
  const list = (await (await fetch(`${url}/api/team/threads`)).json()) as { drafts: Record<string, unknown>[] }
  expect(list.drafts).toEqual([
    expect.objectContaining({
      to: anna.pub,
      key: `${anna.pub}/general`,
      reason: 'off',
      agent: 'worker',
      text: 'report',
      file: { name: 'report.csv', size: 4 },
    }),
  ])
  expect(await post(url, '/api/team/post', { to: anna.pub, text: 'x', session, file: { path: 'report.csv' } })).toEqual(
    [400, { ok: false, error: 'file' }],
  )
})
