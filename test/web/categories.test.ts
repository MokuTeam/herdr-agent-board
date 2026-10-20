// The categories editor's rules (web/app.js "categories": slug, createDraft, renderDraft's color,
// updateCatRow, the list's click, keydown and focusout handlers), as pure functions. `slug` is also
// held against the old function itself over a small corpus.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardCategory, Swatch } from '../../src/core/payload.ts'
import {
  categoryCounts,
  confirmText,
  draftCategory,
  draftColor,
  laneSuggestions,
  renamed,
  rowText,
  slug,
  swatchPressed,
  withoutPath,
  withPath,
} from '../../web/src/models/categories.ts'
import { item } from './support/board.tsx'
import { oldCode, oldFunction } from './support/old-app.ts'

const t = translator('en')

const cat = (fields: Partial<BoardCategory> & Pick<BoardCategory, 'id'>): BoardCategory => ({
  title: fields.id,
  color: '#007AFF',
  colorName: 'blue',
  paths: [],
  configured: true,
  fallback: false,
  ...fields,
})

describe('slug: a latin id agents can type', () => {
  test('pinned from the old function', () => {
    expect(slug('Новый клиент')).toBe('novyy-klient')
    expect(slug('Acme Corp!')).toBe('acme-corp')
  })

  test('the same as web/app.js slug over a corpus (Cyrillic, ё/ъ/ь, digits, symbols, long titles)', () => {
    const old = oldFunction(oldCode('web/app.js', ['TRANSLIT', 'slug'], {}), 'slug')
    const corpus = [
      'Ромашка',
      'Новый клиент',
      'Acme Corp!',
      'Щука и ёжик',
      'Объявление: подъезд №5',
      'ЮЛЯ & Я',
      '  --Hello__World--  ',
      'Café déjà vu',
      'v2.0 release',
      'Съешь же ещё этих мягких французских булок, да выпей чаю',
      '',
      '!!!',
      '123',
      'a'.repeat(40),
    ]
    for (const s of corpus) expect(slug(s)).toBe(String(old(s)))
  })
})

describe('the "new category" form', () => {
  test('nothing typed: nothing to create (the title takes the focus)', () => {
    expect(draftCategory('', '')).toBe(null)
    expect(draftCategory('   ', '  ')).toBe(null)
  })

  test('a title alone: its slug is the id', () => {
    expect(draftCategory('  Новый клиент ', '')).toEqual({ id: 'novyy-klient', title: 'Новый клиент' })
  })

  test('an id typed by hand wins; an id alone is the title too', () => {
    expect(draftCategory('Acme Corp', ' acme ')).toEqual({ id: 'acme', title: 'Acme Corp' })
    expect(draftCategory('', 'ops')).toEqual({ id: 'ops', title: 'ops' })
  })

  test('a title with no latin letters or digits goes with an empty id, as before (the server says no)', () => {
    expect(draftCategory('!!!', '')).toEqual({ id: '', title: '!!!' })
  })

  const swatches: Swatch[] = [
    { name: 'blue', hex: '#007AFF' },
    { name: 'green', hex: '#34C759' },
    { name: 'orange', hex: '#FF9500' },
  ]

  test('its color: the first swatch no category has yet', () => {
    const categories = [cat({ id: 'a', colorName: 'blue' }), cat({ id: 'b', colorName: 'green' })]
    expect(draftColor(categories, swatches)).toEqual({ name: 'orange', hex: '#FF9500' })
  })

  test('every swatch taken, or none known: blue, in the accent color when blue is not a swatch', () => {
    const all = swatches.map((s, i) => cat({ id: String(i), colorName: s.name }))
    expect(draftColor(all, swatches)).toEqual({ name: 'blue', hex: '#007AFF' })
    expect(draftColor([], [])).toEqual({ name: 'blue', hex: 'var(--accent)' })
  })
})

describe('a row', () => {
  test('its texts: the sessions in it, its id (an agent’s own lane says so)', () => {
    expect(rowText(cat({ id: 'proj' }), 2, t)).toEqual({ count: '2 sessions', id: 'proj' })
    expect(rowText(cat({ id: 'proj' }), 0, t)).toEqual({ count: 'empty', id: 'proj' })
    expect(rowText(cat({ id: 'x', configured: false }), 1, t)).toEqual({
      count: '1 session',
      id: 'x · made by an agent, not in the settings',
    })
  })

  test('sessions per lane, with the cards the user moved and the server has not confirmed', () => {
    const items = [item({ key: 'a', category: 'p' }), item({ key: 'b', category: 'p' }), item({ key: 'c' })]
    const counts = categoryCounts(items, it => (it.key === 'b' ? 'q' : it.category))
    expect([...counts]).toEqual([
      ['p', 1],
      ['q', 1],
      ['other', 1],
    ])
  })

  test('a title left: saved when the lane is configured and the trimmed title is new', () => {
    const c = cat({ id: 'p', title: 'Project' })
    expect(renamed(c, '  Project X ')).toBe('Project X')
    expect(renamed(c, 'Project')).toBe(null)
    expect(renamed(c, '   ')).toBe(null)
    expect(renamed(cat({ id: 'x', title: 'X', configured: false }), 'Y')).toBe(null)
    expect(renamed(undefined, 'Y')).toBe(null)
  })

  test('folders: typed as they are, Windows and POSIX alike; one removed by its exact text', () => {
    const c = cat({ id: 'p', paths: ['C:\\work\\acme'] })
    expect(withPath(c, '  D:\\clients\\new  ')).toEqual(['C:\\work\\acme', 'D:\\clients\\new'])
    expect(withPath(c, '/home/me/acme/')).toEqual(['C:\\work\\acme', '/home/me/acme/'])
    expect(withPath(c, '~/src')).toEqual(['C:\\work\\acme', '~/src'])
    expect(withPath(c, '\\\\server\\share\\x')).toEqual(['C:\\work\\acme', '\\\\server\\share\\x'])
    expect(withPath(c, '   ')).toBe(null)
    expect(withoutPath(cat({ id: 'p', paths: ['C:\\a', '/b', 'C:\\a\\b'] }), 'C:\\a')).toEqual(['/b', 'C:\\a\\b'])
  })

  test('a folder the lane has already, however it is written, is not added twice', () => {
    const c = cat({ id: 'p', paths: ['C:\\work\\acme', '/home/me/src'] })
    for (const typed of ['C:\\work\\acme', ' c:/Work/ACME/ ', 'C:\\work\\acme\\', '/home/me/src/'])
      expect([typed, withPath(c, typed)]).toEqual([typed, null])
    // A folder inside one it has is another folder.
    expect(withPath(c, 'C:\\work\\acme\\web')).toEqual(['C:\\work\\acme', '/home/me/src', 'C:\\work\\acme\\web'])
  })

  test('the first click on delete asks, saying how many sessions then go by folder', () => {
    expect(confirmText(0, t)).toBe('Delete?')
    expect(confirmText(1, t)).toBe('Delete? 1 session goes by folder')
    expect(confirmText(3, t)).toBe('Delete? 3 sessions go by folder')
  })

  test('the swatch of its color is pressed, by name or by hex', () => {
    const blue = { name: 'blue', hex: '#007AFF' }
    expect(swatchPressed(blue, cat({ id: 'p', colorName: 'blue' }))).toBe(true)
    expect(swatchPressed(blue, cat({ id: 'p', colorName: '#007aff' }))).toBe(true)
    expect(swatchPressed(blue, cat({ id: 'p', colorName: 'green' }))).toBe(false)
  })
})

describe('a lane’s "+ folder" offers, while it is empty', () => {
  const acme = cat({ id: 'acme', paths: ['C:\\Work\\acme'] })

  test('folders of the lane’s sessions first, newest first, then recent ones, then the board’s others; none the lane has', () => {
    const sessions = [
      { cwd: 'C:\\Work\\acme', category: 'acme', activity: 50 },
      { cwd: '/srv/web', category: 'web', activity: 60 },
      { cwd: 'C:\\Work\\acme-web', category: 'acme', activity: 40 },
      { cwd: 'D:\\old\\acme', category: 'acme', activity: 10 },
    ]
    const recent = ['C:\\Work\\beta', 'c:/work/acme/', 'C:\\Users\\me\\AppData\\Local\\Temp\\scratch', '/srv/web']
    expect(laneSuggestions(acme, { sessions, recent })).toEqual([
      { path: 'C:\\Work\\acme-web', why: 'session' },
      { path: 'D:\\old\\acme', why: 'session' },
      { path: 'C:\\Work\\beta', why: 'recent' },
      { path: '/srv/web', why: 'recent' },
    ])
  })

  test('ten at most, once the lane’s own are left out; nothing known, nothing offered', () => {
    const sessions = Array.from({ length: 14 }, (_, i) => ({
      cwd: i < 3 ? 'C:\\Work\\acme' : `C:\\Work\\s${i}`,
      category: 'acme',
      activity: 100 - i,
    }))
    const offered = laneSuggestions(acme, { sessions, recent: [] })
    expect(offered.map(x => x.path)).toEqual(Array.from({ length: 10 }, (_, i) => `C:\\Work\\s${i + 3}`))
    expect(laneSuggestions(cat({ id: 'web', paths: ['/srv/web'] }), { sessions: [], recent: [] })).toEqual([])
  })
})
