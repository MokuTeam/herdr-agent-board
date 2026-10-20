// The field that renames a session where its name is: over the name, in its type, with what an
// empty name gives back and, for a Claude session, the choice to rename it in Claude and herdr
// too. Over a workspace's name it says what renaming that does instead. It lives in <body> beside
// the page, like the menus; its keys, focus and motion are hooks/useRenameInPlace.ts's.
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { NAME_MAX } from '../../../src/core/launch/names.ts'
import type { Translator } from '../../../src/core/types.ts'
import type { Renamer, RenameView } from '../hooks/useRenameInPlace.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { useStore } from '../state/store.ts'
import { classNames } from './class-names.ts'

export interface RenameRefs {
  box: RefObject<HTMLDivElement | null>
  field: RefObject<HTMLInputElement | null>
  more: RefObject<HTMLDivElement | null>
  check: RefObject<HTMLInputElement | null>
}

export function RenameField({ rename }: { rename: Renamer }) {
  const view = useStore(rename.view)
  const t = useT()
  if (!view || typeof document === 'undefined') return null
  // A new field for every rename.
  return createPortal(<Field key={view.id} view={view} rename={rename} t={t} />, document.body)
}

function Field({ view, rename, t }: { view: RenameView; rename: Renamer; t: Translator }) {
  const refs: RenameRefs = { box: useRef(null), field: useRef(null), more: useRef(null), check: useRef(null) }
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawn once per rename (keyed); the refs are this field's own
  useLayoutEffect(() => {
    const [box, field, more] = [refs.box.current, refs.field.current, refs.more.current]
    return box && field && more ? rename.attach({ box, field, more, check: refs.check.current }) : undefined
  }, [rename])
  return <RenameFieldView view={view} t={t} refs={refs} />
}

/** The field as drawn for one rename. */
export function RenameFieldView({ view, t, refs }: { view: RenameView; t: Translator; refs?: Partial<RenameRefs> }) {
  const { box, font, claude } = view
  const workspace = view.kind === 'workspace'
  return (
    <div
      className="rename"
      style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` }}
      ref={refs?.box}
    >
      <input
        className="rename-field"
        maxLength={NAME_MAX}
        spellCheck={false}
        autoComplete="off"
        aria-label={t(workspace ? 'launch.workspaceName' : 'rename.label')}
        style={{ ...font, height: `${box.fieldHeight}px` }}
        defaultValue={view.value}
        ref={refs?.field}
      />
      <div className="rename-more" ref={refs?.more}>
        {workspace ? (
          <span className="rename-hint">{t('rename.workspaceHint')}</span>
        ) : (
          <span className="rename-auto">{t('rename.auto', { name: view.auto })}</span>
        )}
        {claude && (
          <label className={classNames('rename-claude', !!claude.why && 'off')}>
            <input type="checkbox" disabled={!!claude.why} ref={refs?.check} />
            <span>
              {t('rename.alsoClaude')}
              <small>{claude.why || t('rename.alsoClaudeHint')}</small>
            </span>
          </label>
        )}
      </div>
    </div>
  )
}
