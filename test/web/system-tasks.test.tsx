import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Lane } from '../../web/src/components/Lane.tsx'
import { SystemTasks } from '../../web/src/components/SystemTasks.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'

test('recently completed system tasks are visible in a Tripio lane with no sessions', () => {
  const markup = renderToStaticMarkup(
    <I18nProvider lang="ru">
      <Lane
        lane={{ id: 'tripio', title: 'Трипио', color: 'blue', items: [], shown: true, columns: [] }}
        lit={null}
        canMutate={false}
        onNewSession={() => {}}
        renderCard={() => null}
        systemTasks={
          <SystemTasks
            feed={{
              state: 'ready',
              tasks: [
                {
                  key: 'TRIPIO-32',
                  title: 'Трейс чата Помощник',
                  status: 'done',
                  updatedAt: 1795706794784,
                  url: 'https://workdesk.test/workdesk/#tasks/TRIPIO-32',
                  executor: 'Tripio agent',
                },
              ],
            }}
          />
        }
      />
    </I18nProvider>,
  )
  expect(markup).not.toContain('empty-lane')
  expect(markup).toContain('TRIPIO-32')
  expect(markup).toContain('Трейс чата Помощник')
  expect(markup).toContain('Завершена')
  expect(markup).toContain('dateTime=')
  expect(markup).toContain('href="https://workdesk.test/workdesk/#tasks/TRIPIO-32"')
  expect(markup).not.toContain('claim')
})

test('the system task panel distinguishes a successfully empty feed from an unavailable feed', () => {
  const empty = renderToStaticMarkup(
    <I18nProvider lang="en">
      <SystemTasks feed={{ state: 'ready', tasks: [] }} />
    </I18nProvider>,
  )
  const unavailable = renderToStaticMarkup(
    <I18nProvider lang="en">
      <SystemTasks feed={{ state: 'unavailable' }} />
    </I18nProvider>,
  )
  expect(empty).toContain('No system tasks')
  expect(unavailable).toContain('System tasks unavailable')
})
