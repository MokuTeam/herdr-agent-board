// The "new category" form at the end of the list: a title, the id agents type (its latin slug
// until one is typed by hand), Create or Enter, × or Escape. Its color is the first swatch no
// lane has yet, picked when the form opened.
import { type KeyboardEvent, type Ref, useEffect, useRef, useState } from 'react'
import type { Swatch } from '../../../../src/core/payload.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { draftCategory, slug } from '../../models/categories.ts'
import { CloseGlyph } from '../icons.tsx'
import type { CategoryEdit } from './CategoryRow.tsx'

export interface CategoryDraftProps {
  color: Swatch
  disabled: boolean
  edit: CategoryEdit
  /** Made: the form goes, the toast says so, the new lane lights up in the list. */
  onCreated(category: { id: string; title: string }): void
  onCancel(): void
}

export function CategoryDraft({ color, disabled, edit, onCreated, onCancel }: CategoryDraftProps) {
  const [title, setTitle] = useState('')
  const [id, setId] = useState('')
  // An id typed by hand stays; until then it follows the title.
  const [touched, setTouched] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => titleRef.current?.focus(), 30)
    return () => clearTimeout(timer)
  }, [])

  async function create(): Promise<void> {
    const made = draftCategory(title, id)
    if (!made) return titleRef.current?.focus()
    if (await edit({ op: 'create', id: made.id, title: made.title, color: color.name })) onCreated(made)
  }

  return (
    <CategoryDraftView
      color={color}
      title={title}
      id={id}
      disabled={disabled}
      titleRef={titleRef}
      on={{
        title(text) {
          setTitle(text)
          if (!touched) setId(slug(text))
        },
        id(text) {
          setTouched(true)
          setId(text)
        },
        // Anywhere in the form, its buttons too, as before.
        key(e) {
          if (e.key === 'Enter') void create()
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        },
        create: () => void create(),
        cancel: onCancel,
      }}
    />
  )
}

export interface DraftHandlers {
  title(text: string): void
  id(text: string): void
  key(e: KeyboardEvent<HTMLDivElement>): void
  create(): void
  cancel(): void
}

export interface CategoryDraftViewProps {
  color: Swatch
  title: string
  id: string
  disabled: boolean
  titleRef?: Ref<HTMLInputElement>
  on?: DraftHandlers
}

/** The form as drawn for what is typed in it. */
export function CategoryDraftView({ color, title, id, disabled, titleRef, on }: CategoryDraftViewProps) {
  const t = useT()
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Enter and Escape anywhere in the form, its buttons too, as before
    <div className="cat-row draft" style={{ '--lane': color.hex }} onKeyDown={e => on?.key(e)}>
      <div className="cat-main">
        <span className="swatch" />
        <input
          className="cat-title draft-title"
          placeholder={t('cat.newTitle')}
          spellCheck={false}
          value={title}
          disabled={disabled}
          ref={titleRef}
          onChange={e => on?.title(e.currentTarget.value)}
        />
        <button type="button" className="button primary draft-ok" disabled={disabled} onClick={() => on?.create()}>
          {t('cat.create')}
        </button>
        <button
          type="button"
          className="icon-button draft-cancel"
          title={t('cancel')}
          aria-label={t('cancel')}
          disabled={disabled}
          onClick={() => on?.cancel()}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="cat-sub">
        <input
          className="draft-id"
          placeholder={t('cat.idPlaceholder')}
          spellCheck={false}
          aria-label="id"
          value={id}
          disabled={disabled}
          onChange={e => on?.id(e.currentTarget.value)}
        />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the board's own dictionary text, with <code> in it */}
        <span className="hint" dangerouslySetInnerHTML={{ __html: t('cat.idHint') }} />
      </div>
    </div>
  )
}
