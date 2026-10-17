import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { draftBook } from '../../web/src/models/drafts.ts'

test('draft text survives reload and session switches; completed old sends cannot clear new edits', () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
  const drafts = draftBook(storage)
  const first = drafts.save('a', 'first')
  drafts.save('b', 'second')
  assert.equal(draftBook(storage).read('a')?.text, 'first')
  const edited = drafts.save('a', 'edited')
  drafts.clear('a', first?.id)
  assert.equal(drafts.read('a')?.id, edited?.id)
  drafts.clear('b')
  assert.equal(drafts.read('b'), null)
  assert.equal(drafts.read('a')?.text, 'edited')
})

test('storage errors do not send anything', () => {
  const drafts = draftBook({
    getItem() {
      throw Error('disabled')
    },
    setItem() {
      throw Error('disabled')
    },
    removeItem() {
      throw Error('disabled')
    },
  })
  assert.equal(drafts.read('a'), null)
  assert.equal(drafts.save('a', 'text')?.text, 'text')
})
