// A file on a thread's line in the Team panel (#371, components/team/TeamFile.tsx): a picture this
// board has shows inline and links to its uploads address, anything else is a download link; a file
// on its way, failed or refused says so; a draft's file says it is attached; the confirmation window
// names the file that goes with a send or a draft; and the lines' check takes no address outside
// the uploads.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Translator } from '../../src/core/types.ts'
import { confirmLines } from '../../web/src/components/team/ConfirmScreen.tsx'
import { fileSize, TeamFile } from '../../web/src/components/team/TeamFile.tsx'
import { draftWhy, isThreadLines } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const tags = (nodes: Node[], tag: string): Node[] => findAll(nodes, n => n.kind === 'element' && n.tag === tag)
const attr = (n: Node | undefined, name: string): unknown => (n?.kind === 'element' ? n.attrs.get(name) : undefined)

test('a picture this board has shows inline and links to it; anything else is a download link', () => {
  const img = renderInBoard(
    <TeamFile
      file={{ state: 'ready', name: 'shot.png', size: 2048, url: '/uploads/2026-11-11/120000-abcd1234-shot.png' }}
    />,
    board(),
  )
  expect(attr(tags(img, 'img')[0], 'src')).toBe('/uploads/2026-11-11/120000-abcd1234-shot.png')
  expect(text(img)).toContain('shot.png · 2 KB')
  const doc = renderInBoard(
    <TeamFile
      file={{ state: 'ready', name: 'spec.pdf', size: 3 * 1024 * 1024, url: '/uploads/2026-11-11/1-spec.pdf' }}
    />,
    board(),
  )
  expect(tags(doc, 'img')).toEqual([])
  const link = tags(doc, 'a')[0]
  expect([attr(link, 'href'), attr(link, 'download')]).toEqual(['/uploads/2026-11-11/1-spec.pdf', 'spec.pdf'])
  expect(text(doc)).toContain('3 MB')
})

test('on its way, failed, refused or attached to a draft, it says so, and links nothing', () => {
  const cases: [Parameters<typeof TeamFile>[0]['file'], string][] = [
    [{ state: 'pending', name: 'a.bin', size: 10, progress: 0.5 }, 'a.bin · 10 B · coming… · 50%'],
    [{ state: 'failed', why: 'hash' }, 'a file · did not arrive (hash)'],
    [{ state: 'refused', name: 'b.bin', size: 1, why: 'quota' }, 'b.bin · 1 B · not sent (quota)'],
    [{ state: 'draft', name: 'notes.md', size: 5 }, 'notes.md · 5 B · attached'],
  ]
  for (const [file, said] of cases) {
    const out = renderInBoard(<TeamFile file={file} />, board())
    expect(text(out)).toBe(said)
    expect(tags(out, 'a')).toEqual([])
  }
  expect(fileSize(1536)).toBe('1.5 KB')
})

test('a draft held for its file says why, and the window names the file of a send or a draft', () => {
  const t = translator('en')
  expect(draftWhy('file', t)).toBe('held: it carries a file, which you send')
  const k = Object.assign(
    (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    {
      lang: 'en' as const,
    },
  ) as unknown as Translator
  expect(confirmLines({ kind: 'draft', who: 'anna', text: '', file: 'report.csv' }, k).items).toEqual([
    'team.confirm.file {"name":"report.csv"}',
  ])
  expect(confirmLines({ kind: 'send', who: 'anna', text: 'x', file: 'shot.png' }, k).items).toEqual([
    'team.confirm.file {"name":"shot.png"}',
  ])
})

test("the lines' check takes a file with the board's uploads address only", () => {
  const thread = {
    key: 'team/general',
    scope: 'team',
    id: 'general',
    title: null,
    link: null,
    handler: null,
    muted: false,
    by: 'me',
    createdAt: 1,
    lastAt: 1,
    peerName: null,
  }
  const line = (file: unknown) => ({ thread, lines: [{ id: 'x', dir: 'in', text: '', ts: '', file }] })
  expect(isThreadLines(line({ state: 'ready', name: 'a.png', url: '/uploads/2026-11-11/a.png' }))).toBe(true)
  expect(isThreadLines(line({ state: 'ready', name: 'a.png', url: 'https://evil.example/a.png' }))).toBe(false)
  expect(isThreadLines(line({ state: 'ready', name: 'a.png', url: 'javascript:alert(1)' }))).toBe(false)
  expect(isThreadLines(line({ name: 'no state' }))).toBe(false)
})
