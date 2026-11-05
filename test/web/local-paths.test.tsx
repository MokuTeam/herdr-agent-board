// The board seen from another device (web/src/models/local-paths.ts): where a server file is on
// this computer through its shared drive, what each system starts from, the list kept in the
// browser, and the quick look's Download and "Copy path on this computer" (none at the computer).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { translator } from '../../src/core/i18n/translator.ts'
import { QuickLookView } from '../../web/src/components/files/QuickLook.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import {
  devicePlatform,
  downloadUrl,
  localPath,
  mapsOf,
  type PathMap,
  remoteTools,
  suggestedMaps,
} from '../../web/src/models/local-paths.ts'
import type { LookView } from '../../web/src/models/quick-look.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'

const WIN: PathMap[] = [{ server: '/data/work', local: 'Z:\\' }]
const MAC: PathMap[] = [{ server: '/data/work', local: '/Volumes/work' }]

describe('a server path on this computer', () => {
  test('Windows: the drive, backslashes all the way, spaces and other alphabets kept', () => {
    expect(localPath('/data/work/proj/src/a.ts', WIN)).toBe('Z:\\proj\\src\\a.ts')
    expect(localPath('/data/work/Отчёт за май/план 100%.md', WIN)).toBe('Z:\\Отчёт за май\\план 100%.md')
    expect(localPath('/data/work', WIN)).toBe('Z:\\')
    expect(localPath('/data/work/', WIN)).toBe('Z:\\')
    // A drive written without its backslash, or a share.
    expect(localPath('/data/work/a.txt', [{ server: '/data/work', local: 'Z:' }])).toBe('Z:\\a.txt')
    expect(localPath('/data/work/a/b.txt', [{ server: '/data/work', local: '\\\\dell\\work\\' }])).toBe(
      '\\\\dell\\work\\a\\b.txt',
    )
  })

  test('macOS: the mounted volume, slashes', () => {
    expect(localPath('/data/work/proj/a.ts', MAC)).toBe('/Volumes/work/proj/a.ts')
    expect(localPath('/data/work', MAC)).toBe('/Volumes/work')
    expect(localPath('/data/work/a b/ü.txt', [{ server: '/data/work/', local: '/Volumes/work/' }])).toBe(
      '/Volumes/work/a b/ü.txt',
    )
  })

  test('the longest folder wins, whatever the order', () => {
    const maps: PathMap[] = [
      { server: '/data/work', local: 'Z:\\' },
      { server: '/data/work/media', local: 'M:\\' },
    ]
    expect(localPath('/data/work/media/clip.mp4', maps)).toBe('M:\\clip.mp4')
    expect(localPath('/data/work/media/clip.mp4', [...maps].reverse())).toBe('M:\\clip.mp4')
    expect(localPath('/data/work/mediaX/clip.mp4', maps)).toBe('Z:\\mediaX\\clip.mp4')
  })

  test('whole names only: /data/work does not take /data/workshop', () => {
    expect(localPath('/data/workshop/a.txt', WIN)).toBeNull()
    expect(localPath('/data/work-old/a.txt', MAC)).toBeNull()
    expect(localPath('/data/wor', MAC)).toBeNull()
  })

  test('no folder takes it, or none is kept: no path here', () => {
    expect(localPath('/home/me/a.txt', WIN)).toBeNull()
    expect(localPath('/data/work/a.txt', [])).toBeNull()
    // Rows half filled in the panel count for nothing.
    expect(localPath('/data/work/a.txt', [{ server: '/data/work', local: '' }])).toBeNull()
    expect(localPath('/data/work/a.txt', [{ server: '', local: 'Z:\\' }])).toBeNull()
  })
})

test('what each system starts from: Z:\\ on Windows, /Volumes/work on a Mac, nothing on a phone', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36'
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15'
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'
  expect(devicePlatform({ userAgent: win })).toBe('windows')
  expect(devicePlatform({ userAgent: mac })).toBe('mac')
  expect(devicePlatform({ userAgent: '', userAgentData: { platform: 'Windows' } })).toBe('windows')
  expect(devicePlatform({ userAgent: iphone })).toBe('other')
  expect(devicePlatform({ userAgent: android })).toBe('other')
  expect(devicePlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('other')
  expect(suggestedMaps('windows')).toEqual(WIN)
  expect(suggestedMaps('mac')).toEqual(MAC)
  expect(suggestedMaps('other')).toEqual([])
})

test('the list kept in the browser: none, or one that cannot be read, is the suggestion’s turn', () => {
  expect(mapsOf(null)).toBeNull()
  expect(mapsOf('not json')).toBeNull()
  expect(mapsOf('{"server":"/x"}')).toBeNull()
  expect(mapsOf('[]')).toEqual([])
  expect(mapsOf(JSON.stringify([...WIN, { server: 3 }, null]))).toEqual(WIN)
})

describe('the quick look on another device', () => {
  const file = { path: '/data/work/a b.zip', name: 'a b.zip', exists: true, dir: false, kind: 'file', line: null }

  test('a file there downloads and, inside a kept folder, has a path here', () => {
    expect(remoteTools(file, WIN, 'tok')).toEqual({
      download: '/api/fs/download?path=%2Fdata%2Fwork%2Fa%20b.zip&t=tok',
      local: 'Z:\\a b.zip',
    })
    expect(downloadUrl('/x/Отчёт.pdf', null)).toBe(`/api/fs/download?path=${encodeURIComponent('/x/Отчёт.pdf')}&t=`)
  })

  test('outside the kept folders: Download only; a folder: its path here only; missing: neither', () => {
    expect(remoteTools({ ...file, path: '/home/me/a.zip' }, WIN, 't')).toEqual({
      download: '/api/fs/download?path=%2Fhome%2Fme%2Fa.zip&t=t',
      local: null,
    })
    expect(remoteTools({ ...file, dir: true, path: '/data/work/proj' }, MAC, 't')).toEqual({
      download: null,
      local: '/Volumes/work/proj',
    })
    expect(remoteTools({ ...file, error: 'missing' }, WIN, 't')).toEqual({ download: null, local: null })
    expect(remoteTools(null, WIN, 't')).toEqual({ download: null, local: null })
  })

  test('at the computer (no list): neither, as before', () => {
    expect(remoteTools(file, null, 't')).toEqual({ download: null, local: null })
  })

  const view = (data: typeof file): LookView => ({
    hidden: false,
    closing: false,
    depth: 1,
    top: { kind: 'file', path: data.path, line: null },
    head: { kind: data.kind, name: data.name, path: data.path },
    drawn: 1,
    data,
    loading: false,
    mode: 'view',
  })
  const draw = (local: PathMap[] | null, data = file, lang = 'en') =>
    renderToStaticMarkup(
      <I18nProvider lang={lang}>
        <QuickLookView view={view(data)} canEdit token="tok" local={local} />
      </I18nProvider>,
    )

  test('drawn: Download as a link to save, the path-here button with its label, in English and Russian', () => {
    const html = draw(WIN)
    expect(html).toContain(
      'class="icon-button ql-download" href="/api/fs/download?path=%2Fdata%2Fwork%2Fa%20b.zip&amp;t=tok" download=""',
    )
    expect(html).toContain('aria-label="Download"')
    expect(html).toContain('class="icon-button ql-local" title="Copy path on this computer"')
    const ru = draw(WIN, file, 'ru')
    expect(ru).toContain('aria-label="Скачать"')
    expect(ru).toContain('aria-label="Скопировать путь на этом компьютере"')
  })

  test('drawn: no kept folder takes it, no path-here button; at the computer, neither', () => {
    const outside = draw(WIN, { ...file, path: '/data/workshop/a.zip' })
    expect(outside).toContain('ql-download')
    expect(outside).not.toContain('ql-local')
    const home = draw(null)
    expect(home).not.toContain('ql-download')
    expect(home).not.toContain('ql-local')
  })
})

test('Settings offers Paths on this computer… only on the board seen from another device', () => {
  const now = {
    t: translator('en'),
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right' as const,
    sleepers: true,
    profiles: false,
  }
  const ids = (items: ReturnType<typeof settingsMenu>) => items.map(i => ('id' in i ? i.id : '—'))
  expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
  expect(ids(settingsMenu({ ...now, phones: true, localPaths: true }))).toEqual([
    'theme',
    'lang',
    'panel',
    'phones',
    'localPaths',
    '—',
    'sleepers',
  ])
  expect(settingsMenu({ ...now, t: translator('ru'), localPaths: true })[3]).toEqual({
    id: 'localPaths',
    label: 'Пути на этом компьютере…',
  })
  expect(settingPicked('localPaths')).toEqual({ kind: 'localPaths' })
})

test('a browser that keeps nothing (storage refused): the list still changes for this visit', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError')
    },
  })
  try {
    const { keepLocalPaths, localPaths } = await import('../../web/src/state/local-paths.ts')
    expect(Array.isArray(localPaths().get())).toBe(true)
    keepLocalPaths(MAC)
    expect(localPaths().get()).toEqual(MAC)
    expect(localPath('/data/work/x', localPaths().get())).toBe('/Volumes/work/x')
  } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
})
