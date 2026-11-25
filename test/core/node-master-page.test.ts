// A node's page carries its master (#797, core/node-master-page.ts): the tag goes in only with a
// master, the page is the same string without one, and what the page reads back is the same view.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeMasterOfMeta, pageWithNodeMaster } from '../../src/core/node-master-page.ts'

const INDEX = readFileSync(join(import.meta.dir, '../../web/index.html'), 'utf8')

test('no master: the page is exactly as it was', () => {
  expect(pageWithNodeMaster(INDEX, null)).toBe(INDEX)
})

test('a master goes in the head as one tag, and reads back as it went, whatever its name holds', () => {
  const view = {
    nodeId: 'server-1',
    name: 'atlas "ünï" <b>&amp; 100%',
    url: 'https://board.atlas.test/?a=1&b=2',
    online: true,
  }
  const page = pageWithNodeMaster(INDEX, view)
  expect(page.length).toBeGreaterThan(INDEX.length)
  const head = page.slice(0, page.indexOf('</head>'))
  const m = /<meta name="board-node-master" content="([^"]*)">/.exec(head)
  expect(m).not.toBeNull()
  // As a browser reads the attribute: the entities undone.
  const content = (m?.[1] ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  expect(nodeMasterOfMeta(content)).toEqual(view)
  // Only the tag was added.
  expect(page.replace(/ {2}<meta name="board-node-master"[^\n]*\n/, '')).toBe(INDEX)
  expect(nodeMasterOfMeta(JSON.stringify({ ...view, url: null, online: false }))).toEqual({
    ...view,
    url: null,
    online: false,
  })
})

test('what is no such view reads as none', () => {
  for (const bad of [null, '', 'x', '[]', '{"nodeId":"a","name":"b","url":3,"online":true}', '{"nodeId":"a"}'])
    expect(nodeMasterOfMeta(bad)).toBeNull()
})
