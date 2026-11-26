// A picture from a Team message opened full size inside the board's page (#873,
// components/files/PictureLook.tsx), and a file saved by the page itself (models/file-save.ts). On
// the phone's page a link that leaves the page goes without the login cookie (SameSite=Strict) and
// the board answers 401: there the thumbnail opens the picture over the panel, loaded by the page
// as the thumbnail is, and Download fetches the bytes and saves them as a blob. The board on the
// computer keeps its links as they were.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { PictureLookView, pictureFoot } from '../../web/src/components/files/PictureLook.tsx'
import { TeamFile } from '../../web/src/components/team/TeamFile.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { type SaveDeps, saveFile } from '../../web/src/models/file-save.ts'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { closePicture, pictureGone, pictureLook, pictureOpen, showPicture } from '../../web/src/state/picture-look.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

const URL_PNG = '/uploads/2026-11-11/120000-abcd1234-shot.png'
const URL_PDF = '/uploads/2026-11-11/1-spec.pdf'
const SHOT = { state: 'ready' as const, name: 'shot.png', size: 2048, url: URL_PNG }
const SPEC = { state: 'ready' as const, name: 'spec.pdf', size: 10, url: URL_PDF }

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const tags = (nodes: Node[], tag: string): Node[] => findAll(nodes, n => n.kind === 'element' && n.tag === tag)
const attr = (n: Node | undefined, name: string): unknown => (n?.kind === 'element' ? n.attrs.get(name) : undefined)

afterEach(() => pictureLook.set(null))

describe('the picture look as drawn', () => {
  test('nothing on show: hidden, no picture', () => {
    const out = renderInBoard(<PictureLookView picture={null} />, board())
    const layer = tags(out, 'div')[0]
    expect(layer?.kind === 'element' && layer.attrs.has('hidden')).toBe(true)
    expect(tags(out, 'img')).toEqual([])
  })

  test("a picture: a dialog named for it, the picture from the board's uploads address, Download and Close", () => {
    const out = renderInBoard(
      <PictureLookView
        picture={{ url: URL_PNG, name: 'shot.png', size: 2048 }}
        natural={{ width: 640, height: 480 }}
      />,
      board(),
    )
    const dialog = tags(out, 'section')[0]
    expect([attr(dialog, 'role'), attr(dialog, 'aria-modal')]).toEqual(['dialog', 'true'])
    expect(text(tags(out, 'h3'))).toBe('shot.png')
    const img = tags(out, 'img')
    expect(img.map(i => [attr(i, 'src'), attr(i, 'alt')])).toEqual([[URL_PNG, 'shot.png']])
    // Nothing in it leaves the page: no link at all.
    expect(tags(out, 'a')).toEqual([])
    expect(text(tags(out, 'button'))).toContain('Download')
    expect(text(tags(out, 'footer'))).toBe('640 × 480 · 2 KB')
  })

  test('the footer says what it knows', () => {
    expect(pictureFoot({ url: URL_PNG, name: 'a.png' }, null)).toBe('')
    expect(pictureFoot({ url: URL_PNG, name: 'a.png', size: 1536 }, null)).toBe('1.5 KB')
  })

  test('open, folding away, gone; one folding away turns around when opened again', () => {
    const p = { url: URL_PNG, name: 'shot.png' }
    showPicture(p)
    expect(pictureOpen()).toBe(true)
    closePicture()
    expect([pictureOpen(), pictureLook.get()?.closing]).toEqual([false, true])
    showPicture(p)
    expect(pictureOpen()).toBe(true)
    // Gone only once it folded away: a late end of an old close leaves an open one alone.
    pictureGone()
    expect(pictureOpen()).toBe(true)
    closePicture()
    pictureGone()
    expect(pictureLook.get()).toBeNull()
  })
})

describe('a file saved by the page itself', () => {
  function fakePage(reply: Response | Error) {
    const seen = {
      fetched: [] as [string, RequestInit][],
      clicked: [] as [string, string, boolean][],
      revoked: [] as string[],
    }
    const later: (() => void)[] = []
    const deps: SaveDeps = {
      fetch: async (url, init) => {
        seen.fetched.push([url, init])
        if (reply instanceof Error) throw reply
        return reply
      },
      document: {
        body: { append() {} } as unknown as HTMLElement,
        createElement: (() => {
          const a = {
            href: '',
            download: '',
            hidden: false,
            remove() {},
            click: () => seen.clicked.push([a.href, a.download, a.hidden]),
          }
          return a
        }) as unknown as Document['createElement'],
      },
      URL: { createObjectURL: () => 'blob:board/1', revokeObjectURL: url => void seen.revoked.push(url) },
      later: fn => void later.push(fn),
    }
    return { deps, seen, later }
  }

  test("fetched with the page's cookie, handed to the download as a blob named for the file, let go later", async () => {
    const { deps, seen, later } = fakePage(new Response('%PDF-1.7', { status: 200 }))
    expect(await saveFile(URL_PDF, 'spec.pdf', deps)).toBeNull()
    expect(seen.fetched).toEqual([[URL_PDF, { credentials: 'same-origin' }]])
    expect(seen.clicked).toEqual([['blob:board/1', 'spec.pdf', true]])
    expect(seen.revoked).toEqual([])
    for (const fn of later) fn()
    expect(seen.revoked).toEqual(['blob:board/1'])
  })

  test('a refusal or no connection says why and starts no download', async () => {
    const refused = fakePage(new Response('{"error":"login"}', { status: 401 }))
    expect(await saveFile(URL_PDF, 'spec.pdf', refused.deps)).toBe('HTTP 401')
    expect(refused.seen.clicked).toEqual([])
    const offline = fakePage(new Error('offline'))
    expect(await saveFile(URL_PDF, 'spec.pdf', offline.deps)).toBe('offline')
    expect(offline.seen.clicked).toEqual([])
  })
})

describe("a Team message's file", () => {
  const g = globalThis as Record<string, unknown>
  let saved: PropertyDescriptor | undefined
  let remote = false
  beforeAll(() => {
    saved = Object.getOwnPropertyDescriptor(g, 'document')
    Object.defineProperty(g, 'document', {
      value: { documentElement: { hasAttribute: (name: string) => remote && name === 'data-remote' } },
      configurable: true,
      writable: true,
    })
  })
  afterAll(() => {
    if (saved) Object.defineProperty(g, 'document', saved)
    else delete g.document
  })

  function anchors(file: Parameters<typeof TeamFile>[0]['file']): Host[] {
    let hosts: Host[] = []
    function Probe() {
      hosts = hostElements(<TeamFile file={file} />)
      return null
    }
    renderInBoard(<Probe />, board())
    return hosts.filter(h => h.tag === 'a')
  }

  test('on the computer: the links as they were, nothing taken over', () => {
    remote = false
    const [picture, name] = anchors(SHOT)
    expect([picture?.props.href, picture?.props.target, picture?.props.onClick]).toEqual([URL_PNG, '_blank', undefined])
    expect([name?.props.download, name?.props.onClick]).toEqual(['shot.png', undefined])
    const [doc] = anchors(SPEC)
    expect([doc?.props.href, doc?.props.download, doc?.props.onClick]).toEqual([URL_PDF, 'spec.pdf', undefined])
  })

  test("on the phone's page: the thumbnail opens the picture over the panel, and does not leave the page", () => {
    remote = true
    const [picture] = anchors(SHOT)
    let prevented = 0
    const from = { tag: 'a' }
    const look = picture?.props.onClick as (e: unknown) => void
    look({ preventDefault: () => void prevented++, currentTarget: from })
    expect(prevented).toBe(1)
    expect(pictureLook.get()).toEqual({ picture: { url: URL_PNG, name: 'shot.png', size: 2048 }, from, closing: false })
  })

  test("on the phone's page: Download fetches the file itself instead of following the link", async () => {
    remote = true
    const [, name] = anchors(SHOT)
    const [doc] = anchors(SPEC)
    for (const a of [name, doc]) expect(typeof a?.props.onClick).toBe('function')
    const calls: string[] = []
    const real = g.fetch
    g.fetch = async (url: string) => {
      calls.push(url)
      return new Response('{"error":"login"}', { status: 401 })
    }
    try {
      let prevented = 0
      const save = doc?.props.onClick as (e: unknown) => void
      save({ preventDefault: () => void prevented++ })
      await Bun.sleep(5)
      expect([prevented, calls]).toEqual([1, [URL_PDF]])
    } finally {
      g.fetch = real
    }
  })
})

describe('the picture look in the page', () => {
  const dom = new JSDOM('<!doctype html><html data-remote><body><div id="root"></div></body></html>', {
    url: 'https://board.example.com/',
  })
  const g = globalThis as Record<string, unknown>
  const KEYS = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
  ] as const
  const OWN = [
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'addEventListener',
    'removeEventListener',
    'innerHeight',
  ] as const
  const saved = new Map<string, PropertyDescriptor | undefined>()
  let frames: ((now: number) => void)[] = []
  let clock = 1000

  beforeAll(() => {
    const win = dom.window as unknown as Record<string, unknown>
    for (const k of [...KEYS, ...OWN, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
    for (const k of KEYS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
    g.IS_REACT_ACT_ENVIRONMENT = true
    const define = (k: string, value: unknown) =>
      Object.defineProperty(g, k, { value, configurable: true, writable: true })
    define('requestAnimationFrame', (fn: (now: number) => void) => frames.push(fn))
    define('cancelAnimationFrame', () => {})
    define('addEventListener', dom.window.addEventListener.bind(dom.window))
    define('removeEventListener', dom.window.removeEventListener.bind(dom.window))
    define('innerHeight', 800)
  })
  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d)
      else delete g[k]
    }
  })

  /** The springs run to rest, a frame at a time. */
  function settle(): void {
    for (let i = 0; i < 600 && frames.length; i++) {
      const due = frames
      frames = []
      clock += 16
      for (const fn of due) fn(clock)
    }
  }

  test('the thumbnail opens it over the panel; Esc folds it away and it is gone', async () => {
    const { createRoot } = await import('react-dom/client')
    const { PictureLook } = await import('../../web/src/components/files/PictureLook.tsx')
    const host = dom.window.document.getElementById('root') as HTMLElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board()}>
            <TeamFile file={SHOT} />
            <PictureLook />
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
    const look = () => dom.window.document.querySelector<HTMLElement>('body > .picture-look')
    expect(look()?.hidden).toBe(true)
    const thumb = host.querySelector('a[target="_blank"]') as HTMLAnchorElement
    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => {
      thumb.dispatchEvent(click)
    })
    // The click stayed in the page: no tab, no navigation.
    expect(click.defaultPrevented).toBe(true)
    await act(async () => settle())
    expect(look()?.hidden).toBe(false)
    expect(look()?.querySelector('img')?.getAttribute('src')).toBe(URL_PNG)
    expect(look()?.querySelector('h3')?.textContent).toBe('shot.png')
    expect(look()?.querySelector<HTMLElement>('.ql-win')?.style.opacity).toBe('1')
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    })
    expect(pictureLook.get()?.closing).toBe(true)
    await act(async () => settle())
    expect(pictureLook.get()).toBeNull()
    expect(look()?.hidden).toBe(true)
    await act(async () => root.unmount())
  })
})
