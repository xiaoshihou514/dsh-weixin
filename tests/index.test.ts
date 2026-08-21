import { describe, expect, it } from 'vitest'
import { assistantDelivery, formatChineseNumber, formatUsage, isAllowed, splitText } from '../src/index.js'
import type { Config } from '../src/index.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

describe('formatChineseNumber', () => {
  it('keeps plain numbers below ten thousand as-is', () => {
    expect(formatChineseNumber(0)).toBe('0')
    expect(formatChineseNumber(56)).toBe('56')
    expect(formatChineseNumber(9_999)).toBe('9999')
  })

  it('uses 万 above ten thousand and trims trailing zeros', () => {
    expect(formatChineseNumber(10_000)).toBe('1万')
    expect(formatChineseNumber(12_345)).toBe('1.23万')
    expect(formatChineseNumber(120_000)).toBe('12万')
  })

  it('uses 亿 above one hundred million', () => {
    expect(formatChineseNumber(123_456_789)).toBe('1.23亿')
    expect(formatChineseNumber(1_000_000_000)).toBe('10亿')
  })
})

describe('formatUsage', () => {
  it('formats input and output tokens with a cache line when cache reads are reported', () => {
    expect(formatUsage({ inputTokens: 12_345, outputTokens: 56, cacheReadTokens: 789 })).toBe('词元用量:输入 1.23万 · 输出 56 · 缓存 789')
  })

  it('distinguishes cache reads and writes when both are reported', () => {
    expect(formatUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe('词元用量:输入 1 · 输出 2 · 缓存读取 3 · 缓存写入 4')
  })

  it('omits cache fields entirely when the provider reported none', () => {
    expect(formatUsage({ inputTokens: 10, outputTokens: 5 })).toBe('词元用量:输入 10 · 输出 5')
  })
})

function assistantEvent(seq: number, text: string, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }): SessionEvent {
  return {
    seq,
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        content: text === '' ? [] : [{ type: 'text', text }],
        stopReason: 'stop',
      },
      ...(usage === undefined ? {} : { usage }),
    },
  } as SessionEvent
}

describe('assistantDelivery', () => {
  it('keeps the last assistant text and sums usage across every model call', () => {
    const events: SessionEvent[] = [
      assistantEvent(1, 'first step', { inputTokens: 100, outputTokens: 10 }),
      assistantEvent(2, '', { inputTokens: 200, outputTokens: 20, cacheReadTokens: 30 }),
      assistantEvent(3, 'final answer', { inputTokens: 300, outputTokens: 30, cacheReadTokens: 40 }),
    ]
    expect(assistantDelivery(events, 0)).toEqual({
      text: 'final answer',
      seq: 3,
      usage: { inputTokens: 600, outputTokens: 60, cacheReadTokens: 70 },
    })
  })

  it('ignores events at or before the delivery cursor and returns no usage when none is reported', () => {
    const events: SessionEvent[] = [
      assistantEvent(1, 'seen', { inputTokens: 1, outputTokens: 1 }),
      assistantEvent(2, 'new', { inputTokens: 5, outputTokens: 2 }),
    ]
    expect(assistantDelivery(events, 1)).toEqual({ text: 'new', seq: 2, usage: { inputTokens: 5, outputTokens: 2 } })
    expect(assistantDelivery([assistantEvent(1, 'plain')], 0)).toEqual({ text: 'plain', seq: 1, usage: undefined })
  })
})
