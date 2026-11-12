// Auto-compact on the page (#378): Settings' default in the gear's menu, the sheet's line for the
// board's last /compact, and the compaction's line in the conversation.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { compactNotice } from '../../src/core/notices.ts'
import { compactPlaceholder, compactRunText, offersCompact } from '../../web/src/models/compact.ts'
import { noticeLine } from '../../web/src/models/notice.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'

const en = translator('en')
const ru = translator('ru')
const now = {
  t: en,
  theme: 'auto',
  languages: { en: 'English' },
  canEdit: true,
  dock: 'right' as const,
  sleepers: false,
  profiles: false,
}
const entry = (items: ReturnType<typeof settingsMenu>, id: string) => items.find(i => 'id' in i && i.id === id)

test("Settings → Auto-compact: off or a default limit, the board's own checked; none from an older board", () => {
  expect(entry(settingsMenu(now), 'compact')).toBeUndefined()
  const off = entry(settingsMenu({ ...now, compact: '' }), 'compact') as unknown as {
    submenu: Record<string, unknown>[]
  }
  expect(off.submenu.map(i => ('separator' in i ? '---' : `${i.id}${i.checked ? ' ✓' : ''}`))).toEqual([
    'compact:off ✓',
    '---',
    'compact:200k',
    'compact:300k',
    'compact:400k',
    'compact:500k',
    'compact:50%',
    'compact:75%',
  ])
  // A limit config.json or the CLI holds that the menu does not offer: shown too, checked.
  const own = entry(settingsMenu({ ...now, t: ru, compact: '350k' }), 'compact') as unknown as {
    label: string
    submenu: Record<string, unknown>[]
  }
  expect(own.label).toBe('Автокомпакт')
  expect(own.submenu.at(-1)).toEqual({ id: 'compact:350k', label: 'На 350k токенов', checked: true })
  expect(entry(settingsMenu({ ...now, compact: '', canEdit: false }), 'compact')).toMatchObject({ disabled: true })
  expect(settingPicked('compact:off')).toEqual({ kind: 'compact', value: '' })
  expect(settingPicked('compact:60%')).toEqual({ kind: 'compact', value: '60%' })
})

test("the sheet: a Claude session's card offers it; its empty field says what applies; the last run in words", () => {
  expect(offersCompact({ agent: 'claude' }, true)).toBe(true)
  expect(offersCompact({ agent: 'claude' }, false)).toBe(false)
  expect(offersCompact({ agent: 'pi' }, true)).toBe(false)
  expect(offersCompact({ agent: 'claude', day: true }, true)).toBe(false)
  expect(compactPlaceholder(undefined, '', en)).toBe('Off: 300k, 60% or never')
  expect(compactPlaceholder(undefined, '400k', en)).toBe('Default: 400k (300k, 60% or never)')
  const at = new Date(2026, 10, 12, 14, 5).getTime()
  const done = {
    state: 'done' as const,
    at: at - 60_000,
    from: 612_000,
    limit: 300_000,
    setting: '300k',
    to: 48_000,
    doneAt: at,
  }
  expect(compactRunText(done, en, at).text).toMatch(/^\d{1,2}:05( PM)?: 612k → 48k$/)
  const high = compactRunText({ ...done, to: 320_000, hold: true }, ru, at)
  expect(high.held).toBe(true)
  expect(high.text).toMatch(/: 612k → 320k, всё ещё выше 300k: пауза$/)
  expect(high.hint).toBe('Нового /compact не будет, пока контекст не станет меньше 300k или не сменится порог')
  expect(compactRunText({ ...done, state: 'failed', hold: true }, en, at).text).toMatch(
    /^\/compact typed .+ at 612k, no compaction followed: paused$/,
  )
})

test('the conversation: who compacted it and what it left', () => {
  const boundary = (trigger: string) =>
    compactNotice({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger, preTokens: 612_000, postTokens: 48_000 },
    })
  const manual = boundary('manual')
  if (!manual) throw new Error('no notice')
  expect(noticeLine(manual, en)).toEqual({ text: 'Compacted: 612k → 48k', sub: '', tone: 'info' })
  expect(noticeLine({ ...manual, by: 'board' }, ru).text).toBe('Сжато доской: 612k → 48k')
  const auto = boundary('auto')
  if (!auto) throw new Error('no notice')
  expect(noticeLine(auto, en).text).toBe('Compacted by Claude Code: 612k → 48k')
  expect(compactNotice({ type: 'system', subtype: 'compact_boundary', isSidechain: true })).toBeNull()
  expect(compactNotice({ type: 'user' })).toBeNull()
})
