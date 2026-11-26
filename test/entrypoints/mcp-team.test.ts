// The HTTP MCP's `team` tool (#819, entrypoints/mcp-http.ts): each op is `board team <op>` with the
// same words the command takes, so the MCP is a second door to the CLI's code paths. What a person
// or an agent wrote (the text, a thread or message ref, a peer's name, an emoji) goes after the `--`,
// where the command reads plain words only; a value that would read as a flag before it is refused.
import { describe, expect, test } from 'bun:test'
import { HTTP_TOOLS, toolRun } from '../../src/entrypoints/mcp-http.ts'

const argv = (args: Record<string, unknown>): string[] => toolRun('team', args).argv
const bad = (args: Record<string, unknown>): string => {
  try {
    toolRun('team', args)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error(`team ${JSON.stringify(args)} ran`)
}

describe('team (#819)', () => {
  test('is a tool of the server, with its ops and nothing else', () => {
    const tool = HTTP_TOOLS.find(t => t.name === 'team')
    expect(tool?.inputSchema.additionalProperties).toBe(false)
    expect(tool?.inputSchema.properties.op.enum).toEqual([
      'roster',
      'inbox',
      'thread',
      'post',
      'reply',
      'react',
      'wait',
    ])
    expect(toolRun('team', { op: 'roster' }).program).toBe('board')
  })

  test('read: roster, inbox, thread (read marks it read), wait', () => {
    expect(argv({ op: 'roster' })).toEqual(['team', 'roster'])
    expect(argv({ op: 'inbox' })).toEqual(['team', 'inbox'])
    expect(argv({ op: 'inbox', unread: true, json: true })).toEqual(['team', 'inbox', '--unread', '--json'])
    expect(argv({ op: 'thread', thread: '1a2b3c4d' })).toEqual(['team', 'thread', '--', '1a2b3c4d'])
    expect(argv({ op: 'thread', thread: 'general:anna', read: true, json: true })).toEqual([
      'team',
      'thread',
      '--json',
      '--read',
      '--',
      'general:anna',
    ])
    expect(argv({ op: 'wait' })).toEqual(['team', 'wait'])
    expect(argv({ op: 'wait', timeout: 30, json: true })).toEqual(['team', 'wait', '--timeout', '30', '--json'])
  })

  test('write: post (a new topic with a link), reply to a message, react and take it back', () => {
    expect(argv({ op: 'post', to: 'team', text: 'hello' })).toEqual(['team', 'post', '--', 'team', 'hello'])
    expect(
      argv({
        op: 'post',
        to: 'anna ☃',
        text: '--session x 100% done',
        title: 'Release · notes',
        link: 'https://x.y/z',
      }),
    ).toEqual([
      'team',
      'post',
      '--new',
      'Release · notes',
      '--link',
      'https://x.y/z',
      '--',
      'anna ☃',
      '--session x 100% done',
    ])
    expect(argv({ op: 'reply', thread: '1a2b3c4d', text: 'done', to: '9f8e7d6c' })).toEqual([
      'team',
      'reply',
      '--to',
      '9f8e7d6c',
      '--',
      '1a2b3c4d',
      'done',
    ])
    expect(argv({ op: 'reply', thread: 'team', text: '--to x' })).toEqual(['team', 'reply', '--', 'team', '--to x'])
    expect(argv({ op: 'react', thread: '1a2b3c4d', message: '9f8e7d6c', emoji: '👍' })).toEqual([
      'team',
      'react',
      '--',
      '1a2b3c4d',
      '9f8e7d6c',
      '👍',
    ])
    expect(argv({ op: 'react', thread: 't', message: 'm', emoji: '👍', remove: true })).toContain('--remove')
  })

  test('refused before anything runs: a flag where a value goes, a missing word, a wait too long', () => {
    expect(bad({ op: 'post', to: '--session', text: 'x' })).toContain('to')
    expect(bad({ op: 'post', to: 'team', text: 'x', title: '--session other' })).toContain('title')
    expect(bad({ op: 'post', to: 'team', text: 'x', link: 'https://x.y' })).toBe('link goes with title')
    expect(bad({ op: 'post', to: 'team' })).toBe('post needs text')
    expect(bad({ op: 'reply', thread: 'x', text: 'y', to: '--session' })).toContain('to')
    expect(bad({ op: 'thread' })).toContain('needs thread')
    expect(bad({ op: 'thread', thread: '-x' })).toContain('thread')
    expect(bad({ op: 'react', thread: 't', emoji: '👍' })).toContain('needs message')
    expect(bad({ op: 'wait', timeout: 600 })).toContain('timeout')
    expect(bad({ op: 'wait', timeout: 1.5 })).toContain('timeout')
    expect(bad({ op: 'join' })).toContain('op is')
  })
})
