import type { WorkdeskSystemTasksPayload } from '../../../src/core/workdesk-system-tasks.ts'
import { useT } from '../i18n/I18nProvider.tsx'

export function SystemTasks({ feed }: { feed: WorkdeskSystemTasksPayload }) {
  const t = useT()
  const format = new Intl.DateTimeFormat(t.lang, { dateStyle: 'short', timeStyle: 'short' })
  return (
    <section className="system-tasks" aria-label={t('systemTasks.title')}>
      <h3>{t('systemTasks.title')}</h3>
      {feed.state !== 'ready' ? (
        <p role="status">{t(`systemTasks.${feed.state}`)}</p>
      ) : feed.tasks.length === 0 ? (
        <p>{t('systemTasks.empty')}</p>
      ) : (
        <ul>
          {feed.tasks.map(task => (
            <li key={task.key}>
              <a href={task.url} target="_blank" rel="noreferrer">
                <strong>{task.key}</strong> {task.title}
              </a>
              <span>{t(`systemTasks.${task.status}`)}</span>
              {task.executor && <span>{task.executor}</span>}
              <time dateTime={new Date(task.updatedAt).toISOString()}>{format.format(task.updatedAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
