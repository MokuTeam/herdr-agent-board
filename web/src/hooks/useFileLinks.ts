// Clicks on the chat's files and links, anywhere on the page (the old page's files.js document
// listeners): a chip (or Enter or Space on it) opens its quick look; a web link opens in the
// default browser through the board, else in a new tab.
import { useEffect } from 'react'
import { filesApi } from '../api/files.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'
import type { QuickLook } from './useQuickLook.ts'

const CHIP = '[data-fs="file"], [data-fs="dir"]'

/** What a chip opens: its full path, at its line. */
const targetOf = (chip: HTMLElement) => ({ path: chip.dataset.abs ?? '', line: Number(chip.dataset.line) || null })

export function useFileLinks(look: QuickLook['look']): void {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ t, board, look })

  useEffect(() => {
    const api = filesApi(() => latest.current.t)
    async function openUrl(href: string): Promise<void> {
      const { board, t } = latest.current
      if (!board.canEdit) return board.toast(t('mobile.readOnly'), true)
      const refused = await api.openUrl(href)
      if (!refused) return
      // The board could not open it: a new tab, unless the board said no (409) or it went read only.
      if (refused.httpStatus !== 409 && latest.current.board.canEdit) window.open(href, '_blank', 'noopener')
      else latest.current.board.toast(refused.error, true)
    }
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const chip = target?.closest<HTMLElement>(CHIP)
      if (chip) {
        e.preventDefault()
        return latest.current.look(targetOf(chip), chip)
      }
      const ext = target?.closest<HTMLAnchorElement>('a.ext[href]')
      if (ext) {
        e.preventDefault()
        void openUrl(ext.href)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement && e.target.matches(CHIP)) {
        e.preventDefault()
        latest.current.look(targetOf(e.target), e.target)
      }
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [latest])
}
