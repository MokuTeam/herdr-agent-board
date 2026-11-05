// The tasks panel (#202, #319): what is still open across sessions. First what agents say is done,
// for the user to close or keep open; then the open points by lane, as the board orders its lanes,
// and by session, with its state. Mine are the user's points, Agents' the promises agents made
// (pinned as such, or recorded with `board todo`). A point: its key (<lane>-<session>-<n>, the
// name agents use for it), its text, what it refers to and waits on, its age, Open (the session's
// sheet), To chat (quoted in the session's message box), Done. Done ones fold under the list, to
// open again or remove. Only sessions on the board count: an archived one's points come back with it.
import { useState } from 'react'
import { type Todo, todoKey } from '../../../../src/core/todos.ts'
import type { Item } from '../../../../src/core/types.ts'
import type { TodosUi } from '../../hooks/useTodos.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { ageText, doneTodos, proposedGroups, TODO_FILTERS, type TodoFilter, todoLanes } from '../../models/todos.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { CheckGlyph, MoonGlyph, TrashGlyph } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface TodosPanelProps {
  open: boolean
  onClose(): void
  todos: TodosUi
}

/** What a point refers to: a link opens in a new tab; a ticket or a path is shown as it is. */
function Ref({ text }: { text: string }) {
  return /^https?:\/\//i.test(text) ? (
    <a className="todo-ref" href={text} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <code className="todo-ref">{text}</code>
  )
}

export function TodosPanel({ open, onClose, todos }: TodosPanelProps) {
  const t = useT()
  const { data, now, canEdit, dispatch } = useBoardContext()
  const [filter, setFilter] = useState<TodoFilter>('mine')
  const items = data?.items ?? []
  const lanes = todoLanes(items, data?.categories ?? [], filter)
  const proposed = filter === 'agents' ? [] : proposedGroups(items)
  const done = doneTodos(items, filter)
  const goTo = (key: string) => dispatch({ type: 'open', key })

  const head = (x: Todo, item: Item) => (
    <p className="todo-text">
      <span className="todo-key" title={t('todo.keyHint')}>
        {todoKey(item, x)}
      </span>
      {x.text}
    </p>
  )

  const notes = (x: Todo) =>
    (x.ref || x.why) && (
      <div className="todo-notes">
        {x.ref && <Ref text={x.ref} />}
        {x.why && <span className="todo-why">{x.why}</span>}
      </div>
    )

  const openButton = (item: Item) => (
    <button type="button" className="mini" onClick={() => goTo(item.key)} title={t('todo.goToHint')}>
      {t('todo.goTo')}
    </button>
  )

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
        {proposed.length > 0 && (
          <section className="todos-proposed">
            <h3 className="todos-lane">{t('todo.proposedTitle')}</h3>
            {proposed.map(({ item, open: list }) => (
              <div key={item.key} className="todos-group">
                <div className="todos-session-row">
                  <button
                    type="button"
                    className="todos-session"
                    onClick={() => goTo(item.key)}
                    title={t('todo.goToHint')}
                  >
                    {item.sleeping && <MoonGlyph />}
                    <span>{item.name}</span>
                  </button>
                  {list.length > 1 && (
                    <button
                      type="button"
                      className="mini"
                      disabled={!canEdit}
                      onClick={() =>
                        todos.closeAll(
                          item.key,
                          list.map(x => x.id),
                        )
                      }
                    >
                      {t('todo.closeAll', { n: list.length })}
                    </button>
                  )}
                </div>
                {list.map(x => (
                  <div key={x.id} className="todo-row proposed">
                    {head(x, item)}
                    <p className="todo-said">
                      {t('todo.agentSays')}
                      {x.proposed?.why ? `: ${x.proposed.why}` : ''}
                    </p>
                    {notes(x)}
                    <div className="todo-foot">
                      <span className="todo-meta">{ageText(x.proposed?.at ?? x.at, now)}</span>
                      {openButton(item)}
                      <button
                        type="button"
                        className="mini"
                        disabled={!canEdit}
                        onClick={() => todos.keep(item.key, x.id)}
                        title={t('todo.keepHint')}
                      >
                        {t('todo.keep')}
                      </button>
                      <button
                        type="button"
                        className="mini accent"
                        disabled={!canEdit}
                        onClick={() => todos.done(item.key, x.id)}
                        title={t('todo.confirmHint')}
                      >
                        <CheckGlyph />
                        {t('todo.confirm')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
        {!lanes.length && !proposed.length && (
          <div className="todos-empty">
            <p>{t('todo.empty')}</p>
            <p className="hint">{t('todo.emptyHint')}</p>
          </div>
        )}
        {lanes.map(lane => (
          <section key={lane.id} className="todos-lane-block">
            <h3 className="todos-lane" style={lane.color ? { '--c': lane.color } : undefined}>
              {lane.title || t('todo.noLane')}
            </h3>
            {lane.groups.map(({ item, open: list }) => (
              <div key={item.key} className="todos-group">
                <div className="todos-session-row">
                  <button
                    type="button"
                    className="todos-session"
                    onClick={() => goTo(item.key)}
                    title={t('todo.goToHint')}
                  >
                    {item.sleeping && <MoonGlyph />}
                    <span>{item.name}</span>
                  </button>
                  <span className="todos-state">{t(`col.${item.column}`)}</span>
                </div>
                {list.map(x => (
                  <div key={x.id} className={classNames('todo-row', x.owner === 'agent' && 'agent')}>
                    {head(x, item)}
                    {notes(x)}
                    <div className="todo-foot">
                      <span className="todo-meta">
                        {ageText(x.at, now)}
                        {x.owner === 'agent' && ` · ${t('todo.agent')}`}
                        {x.by === 'agent' && x.owner === 'user' && ` · ${t('todo.byAgent')}`}
                      </span>
                      {openButton(item)}
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
              </div>
            ))}
          </section>
        ))}
        {done.length > 0 && (
          <details className="todos-done">
            <summary>{t('todo.doneList', { n: done.length })}</summary>
            {done.map(({ item, todo: x }) => (
              <div key={x.id} className="todo-row done">
                {head(x, item)}
                <div className="todo-foot">
                  <span className="todo-meta">
                    {item.name}
                    {x.doneBy === 'agent' && ` · ${t('todo.doneByAgent')}`}
                    {x.doneWhy && ` · ${x.doneWhy}`}
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
