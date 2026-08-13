import { describe, expect, it } from 'vitest'
import { sessionId, textUserMessage } from './harness.js'

describe('Harness adapters', () => {
  it('brands session ids without changing their value', () => {
    expect(sessionId('session-1')).toBe('session-1')
  })

  it('creates immutable identified user text', () => {
    const message = textUserMessage('hello')
    expect(message).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    expect(message.id).toEqual(expect.any(String))
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
  })
})
