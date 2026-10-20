// The files that go with the next message: each uploads as soon as it comes in (POST /api/upload),
// a picture previews in the box from the browser's own copy, and a failed one says why in a toast.
import { useRef, useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, api, errorText, pageLog } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { type Attachment, previewsAsImage, screenshotName } from '../models/composer.ts'
import { remotePage } from '../models/remote-page.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export interface AttachmentsApi {
  list: readonly Attachment[]
  add(files: readonly File[]): void
  remove(id: number): void
  clear(): void
  /** Empties the list but keeps the previews: a message just sent shows them, and "Edit" puts them back. */
  release(): void
  /** A message's files back into the list ("Edit"), the ones not in it already. */
  restore(files: readonly Attachment[]): void
}

/** Why an upload failed: the server's words, else its status, else the network's. */
const uploadError = (err: unknown, t: Translator): string =>
  err instanceof ApiError ? errorText(err, t) : err instanceof Error ? err.message : String(err)

export function useAttachments(): AttachmentsApi {
  const t = useT()
  const { canEdit, toast } = useBoardContext()
  const latest = useLatest({ t, canEdit, toast })
  const [list, setList] = useState<readonly Attachment[]>([])
  // The list as of now, for uploads that finish later.
  const current = useRef(list)
  const seq = useRef(0)

  const [controls] = useState(() => {
    const commit = (next: readonly Attachment[]) => {
      current.current = next
      setList(next)
    }
    const update = (id: number, fields: Partial<Attachment>) =>
      commit(current.current.map(a => (a.id === id ? { ...a, ...fields } : a)))

    // In a phone's browser the network may still be waking when the page comes back from the
    // picker: an upload that did not get through is tried again, three times a second apart.
    async function send(a: Attachment, file: File, tries: number): Promise<string> {
      try {
        return await api.upload(a.name, file)
      } catch (err) {
        if (tries <= 1 || err instanceof ApiError) throw err
        await new Promise(resolve => setTimeout(resolve, 1000))
        return send(a, file, tries - 1)
      }
    }

    async function upload(a: Attachment, file: File): Promise<void> {
      try {
        update(a.id, { status: 'done', path: await send(a, file, remotePage() ? 4 : 1) })
      } catch (err) {
        if (remotePage())
          pageLog(`upload ${a.name} (${file.type || 'no type'}, ${file.size} B): ${uploadError(err, latest.current.t)}`)
        update(a.id, { status: 'error' })
        const { t, toast } = latest.current
        toast(t('err.upload', { name: a.name, why: uploadError(err, t) }), true)
      }
    }

    return {
      add(files: readonly File[]): void {
        const { t, canEdit, toast } = latest.current
        // A phone's browser comes back from the photo picker or the camera before the board's live
        // connection does (the page was hidden): the files are kept and uploaded, not dropped (#102).
        if (!canEdit && !remotePage()) {
          toast(t('live.off'), true)
          return
        }
        const added = files.map(given => {
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
        commit([...current.current, ...added.map(({ a }) => a)])
        for (const { a, file } of added) void upload(a, file)
      },
      remove(id: number): void {
        const gone = current.current.find(a => a.id === id)
        if (gone?.url) URL.revokeObjectURL(gone.url)
        commit(current.current.filter(a => a.id !== id))
      },
      clear(): void {
        for (const a of current.current) if (a.url) URL.revokeObjectURL(a.url)
        commit([])
      },
      release(): void {
        commit([])
      },
      restore(files: readonly Attachment[]): void {
        const back = files.filter(a => !current.current.some(b => b.id === a.id))
        if (back.length) commit([...current.current, ...back])
      },
    }
  })

  return { list, ...controls }
}
