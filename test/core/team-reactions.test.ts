import { describe, expect, test } from 'bun:test'
import { CAPS, checkMessage, generateKey, hasReactions, MAX_CAPS, OUR_CAPS, ourCaps } from '../../src/core/team.ts'
import { EMOJI_LIST, normalizeEmoji, QUICK_REACTIONS, searchEmoji, validEmoji } from '../../src/core/team-reactions.ts'
import { question } from '../hub/harness.ts'

describe('team-reactions pure rules', () => {
  test('OUR_CAPS includes reactions and stays within MAX_CAPS with work caps enabled', () => {
    expect(CAPS).toContain('reactions')
    expect(OUR_CAPS).toContain('reactions')
    expect(ourCaps({ files: true, work: true }).length).toBeLessThanOrEqual(MAX_CAPS)
    expect(hasReactions({ caps: ['threads', 'reactions'] })).toBe(true)
    expect(hasReactions({ caps: ['threads', 'channels', 'replies', 'files'] })).toBe(false)
    expect(hasReactions(undefined)).toBe(false)
  })

  test('validEmoji accepts single Unicode emoji and rejects text, controls, and multi-grapheme strings', () => {
    for (const ok of [...QUICK_REACTIONS, '👨‍💻', '1️⃣', '🇺🇸', '🫡', '❤️']) {
      expect(validEmoji(ok)).toBe(true)
    }
    for (const bad of [
      '',
      ' ',
      'ok',
      'a',
      '1',
      '👍 ',
      ' 👍',
      '👍\n',
      '👍👍',
      '👍a',
      '👍\u202e',
      '👍\u0007',
      '👍'.repeat(20),
      null,
      123,
    ]) {
      expect(validEmoji(bad)).toBe(false)
    }
  })

  test('normalizeEmoji accepts Slack shortcodes and raw emoji, rejects unknown codes', () => {
    expect(normalizeEmoji(':eyes:')).toBe('👀')
    expect(normalizeEmoji(' :+1: ')).toBe('👍')
    expect(normalizeEmoji(':white_check_mark:')).toBe('✅')
    expect(normalizeEmoji(':lgtm:')).toBe('👍')
    expect(normalizeEmoji('🔥')).toBe('🔥')
    expect(normalizeEmoji(':unknown_code_xyz:')).toBeNull()
    expect(normalizeEmoji('hello')).toBeNull()
    expect(normalizeEmoji('')).toBeNull()
  })

  test('searchEmoji matches shortcodes, English keywords, and Russian keywords', () => {
    expect(searchEmoji('')).toBe(EMOJI_LIST)
    expect(searchEmoji('rocket').some(e => e.emoji === '🚀')).toBe(true)
    expect(searchEmoji('огонь').some(e => e.emoji === '🔥')).toBe(true)
    expect(searchEmoji('спасибо').some(e => e.emoji === '🙏')).toBe(true)
    expect(searchEmoji(':eyes:').some(e => e.emoji === '👀')).toBe(true)
    expect(searchEmoji('green heart').some(e => e.emoji === '💚')).toBe(true)
    expect(searchEmoji('zzzz_no_such_emoji_xyz')).toEqual([])
  })

  test('checkMessage validates body.react in board mode and relays it in relay mode', async () => {
    const A = await generateKey()
    const B = (await generateKey()).pub
    const target = '00000000-0000-4000-8000-000000000001'

    const addEnv = await question(A, B, '👀', { body: { text: '👀', react: { to: target, emoji: '👀', op: 'add' } } })
    expect(checkMessage(addEnv.payload, A.pub, 'board')).toMatchObject({
      ok: true,
      msg: { body: { react: { to: target, emoji: '👀', op: 'add' } } },
    })
    expect(checkMessage(addEnv.payload, A.pub, 'relay').ok).toBe(true)

    const rmEnv = await question(A, B, '👀', { body: { text: '👀', react: { to: target, emoji: '👀', op: 'remove' } } })
    expect(checkMessage(rmEnv.payload, A.pub, 'board')).toMatchObject({
      ok: true,
      msg: { body: { react: { to: target, emoji: '👀', op: 'remove' } } },
    })

    for (const bad of [
      { to: 'not-a-uuid', emoji: '👀', op: 'add' },
      { to: target, emoji: 'not-emoji', op: 'add' },
      { to: target, emoji: '👀', op: 'toggle' },
      { to: target, emoji: '👀', op: 'add', extra: 1 },
    ]) {
      const env = await question(A, B, '👀', { body: { text: '👀', react: bad } as never })
      expect(checkMessage(env.payload, A.pub, 'board')).toMatchObject({ ok: false, code: 'bad_frame' })
      expect(checkMessage(env.payload, A.pub, 'relay').ok).toBe(true)
    }

    // Cannot combine react with replyTo, post, file, or work
    const combo = await question(A, B, '👀', {
      body: { text: '👀', replyTo: target, react: { to: target, emoji: '👀', op: 'add' } },
    })
    expect(checkMessage(combo.payload, A.pub, 'board')).toMatchObject({ ok: false, code: 'bad_frame' })
  })
})
