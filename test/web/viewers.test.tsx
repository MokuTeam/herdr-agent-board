// A file in one of the quick look's viewers (components/files/viewers.ts, #176): its session (the
// script imported, the file drawn, the viewer let go of when it fails or the look moves on), what
// the quick look draws for each state, and what went wrong reading a PDF.
import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import { ViewerShown } from '../../web/src/components/files/Preview.tsx'
import {
  openViewer,
  PDF_TEXTS,
  type ViewerReport,
  type ViewerState,
  viewerLook,
} from '../../web/src/components/files/viewers.ts'
import { failureOf } from '../../web/src/models/pdf-view.ts'
import { board, renderInBoard } from './support/board.tsx'
import { canonical } from './support/markup.ts'

const en = translator('en')

/** A module that comes when told to, a viewer that counts its endings, and the states said. */
function session() {
  let arrive: (m: string) => void = () => {}
  let refuse: (e: Error) => void = () => {}
  const states: ViewerState[] = []
  const mounted: string[] = []
  let destroyed = 0
  let report: ViewerReport | null = null
  let failAtOnce = false
  const stop = openViewer(
    () =>
      new Promise<string>((resolve, reject) => {
        arrive = resolve
        refuse = reject
      }),
    (module, r) => {
      mounted.push(module)
      report = r
      if (failAtOnce) r.fail('broken')
      return { destroy: () => void destroyed++ }
    },
    s => states.push(s),
  )
  return {
    stop,
    states,
    mounted,
    destroyed: () => destroyed,
    report: () => report as ViewerReport | null,
    arrive: async (m = 'viewer') => {
      arrive(m)
      await Promise.resolve()
      await Promise.resolve()
    },
    refuse: async () => {
      refuse(new Error('not built'))
      await Promise.resolve()
      await Promise.resolve()
    },
    failAtOnce: () => {
      failAtOnce = true
    },
  }
}

describe('a file in a viewer', () => {
  test('loading, then drawn; the look moving on lets go of the viewer once', async () => {
    const s = session()
    expect(s.states).toEqual([{ at: 'loading' }])
    await s.arrive()
    expect(s.mounted).toEqual(['viewer'])
    s.report()?.ready()
    expect(s.states.at(-1)).toEqual({ at: 'shown' })
    s.stop()
    s.stop()
    expect(s.destroyed()).toBe(1)
  })

  test('the look gone before the script came: nothing is drawn', async () => {
    const s = session()
    s.stop()
    await s.arrive()
    expect(s.mounted).toEqual([])
    expect(s.states).toEqual([{ at: 'loading' }])
  })

  test('a failure says why and lets go of the viewer (its worker with it) at once, even while mounting', async () => {
    const s = session()
    await s.arrive()
    s.report()?.fail('password')
    expect(s.states.at(-1)).toEqual({ at: 'failed', why: 'password' })
    expect(s.destroyed()).toBe(1)
    // Said once: a late "ready" or a stop changes nothing.
    s.report()?.ready()
    s.stop()
    expect(s.states.at(-1)).toEqual({ at: 'failed', why: 'password' })
    expect(s.destroyed()).toBe(1)

    const early = session()
    early.failAtOnce()
    await early.arrive()
    expect(early.states.at(-1)).toEqual({ at: 'failed', why: 'broken' })
    expect(early.destroyed()).toBe(1)
  })

  test('no script to import: no viewer', async () => {
    const s = session()
    await s.refuse()
    expect(s.states.at(-1)).toEqual({ at: 'unavailable' })
  })
})

describe('what the quick look draws for a viewer’s state', () => {
  const office = { password: 'ql.fileLocked', broken: 'ql.fileBroken', unavailable: 'ql.fileBroken' }

  test('loading over it, nothing more once drawn, why when not; a PDF with no viewer in a frame', () => {
    expect(viewerLook({ at: 'loading' }, PDF_TEXTS)).toEqual({ frame: false, wait: true, empty: null })
    expect(viewerLook({ at: 'shown' }, PDF_TEXTS)).toEqual({ frame: false, wait: false, empty: null })
    expect(viewerLook({ at: 'failed', why: 'password' }, PDF_TEXTS).empty).toBe('ql.pdfPassword')
    expect(viewerLook({ at: 'failed', why: 'broken' }, PDF_TEXTS).empty).toBe('ql.pdfBroken')
    expect(viewerLook({ at: 'failed', why: 'other' }, PDF_TEXTS).empty).toBe('ql.pdfBroken')
    expect(viewerLook({ at: 'unavailable' }, PDF_TEXTS)).toEqual({ frame: true, wait: false, empty: null })
    expect(viewerLook({ at: 'unavailable' }, office)).toEqual({ frame: false, wait: false, empty: 'ql.fileBroken' })
  })

  const drawn = (state: ViewerState) =>
    canonical(
      renderInBoard(
        <ViewerShown
          look={viewerLook(state, PDF_TEXTS)}
          host={createRef()}
          hostClass="ql-pdf"
          icon="pdf"
          src="/api/fs/raw?path=%2Fa.pdf&t=tok"
          name="a.pdf"
          onOpen={() => {}}
        />,
        board(),
      ),
    )

  test('a password or a broken file: said so, with the button that opens it; no viewer: the frame', () => {
    const locked = drawn({ at: 'failed', why: 'password' })
    expect(locked).toContain(en('ql.pdfPassword'))
    expect(locked).toContain('data-ql="open"')
    expect(locked).toContain('<div class="ql-pdf" hidden=""></div>')
    const broken = drawn({ at: 'failed', why: 'broken' })
    expect(broken).toContain(en('ql.pdfBroken'))
    expect(broken).toContain('data-ql="open"')
    const frame = drawn({ at: 'unavailable' })
    expect(frame).toContain(
      '<iframe class="ql-frame" src="/api/fs/raw?path=%2Fa.pdf&amp;t=tok" title="a.pdf"></iframe>',
    )
    expect(frame).not.toContain('ql-pdf')
    expect(drawn({ at: 'loading' })).toContain(`<div class="ql-wait">${en('loading')}</div>`)
  })

  test('what went wrong reading a PDF, by PDF.js’s exceptions', () => {
    expect(failureOf({ name: 'PasswordException', message: 'No password given' })).toBe('password')
    expect(failureOf({ name: 'InvalidPDFException', message: 'Invalid PDF structure.' })).toBe('broken')
    expect(failureOf({ name: 'ResponseException', message: '404' })).toBe('other')
    expect(failureOf(new Error('x'))).toBe('other')
    expect(failureOf(null)).toBe('other')
  })
})
