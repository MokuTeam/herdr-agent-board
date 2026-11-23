// Card provider marks (#651): small monochrome official logos for Claude, Antigravity (Gemini),
// Codex (OpenAI), and pi in the card head, with provider + model tooltips and clean omission for
// unrecognised agents.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { Card } from '../../web/src/components/Card.tsx'
import { providerOf, providerTooltip } from '../../web/src/models/provider.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { find, findAll, hasClass } from './support/markup.ts'

describe('provider model', () => {
  const en = translator('en')
  const ru = translator('ru')

  test('recognises Claude, Antigravity, Codex and pi (case-insensitive) and returns null for unknown', () => {
    expect(providerOf({ agent: 'claude' })?.id).toBe('claude')
    expect(providerOf({ agent: 'CLAUDE' })?.id).toBe('claude')
    expect(providerOf({ agent: 'agy' })?.id).toBe('agy')
    expect(providerOf({ agent: 'antigravity' })?.id).toBe('agy')
    expect(providerOf({ agent: 'gemini' })?.id).toBe('agy')
    expect(providerOf({ agent: 'codex' })?.id).toBe('codex')
    expect(providerOf({ agent: 'openai' })?.id).toBe('codex')
    expect(providerOf({ agent: 'pi' })?.id).toBe('pi')
    expect(providerOf({ agent: '' })).toBeNull()
    expect(providerOf({})).toBeNull()
    expect(providerOf({ agent: 'custom-shell' })).toBeNull()
  })

  test('tooltip formats provider and model, falling back to provider alone', () => {
    const claude = providerOf({ agent: 'claude' })
    const agy = providerOf({ agent: 'agy' })
    const codex = providerOf({ agent: 'codex' })
    const pi = providerOf({ agent: 'pi' })
    if (!claude || !agy || !codex || !pi) throw new Error('expected known providers')
    expect(providerTooltip(claude, 'Opus 4.6', en)).toBe('Claude · Opus 4.6')
    expect(providerTooltip(agy, 'Gemini 2.5 Pro', en)).toBe('Antigravity · Gemini 2.5 Pro')
    expect(providerTooltip(codex, 'o3', ru)).toBe('Codex · o3')
    expect(providerTooltip(pi, null, en)).toBe('pi')
    expect(providerTooltip(pi, '  ', en)).toBe('pi')
  })
})

describe('provider mark on cards', () => {
  const noop = () => {}
  const drawCard = (fields: Parameters<typeof item>[0]) => {
    const it = item(fields)
    return renderInBoard(
      <Card
        item={it}
        selected={false}
        busy={undefined}
        placeholder={false}
        launch={undefined}
        onPointerDown={noop}
        onClick={noop}
        onKeyDown={noop}
      />,
      board({ data: payload({ items: [it] }) }),
      'en',
    )
  }

  for (const [agent, id, model, expectedTip] of [
    ['claude', 'claude', 'Opus 4.6', 'Claude · Opus 4.6'],
    ['agy', 'agy', 'Gemini 2.5 Pro', 'Antigravity · Gemini 2.5 Pro'],
    ['codex', 'codex', 'o3', 'Codex · o3'],
    ['pi', 'pi', 'Sonnet 4.5', 'pi · Sonnet 4.5'],
  ] as const) {
    test(`renders ${id} logo in card-top right before the session name`, () => {
      const nodes = drawCard({ key: `k-${id}`, name: 'atlas-task', agent, model, column: 'work', status: 'working' })
      const top = find(nodes, el => hasClass(el, 'card-top'))
      const children = top.children.filter(c => c.kind === 'element')
      const markIdx = children.findIndex(c => hasClass(c, 'provider-mark'))
      const nameIdx = children.findIndex(c => hasClass(c, 'name'))
      expect(markIdx).toBe(1)
      expect(nameIdx).toBe(2)
      const mark = children[markIdx]
      if (!mark) throw new Error('expected provider mark')
      expect(mark.attrs.get('data-provider')).toBe(id)
      expect(mark.attrs.get('title')).toBe(expectedTip)
      expect(mark.attrs.get('aria-label')).toBe(expectedTip)
      expect(findAll(mark.children, el => el.tag === 'svg')).toHaveLength(1)
    })
  }

  test('renders on compact sleeping cards without adding an extra row', () => {
    const nodes = drawCard({
      key: 'sleep-1',
      name: 'atlas-idle',
      agent: 'codex',
      column: 'idle',
      status: 'sleeping',
      sleeping: true,
    })
    const mark = find(nodes, el => hasClass(el, 'provider-mark'))
    expect(mark.attrs.get('data-provider')).toBe('codex')
    expect(mark.attrs.get('title')).toBe('Codex')
  })

  test('omits the provider mark when agent is absent or unknown', () => {
    const nodes = drawCard({ key: 'plain', name: 'atlas-plain', column: 'idle' })
    expect(findAll(nodes, el => hasClass(el, 'provider-mark'))).toHaveLength(0)
  })
})
