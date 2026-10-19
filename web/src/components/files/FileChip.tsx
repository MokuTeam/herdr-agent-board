// A path in the chat once the server found it on disk: its kind's icon and its name (a link keeps
// its own words). The chat's Markdown is HTML the board made (models/markdown.ts), so the chips go
// into its path candidates through portals (hooks/useFileChips.ts) rather than being drawn with it.
import { createPortal } from 'react-dom'
import type { ChipEntry, FileChipsApi } from '../../hooks/useFileChips.ts'
import { ICON_PATHS, type IconName, iconName } from '../../models/files.ts'
import { useStore } from '../../state/store.ts'

/** One of the files' icons (20 × 20, stroked by the stylesheet), as the old page's ICONS drew it. */
export function FileIcon({ name }: { name: IconName }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the board's own fixed icon paths (models/files.ts)
    <svg viewBox="0 0 20 20" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }} />
  )
}

export interface FileChipProps {
  /** The kind the server gave it (models/files.ts iconName picks the icon). */
  kind: string | undefined
  /** Its name and :line, or a link's own markup (`html`). */
  label: string
  html?: boolean
}

/** What a chip holds: the icon, then the label. */
export function FileChip({ kind, label, html = false }: FileChipProps) {
  return (
    <>
      <FileIcon name={iconName(kind)} />
      {html ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a link's own words, as markdown() made them (escaped)
        <span className="fs-chip-label" dangerouslySetInnerHTML={{ __html: label }} />
      ) : (
        <span className="fs-chip-label">{label}</span>
      )}
    </>
  )
}

/** Every chip on the page, each into its candidate. */
export function FileChips({ chips }: { chips: FileChipsApi }) {
  const list: readonly ChipEntry[] = useStore(chips.list)
  return list.map(chip =>
    createPortal(<FileChip kind={chip.kind} label={chip.label} html={chip.html} />, chip.el, String(chip.id)),
  )
}
