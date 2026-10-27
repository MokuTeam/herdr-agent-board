// The tasks panel (#202): what is still open across sessions, grouped by session, the one with
// the oldest point first. Mine are the user's points, Agents' the promises agents made (pinned as
// such, or recorded with `board todo`). A point: its text, its age, Open (the session's sheet), To
// chat (quoted in the session's message box), Done. Done ones fold under the list, to open again
// or remove. Only sessions on the board count: an archived one's points come back with it.
import { useState } from 'react'
import type { TodosUi } from '../../hooks/useTodos.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { ageText, doneTodos, TODO_FILTERS, type TodoFilter, todoGroups } from '../../models/todos.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { CheckGlyph, MoonGlyph, TrashGlyph } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface TodosPanelProps {
  open: boolean
  onClose(): void
  todos: TodosUi
}

export function TodosPanel({ open, onClose, todos }: TodosPanelProps) {
  const t = useT()
  const { data, now, canEdit, dispatch } = useBoardContext()
  const [filter, setFilter] = useState<TodoFilter>('mine')
  const items = data?.items ?? []
  const groups = todoGroups(items, filter)
  const done = doneTodos(items, filter)
  const goTo = (key: string) => dispatch({ type: 'open', key })
  return (
    <Panel
      id="todos-sheet"
      kind="todos"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('todo.title')}</h2>
          <p className="sheet-meta">{t('todo.about')}</p>
        </>
      }
    >
      <div className="sheet-body todos-body">
        <div className="todos-filter" role="tablist">
          {TODO_FILTERS.map(f => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={classNames('pill-toggle', filter === f && 'on')}
              onClick={() => setFilter(f)}
            >
              {t(`todo.filter.${f}`)}
            </button>
          ))}
        </div>
        {!groups.length && (
          <div className="todos-empty">
            <p>{t('todo.empty')}</p>
            <p className="hint">{t('todo.emptyHint')}</p>
          </div>
        )}
        {groups.map(({ item, open: list }) => (
          <section key={item.key} className="todos-group">
            <button type="button" className="todos-session" onClick={() => goTo(item.key)} title={t('todo.goToHint')}>
              {item.sleeping && <MoonGlyph />}
              <span>{item.name}</span>
            </button>
            {list.map(x => (
              <div key={x.id} className={classNames('todo-row', x.owner === 'agent' && 'agent')}>
                <p className="todo-text">{x.text}</p>
                <div className="todo-foot">
                  <span className="todo-meta">
                    {ageText(x.at, now)}
                    {x.owner === 'agent' && ` · ${t('todo.agent')}`}
                    {x.by === 'agent' && x.owner === 'user' && ` · ${t('todo.byAgent')}`}
                  </span>
                  <button type="button" className="mini" onClick={() => goTo(item.key)} title={t('todo.goToHint')}>
                    {t('todo.goTo')}
                  </button>
                  <button
                    type="button"
                    className="mini"
                    onClick={() => todos.toChat(item, x)}
                    title={t('todo.toChatHint')}
                  >
                    {t('todo.toChat')}
                  </button>
                  <button
                    type="button"
                    className="mini icon"
                    disabled={!canEdit}
                    onClick={() => todos.done(item.key, x.id)}
                    title={t('todo.doneHint')}
                    aria-label={t('todo.doneHint')}
                  >
                    <CheckGlyph />
                  </button>
                </div>
              </div>
            ))}
          </section>
        ))}
        {done.length > 0 && (
          <details className="todos-done">
            <summary>{t('todo.doneList', { n: done.length })}</summary>
            {done.map(({ item, todo: x }) => (
              <div key={x.id} className="todo-row done">
                <p className="todo-text">{x.text}</p>
                <div className="todo-foot">
                  <span className="todo-meta">
                    {item.name}
                    {x.doneBy === 'agent' && ` · ${t('todo.doneByAgent')}`}
                  </span>
                  <button
                    type="button"
                    className="mini"
                    disabled={!canEdit}
                    onClick={() => todos.reopen(item.key, x.id)}
                  >
                    {t('todo.reopen')}
                  </button>
                  <button
                    type="button"
                    className="mini icon"
                    disabled={!canEdit}
                    onClick={() => todos.remove(item.key, x.id)}
                    title={t('todo.remove')}
                    aria-label={t('todo.remove')}
                  >
                    <TrashGlyph />
                  </button>
                </div>
              </div>
            ))}
          </details>
        )}
      </div>
    </Panel>
  )
}
