// A <task-notification> prompt as Claude Code writes them (summaries copied from real
// transcripts), for the notice tests (src/core/notices.ts).

export interface NotificationParts {
  id?: string
  /** null: no output file. */
  file?: string | null
  /** null: no status tag. */
  status?: string | null
  /** What comes after the summary: a result, an event, a note. */
  tail?: string
}

export const notification = (summary: string, more: NotificationParts = {}): string =>
  [
    '<task-notification>',
    `<task-id>${more.id ?? 'b5wcamkuh'}</task-id>`,
    '<tool-use-id>toolu_01</tool-use-id>',
    more.file === null ? '' : `<output-file>${more.file ?? 'C:\\Temp\\tasks\\b5wcamkuh.output'}</output-file>`,
    more.status === null ? '' : `<status>${more.status ?? 'completed'}</status>`,
    `<summary>${summary}</summary>`,
    more.tail ?? '',
    '</task-notification>',
  ]
    .filter(Boolean)
    .join('\n')
