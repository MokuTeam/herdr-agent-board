// A master's start on its launch card (#504): what the placer gives as data (core/placement.ts
// LaunchPlace) in the board's words, English and Russian, and the card a queued start draws.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { STRINGS } from '../../src/core/i18n/strings.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { LaunchView } from '../../src/core/types.ts'
import { LaunchNote } from '../../web/src/components/launch/LaunchCard.tsx'
import {
  blockerText,
  homeText,
  launchColumn,
  placeRefusal,
  queuedText,
  refusalText,
  stepText,
  turnedText,
} from '../../web/src/models/launch.ts'

const en = translator('en')
const ru = translator('ru')

const launch = (fields: Partial<LaunchView> = {}): LaunchView => ({
  id: 'L1',
  name: 'atlas 1',
  cwd: 'C:\\Work\\atlas',
  category: 'atlas',
  workspace: 'Atlas',
  workspaceId: 'w2',
  state: 'starting',
  step: 'placing',
  error: '',
  kind: '',
  pane: null,
  key: null,
  startedAt: 1000,
  doneAt: null,
  message: '',
  worktree: null,
  newWorkspace: false,
  place: {},
  ...fields,
})
const look = { t: en, launcher: '', pressed: () => false }
const markup = (l: LaunchView, t = en) => renderToStaticMarkup(<LaunchNote launch={l} look={{ ...look, t }} />)

test('every word of a placed start is there in English and Russian', () => {
  const keys = Object.keys(STRINGS.en).filter(k => k.startsWith('place.') || k === 'launch.err.pin')
  expect(keys.length).toBeGreaterThan(30)
  for (const k of ['node.place.choosing', 'node.place.cloning', 'node.place.syncing', ...keys]) {
    expect([k, typeof STRINGS.en[k]]).toEqual([k, 'string'])
    expect([k, typeof STRINGS.ru[k]]).toEqual([k, 'string'])
  }
})

test('the steps: choosing a device, cloning on it, starting on it', () => {
  expect(stepText(launch(), en, '')).toBe('Choosing a device…')
  expect(stepText(launch({ step: 'cloning', place: { device: 'server-1' } }), en, '')).toBe('Cloning on server-1…')
  expect(stepText(launch({ place: { device: 'server-1' } }), en, '')).toBe('Starting on server-1…')
  expect(stepText(launch({ state: 'done', place: { device: 'server-1' } }), en, '')).toBe('Starting on server-1…')
  expect(stepText(launch({ step: 'cloning', place: { device: 'server-1' } }), ru, '')).toBe(
    'Клонирую репозиторий на server-1…',
  )
  // A start without a place reads as before.
  const { place: _, ...plain } = launch({ step: 'agent' })
  expect(stepText(plain, en, '')).toBe('Claude is starting…')
})

test('what a start waits on, why it stays here, why it was refused', () => {
  expect(blockerText({ device: 'server-1', kind: 'sessions', busy: 3, max: 3 }, en)).toBe(
    'server-1 has 3 of 3 sessions',
  )
  expect(blockerText({ device: 'local', kind: 'memory', freeMb: 900.4, needMb: 1184 }, en)).toBe(
    'this computer has 900 MB free, 1184 MB needed',
  )
  expect(blockerText({ device: 'server-2', kind: 'load', perCore: 1.234, max: 0.9 }, en)).toBe(
    'server-2 is loaded 1.23 per core, 0.9 at most',
  )
  expect(blockerText({ device: 'server-1', kind: 'offline' }, ru)).toBe('server-1 недоступен')
  expect(blockerText({ device: 'server-1', kind: 'no-status' }, en)).toBe('server-1 has not said how busy it is yet')
  expect(homeText({ kind: 'unpushed' }, en)).toBe('the branch is not at its remote branch')
  expect(homeText({ kind: 'base-unpushed', branch: 'main' }, en)).toBe('the branch main is not at its remote branch')
  expect(homeText({ kind: 'local-path', path: 'C:\\tmp\\brief.md' }, en)).toBe(
    'the first message names C:\\tmp\\brief.md, which is on this computer',
  )
  expect(refusalText({ kind: 'no-device', pin: { tag: 'gpu' } }, en)).toBe('No device fits “Where”: gpu')
  expect(
    refusalText(
      {
        kind: 'unfit',
        devices: [
          { device: 'server-1', kind: 'not-logged-in', profile: 'work' },
          { device: 'local', kind: 'tags', missing: ['gpu', 'linux'] },
        ],
      },
      en,
    ),
  ).toBe('No device can take it: server-1 is not logged in to work; this computer lacks the tags gpu, linux')
  // Another version: said as an update on its way while one is (#590).
  expect(
    refusalText({ kind: 'unfit', devices: [{ device: 'server-1', kind: 'commit', theirs: 'a', ours: 'b' }] }, en),
  ).toBe('No device can take it: server-1 runs another version of the board')
  expect(
    refusalText(
      { kind: 'unfit', devices: [{ device: 'server-1', kind: 'commit', theirs: 'a', ours: 'b', updating: true }] },
      en,
    ),
  ).toBe("No device can take it: server-1 is updating to this board's version")
  expect(
    refusalText({ kind: 'pinned-away', pin: { device: 'server-1' }, origin: 'local', home: { kind: 'changes' } }, en),
  ).toBe('It runs only on this computer (the folder has changes that are not committed), and “Where” says server-1')
  // Refused at origin because it could not leave: portable reason first, device reason, and what to do (#600).
  const pathSpecial = String.raw`C:\Users\anna\My Docs\бриф 100%.md`
  const cases = [
    [
      { kind: 'lane' as const },
      'Cannot leave this computer (its lane does not leave this computer), and this computer is draining. Allow this lane in Settings, Devices.',
      'Не может покинуть этот компьютер (её дорожка не уходит с этого компьютера), а этот компьютер освобождается. Отметьте дорожку в настройках устройств.',
    ],
    [
      { kind: 'no-remote' as const },
      'Cannot leave this computer (the folder is not in a checkout with a remote), and this computer is draining. Add a git remote, or start from a checkout with one.',
      'Не может покинуть этот компьютер (папка не в checkout с remote), а этот компьютер освобождается. Добавьте git remote или запустите из репозитория с remote.',
    ],
    [
      { kind: 'changes' as const },
      'Cannot leave this computer (the folder has changes that are not committed), and this computer is draining. Commit and push the changes.',
      'Не может покинуть этот компьютер (в папке есть незакоммиченные изменения), а этот компьютер освобождается. Закоммитьте и запушьте изменения.',
    ],
    [
      { kind: 'unpushed' as const },
      'Cannot leave this computer (the branch is not at its remote branch), and this computer is draining. Push the branch.',
      'Не может покинуть этот компьютер (ветка не совпадает со своей remote-веткой), а этот компьютер освобождается. Запушьте ветку.',
    ],
    [
      { kind: 'base-unpushed' as const, branch: 'feature/atlas' },
      'Cannot leave this computer (the branch feature/atlas is not at its remote branch), and this computer is draining. Push the branch feature/atlas.',
      'Не может покинуть этот компьютер (ветка feature/atlas не совпадает со своей remote-веткой), а этот компьютер освобождается. Запушьте ветку feature/atlas.',
    ],
    [
      { kind: 'local-path' as const, path: pathSpecial },
      `Cannot leave this computer (the first message names ${pathSpecial}, which is on this computer), and this computer is draining. Drop the path from the first message.`,
      `Не может покинуть этот компьютер (первое сообщение называет ${pathSpecial}, а это файл этого компьютера), а этот компьютер освобождается. Уберите путь из первого сообщения.`,
    ],
    [
      { kind: 'name' as const, name: 'fix+one' },
      'Cannot leave this computer (a node does not take the name fix+one), and this computer is draining. Use a plain branch or folder name.',
      'Не может покинуть этот компьютер (узел не принимает имя fix+one), а этот компьютер освобождается. Используйте простое имя ветки или папки.',
    ],
  ] as const
  for (const [home, expectedEn, expectedRu] of cases) {
    const refuse = { kind: 'unfit' as const, devices: [{ device: 'local', kind: 'draining' as const }], home }
    expect(refusalText(refuse, en)).toBe(expectedEn)
    expect(refusalText(refuse, ru)).toBe(expectedRu)
  }
  expect(
    refusalText(
      {
        kind: 'unfit',
        devices: [{ device: 'server-2', kind: 'paused' }],
        home: { kind: 'unpushed' },
      },
      en,
    ),
  ).toBe('Cannot leave server-2 (the branch is not at its remote branch), and server-2 is paused. Push the branch.')
  expect(
    refusalText(
      {
        kind: 'unfit',
        devices: [{ device: 'server-2', kind: 'paused' }],
        home: { kind: 'unpushed' },
      },
      ru,
    ),
  ).toBe('Не может покинуть server-2 (ветка не совпадает со своей remote-веткой), а server-2 на паузе. Запушьте ветку.')
  expect(placeRefusal({ place: { queueFull: true } }, en)).toBe('50 starts are waiting already: this one was not added')
  expect(placeRefusal({ place: {} }, en)).toBeNull()
  expect(
    turnedText(
      {
        place: {
          turned: [
            { device: 'server-1', error: 'full' },
            { device: 'server-2', error: 'repo' },
          ],
        },
      },
      en,
    ),
  ).toBe('server-1: no room; server-2: its copy of the repository cannot be used')
})

test('a queued start waits under "waiting on someone else" with what it waits on and Cancel', () => {
  const queued = launch({ state: 'queued', place: { wait: { device: 'server-1', kind: 'sessions', busy: 3, max: 3 } } })
  expect(launchColumn(queued)).toBe('ext')
  expect(queuedText(queued, en)).toBe('Waiting for room: server-1 has 3 of 3 sessions')
  const html = markup(queued)
  expect(html).toContain('Waiting for room: server-1 has 3 of 3 sessions')
  expect(html).toContain('data-launch="dismiss"')
  expect(html).toContain('>Cancel<')
  // Every device turned it away: it waits for one that takes it, and says who turned it away.
  const turned = markup(launch({ state: 'queued', place: { turned: [{ device: 'server-1', error: 'full' }] } }), ru)
  expect(turned).toContain('Жду устройство, которое её возьмёт')
  expect(turned).toContain('server-1: нет места')
  // A refusal is the failure's text; a start kept here says why under its step.
  expect(
    markup(launch({ state: 'failed', place: { refuse: { kind: 'no-device', pin: { device: 'server-9' } } } })),
  ).toContain('No device fits “Where”: server-9')
  const homeRefused = launch({
    state: 'failed',
    place: { refuse: { kind: 'unfit', devices: [{ device: 'local', kind: 'draining' }], home: { kind: 'unpushed' } } },
  })
  expect(markup(homeRefused)).toContain(
    'Cannot leave this computer (the branch is not at its remote branch), and this computer is draining. Push the branch.',
  )
  expect(markup(homeRefused, ru)).toContain(
    'Не может покинуть этот компьютер (ветка не совпадает со своей remote-веткой), а этот компьютер освобождается. Запушьте ветку.',
  )
  expect(markup(launch({ step: 'prepare', place: { home: { kind: 'lane' } } }))).toContain(
    'On this computer: its lane does not leave this computer',
  )
})

test('renamed device titles appear on launch cards, blockers, refusals and turned lists (#601)', () => {
  const devices = [
    { id: 'local', title: 'Work Laptop' },
    { id: 'server-1', title: 'Atlas Box' },
    { id: 'server-2', title: 'Beta Box' },
  ]
  expect(stepText(launch({ step: 'cloning', place: { device: 'server-1' } }), en, '', devices)).toBe(
    'Cloning on Atlas Box…',
  )
  expect(stepText(launch({ place: { device: 'local' } }), en, '', devices)).toBe('Starting on Work Laptop…')
  expect(blockerText({ device: 'server-1', kind: 'sessions', busy: 3, max: 3 }, en, devices)).toBe(
    'Atlas Box has 3 of 3 sessions',
  )
  expect(blockerText({ device: 'local', kind: 'offline' }, ru, devices)).toBe('Work Laptop недоступен')
  expect(
    refusalText(
      {
        kind: 'unfit',
        devices: [
          { device: 'server-1', kind: 'paused' },
          { device: 'local', kind: 'tags', missing: ['gpu'] },
        ],
      },
      en,
      devices,
    ),
  ).toBe('No device can take it: Atlas Box is paused; Work Laptop lacks the tags gpu')
  expect(
    refusalText(
      {
        kind: 'unfit',
        devices: [{ device: 'local', kind: 'draining' }],
        home: { kind: 'unpushed' },
      },
      en,
      devices,
    ),
  ).toBe(
    'Cannot leave Work Laptop (the branch is not at its remote branch), and Work Laptop is draining. Push the branch.',
  )
  expect(
    refusalText(
      { kind: 'pinned-away', pin: { device: 'server-1' }, origin: 'local', home: { kind: 'changes' } },
      en,
      devices,
    ),
  ).toBe('It runs only on Work Laptop (the folder has changes that are not committed), and “Where” says Atlas Box')

  const queued = launch({
    state: 'queued',
    place: {
      wait: { device: 'local', kind: 'sessions', busy: 2, max: 2 },
      turned: [{ device: 'server-2', error: 'full' }],
    },
  })
  const queuedHtml = renderToStaticMarkup(<LaunchNote launch={queued} look={{ ...look, devices: devices as never }} />)
  expect(queuedHtml).toContain('Waiting for room: Work Laptop has 2 of 2 sessions')
  expect(queuedHtml).toContain('Beta Box: no room')

  const refused = launch({
    state: 'failed',
    place: { refuse: { kind: 'unfit', devices: [{ device: 'server-1', kind: 'paused' }] } },
  })
  const refusedHtml = renderToStaticMarkup(
    <LaunchNote launch={refused} look={{ ...look, devices: devices as never }} />,
  )
  expect(refusedHtml).toContain('No device can take it: Atlas Box is paused')
})
