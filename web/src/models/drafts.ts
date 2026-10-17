// Text drafts belong to a stable Claude session, not to the pane occupying the screen.

export interface Draft {
  text: string
  /** A new one for every save: a send that finishes clears only the draft it sent. */
  id: string
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface DraftBook {
  read(session: string | null | undefined): Draft | null
  save(session: string | null | undefined, text: string): Draft | null
  clear(session: string | null | undefined, expectedId?: string | null): void
}

const isDraft = (value: unknown): value is Draft =>
  typeof value === 'object' &&
  value !== null &&
  'text' in value &&
  typeof value.text === 'string' &&
  'id' in value &&
  typeof value.id === 'string'

export function draftBook(storage: DraftStorage): DraftBook {
  const prefix = 'board.draft.'
  return {
    read(session) {
      if (!session) return null
      try {
        const value: unknown = JSON.parse(storage.getItem(prefix + session) ?? 'null')
        return isDraft(value) ? value : null
      } catch {
        return null
      }
    },
    save(session, text) {
      if (!session) return null
      const draft = { text, id: crypto.randomUUID() }
      try {
        storage.setItem(prefix + session, JSON.stringify(draft))
      } catch {}
      return draft
    },
    clear(session, expectedId) {
      if (!session) return
      const value = this.read(session)
      if (expectedId && value?.id !== expectedId) return
      try {
        storage.removeItem(prefix + session)
      } catch {}
    },
  }
}
