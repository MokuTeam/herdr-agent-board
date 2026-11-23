import { describe, expect, test } from 'bun:test'
import { brief } from '../../src/core/brief.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Config, Item } from '../../src/core/types.ts'
import { launcherLine } from '../../web/src/models/launch.ts'
import { agentBody, agentRow, agentStart, launcherFor } from '../../web/src/models/launch-agent.ts'
import { cardMenu, isSeparator } from '../../web/src/models/menu-model.ts'
import { claudeRename } from '../../web/src/models/rename.ts'
import { headButtons } from '../../web/src/models/sheet.ts'

const t = translator('en')

const makeItem = (over: Partial<Item> = {}): Item =>
  ({
    key: '18fb0773-7c19-4e3d-8e9b-ceadaef29211',
    name: 'Agy Session',
    autoName: 'Agy Session',
    category: 'other',
    categorySet: false,
    column: 'idle',
    status: 'idle',
    attention: '',
    agent: 'agy',
    session: '18fb0773-7c19-4e3d-8e9b-ceadaef29211',
    pane: 'w1:p1',
    cwd: '/repo',
    workspace: 'Work',
    activity: Date.now(),
    ...over,
  }) as Item

describe('Antigravity UI models and brief', () => {
  test('launcherLine and launch-agent support agy beside Claude and pi', () => {
    expect(launcherLine({ kind: 'herdr', agent: 'agy' }, t)).toContain('Antigravity')
    expect(launcherLine({ kind: 'herdr', agent: 'claude' }, t)).toContain('Claude')
    expect(launcherLine({ kind: 'herdr', agent: 'pi' }, t)).toContain('pi')

    const agents = [
      { id: 'claude', title: 'Claude Code' },
      { id: 'pi', title: 'pi' },
      { id: 'agy', title: 'Antigravity' },
    ]
    expect(agentStart('agy', agents, 'claude')).toBe('agy')
    expect(agentStart(null, agents, 'agy')).toBe('agy')
    expect(agentBody('agy', agents)).toEqual({ agent: 'agy' })
    expect(agentRow('agy', agents)).toEqual({
      offered: true,
      options: [
        { id: 'claude', title: 'Claude Code', pressed: false },
        { id: 'pi', title: 'pi', pressed: false },
        { id: 'agy', title: 'Antigravity', pressed: true },
      ],
    })
    expect(launcherFor({ kind: 'herdr', agent: 'claude' }, 'agy')).toEqual({ kind: 'herdr', agent: 'agy' })
  })

  test('sheet headButtons, cardMenu, and claudeRename enable archive and /rename for agy without touching codex', () => {
    const agy = makeItem({ agent: 'agy' })
    const agyBare = makeItem({ agent: 'agy', session: null, key: 'pane-w1:p1' })
    const codex = makeItem({ agent: 'codex' })
    const claude = makeItem({ agent: 'claude' })

    expect(headButtons(agy, t).archiveHidden).toBe(false)
    expect(headButtons(agyBare, t).archiveHidden).toBe(true)
    expect(headButtons(codex, t).archiveHidden).toBe(true)
    expect(headButtons(claude, t).archiveHidden).toBe(false)
    // Restart is enabled for agy (#631); Claude-only actions (MokuPilot, Fork) remain hidden.
    expect(headButtons(agy, t, true, [], true)).toMatchObject({
      sleepHidden: false,
      restartHidden: false,
      mokupilotHidden: true,
      forkHidden: true,
    })
    expect(headButtons(agyBare, t).restartHidden).toBe(true)
    expect(headButtons(codex, t).restartHidden).toBe(true)

    const idsOf = (it: Item) =>
      cardMenu(it, { t, canMutate: true, canEdit: true, column: 'idle', category: 'other' })
        .filter(e => !isSeparator(e))
        .map(e => e.id)
    expect(idsOf(agy)).toContain('archive')
    expect(idsOf(agy)).toContain('restart')
    expect(idsOf(agyBare)).not.toContain('archive')
    expect(idsOf(agyBare)).not.toContain('restart')
    expect(idsOf(codex)).not.toContain('archive')
    expect(idsOf(codex)).not.toContain('restart')

    expect(claudeRename(agy, true, t)).toEqual({ why: '' })
    expect(claudeRename(agyBare, true, t)).toBeNull()
    expect(claudeRename(codex, true, t)).toBeNull()
    expect(claudeRename(claude, true, t)).toEqual({ why: '' })
  })

  test('brief gives Antigravity full board instructions while keeping Codex minimal and Claude unchanged', () => {
    const cfg = { categories: [{ id: 'other', title: 'Other', color: 'gray', paths: [] }] } as unknown as Config
    const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1' }
    const agyText = brief(cfg, null, '/repo', env, 'Antigravity', null, null, ['vault'], true)
    const claudeText = brief(cfg, null, '/repo', env, 'Claude', null, null, ['vault'], true)
    const codexText = brief(cfg, null, '/repo', env, 'Codex', null, null, ['vault'], true)

    expect(agyText).toContain('board secret request')
    expect(agyText).toContain('board cal list')
    expect(agyText).toContain('herdr-agents skill')
    expect(agyText).toContain('board wait')
    expect(claudeText).toContain('board secret request')
    expect(claudeText).toContain('board cal list')
    expect(codexText).not.toContain('board secret request')
    expect(codexText).not.toContain('board cal list')
  })
})
