// Settings → Secrets… (components/secrets/SecretsPanel.tsx): the owner's secrets for the agents,
// never their values. The list (GET /api/secrets, on opening and after each own change): a
// secret's name, where it applies (everywhere, a profile by its title, a session by its name now),
// when it was set and when a session last got it, and how; Replace fills the form, Delete asks
// first. The form: a name checked as the board checks it, where it applies, the value in a
// password field that is never filled in, emptied as soon as the board answered, and never on the
// page, in a toast or in what the panel keeps. Offered on the local board's page and on the
// board's own server, not on a remote page to a PC board.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import type { SecretMeta, SecretsView } from '../../src/core/secrets.ts'
import type { Item } from '../../src/core/types.ts'
import { longWhen } from '../../src/core/when-format.ts'
import { SecretsBody, SecretsPanel } from '../../web/src/components/secrets/SecretsPanel.tsx'
import { type SecretsNow, secretsSource } from '../../web/src/hooks/useSecrets.ts'
import { settingsMenuFrom } from '../../web/src/hooks/useSettingsMenu.ts'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import {
  EMPTY_FORM,
  formOf,
  isSecretsView,
  nameError,
  profileChoices,
  type SecretForm,
  scopeLabel,
  sessionChoices,
  setBody,
  shortKey,
  usedLine,
  valueError,
} from '../../web/src/models/secrets.ts'
import { offersSecrets, settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import type { Board } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { byId, type Element, find, findAll, hasClass, type Node, serializeNodes } from './support/markup.ts'
import { clone, commit, first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

afterEach(restoreFetch)

const t = translator('en')
const ru = translator('ru')
const VP = { w: 1600, h: 1000 }
/** The page's clock, and moments before it. */
const NOW = new Date(2026, 9, 21, 15, 0).getTime()
const SET_AT = new Date(2026, 9, 16, 9, 30).getTime()
const USED_AT = new Date(2026, 9, 21, 14, 40).getTime()

/** What the test types as a value: it must never come back anywhere but in the POST that sets it. */
const MARKER = 's3cr3t-MARKER'

const ALPHA = '0a1b2c3d-1111-4222-8333-444455556666'
const BETA = 'ffeeddcc-2222-4333-8444-555566667777'
/** A session gone from the board, its name kept with the secret. */
const GONE = '12345678-aaaa-4bbb-8ccc-ddddeeeeffff'
/** Gone, and no name kept. */
const NAMELESS = '9abcdef0-bbbb-4ccc-8ddd-eeeeffff0000'

const ITEMS: Item[] = [
  item({ key: ALPHA, name: 'Alpha' }),
  item({ key: BETA, name: 'Бета сессия', sleeping: true }),
  // Not Claude sessions: a pane without a session yet, and pi's.
  item({ key: 'pane-7', name: 'Shell' }),
  item({ key: '/home/me/.pi/agent/sessions/x.jsonl', name: 'Pi one', agent: 'pi' }),
]

const profile = (fields: Partial<BoardProfile> & Pick<BoardProfile, 'id' | 'title'>): BoardProfile => ({
  color: '#5856D6',
  colorName: 'indigo',
  dir: `/home/me/.claude-${fields.id}`,
  hidden: false,
  inherited: false,
  exists: true,
  hooks: true,
  sessions: 0,
  limits: null,
  ...fields,
})
const PROFILES = [
  profile({ id: 'default', title: 'Private' }),
  profile({ id: 'work', title: 'Work 100%' }),
  profile({ id: 'gamedev', title: 'Gamedev', hidden: true }),
]

const meta = (fields: Partial<SecretMeta> & Pick<SecretMeta, 'name'>): SecretMeta => {
  const scope = fields.scope ?? 'global'
  const target = fields.target ?? null
  return { id: `${scope}:${target ?? ''}:${fields.name}`, scope, target, setAt: SET_AT, ...fields }
}
const GLOBAL = meta({ name: 'GITHUB_TOKEN', usedAt: USED_AT, usedBy: ALPHA, usedHow: 'env' })
const WORK = meta({ name: 'GITHUB_TOKEN', scope: 'profile', target: 'work' })
const NO_PROFILE = meta({ name: 'NPM_TOKEN', scope: 'profile', target: 'gone', usedAt: USED_AT, usedHow: 'get' })
const OWN = meta({
  name: 'OPENAI_KEY',
  scope: 'session',
  target: ALPHA,
  targetName: 'Old name',
  usedAt: USED_AT,
  usedBy: GONE,
  usedHow: 'launch',
})
const KEPT_NAME = meta({
  name: 'X_KEY',
  scope: 'session',
  target: GONE,
  targetName: 'Old one',
  usedAt: USED_AT,
  usedBy: 'pane-7',
  usedHow: 'file',
})
const NO_NAME = meta({ name: 'Y_KEY', scope: 'session', target: NAMELESS })
const VIEW: SecretsView = { secrets: [GLOBAL, WORK, NO_PROFILE, OWN, KEPT_NAME, NO_NAME] }

const DATA = (lang: 'en' | 'ru' = 'en'): BoardPayload => payload({ lang, items: ITEMS, profiles: PROFILES })

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))

const state = (fields: Partial<SecretsNow> = {}): SecretsNow => ({
  view: VIEW,
  form: EMPTY_FORM,
  busy: false,
  sure: null,
  focus: 0,
  ...fields,
})
const NO_ACT = { edit() {}, replace() {}, arm() {}, save: async () => {}, remove: async () => {} }

/** The panel's body as drawn for a state. */
function bodyOf(now: SecretsNow, fields: Partial<Omit<Board, 'ui'>> = {}, lang: 'en' | 'ru' = 'en'): Node[] {
  return renderInBoard(<SecretsBody now={now} act={NO_ACT} />, board({ data: DATA(lang), now: NOW, ...fields }), lang)
}

/** A row as drawn: its name and its lines. */
const rowsOf = (nodes: Node[]) =>
  findAll(nodes, el => hasClass(el, 'secrets-row')).map(row => [
    textOf(find([row], el => hasClass(el, 'secrets-name'))),
    ...findAll([row], el => hasClass(el, 'access-meta')).map(textOf),
  ])

describe('the list', () => {
  test('each secret: its name, where it applies, when it was set and last used, and how', () => {
    const set = `set ${longWhen(SET_AT, t, NOW)}`
    const used = longWhen(USED_AT, t, NOW)
    expect(rowsOf(bodyOf(state()))).toEqual([
      ['GITHUB_TOKEN', 'Everywhere', `${set} · last used ${used} by Alpha, in Bash`],
      ['GITHUB_TOKEN', 'Profile: Work 100%', `${set} · never used`],
      // A profile the board has no more: its id; used without a session said.
      ['NPM_TOKEN', 'Profile: gone', `${set} · last used ${used}`],
      // The session's name now, not the one it had; used by a session gone: its short id.
      ['OPENAI_KEY', 'Session: Alpha', `${set} · last used ${used} by 12345678, at start`],
      ['X_KEY', 'Session: Old one', `${set} · last used ${used} by Shell, via board secret file`],
      ['Y_KEY', 'Session: 9abcdef0', `${set} · never used`],
    ])
    // A row's buttons: Replace and Delete.
    const row = find(bodyOf(state()), el => hasClass(el, 'secrets-row'))
    expect(findAll([row], el => el.tag === 'button').map(textOf)).toEqual(['Replace', 'Delete'])
  })

  test('in Russian', () => {
    const set = `задан: ${longWhen(SET_AT, ru, NOW)}`
    const used = longWhen(USED_AT, ru, NOW)
    expect(rowsOf(bodyOf(state(), {}, 'ru')).slice(0, 4)).toEqual([
      ['GITHUB_TOKEN', 'Везде', `${set} · последний раз: ${used}, Alpha, в Bash`],
      ['GITHUB_TOKEN', 'Профиль: Work 100%', `${set} · ещё не использовался`],
      ['NPM_TOKEN', 'Профиль: gone', `${set} · последний раз: ${used}`],
      ['OPENAI_KEY', 'Сессия: Alpha', `${set} · последний раз: ${used}, 12345678, при запуске`],
    ])
    const row = find(bodyOf(state(), {}, 'ru'), el => hasClass(el, 'secrets-row'))
    expect(findAll([row], el => el.tag === 'button').map(textOf)).toEqual(['Заменить', 'Удалить'])
  })

  test('none yet: says how to add one; before the board answers: that it is asked', () => {
    const none = bodyOf(state({ view: { secrets: [] } }))
    expect(findAll(none, el => hasClass(el, 'access-none')).map(textOf)).toEqual([
      'No secrets yet. Add one below, or in a terminal: board secret set NAME',
    ])
    expect(findAll(none, el => hasClass(el, 'secrets-row'))).toEqual([])
    expect(
      findAll(bodyOf(state({ view: { secrets: [] } }), {}, 'ru'), el => hasClass(el, 'access-none')).map(textOf),
    ).toEqual(['Секретов пока нет. Добавьте ниже или в терминале: board secret set NAME'])
    expect(findAll(bodyOf(state({ view: null })), el => hasClass(el, 'access-none')).map(textOf)).toEqual([
      'Asking the board…',
    ])
  })

  test('the words, one by one', () => {
    const items = ITEMS
    expect(scopeLabel(GLOBAL, PROFILES, items, t)).toBe('Everywhere')
    expect(scopeLabel(WORK, PROFILES, items, t)).toBe('Profile: Work 100%')
    expect(scopeLabel(WORK, undefined, items, t)).toBe('Profile: work')
    expect(scopeLabel(OWN, PROFILES, [], t)).toBe('Session: Old name')
    expect(scopeLabel(NO_NAME, PROFILES, [], ru)).toBe('Сессия: 9abcdef0')
    expect(usedLine(WORK, items, t, NOW)).toBe('never used')
    expect(usedLine({ ...GLOBAL, usedHow: 'get' }, items, t, NOW)).toBe(
      `last used ${longWhen(USED_AT, t, NOW)} by Alpha, via board secret get`,
    )
    expect(shortKey(ALPHA)).toBe('0a1b2c3d')
    expect(shortKey('pane-7')).toBe('pane-7')
    expect(shortKey('C:\\Users\\Иван Петров\\.pi\\sessions\\a b%.jsonl')).toBe('a b%.jsonl')
    expect(shortKey('/home/me/.pi/agent/sessions/x.jsonl')).toBe('x.jsonl')
  })
})

describe('the help', () => {
  test('how agents get them, when changes apply, which one wins, and the honest limit', () => {
    const nodes = bodyOf(state())
    const help = textOf(find(nodes, el => hasClass(el, 'secrets-help')))
    expect(help).toContain('environment variables in their Bash commands')
    expect(help).toContain('MCP servers')
    expect(findAll(nodes, el => el.tag === 'code').map(textOf)).toEqual([
      'board secret get NAME',
      'board secret file NAME',
    ])
    expect(help).toContain('Changes apply to new or restarted sessions.')
    expect(help).toContain('the session’s wins over the profile’s')
    expect(help).toContain('All agents run as one Linux user')
    expect(help).toContain('not from an agent set on reading it')
    const inRu = textOf(find(bodyOf(state(), {}, 'ru'), el => hasClass(el, 'secrets-help')))
    expect(inRu).toContain('Изменения действуют в новых и перезапущенных сессиях.')
    expect(inRu).toContain('под одним пользователем Linux')
  })

  test('the panel: its id, its name, its title and its line', () => {
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <SecretsPanel open={false} onClose={() => {}} />
      </PanelProvider>,
      board({ data: DATA(), now: NOW }),
    )
    const panel = byId(nodes, 'secrets-sheet')
    expect(panel.attrs.get('aria-label')).toBe('Secrets')
    const head = find([panel], el => hasClass(el, 'sheet-title'))
    expect(textOf(find([head], el => el.tag === 'h2'))).toBe('Secrets')
    expect(textOf(find([head], el => hasClass(el, 'sheet-meta')))).toBe(
      'API tokens and keys for your agents. A value is kept encrypted and never shown again.',
    )
    const inRu = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <SecretsPanel open={false} onClose={() => {}} />
      </PanelProvider>,
      board({ data: DATA('ru'), now: NOW }),
      'ru',
    )
    expect(byId(inRu, 'secrets-sheet').attrs.get('aria-label')).toBe('Секреты')
  })
})

describe('the form', () => {
  const field = (nodes: Node[], name: string): Element => find(nodes, el => el.attrs.get('name') === name)

  test('the value: a password field, empty, not spell-checked, not filled in by the browser', () => {
    // Even with a value typed (as the panel keeps it while typed), the markup… holds it only as the field's own.
    const nodes = bodyOf(state())
    const value = field(nodes, 'secret-value')
    expect(value.tag).toBe('input')
    expect(
      ['type', 'autocomplete', 'spellcheck', 'autocapitalize', 'value'].map(a => value.attrs.get(a) ?? null),
    ).toEqual(['password', 'new-password', 'false', 'off', ''])
    expect(value.attrs.get('aria-label')).toBe('Value')
    // A new form never has one.
    expect(EMPTY_FORM.value).toBe('')
    expect(formOf(OWN).value).toBe('')
  })

  test('where it applies: three choices; the profiles (a hidden one said so); the Claude sessions only, asleep too', () => {
    const scopes = (nodes: Node[]) =>
      findAll([find(nodes, el => hasClass(el, 'profile-shown'))], el => el.tag === 'button').map(b => [
        textOf(b),
        b.attrs.get('aria-pressed'),
      ])
    expect(scopes(bodyOf(state()))).toEqual([
      ['Everywhere', 'true'],
      ['A profile', 'false'],
      ['A session', 'false'],
    ])
    // Everywhere: no select.
    expect(findAll(bodyOf(state()), el => el.tag === 'select')).toEqual([])
    const options = (nodes: Node[]) =>
      findAll(nodes, el => el.tag === 'option').map(o => [o.attrs.get('value'), textOf(o)])
    const prof = bodyOf(state({ form: { ...EMPTY_FORM, scope: 'profile' } }))
    expect(scopes(prof).map(s => s[1])).toEqual(['false', 'true', 'false'])
    expect(options(prof)).toEqual([
      ['', 'Pick a profile'],
      ['default', 'Private'],
      ['work', 'Work 100%'],
      ['gamedev', 'Gamedev (hidden)'],
    ])
    const sess = bodyOf(state({ form: { ...EMPTY_FORM, scope: 'session' } }))
    expect(options(sess)).toEqual([
      ['', 'Pick a session'],
      [ALPHA, 'Alpha'],
      [BETA, 'Бета сессия (asleep)'],
    ])
    // In Russian: by name as Russian sorts them, Cyrillic first.
    expect(options(bodyOf(state({ form: { ...EMPTY_FORM, scope: 'session' } }), {}, 'ru'))).toEqual([
      ['', 'Выберите сессию'],
      [BETA, 'Бета сессия (спит)'],
      [ALPHA, 'Alpha'],
    ])
    // None on the board: it says so.
    const empty = renderInBoard(
      <SecretsBody now={state({ form: { ...EMPTY_FORM, scope: 'session' } })} act={NO_ACT} />,
      board({ data: payload({ items: [], profiles: PROFILES }), now: NOW }),
    )
    expect(options(empty)).toEqual([['', 'No Claude sessions on the board']])
    // The place being replaced, gone from the board, is still offered.
    expect(sessionChoices(ITEMS, t, { id: GONE, name: 'Old one' }).at(-1)).toEqual({ id: GONE, label: 'Old one' })
    expect(sessionChoices(ITEMS, t, { id: ALPHA, name: 'Old name' })).toHaveLength(2)
    expect(profileChoices(PROFILES, t, 'gone').at(-1)).toEqual({ id: 'gone', label: 'gone' })
  })

  test('the name is checked as the board checks it, in the board’s words; the value too', () => {
    expect(nameError('', t)).toBeNull()
    expect(nameError('MY_TOKEN', t)).toBeNull()
    expect(nameError('_x9', t)).toBeNull()
    expect(nameError('9LIVES', t)).toBe(t('secrets.err.name'))
    expect(nameError('MY-TOKEN', t)).toBe(t('secrets.err.name'))
    expect(nameError('A'.repeat(129), t)).toBe(t('secrets.err.name'))
    expect(nameError('PATH', t)).toBe(
      'PATH is read by the shell, Claude Code, herdr or the board itself: pick another name',
    )
    expect(nameError('ANTHROPIC_API_KEY', ru)).toBe(
      'ANTHROPIC_API_KEY читают сама оболочка, Claude Code, herdr или доска: выберите другое имя',
    )
    expect(valueError('', t)).toBeNull()
    expect(valueError('a\0b', t)).toBe('A value cannot hold a NUL character')
    expect(valueError('я'.repeat(32 * 1024 + 1), t)).toBe('A value is 64 KB at most')
    expect(valueError('я'.repeat(32 * 1024), t)).toBeNull()
    // Drawn under its field.
    const nodes = bodyOf(state({ form: { ...EMPTY_FORM, name: 'my-token' } }))
    expect(findAll(nodes, el => hasClass(el, 'access-problem')).map(textOf)).toEqual([t('secrets.err.name')])
  })

  test('Save waits for a name, a place and a value; the same name and place there already: Replace', () => {
    const save = (form: SecretForm, fields: Partial<SecretsNow> = {}, ctx: Partial<Omit<Board, 'ui'>> = {}) => {
      const button = find(bodyOf(state({ form, ...fields }), ctx), el => el.attrs.get('type') === 'submit')
      return [textOf(button), button.attrs.has('disabled')]
    }
    const ready: SecretForm = { name: 'NEW_KEY', scope: 'global', target: null, value: 'x' }
    expect(save(ready)).toEqual(['Save', false])
    expect(save({ ...ready, name: '' })).toEqual(['Save', true])
    expect(save({ ...ready, name: 'PATH' })).toEqual(['Save', true])
    expect(save({ ...ready, value: '' })).toEqual(['Save', true])
    expect(save({ ...ready, scope: 'profile' })).toEqual(['Save', true])
    expect(save({ ...ready, scope: 'profile', target: 'default' })).toEqual(['Save', false])
    expect(save({ ...ready, name: 'GITHUB_TOKEN' })).toEqual(['Replace', false])
    expect(save({ ...ready, name: 'GITHUB_TOKEN', scope: 'profile', target: 'work' })).toEqual(['Replace', false])
    expect(save({ ...ready, name: 'GITHUB_TOKEN', scope: 'profile', target: 'default' })).toEqual(['Save', false])
    // A request on its way, or no board: nothing can be pressed or typed.
    for (const [fields, ctx] of [
      [{ busy: true }, {}],
      [{}, { connected: false, canEdit: false }],
    ] as const) {
      const nodes = bodyOf(state({ form: ready, ...fields }), ctx)
      const controls = findAll(nodes, el => ['input', 'button', 'select'].includes(el.tag))
      expect(controls.length).toBeGreaterThan(10)
      expect(controls.filter(el => !el.attrs.has('disabled')).map(el => el.tag)).toEqual([])
    }
  })

  test('what Save sends: exactly the set, the session’s name with a session’s', () => {
    const value = MARKER
    expect(setBody({ name: ' NEW_KEY ', scope: 'global', target: null, value }, ITEMS)).toEqual({
      op: 'set',
      name: 'NEW_KEY',
      scope: 'global',
      target: null,
      value,
    })
    expect(setBody({ name: 'NEW_KEY', scope: 'profile', target: 'work', value }, ITEMS)).toEqual({
      op: 'set',
      name: 'NEW_KEY',
      scope: 'profile',
      target: 'work',
      value,
    })
    expect(setBody({ name: 'NEW_KEY', scope: 'session', target: ALPHA, value }, ITEMS)).toEqual({
      op: 'set',
      name: 'NEW_KEY',
      scope: 'session',
      target: ALPHA,
      targetName: 'Alpha',
      value,
    })
    // A session gone from the board: the name it had.
    expect(setBody(formOf(KEPT_NAME), ITEMS)).toBeNull()
    expect(setBody({ ...formOf(KEPT_NAME), value }, ITEMS)).toEqual({
      op: 'set',
      name: 'X_KEY',
      scope: 'session',
      target: GONE,
      targetName: 'Old one',
      value,
    })
    expect(setBody({ ...formOf(NO_NAME), value }, ITEMS)).toEqual({
      op: 'set',
      name: 'Y_KEY',
      scope: 'session',
      target: NAMELESS,
      value,
    })
    for (const form of [
      { name: 'PATH', scope: 'global', target: null, value },
      { name: 'OK', scope: 'session', target: null, value },
      { name: 'OK', scope: 'global', target: null, value: '' },
      { name: 'OK', scope: 'global', target: null, value: 'a\0' },
    ] as const)
      expect(setBody(form, ITEMS)).toBeNull()
  })

  test('the board’s view, read through its guard', () => {
    expect(isSecretsView(VIEW)).toBe(true)
    expect(isSecretsView({ secrets: [] })).toBe(true)
    expect(isSecretsView({ secrets: [{ ...GLOBAL, scope: 'team' }] })).toBe(false)
    expect(isSecretsView({ secrets: [{ ...GLOBAL, setAt: 'today' }] })).toBe(false)
    expect(isSecretsView({ secrets: [{ ...GLOBAL, usedHow: 'mail' }] })).toBe(false)
    expect(isSecretsView({ secrets: [{ ...GLOBAL, name: 3 }] })).toBe(false)
    expect(isSecretsView({ ok: false, error: 'x' })).toBe(false)
    expect(isSecretsView(null)).toBe(false)
  })
})

// ---------------------------------------------------------------- live, with React's handlers

/**
 * The body live in a fake DOM with React's handlers on it (support/react-events.ts), drawn again
 * after every event as React would (support/react-commit.ts), from the panel's source
 * (hooks/useSecrets.ts) as the panel draws it. The board's answers are the test's; its toasts kept.
 */
function liveSecrets(view: SecretsView = VIEW) {
  const toasts: [string, boolean][] = []
  const context = board({
    data: DATA(),
    now: NOW,
    toast: (text, error = false) => void toasts.push([text, error]),
  })
  const source = secretsSource({ t: () => t, toast: context.toast, items: () => ITEMS })
  source.now.set({ ...source.now.get(), view })
  const world = new FakeWorld({ viewport: VP })
  const tree = () => <SecretsBody now={source.now.get()} act={source} />
  let drawn: { el: FakeElement; markup: Element; hosts: Host[] } | null = null
  const draw = () => {
    const node = tree()
    let hosts: Host[] = []
    function Probe() {
      hosts = hostElements(node)
      return null
    }
    renderInBoard(<Probe />, context)
    const next = first(renderInBoard(node, context))
    if (!drawn) drawn = { el: world.mount(clone(next)), markup: next, hosts }
    else {
      commit(world, drawn.el.node, drawn.markup, next)
      drawn = { el: drawn.el, markup: next, hosts }
    }
  }
  draw()
  world.afterFlush = draw
  listenLikeReact(
    world.wrap(world.body),
    () => drawn?.el ?? null,
    () => drawn?.hosts ?? [],
  )
  const page = (): FakeElement => {
    if (!drawn) throw new Error('nothing drawn')
    return drawn.el
  }
  const pick = (selector: string): FakeElement => {
    const el = page().querySelector(selector)
    if (!el) throw new Error(`no ${selector}`)
    return el
  }
  const idle = async () => {
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(0)
      await world.flush()
    }
  }
  const button = (label: string, under: FakeElement = page()): FakeElement => {
    const found = under.querySelectorAll('button').find(b => b.textContent === label)
    if (!found) throw new Error(`no button ${label}`)
    return found
  }
  return {
    world,
    source,
    toasts,
    pick,
    /** All that is drawn, as markup, and the live elements' too (what typing wrote into them). */
    html: () => serializeNodes([drawn?.markup ?? page().node, page().node]),
    row: (id: string): FakeElement => {
      const found = page()
        .querySelectorAll('.secrets-row')
        .find(r => r.getAttribute('data-id') === id)
      if (!found) throw new Error(`no row ${id}`)
      return found
    },
    async click(label: string, under?: FakeElement) {
      await world.fire(button(label, under), 'click')
      await idle()
    },
    async blur(label: string, under?: FakeElement) {
      await world.fire(button(label, under), 'focusout')
      await idle()
    },
    async type(name: string, text: string) {
      const field = pick(`input[name="${name}"]`)
      field.value = text
      await world.fire(field, 'input')
      await idle()
    },
    async choose(name: string, value: string) {
      const field = pick(`select[name="${name}"]`)
      field.value = value
      await world.fire(field, 'change')
      await idle()
    },
    async submit() {
      await world.fire(pick('.secrets-form'), 'submit')
      await idle()
    },
  }
}

const GET = ['/api/secrets', undefined, undefined, undefined]
const post = (body: Record<string, unknown>) => ['/api/secrets', 'POST', '1', body]
const SAVED = meta({ name: 'MY_TOKEN', scope: 'session', target: ALPHA, targetName: 'Alpha', setAt: NOW })
const AFTER: SecretsView = { secrets: [...VIEW.secrets, SAVED] }

describe('live', () => {
  test('Save posts exactly the set; the value is gone at once, and nowhere on the page, in a toast or kept', async () => {
    const calls = answers([200, { ok: true, secret: SAVED }], [200, AFTER])
    const live = liveSecrets()
    await live.type('secret-name', 'MY_TOKEN')
    await live.click('A session')
    await live.choose('secret-session', ALPHA)
    await live.type('secret-value', MARKER)
    expect(live.pick('button[type="submit"]').textContent).toBe('Save')
    await live.submit()
    expect(sent(calls)).toEqual([
      post({ op: 'set', name: 'MY_TOKEN', scope: 'session', target: ALPHA, targetName: 'Alpha', value: MARKER }),
      GET,
    ])
    // Its own headers, as every POST of the board's.
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect([headers['x-board'], headers['content-type']]).toEqual(['1', 'application/json'])
    // The value: gone from the field, the page, the toasts and what the panel keeps.
    expect(live.pick('input[name="secret-value"]').value).toBe('')
    expect(live.html()).not.toContain(MARKER)
    expect(JSON.stringify(live.source.now.get())).not.toContain(MARKER)
    expect(live.toasts).toEqual([['Saved MY_TOKEN. It applies to new or restarted sessions.', false]])
    expect(JSON.stringify(live.toasts)).not.toContain(MARKER)
    // The list as the board sends it again; the place kept for the next one, the name cleared.
    expect(live.row(SAVED.id).textContent).toContain('MY_TOKEN')
    expect(live.source.now.get().form).toEqual({ name: '', scope: 'session', target: ALPHA, value: '' })
    expect(live.source.now.get().busy).toBe(false)
  })

  test('everywhere: target null, no session’s name', async () => {
    const calls = answers([200, { ok: true, secret: meta({ name: 'NEW_KEY' }) }], [200, VIEW])
    const live = liveSecrets()
    await live.type('secret-name', 'NEW_KEY')
    await live.type('secret-value', MARKER)
    await live.submit()
    expect(sent(calls)).toEqual([
      post({ op: 'set', name: 'NEW_KEY', scope: 'global', target: null, value: MARKER }),
      GET,
    ])
    expect(live.html()).not.toContain(MARKER)
  })

  test('a refusal: the board’s words toasted, never the value; the value gone, the rest kept', async () => {
    const error = t('secrets.err.scope')
    const calls = answers([409, { ok: false, error }], [200, VIEW])
    const live = liveSecrets()
    await live.type('secret-name', 'NEW_KEY')
    await live.click('A profile')
    await live.choose('secret-profile', 'work')
    await live.type('secret-value', MARKER)
    await live.submit()
    expect(sent(calls)).toEqual([
      post({ op: 'set', name: 'NEW_KEY', scope: 'profile', target: 'work', value: MARKER }),
      GET,
    ])
    expect(live.toasts).toEqual([['There is no such profile or session to set it for', true]])
    expect(live.pick('input[name="secret-value"]').value).toBe('')
    expect(live.html()).not.toContain(MARKER)
    expect(JSON.stringify(live.source.now.get())).not.toContain(MARKER)
    expect(live.source.now.get().form).toEqual({ name: 'NEW_KEY', scope: 'profile', target: 'work', value: '' })

    // No answer at all: the connection's words, never the value.
    answers(new Error('Failed to fetch'), [200, VIEW])
    const lost = liveSecrets()
    await lost.type('secret-name', 'NEW_KEY')
    await lost.type('secret-value', MARKER)
    await lost.submit()
    expect(lost.toasts).toHaveLength(1)
    expect(lost.toasts[0]?.[1]).toBe(true)
    expect(JSON.stringify(lost.toasts)).not.toContain(MARKER)
    expect(lost.html()).not.toContain(MARKER)
    expect(lost.pick('input[name="secret-value"]').value).toBe('')
  })

  test('a name the board would refuse is not sent', async () => {
    const calls = answers()
    const live = liveSecrets()
    await live.type('secret-name', 'PATH')
    await live.type('secret-value', MARKER)
    await live.submit()
    expect(calls).toEqual([])
    expect(live.pick('.access-problem').textContent).toBe(
      'PATH is read by the shell, Claude Code, herdr or the board itself: pick another name',
    )
  })

  test('Replace fills in its name and place, the value empty, and asks for the value field’s focus', async () => {
    answers()
    const live = liveSecrets()
    await live.type('secret-value', MARKER)
    await live.click('Replace', live.row(OWN.id))
    expect(live.source.now.get().form).toEqual({
      name: 'OPENAI_KEY',
      scope: 'session',
      target: ALPHA,
      targetName: 'Old name',
      value: '',
    })
    expect(live.source.now.get().focus).toBe(1)
    expect(live.pick('input[name="secret-name"]').value).toBe('OPENAI_KEY')
    expect(live.pick('select[name="secret-session"]').value).toBe(ALPHA)
    expect(live.pick('input[name="secret-value"]').value).toBe('')
    expect(live.pick('button[type="submit"]').textContent).toBe('Replace')
    expect(live.html()).not.toContain(MARKER)
    // A session's place gone from the board: still offered, by the name it had.
    await live.click('Replace', live.row(KEPT_NAME.id))
    expect(live.pick('select[name="secret-session"]').value).toBe(GONE)
    expect(live.source.now.get().focus).toBe(2)
  })

  test('Delete asks first; the second click sends rm with its id; leaving it takes the first back', async () => {
    const calls = answers([200, { ok: true }], [200, { secrets: [GLOBAL] }])
    const live = liveSecrets()
    const row = () => live.row(WORK.id)
    await live.click('Delete', row())
    expect(calls).toEqual([])
    expect(live.source.now.get().sure).toBe(WORK.id)
    // Left: asked no more.
    await live.blur('Delete? Click again', row())
    expect(live.source.now.get().sure).toBeNull()
    await live.click('Delete', row())
    await live.click('Delete? Click again', row())
    expect(sent(calls)).toEqual([post({ op: 'rm', id: WORK.id }), GET])
    expect(live.toasts).toEqual([
      ['Deleted GITHUB_TOKEN. Sessions running now may still have it until they restart.', false],
    ])
    expect(live.source.now.get().view).toEqual({ secrets: [GLOBAL] })

    // Refused: the board's words.
    const gone = answers([409, { ok: false, error: t('secrets.err.gone') }], [200, VIEW])
    const again = liveSecrets()
    await again.click('Delete', again.row(GLOBAL.id))
    await again.click('Delete? Click again', again.row(GLOBAL.id))
    expect(sent(gone)).toEqual([post({ op: 'rm', id: GLOBAL.id }), GET])
    expect(again.toasts).toEqual([['There is no such secret any more', true]])
  })
})

describe('the source', () => {
  const sourceOf = () => {
    const toasts: [string, boolean][] = []
    const source = secretsSource({
      t: () => t,
      toast: (text, error = false) => void toasts.push([text, error]),
      items: () => ITEMS,
    })
    return { source, toasts }
  }
  const idle = async () => {
    for (let i = 0; i < 6; i++) await Bun.sleep(0)
  }

  test('the list is asked on opening, not again while open; the value is dropped as the panel closes', async () => {
    const calls = answers([200, VIEW], [200, VIEW])
    const { source } = sourceOf()
    source.sync(true)
    source.sync(true)
    await idle()
    expect(sent(calls)).toEqual([GET])
    expect(calls[0]?.init?.cache).toBe('no-store')
    expect(source.now.get().view).toEqual(VIEW)
    source.edit({ name: 'KEEP', value: MARKER })
    source.arm(GLOBAL.id)
    source.sync(false)
    expect(source.now.get().form.value).toBe('')
    expect(source.now.get().form.name).toBe('KEEP')
    expect(source.now.get().sure).toBeNull()
    source.sync(true)
    await idle()
    expect(sent(calls)).toEqual([GET, GET])
  })

  test('a view the page cannot read is toasted, never drawn', async () => {
    answers([200, { secrets: [{ name: 'X', value: 'oops' }] }])
    const { source, toasts } = sourceOf()
    source.sync(true)
    await idle()
    expect(source.now.get().view).toBeNull()
    expect(toasts).toHaveLength(1)
    expect(JSON.stringify(toasts)).not.toContain('oops')
  })

  test('the panel’s code keeps no value: no browser storage, no log', () => {
    const root = join(import.meta.dir, '..', '..')
    for (const file of [
      'web/src/components/secrets/SecretsPanel.tsx',
      'web/src/hooks/useSecrets.ts',
      'web/src/models/secrets.ts',
    ]) {
      const code = readFileSync(join(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect([file, /localStorage|sessionStorage|state\/storage|console\.|pageLog/.test(code)]).toEqual([file, false])
    }
  })

  test('a scope picked anew forgets the place before', () => {
    const { source } = sourceOf()
    source.edit({ scope: 'session', target: ALPHA })
    source.edit({ scope: 'profile' })
    expect(source.now.get().form).toEqual({ ...EMPTY_FORM, scope: 'profile', target: null })
    source.edit({ target: 'work' })
    source.edit({ scope: 'profile' })
    expect(source.now.get().form.target).toBe('work')
  })
})

describe('Settings → Secrets…', () => {
  const now = {
    t,
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right' as const,
    sleepers: true,
    profiles: false,
  }
  const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))

  test('offered on the local board’s page and on the board’s own server; not on a remote page to a PC board', () => {
    // The local page (on a PC, or before the payload came).
    expect(offersSecrets(false, DATA())).toBe(true)
    expect(offersSecrets(false, null)).toBe(true)
    // The board's own server, reached through the domain's login.
    expect(offersSecrets(true, { server: true })).toBe(true)
    expect(offersSecrets(false, { server: true })).toBe(true)
    // A phone through Tailscale, or the domain's tunnel to a PC.
    expect(offersSecrets(true, DATA())).toBe(false)
    expect(offersSecrets(true, null)).toBe(false)
    expect(offersSecrets(true, undefined)).toBe(false)
  })

  test('the item after Remote access…; not asked for, the menu as it was; picked, it opens the panel', () => {
    expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, secrets: false }))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, profiles: true, mokupilot: true, access: true, secrets: true }))).toEqual([
      'theme',
      'lang',
      'panel',
      'profiles',
      'mokupilot',
      'access',
      'secrets',
      '—',
      'sleepers',
    ])
    expect(settingsMenu({ ...now, secrets: true })[3]).toEqual({ id: 'secrets', label: 'Secrets…' })
    expect(settingsMenu({ ...now, t: ru, secrets: true })[3]).toEqual({ id: 'secrets', label: 'Секреты…' })
    expect(settingPicked('secrets')).toEqual({ kind: 'secrets' })

    for (const offered of [false, true]) {
      let opened: readonly MenuEntry[] = []
      let pick = (_id: string): void => {}
      let panel = 0
      settingsMenuFrom({
        menu: {
          open: (items, options) => {
            opened = items
            pick = id => options.onPick?.(id, { id, label: '' })
          },
        },
        t: () => t,
        canEdit: () => true,
        languages: () => ({ en: 'English' }),
        dock: () => 'right',
        sleepers: () => true,
        root: () => ({ dataset: {} }),
        coarse: () => false,
        setTheme() {},
        chooseLanguage() {},
        placePanels() {},
        resetPanelSize() {},
        toggleSleepers() {},
        profiles: () => false,
        openProfiles() {},
        fold: () => null,
        chooseFold() {},
        secrets: () => offered,
        openSecrets: () => void panel++,
      })({ getBoundingClientRect: () => ({ right: 0, bottom: 0 }) } as unknown as HTMLElement, false)
      expect([offered, ids(opened).includes('secrets')]).toEqual([offered, offered])
      if (offered) pick('secrets')
      expect(panel).toBe(offered ? 1 : 0)
    }
  })

  test('every key the board translates its refusals with, in both languages', () => {
    for (const key of ['name', 'reserved', 'empty', 'nul', 'long', 'scope', 'gone', 'store']) {
      const id = `secrets.err.${key}`
      expect([id, t(id) !== id, ru(id) !== id, t(id) !== ru(id)]).toEqual([id, true, true, true])
    }
    expect(t('secrets.err.long', { most: 64 })).toBe('A value is 64 KB at most')
    expect(ru('secrets.err.long', { most: 64 })).toBe('Значение — не больше 64 КБ')
    expect(t('secrets.err.store')).toContain('web.log')
  })
})
