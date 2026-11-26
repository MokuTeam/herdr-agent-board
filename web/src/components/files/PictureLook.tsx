// A picture from a Team message, full size inside the board's own page (#873). On the phone's page
// (the owner's domain, or Tailscale), a picture opened in a tab of its own leaves the page: the
// installed app hands it to the system's browser view, that navigation goes without the login
// cookie (SameSite=Strict) and the board answers 401. Here the page loads it itself, as it loads
// the thumbnail. It looks and moves as the quick look does (hooks/useQuickLook.ts): it grows out of
// the thumbnail and folds back into it on a spring that can be caught midway, dims the board and
// takes the focus, and Esc, the dimmed board, the close button and the phone's Back
// (useDialogHistory, in the quick look's layer) close it; the picture zooms
// (components/files/zoom.ts). Download saves the bytes the page fetched (models/file-save.ts),
// again without leaving the page. What is on show is state/picture-look.ts.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLatest } from '../../hooks/useLatest.ts'
import { useModalFocus } from '../../hooks/useModalFocus.ts'
import { measureFrom } from '../../hooks/useQuickLook.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { saveFile } from '../../models/file-save.ts'
import { FROM_BELOW, type GrowFrom, paintWindow } from '../../models/grow.ts'
import { reducedMotion, Spring } from '../../models/spring.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { closePicture, type Picture, pictureGone, pictureLook } from '../../state/picture-look.ts'
import { useStore } from '../../state/store.ts'
import { fileSize } from '../team/TeamFile.tsx'
import { FileIcon } from './FileChip.tsx'
import { LookEmpty } from './Preview.tsx'
import { type ImageZoom, zoomImage } from './zoom.ts'

export interface PictureRefs {
  /** A direct child of <body> (useModalFocus makes the rest of the page inert). */
  layer?: RefObject<HTMLDivElement | null>
  win?: RefObject<HTMLElement | null>
  scrim?: RefObject<HTMLDivElement | null>
}

export interface PictureLookViewProps {
  picture: Picture | null
  /** The picture's own size once it loaded, for the footer. */
  natural?: { width: number; height: number } | null
  refs?: PictureRefs
  onClose?: () => void
  onSave?: () => void
  onImage?: (img: HTMLImageElement) => void
  /** The picture did not load (gone from the uploads, the login ended). */
  failed?: boolean
  onFailed?: () => void
}

/** The footer: the picture's own size once it loaded, and how big the file is. */
export function pictureFoot(picture: Picture, natural: { width: number; height: number } | null): string {
  return [
    natural ? `${natural.width} × ${natural.height}` : null,
    picture.size !== undefined ? fileSize(picture.size) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function PictureLookView({
  picture,
  natural = null,
  refs = {},
  onClose,
  onSave,
  onImage,
  failed = false,
  onFailed,
}: PictureLookViewProps) {
  const t = useT()
  const label = (key: string) => ({ title: t(key), 'aria-label': t(key) })
  return (
    <div className="ql picture-look" hidden={!picture} ref={refs.layer}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the dimmed board around it closes it with a click; Esc does with keys */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
      <div className="ql-scrim" ref={refs.scrim} onClick={() => onClose?.()} />
      <section
        className="ql-win"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picture-look-name"
        tabIndex={-1}
        ref={refs.win}
      >
        <header className="ql-head">
          {/* No steps to walk back: the phone's head lays out as the quick look's first step does (app.css). */}
          <span className="ql-back" hidden />
          <span className="ql-icon">
            <FileIcon name="image" />
          </span>
          <div className="ql-titles">
            <h3 id="picture-look-name">{picture?.name ?? ''}</h3>
          </div>
          <div className="ql-tools">
            <button type="button" className="button primary picture-save" onClick={() => onSave?.()}>
              {t('team.file.open')}
            </button>
          </div>
          <button type="button" className="icon-button ql-close" {...label('sheet.close')} onClick={() => onClose?.()}>
            <FileIcon name="close" />
          </button>
        </header>
        <div className="ql-body k-image">
          {picture && failed && <LookEmpty icon="missing" text={t('team.file.notLoaded')} />}
          {picture && !failed && (
            <div className="ql-media ql-stage">
              <img
                key={picture.url}
                className="checker"
                src={picture.url}
                alt={picture.name}
                onLoad={e => onImage?.(e.currentTarget)}
                onError={() => onFailed?.()}
              />
            </div>
          )}
        </div>
        <footer className="ql-foot look-foot">
          <span className="look-foot-text">{picture ? pictureFoot(picture, natural) : ''}</span>
        </footer>
      </section>
    </div>
  )
}

/** The page's picture look, in <body> beside the page. */
export function PictureLook() {
  const t = useT()
  const { toast } = useBoardContext()
  const state = useStore(pictureLook)
  const [refs] = useState(() => ({
    layer: { current: null as HTMLDivElement | null },
    win: { current: null as HTMLElement | null },
    scrim: { current: null as HTMLDivElement | null },
  }))
  const focus = useModalFocus(refs.layer, refs.win)
  const latest = useLatest({ focus, state, t, toast })
  const [natural, setNatural] = useState<{ url: string; width: number; height: number } | null>(null)
  /** The address of a picture that did not load. */
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // The picture's zoom, once it loaded: a new picture and the close drop it.
  const [zoom] = useState(() => {
    let control: ImageZoom | null = null
    return {
      take(next: ImageZoom): void {
        control?.destroy()
        control = next
      },
      drop(): void {
        control?.destroy()
        control = null
      },
      key: (e: KeyboardEvent): boolean => control?.key(e) ?? false,
    }
  })
  const from = useRef<GrowFrom>(FROM_BELOW)
  /** The picture it last grew for: a draw of the same one does not grow it again. */
  const grown = useRef<Picture | null>(null)

  // p: 0 = folded into the thumbnail, 1 = open. A close while it opens turns around from wherever it is.
  const [motion] = useState(
    () =>
      new Spring({
        value: 0,
        damping: 1,
        response: 0.34,
        precision: 0.002,
        onUpdate: v => paintWindow(refs.win.current, refs.scrim.current, v, from.current),
        onRest: v => {
          if (v !== 0) return
          zoom.drop()
          grown.current = null
          latest.current.focus.close()
          pictureGone()
        },
      }),
  )
  // Gone with the page (the login ended, RemoteGate took the board away): nothing stays open for the next one.
  useEffect(
    () => () => {
      motion.stop()
      pictureLook.set(null)
    },
    [motion],
  )

  const picture = state?.picture ?? null
  // Drawn, then it grows out of the thumbnail; asked to close, it folds back into it.
  useLayoutEffect(() => {
    const win = refs.win.current
    if (!state || !win) return
    if (state.closing) {
      from.current = measureFrom(win, state.from)
      motion.to(0, { damping: 1, response: 0.26 })
      if (reducedMotion.matches) motion.set(0)
      return
    }
    if (grown.current === state.picture) return
    // Turned around midway to the same picture: its zoom stays, as its image does.
    if (grown.current && grown.current.url !== state.picture.url) zoom.drop()
    grown.current = state.picture
    from.current = measureFrom(win, state.from)
    if (motion.value <= 0.001) paintWindow(win, refs.scrim.current, 0, from.current)
    motion.to(1, { damping: 1, response: 0.34 })
    latest.current.focus.open(state.from ?? document.activeElement)
  }, [state, motion, refs, latest, zoom])

  // Before the page's own keys (capture on the window): Esc closes it, + − 0 and the arrows zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = latest.current.state
      if (!s || s.closing || !latest.current.focus.isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        closePicture()
      } else if (zoom.key(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [latest, zoom])

  const onImage = (img: HTMLImageElement) => {
    const stage = img.parentElement
    if (!img.isConnected || !stage || !img.naturalWidth || !img.naturalHeight) return
    zoom.take(zoomImage(stage, img, { size: { w: img.naturalWidth, h: img.naturalHeight } }))
    setNatural({ url: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight })
  }

  const onSave = async () => {
    const p = latest.current.state?.picture
    if (!p) return
    const why = await saveFile(p.url, p.name)
    if (why) latest.current.toast(latest.current.t('team.file.saveFailed', { name: p.name, why }), true)
  }

  if (typeof document === 'undefined') return null
  const shownSize = natural && picture && natural.url.endsWith(picture.url) ? natural : null
  return createPortal(
    <PictureLookView
      picture={picture}
      natural={shownSize}
      refs={refs}
      onClose={closePicture}
      onSave={() => void onSave()}
      onImage={onImage}
      failed={!!picture && failedUrl === picture.url}
      onFailed={() => setFailedUrl(picture?.url ?? null)}
    />,
    document.body,
  )
}
