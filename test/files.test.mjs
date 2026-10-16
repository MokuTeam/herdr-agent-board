import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { inline, looksLikePath, markdown } from '../web/markdown.js'
import { sandbox, until } from './support/sandbox.ts'

test('paths in the chat: links, code and running text become candidates; the rest stays text', () => {
  assert.match(inline('[notes](herdr-reveal:C:/Work/My%20Notes/a.md)'), /^<a class="fs" data-path="herdr-reveal:C:\/Work\/My%20Notes\/a\.md">notes<\/a>$/)
  assert.match(inline('see `src/server.mjs:42`'), /<code class="fs-cand" data-path="src\/server\.mjs:42">src\/server\.mjs:42<\/code>/)
  assert.match(inline('saved to C:\\Work\\out\\report_v2.csv.'), /<span class="fs-cand" data-path="C:\\Work\\out\\report_v2\.csv">C:\\Work\\out\\report_v2\.csv<\/span>\.$/)
  assert.match(inline('logs in /var/log/app/today.log'), /data-path="\/var\/log\/app\/today\.log"/)
  assert.match(inline('`~/notes/todo.md`'), /data-path="~\/notes\/todo\.md"/)
  // Not paths: commands, versions, fractions, words with a slash, web links.
  for (const text of ['`npm test`', '`v1.2.3`', '1/2 done', 'and/or', '`foo.bar()`', '`src/**/*.js`']) assert.ok(!/data-path/.test(inline(text)), text)
  assert.match(inline('see https://example.com/a/b and [docs](https://x.dev)'), /<a class="ext" href="https:\/\/example\.com\/a\/b"[^>]*>https:\/\/example\.com\/a\/b<\/a> and <a class="ext" href="https:\/\/x\.dev"/)
  assert.ok(!/fs-cand/.test(inline('see https://example.com/a/b')))
  // Emphasis rules leave paths alone; quotes cannot break out of the attribute.
  assert.match(inline('C:\\a_b\\c_d_e.txt and _this_'), /data-path="C:\\a_b\\c_d_e\.txt">C:\\a_b\\c_d_e\.txt<\/span> and <i>this<\/i>/)
  assert.ok(!/data-path="[^"]*"[^>]*onmouseover/.test(inline('`C:/x" onmouseover="alert(1)`')))
  assert.match(markdown('- see `README.md`'), /<li>see <code class="fs-cand" data-path="README\.md">/)
  // The chat keeps an agent's line breaks; a document in the quick look reads as Markdown does.
  assert.equal(markdown('one\ntwo'), '<p>one<br>two</p>')
  assert.equal(markdown('one\ntwo\n\n- a\n  b', { soft: true }), '<p>one two</p><ul><li>a b</li></ul>')
  assert.ok(looksLikePath('\\\\server\\share\\x.txt') && looksLikePath('file:///C:/x.txt') && !looksLikePath('https://x.dev/a'))
})

async function unusedPort() {
  const server = http.createServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise(r => server.close(r))
  return port
}

test('file API: stat, preview, raw bytes behind the token with ranges, and refusals', { timeout: 20_000 }, async t => {
  const box = await sandbox(t)
  box.state({ 'api snapshot': { error: 'offline' } })
  const files = join(box.dir, 'files')
  mkdirSync(files)
  writeFileSync(join(files, 'pic.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  writeFileSync(join(files, 'note.txt'), 'hello')
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const post = (path, body, headers = { 'x-board': '1' }) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  const stat = await (await post('/api/fs/stat', { cwd: files, paths: ['note.txt:3', 'pic.png', 'missing.md', files] })).json()
  assert.deepEqual(stat.items.map(i => [i.exists, i.dir ?? null, i.kind ?? null, i.line]), [[true, false, 'text', 3], [true, false, 'image', null], [false, null, null, null], [true, true, 'dir', null]])
  assert.equal((await post('/api/fs/stat', { paths: [] }, {})).status, 403)

  const note = await (await post('/api/fs/preview', { path: join(files, 'note.txt') })).json()
  assert.equal(note.text, 'hello')

  const board = await (await fetch(`${url}/api/board`)).json()
  assert.ok(board.fsToken)
  const raw = token => fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'pic.png'))}&t=${token}`)
  assert.equal((await raw('wrong')).status, 403)
  const ok = await raw(board.fsToken)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.match(ok.headers.get('content-security-policy'), /sandbox/)
  assert.equal(Buffer.from(await ok.arrayBuffer()).length, 16)
  const part = await fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'pic.png'))}&t=${board.fsToken}`, { headers: { range: 'bytes=4-7' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 4-7/16')
  assert.deepEqual([...Buffer.from(await part.arrayBuffer())], [0x0d, 0x0a, 0x1a, 0x0a])
  // Text files never come raw: no page of theirs runs on this origin.
  assert.equal((await fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'note.txt'))}&t=${board.fsToken}`)).status, 404)

  assert.equal((await post('/api/open-url', { url: 'javascript:alert(1)' })).status, 400)
  assert.equal((await post('/api/fs/open', { path: join(files, 'nope.txt') })).status, 404)
})
