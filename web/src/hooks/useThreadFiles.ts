// The files that go with the next message in each Team thread (#371), by the thread's key, while
// the page lives: each uploads to the board as soon as it comes in (POST /api/upload, as the
// session's box does), a picture previews from the browser's own copy, and a failed one says why in
// a toast. Another thread on show keeps its own; a send clears the ones it took. The board seals
// each file for the thread's members when the message goes (POST /api/team/send's `file`).
import { useRef, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { type Attachment, previewsAsImage, screenshotName } from '../models/composer.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

/** Files on one message at most: each goes as a message of its own, the first with the text. */
export const MAX_THREAD_FILES = 10

const uploadError = (err: unknown, t: Translator): string =>
  err instanceof ApiError ? errorText(err, t) : err instanceof Error ? err.message : String(err)

/** Where in the board's uploads a saved file is (`<day>/<name>`), from the path /api/upload answered. */
export const uploadPlace = (path: string): string => path.split(/[\\/]/).slice(-2).join('/')

export interface ThreadFiles {
  of(key: string): readonly Attachment[]
  add(key: string, files: readonly File[]): void
  remove(key: string, id: number): void
  /** Takes files off a thread: these (by id), or all of them. */
  clear(key: string, ids?: readonly number[]): void
}

export function useThreadFiles(): ThreadFiles {
  const t = useT()
  const { canEdit, toast } = useBoardContext()
  const latest = useLatest({ t, canEdit, toast })
  const [all, setAll] = useState<Record<string, readonly Attachment[]>>({})
  const current = useRef(all)
  const seq = useRef(0)

  const [controls] = useState(() => {
    const commit = (next: Record<string, readonly Attachment[]>) => {
      current.current = next
      setAll(next)
    }
    const list = (key: string): readonly Attachment[] =>
      Object.hasOwn(current.current, key) ? (current.current[key] ?? []) : []
    const update = (key: string, id: number, fields: Partial<Attachment>) =>
      commit({ ...current.current, [key]: list(key).map(a => (a.id === id ? { ...a, ...fields } : a)) })

    async function upload(key: string, a: Attachment, file: File): Promise<void> {
      try {
        update(key, a.id, { status: 'done', path: await api.upload(a.name, file) })
      } catch (err) {
        update(key, a.id, { status: 'error' })
        const { t, toast } = latest.current
        toast(t('err.upload', { name: a.name, why: uploadError(err, t) }), true)
      }
    }

    return {
      add(key: string, files: readonly File[]): void {
        const { t, canEdit, toast } = latest.current
        if (!canEdit) {
          toast(t('live.off'), true)
          return
        }
        const room = Math.max(0, MAX_THREAD_FILES - list(key).length)
        if (files.length > room) toast(t('team.file.tooMany', { n: MAX_THREAD_FILES }), true)
        const added = files.slice(0, room).map(given => {
          const renamed = screenshotName(given.name, new Date())
          const file = renamed ? new File([given], renamed, { type: given.type }) : given
          const image = previewsAsImage(file.type)
          const a: Attachment = {
            id: ++seq.current,
            name: file.name,
            size: file.size,
            image,
            url: image ? URL.createObjectURL(file) : '',
            status: 'uploading',
            path: '',
          }
          return { a, file }
        })
        if (!added.length) return
        commit({ ...current.current, [key]: [...list(key), ...added.map(({ a }) => a)] })
        for (const { a, file } of added) void upload(key, a, file)
      },
      remove(key: string, id: number): void {
        const gone = list(key).find(a => a.id === id)
        if (gone?.url) URL.revokeObjectURL(gone.url)
        commit({ ...current.current, [key]: list(key).filter(a => a.id !== id) })
      },
      clear(key: string, ids?: readonly number[]): void {
        const going = list(key).filter(a => !ids || ids.includes(a.id))
        for (const a of going) if (a.url) URL.revokeObjectURL(a.url)
        commit({ ...current.current, [key]: list(key).filter(a => !going.includes(a)) })
      },
    }
  })

  return { of: (key: string) => (Object.hasOwn(all, key) ? (all[key] ?? []) : []), ...controls }
}
