// Settings → MokuPilot… (components/mokupilot/MokupilotPanel.tsx): the three choices with a line
// each, under Auto where a call from this browser starts right now and what decided it, under the
// link what MokuPilot there needs; offered in the Settings menu only while the board offers calls.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { MokupilotBody } from '../../web/src/components/mokupilot/MokupilotPanel.tsx'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import { isMokupilotView, type MokupilotView, nowLine, whyLine } from '../../web/src/models/mokupilot.ts'
import { offersMokupilot, settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

const VIEW: MokupilotView = {
  mode: 'auto',
  off: false,
  here: 'ok',
  hereFile: '/usr/bin/meet',
  resolved: 'link',
  why: 'forwarded-other',
  auto: { resolved: 'link', why: 'forwarded-other', viewer: '100.64.0.7' },
}

function render(view: MokupilotView | null, lang = 'en', disabled = false) {
  const chosen: string[] = []
  const nodes = renderInBoard(
    <MokupilotBody view={view} disabled={disabled} onChoose={m => void chosen.push(m)} />,
    board(),
    lang,
  )
  const radios = findAll(nodes, el => el.tag === 'input' && el.attrs.get('type') === 'radio')
  return { nodes, all: text(nodes), radios, chosen }
}

describe('MokuPilot panel', () => {
  test('three choices, each with a line saying what happens', () => {
    const { all, radios } = render(VIEW)
    expect(radios.map(r => r.attrs.get('value'))).toEqual(['auto', 'local', 'link'])
    expect(all).toContain('Auto')
    expect(all).toContain('This machine')
    expect(all).toContain('The computer you’re viewing from')
    expect(all).toContain('The board’s computer starts MokuPilot itself')
    expect(all).toContain('Nothing starts on the board’s computer')
    // The link: what MokuPilot on the viewer's computer needs.
    expect(all).toContain('“agents on another machine” turned on, with this board’s ssh address')
  })

  test('the mode set is the one checked', () => {
    for (const mode of ['auto', 'local', 'link'] as const) {
      const { radios } = render({ ...VIEW, mode })
      expect(radios.filter(r => r.attrs.has('checked')).map(r => r.attrs.get('value'))).toEqual([mode])
    }
  })

  test('under Auto: where a call from this browser starts right now, and what decided it', () => {
    const away = render(VIEW).all
    expect(away).toContain('Right now, from this browser: the call starts on this computer.')
    expect(away).toContain('Decided by: forwarded-other, 100.64.0.7')
    const here = render({
      ...VIEW,
      resolved: 'local',
      why: 'loopback-direct',
      auto: { resolved: 'local', why: 'loopback-direct', viewer: '127.0.0.1' },
    }).all
    expect(here).toContain('Right now, from this browser: the call starts on the board’s computer.')
    expect(here).toContain('Decided by: loopback-direct, 127.0.0.1')
    // In Russian too.
    expect(render(VIEW, 'ru').all).toContain('Сейчас, из этого браузера: звонок начнётся на этом компьютере.')
  })

  test('MokuPilot missing on the board’s computer is said under This machine only', () => {
    expect(render(VIEW).all).not.toContain('not found on the board’s computer')
    const missing = render({ ...VIEW, here: 'missing', hereFile: 'meet' }).all
    expect(missing).toContain('MokuPilot is not found on the board’s computer (meet)')
  })

  test('turned off in config.json: the panel says so, and nothing can be picked', () => {
    const { all, radios } = render({ ...VIEW, off: true })
    expect(all).toContain('MokuPilot calls are turned off in the board’s config.json ("mokupilot": false).')
    expect(radios.every(r => r.attrs.has('disabled'))).toBe(true)
    expect(render(VIEW).all).not.toContain('turned off')
    expect(render({ ...VIEW, off: true }, 'ru').all).toContain('Звонки в MokuPilot выключены')
  })

  test('before the board answers: it is being asked, and nothing can be picked', () => {
    const { all, radios } = render(null, 'en', true)
    expect(all).toContain('Asking the board where a call from this browser would start')
    expect(all).not.toContain('Decided by')
    expect(radios.every(r => r.attrs.has('disabled'))).toBe(true)
    expect(radios.some(r => r.attrs.has('checked'))).toBe(false)
  })

  test('the board’s answer, read through its guard', () => {
    expect(isMokupilotView(VIEW)).toBe(true)
    expect(isMokupilotView({ ...VIEW, mode: 'remote' })).toBe(false)
    expect(isMokupilotView({ ...VIEW, auto: { resolved: 'here', why: 'x' } })).toBe(false)
    expect(isMokupilotView({ ...VIEW, here: 'yes' })).toBe(false)
    expect(isMokupilotView({ ok: false, error: 'x' })).toBe(false)
    expect(isMokupilotView(null)).toBe(false)
    const t = translator('en')
    expect(nowLine(null, t)).toMatch(/Asking the board/)
    expect(whyLine(null, t)).toBe('')
    expect(whyLine({ ...VIEW, auto: { resolved: 'local', why: 'no-peer', viewer: '' } }, t)).toBe('Decided by: no-peer')
  })
})

describe('Settings → MokuPilot…', () => {
  const now = {
    t: translator('en'),
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right' as const,
    sleepers: true,
    profiles: false,
  }
  const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))

  test('offered from the page always, also when the board offers no call (This machine without MokuPilot)', () => {
    for (const payload of [{ mokupilot: false }, { mokupilot: true }, {}, null, undefined])
      expect(offersMokupilot(payload)).toBe(true)
    const items = settingsMenu({ ...now, mokupilot: offersMokupilot({ mokupilot: false }) })
    expect(ids(items)).toContain('mokupilot')
  })

  test('the model draws the item when asked; the menu otherwise as it was', () => {
    expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, mokupilot: false }))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, phones: true, mokupilot: true, access: true }))).toEqual([
      'theme',
      'lang',
      'panel',
      'phones',
      'mokupilot',
      'access',
      '—',
      'sleepers',
    ])
    expect(settingsMenu({ ...now, mokupilot: true })[3]).toEqual({ id: 'mokupilot', label: 'MokuPilot…' })
    expect(settingPicked('mokupilot')).toEqual({ kind: 'mokupilot' })
  })
})
