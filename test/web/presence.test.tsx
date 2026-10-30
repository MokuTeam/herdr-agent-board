// The page's side of presence (#172): the toolbar switch (shown only while the payload carries
// `presence`), what a press sends, detection's offer in mode 'suggest', and Settings → Presence,
// which turns it on and off and sets the mode and the minutes.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { PresenceView } from '../../src/core/presence.ts'
import { PresenceSwitch } from '../../web/src/components/PresenceSwitch.tsx'
import { choosePresence } from '../../web/src/hooks/useSettingsMenu.ts'
import type { MenuEntry, MenuItem } from '../../web/src/models/menu-model.ts'
import { isPresenceView, presenceBody, presenceSwitch } from '../../web/src/models/presence.ts'
import { type SettingsNow, settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { board, payload, renderInBoard } from './support/board.tsx'
import { findAll } from './support/markup.ts'

const t = translator('en')
const view = (fields: Partial<PresenceView> = {}): PresenceView => ({
  state: 'here',
  since: 1,
  by: 'auto',
  mode: 'auto',
  idleMinutes: 15,
  hint: null,
  detects: true,
  ...fields,
})

test('the switch: none while presence is off; says the state, a press flips it', () => {
  expect(presenceSwitch(undefined, t)).toBeNull()
  expect(presenceSwitch({ state: 'away' }, t)).toBeNull()
  expect(isPresenceView(view())).toBe(true)
  expect(presenceSwitch(view(), t)).toEqual({
    state: 'here',
    label: 'At the computer',
    hint: expect.any(String),
    next: 'away',
    offer: null,
  })
  expect(presenceSwitch(view({ state: 'away' }), t)).toMatchObject({ label: 'Away', next: 'here', offer: null })
  // Mode 'suggest': the offer, unless it offers what already is.
  expect(presenceSwitch(view({ hint: 'away' }), t)?.offer).toEqual({ text: expect.any(String), state: 'away' })
  expect(presenceSwitch(view({ state: 'away', hint: 'away' }), t)?.offer).toBeNull()
  expect(presenceBody('away', false)).toEqual({ state: 'away', from: 'web' })
  expect(presenceBody('here', true)).toEqual({ state: 'here', from: 'phone' })
})

test('the toolbar shows nothing new on a board without presence', () => {
  const ids = (nodes: ReturnType<typeof renderInBoard>) =>
    findAll(nodes, el => /^presence-/.test(el.attrs.get('id') ?? '')).map(el => el.attrs.get('id'))
  expect(ids(renderInBoard(<PresenceSwitch />, board({ data: payload() })))).toEqual([])
  expect(ids(renderInBoard(<PresenceSwitch />, board({ data: null })))).toEqual([])
  const away = renderInBoard(<PresenceSwitch />, board({ data: payload({ presence: view({ state: 'away' }) }) }))
  expect(ids(away)).toEqual(['presence-switch'])
  const sw = findAll(away, el => el.attrs.get('id') === 'presence-switch')[0]
  expect(sw?.attrs.get('data-state')).toBe('away')
  expect(sw?.attrs.get('aria-pressed')).toBe('true')
  const offered = renderInBoard(<PresenceSwitch />, board({ data: payload({ presence: view({ hint: 'away' }) }) }))
  expect(ids(offered)).toEqual(['presence-switch', 'presence-offer'])
})

const now: SettingsNow = {
  t,
  theme: 'auto',
  languages: { en: 'English' },
  canEdit: true,
  dock: 'left',
  sleepers: true,
  profiles: false,
}
const ids = (items: MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))
const presenceOf = (items: MenuEntry[]) => items.find(i => 'id' in i && i.id === 'presence') as MenuItem

test('Settings → Presence: only with board data; the modes, Off, and the minutes while detecting', () => {
  expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
  expect(ids(settingsMenu({ ...now, presence: 'none' }))).toEqual([
    'theme',
    'lang',
    'panel',
    'presence',
    '—',
    'sleepers',
  ])
  const off = presenceOf(settingsMenu({ ...now, presence: 'none' }))
  expect(off.label).toBe('Presence')
  expect(ids(off.submenu ?? [])).toEqual(['presence:none', 'presence:auto', 'presence:suggest', 'presence:off'])
  expect((off.submenu?.[0] as MenuItem | undefined)?.checked).toBe(true)
  const auto = presenceOf(settingsMenu({ ...now, presence: 'auto', idleMinutes: 30 }))
  expect(ids(auto.submenu ?? [])).toEqual([
    'presence:none',
    'presence:auto',
    'presence:suggest',
    'presence:off',
    '—',
    'presenceIdle:5',
    'presenceIdle:10',
    'presenceIdle:15',
    'presenceIdle:30',
    'presenceIdle:60',
  ])
  expect((auto.submenu?.find(i => 'id' in i && i.id === 'presenceIdle:30') as MenuItem | undefined)?.checked).toBe(true)
  // Manual only: no minutes to choose.
  expect(ids(presenceOf(settingsMenu({ ...now, presence: 'off' })).submenu ?? [])).not.toContain('presenceIdle:15')
  // A page that may not change settings sees it disabled.
  expect(presenceOf(settingsMenu({ ...now, canEdit: false, presence: 'auto' })).disabled).toBe(true)
  expect(settingPicked('presence:suggest')).toEqual({ kind: 'presence', value: 'suggest' })
  expect(settingPicked('presence:none')).toEqual({ kind: 'presence', value: 'none' })
  expect(settingPicked('presenceIdle:10')).toEqual({ kind: 'presenceIdle', value: 10 })
  expect(settingPicked('presence:sometimes')).toBeNull()
  expect(settingPicked('presenceIdle:x')).toBeNull()
})

test('choosePresence saves the setting, or says why not', async () => {
  const saved: unknown[] = []
  const toasts: [string, boolean | undefined][] = []
  const deps = {
    t,
    canEdit: true,
    save: async (b: unknown) => {
      saved.push(b)
    },
    toast: (m: string, e?: boolean) => {
      toasts.push([m, e])
    },
  }
  await choosePresence({ on: true, mode: 'suggest' }, deps)
  await choosePresence({ on: false }, deps)
  expect(saved).toEqual([
    { op: 'settings', on: true, mode: 'suggest' },
    { op: 'settings', on: false },
  ])
  await choosePresence({ on: true }, { ...deps, canEdit: false })
  expect(saved).toHaveLength(2)
  expect(toasts).toEqual([[t('live.off'), true]])
  await choosePresence({ on: true }, { ...deps, save: async () => Promise.reject(new Error('nope')) })
  expect(toasts).toHaveLength(2)
})

test('on a call (#276): the switch says so and a press ends it where it started; the phone button only where MokuPilot runs', () => {
  expect(presenceSwitch(view({ state: 'call', before: 'away' }), t)).toEqual({
    state: 'call',
    label: 'On a call',
    hint: expect.stringMatching(/when the call is over/),
    next: 'away',
    offer: null,
  })
  expect(presenceSwitch(view({ state: 'call' }), t)?.next).toBe('here')
  expect(presenceSwitch(view({ calls: true }), t)?.call).toMatch(/^On a call/)
  expect(presenceSwitch(view({ state: 'call', calls: true }), t)).not.toHaveProperty('call')
  expect(presenceSwitch(view(), t)).not.toHaveProperty('call')
  expect(presenceBody('call', false)).toEqual({ state: 'call', from: 'web' })

  const ids = (data: Partial<PresenceView>) =>
    findAll(renderInBoard(<PresenceSwitch />, board({ data: payload({ presence: view(data) }) })), el =>
      /^presence-/.test(el.attrs.get('id') ?? ''),
    ).map(el => [el.attrs.get('id'), el.attrs.get('data-state'), el.attrs.get('aria-pressed')])
  expect(ids({})).toEqual([['presence-switch', 'here', 'false']])
  expect(ids({ calls: true })).toEqual([
    ['presence-switch', 'here', 'false'],
    ['presence-call', undefined, undefined],
  ])
  expect(ids({ state: 'call', calls: true })).toEqual([['presence-switch', 'call', 'true']])
  expect(ids({ state: 'call' })).toEqual([['presence-switch', 'call', 'true']])
  expect(translator('ru')('presence.call')).toBe('На звонке')
})
