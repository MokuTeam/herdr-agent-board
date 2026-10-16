import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftBook } from '../web/drafts.js'
test('draft text survives reload and session switches; completed old sends cannot clear new edits', () => {
  const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}
  const drafts=draftBook(storage)
  const first=drafts.save('a','first');drafts.save('b','second')
  assert.equal(draftBook(storage).read('a').text,'first')
  const edited=drafts.save('a','edited');drafts.clear('a',first.id)
  assert.equal(drafts.read('a').id,edited.id)
  drafts.clear('b');assert.equal(drafts.read('b'),null)
  assert.equal(drafts.read('a').text,'edited')
})
test('storage errors do not send anything', () => {
  const drafts=draftBook({getItem(){throw Error('disabled')},setItem(){throw Error('disabled')}})
  assert.equal(drafts.read('a'),null);assert.equal(drafts.save('a','text').text,'text')
})
