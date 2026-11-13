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
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import { uploadPlace } from '../../web/src/hooks/useThreadFiles.ts'
import type { ThreadLine } from '../../web/src/models/team.ts'
import { draftWhy, isThreadLines } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { findAll, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

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

// ---- The box's files (#371 on #370's composer)

const ANNA = 'A'.repeat(43)
const VIEW = {
  state: 'online' as const,
  me: { peer: 'M'.repeat(43), fingerprint: 'aaaa', name: 'me' },
  hub: 'wss://hub.example.com',
  roster: [
    { peer: ANNA, name: 'anna', online: true, lastSeen: null, fingerprint: '1111', pin: 'trusted' as const, drafts: 0 },
  ],
  files: { max: 25 * 1024 * 1024 },
}
const CHAT = {
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
const att = (id: number, name: string, status: 'uploading' | 'done' | 'error') => ({
  id,
  name,
  size: 2048,
  image: false,
  url: '',
  status,
  path: status === 'done' ? `C:\\state\\uploads\\2026-11-11\\120000-${name}` : '',
})
function body(over: Partial<TeamBodyProps> = {}): TeamBodyProps {
  return {
    view: VIEW as never,
    threads: [CHAT as never],
    selected: 'team/general',
    thread: CHAT as never,
    lines: [],
    agents: null,
    draft: '',
    topic: null,
    disabled: false,
    onSelect() {},
    onTrust() {},
    onSendDraft() {},
    onDiscardDraft() {},
    onDraft() {},
    onTopic() {},
    onSend() {},
    onMute() {},
    onAgents() {},
    onAddFiles() {},
    onRemoveFile() {},
    ...over,
  }
}
const sendOf = (nodes: Node[]) => findAll(nodes, n => n.kind === 'element' && n.attrs.has('data-send'))[0]

test('the clip is there while the hub takes files; the files show over the box; files alone can be sent, not while one uploads', () => {
  const plain = renderInBoard(<TeamBody {...body()} />, board())
  expect(findAll(plain, n => n.kind === 'element' && n.attrs.has('data-attach'))).toHaveLength(1)
  expect(sendOf(plain)?.kind === 'element' && sendOf(plain)?.attrs.has('disabled')).toBe(true)
  // An older hub: no clip, nothing to drop on.
  const old = renderInBoard(<TeamBody {...body({ view: { ...VIEW, files: undefined } as never })} />, board())
  expect(findAll(old, n => n.kind === 'element' && n.attrs.has('data-attach'))).toEqual([])
  const ready = renderInBoard(<TeamBody {...body({ files: [att(1, 'report.pdf', 'done')] })} />, board())
  const chips = findAll(ready, n => n.kind === 'element' && n.attrs.get('id') === 'team-attachments')
  expect(text(chips)).toContain('report.pdf')
  expect(sendOf(ready)?.kind === 'element' && sendOf(ready)?.attrs.has('disabled')).toBe(false)
  const busy = renderInBoard(
    <TeamBody {...body({ draft: 'see', files: [att(1, 'a.pdf', 'done'), att(2, 'b.pdf', 'uploading')] })} />,
    board(),
  )
  expect(sendOf(busy)?.kind === 'element' && sendOf(busy)?.attrs.has('disabled')).toBe(true)
})

test('a drop on the thread and a paste into it hand their files over; text pasted is left alone', () => {
  const added: string[][] = []
  let hosts: Host[] = []
  function Probe() {
    hosts = hostElements(<TeamBody {...body({ onAddFiles: f => void added.push(f.map(x => x.name)) })} />)
    return null
  }
  renderInBoard(<Probe />, board())
  const section = hosts.find(h => h.tag === 'section' && h.props['data-thread'] === 'team/general')
  if (!section) throw new Error('no thread')
  const file = new File(['x'], 'shot.png', { type: 'image/png' })
  let stopped = 0
  const ev = (files: File[]) => ({ preventDefault: () => void stopped++, dataTransfer: { files, types: ['Files'] } })
  ;(section.props.onDragOver as (e: unknown) => void)(ev([file]))
  ;(section.props.onDrop as (e: unknown) => void)(ev([file]))
  ;(section.props.onPaste as (e: unknown) => void)({
    preventDefault: () => void stopped++,
    clipboardData: { files: [file] },
  })
  ;(section.props.onPaste as (e: unknown) => void)({
    preventDefault: () => void stopped++,
    clipboardData: { files: [] },
  })
  expect(added).toEqual([['shot.png'], ['shot.png']])
  expect(stopped).toBe(3)
})

test('a message with a file and no text shows the file alone; a draft shows the file it carries', () => {
  const lines: ThreadLine[] = [
    {
      id: 'i1',
      dir: 'in',
      from: ANNA,
      who: 'anna',
      text: '',
      ts: '2026-11-11T10:00:00Z',
      file: { state: 'ready', name: 'spec.pdf', size: 10, url: '/uploads/2026-11-11/1-spec.pdf' },
    },
    {
      id: 'd1',
      dir: 'draft',
      text: 'the report',
      ts: '2026-11-11T10:01:00Z',
      via: 'agent',
      reason: 'file',
      file: { state: 'draft', name: 'report.csv', size: 8 },
    },
  ]
  const out = renderInBoard(<TeamBody {...body({ lines })} />, board())
  expect(text(out)).toContain('spec.pdf · 10 B')
  expect(text(out)).toContain('report.csv · 8 B · attached')
  expect(text(out)).toContain('held: it carries a file, which you send')
})

test('the send carries the file by its place in the uploads and its name; uploadPlace reads either slash', async () => {
  const calls = answers()
  const source = teamSource({ t: () => translator('en'), toast: () => {}, remote: () => false })
  source.select(`${ANNA}/general`)
  expect(await source.send('', undefined, undefined, { upload: '2026-11-11/120000-shot.png', name: 'shot.png' })).toBe(
    true,
  )
  expect(sent(calls)[0]).toEqual([
    '/api/team/send',
    'POST',
    '1',
    { to: ANNA, text: '', file: { upload: '2026-11-11/120000-shot.png', name: 'shot.png' } },
  ])
  restoreFetch()
  expect(uploadPlace('C:\\state\\uploads\\2026-11-11\\120000-shot.png')).toBe('2026-11-11/120000-shot.png')
  expect(uploadPlace('/home/a/.local/state/uploads/2026-11-11/120000-shot.png')).toBe('2026-11-11/120000-shot.png')
})
