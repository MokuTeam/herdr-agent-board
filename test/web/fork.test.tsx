// The fork window (components/fork/ForkPop.tsx) as it draws for one session.
import { expect, test } from 'bun:test'
import { createRef } from 'react'
import { ForkPop } from '../../web/src/components/fork/ForkPop.tsx'
import type { Forker } from '../../web/src/hooks/useFork.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { byId, findAll, type Node } from './support/markup.ts'

const session = item({
  key: 'a',
  name: 'Acme invoices',
  session: '0f8fad5b-d9cb-469f-a165-70867728950e',
  agent: 'claude',
  category: 'acme',
  workspace: 'Clients',
  cwd: 'C:\\Work\\Acme\\invoices',
})
const value = board({
  data: payload({
    items: [session],
    categories: [
      {
        id: 'acme',
        title: 'Acme',
        color: '#ff9500',
        colorName: 'orange',
        paths: [],
        configured: true,
        fallback: false,
      },
    ],
  }),
})

const forker = (fields: Partial<Forker> = {}): Forker => ({
  view: { id: 1, key: 'a', draft: {} },
  open: true,
  hidden: false,
  busy: false,
  error: null,
  popRef: createRef(),
  show() {},
  close() {},
  submit: async () => {},
  isOpen: () => true,
  ...fields,
})

const text = (nodes: Node[]): string =>
  nodes.map(n => ('text' in n ? n.text : text((n as { children: Node[] }).children))).join('')
const field = (nodes: Node[], name: string) => findAll(nodes, el => el.attrs.get('name') === name)[0]

test('it says what a fork is and where it goes, its name ready to type over, its message empty', () => {
  const nodes = renderInBoard(<ForkPop fork={forker()} />, value)
  const pop = byId(nodes, 'fork-pop')
  expect(pop.attrs.get('role')).toBe('dialog')
  expect(text([byId(nodes, 'fork-title')])).toBe('Fork “Acme invoices”')
  expect(text(nodes)).toContain('This session goes on as it is.')
  // The lane, the workspace and the folder it keeps.
  const where = findAll(nodes, el => el.attrs.get('class') === 'fork-where')[0]
  expect(text(where ? [where] : [])).toBe('AcmeClientsinvoices')
  expect(field(nodes, 'name')?.attrs.get('value')).toBe('Acme invoices · fork')
  expect(field(nodes, 'message')).toBeDefined()
  // In Russian too.
  const ru = renderInBoard(<ForkPop fork={forker()} />, value, 'ru')
  expect(text([byId(ru, 'fork-title')])).toBe('Форк «Acme invoices»')
  expect(field(ru, 'name')?.attrs.get('value')).toBe('Acme invoices · форк')
})

test('a retry starts from what it was given; the server’s refusal shows under the fields; Fork waits while it starts', () => {
  const nodes = renderInBoard(
    <ForkPop
      fork={forker({
        view: { id: 2, key: 'a', draft: { name: 'Try B', message: 'the other way' } },
        error: { text: 'No such folder', field: 'cwd' },
        busy: true,
      })}
    />,
    value,
  )
  expect(field(nodes, 'name')?.attrs.get('value')).toBe('Try B')
  expect(text(findAll(nodes, el => el.attrs.get('role') === 'alert'))).toBe('No such folder')
  const start = findAll(nodes, el => el.attrs.get('type') === 'submit')[0]
  expect(start?.attrs.has('disabled')).toBe(true)
  // Closed: nothing in it.
  expect(
    findAll(renderInBoard(<ForkPop fork={forker({ view: null, hidden: true })} />, value), el => el.tag === 'form'),
  ).toEqual([])
})
