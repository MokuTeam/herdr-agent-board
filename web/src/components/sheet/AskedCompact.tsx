// The open question under "Needs me" in the compact sheet (#345): what it asks cut to two lines, with
// the button that waves it off always under it, and a tap on the text opens it whole (the same spring
// the other folds use) and a second tap closes it. A short question that fits has nothing to open.
// The whole banner is Sheet.tsx's `Asked` while the head is whole.
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useCollapse } from '../../hooks/useCollapse.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { askedView } from '../../models/sheet.ts'
import { CheckGlyph, ChevronGlyph } from '../icons.tsx'

/**
 * Whether the text, folded to its two lines, is cut: looked at again when the banner's size changes (a
 * wider panel, a phone turned). The banner is what is watched, not the text: the text moves into a
 * button once it is cut, and an element that left the page is reported at 0 by 0.
 */
function useCut(
  banner: RefObject<HTMLElement | null>,
  text: RefObject<HTMLElement | null>,
  folded: boolean,
  said: string,
): boolean {
  const [cut, setCut] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: what it says is when to look again
  useLayoutEffect(() => {
    const box = banner.current
    if (!box) return
    const look = () => {
      const el = text.current
      // Only the folded text says anything: not one open, on its way (data-moving) or gone.
      if (!el?.isConnected || !folded || el.hasAttribute('data-moving')) return
      setCut(el.scrollHeight > el.clientHeight + 1)
    }
    look()
    if (typeof ResizeObserver !== 'function') return
    const watch = new ResizeObserver(look)
    watch.observe(box)
    return () => watch.disconnect()
  }, [banner, text, folded, said])
  return cut
}

export function AskedCompact({
  item,
  disabled,
  onDismiss,
}: {
  item: Item
  disabled: boolean
  onDismiss?: (() => void) | undefined
}) {
  const t = useT()
  const asked = askedView(item, t)
  const said = `${asked.why}\n${asked.text}`
  // Each question opens folded: a new one, or another session's, starts at its two lines.
  const [opened, setOpened] = useState({ for: said, open: false })
  const open = opened.for === said && opened.open
  const banner = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useCollapse(text, !open, { fade: false })
  const cut = useCut(banner, text, !open, said)
  const body = (
    <span className="asked-clip" ref={text} data-folded={open ? undefined : ''}>
      <b>{asked.why}</b>
      {asked.text}
    </span>
  )
  return (
    <div className="asked asked-compact" ref={banner}>
      {cut || open ? (
        <button
          type="button"
          className="asked-text asked-toggle"
          aria-expanded={open}
          title={t(open ? 'asked.less' : 'asked.more')}
          onClick={() => setOpened({ for: said, open: !open })}
        >
          {body}
          <ChevronGlyph />
        </button>
      ) : (
        <div className="asked-text">{body}</div>
      )}
      {asked.dismiss && (
        <button
          type="button"
          className="button asked-dismiss"
          data-act="dismiss"
          disabled={disabled}
          onClick={() => onDismiss?.()}
        >
          <CheckGlyph />
          <span>{asked.dismiss}</span>
        </button>
      )}
    </div>
  )
}
