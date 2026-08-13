import { describe, expect, it } from 'vitest'
import { splitText } from './index.js'

describe('splitText', () => {
  it('splits by Unicode code points instead of UTF-16 units', () => {
    expect(splitText('ab🙂cd', 3)).toEqual(['ab🙂', 'cd'])
  })

  it('does not add an empty chunk', () => {
    expect(splitText('', 10)).toEqual([])
  })
})
