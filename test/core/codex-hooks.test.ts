import { expect, test } from 'bun:test'
import { brief, herdrLine } from '../../src/core/brief.ts'
import { categoryFor, normalizeConfig } from '../../src/core/categories.ts'
import { planCodexHooks } from '../../src/core/codex-hooks.ts'
import { languageName } from '../../src/core/lang.ts'
import { oldSource } from '../web/support/old-app.ts'

const script = 'C:\\Work\\agent-board\\папка 100%\\src\\entrypoints\\codex-hook.ts'

test('Codex install preserves herdr, other hooks and unknown fields, and is idempotent', () => {
  const herdr = { type: 'command', command: 'herdr-agent-state.ps1 session' }
  const input = {
    description: 'mine',
    hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [herdr] }],
      Stop: [{ hooks: [{ type: 'command', command: 'ingest.py' }] }],
    },
  }
  const before = structuredClone(input)
  const next = planCodexHooks(input, script)
  expect(input).toEqual(before)
  expect(next.description).toBe('mine')
  const hooks = next.hooks as Record<string, unknown[]>
  expect(hooks.SessionStart?.[0]).toEqual(input.hooks.SessionStart[0])
  expect(hooks.Stop).toEqual(input.hooks.Stop)
  expect(hooks.UserPromptSubmit).toHaveLength(1)
  expect(hooks.UserPromptSubmit).toMatchObject([
    { hooks: [{ command: 'bun "C:/Work/agent-board/папка 100%/src/entrypoints/codex-hook.ts"' }] },
  ])
  expect(planCodexHooks(next, script)).toEqual(next)
})

test('moved installs replace only board Codex commands, even in a shared matcher group', () => {
  const next = planCodexHooks(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'bun C:/old/agent-board/src/entrypoints/codex-hook.ts' },
              { type: 'command', command: 'keep-me' },
            ],
          },
        ],
      },
    },
    script,
  )
  expect(JSON.stringify(next)).not.toContain('C:/old')
  expect(JSON.stringify(next)).toContain('keep-me')
  expect(JSON.stringify(next)).toContain('C:/Work/agent-board/папка 100%/src/entrypoints/codex-hook.ts')
})

test("malformed hook structures are rejected without replacing someone else's configuration", () => {
  for (const settings of [null, [], 42, { hooks: [] }, { hooks: { SessionStart: 'mine' } }])
    expect(() => planCodexHooks(settings, script)).toThrow('left as it was')
})

test('the shared brief stays byte-identical for Claude and pi bridge sessions', () => {
  const source = oldSource('src/core/brief.ts', '2273df2')
    .replace(/^import .*\n/gm, '')
    .replace(/^export /gm, '')
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const old = new Function('categoryFor', 'languageName', `${js}\nreturn { brief, herdrLine }`)(
    categoryFor,
    languageName,
  ) as {
    brief: typeof brief
    herdrLine: typeof herdrLine
  }
  const cfg = normalizeConfig({ categories: [{ id: 'work', title: 'Работа 100%', paths: ['C:\\Work\\Имя %'] }] })
  const card = { category: 'work', doing: 'review 126', wait: 'CI', ask: 'Push?' }
  for (const env of [
    {},
    { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' },
    {
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p2',
      HERDR_TAB_ID: 'w1:t1',
      HERDR_WORKSPACE_ID: 'w1',
      PI_CODING_AGENT: '1',
    },
  ]) {
    expect(herdrLine(env)).toBe(old.herdrLine(env))
    expect(brief(cfg, card, 'C:\\Work\\Имя %', env)).toBe(old.brief(cfg, card, 'C:\\Work\\Имя %', env))
  }
  const codex = brief(cfg, card, 'C:\\Work\\Имя %', {}, 'Codex')
  expect(codex).toContain('every Codex session')
  expect(codex).not.toContain('CronCreate')
  expect(codex).not.toContain('Claude process')
})
