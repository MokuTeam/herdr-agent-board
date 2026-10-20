import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { cardMenu } from '../../web/src/models/menu-model.ts'
import { headButtons } from '../../web/src/models/sheet.ts'
import { item } from './support/board.tsx'

test('Codex Fork needs its own server capability; Claude and pi keep their existing choices', () => {
  const t = translator('en')
  const context = { t, canMutate: true, canEdit: true, category: 'work', column: 'idle', fork: false }
  for (const agent of ['claude', 'codex', 'pi']) {
    const it = item({ key: 's1', agent, session: 'session', status: 'idle' })
    const menu = (codexFork: boolean, fork = false) =>
      cardMenu(it, { ...context, codexFork, fork }).some(entry => 'id' in entry && entry.id === 'fork')
    expect(menu(false)).toBe(false)
    expect(menu(true)).toBe(agent === 'codex')
    expect(menu(false, true)).toBe(agent === 'claude')
    expect(headButtons(it, t, false, [], false, true).forkHidden).toBe(agent !== 'codex')
    expect(headButtons(it, t, false, [], true).forkHidden).toBe(agent !== 'claude')
  }
  const noSession = item({ key: 's1', agent: 'codex', session: null })
  expect(headButtons(noSession, t, false, [], false, true).forkHidden).toBe(true)
  const stale = cardMenu(item({ key: 's1', agent: 'codex' }), { ...context, codexFork: true, canMutate: false })
  expect(stale.find(entry => 'id' in entry && entry.id === 'fork')).toMatchObject({ disabled: true })
})
