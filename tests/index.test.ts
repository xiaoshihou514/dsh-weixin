import { describe, expect, it } from 'vitest'
import { isAllowed, splitText } from '../src/index.js'
import type { Config } from '../src/index.js'

const config = {
  allowedUsers: ['user-1'],
  allowedGroups: ['group-1'],
} as Config

describe('splitText', () => {
  it('splits by Unicode code points instead of UTF-16 units', () => {
    expect(splitText('ab🙂cd', 3)).toEqual(['ab🙂', 'cd'])
  })

  it('does not add an empty chunk', () => {
    expect(splitText('', 10)).toEqual([])
  })
})

describe('isAllowed', () => {
  it('requires both the room and sender for group messages', () => {
    expect(isAllowed({ id: '1', chatId: 'group-1', userId: 'user-1', group: true, text: 'ok', media: [], mediaErrors: [] }, config)).toBe(true)
    expect(isAllowed({ id: '2', chatId: 'group-1', userId: 'stranger', group: true, text: 'no', media: [], mediaErrors: [] }, config)).toBe(false)
    expect(isAllowed({ id: '3', chatId: 'other', userId: 'user-1', group: true, text: 'no', media: [], mediaErrors: [] }, config)).toBe(false)
  })

  it('authorizes direct messages by sender', () => {
    expect(isAllowed({ id: '1', chatId: 'user-1', userId: 'user-1', group: false, text: 'ok', media: [], mediaErrors: [] }, config)).toBe(true)
    expect(isAllowed({ id: '2', chatId: 'stranger', userId: 'stranger', group: false, text: 'no', media: [], mediaErrors: [] }, config)).toBe(false)
  })
})
