import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client.js'

describe('Weixin settings card', () => {
  it('registers in the native configurable plugins slot', () => {
    let registration: Record<string, unknown> | undefined
    let component: ((props: Record<string, string>) => unknown) | undefined
    const register = vi.fn((options, card) => {
      registration = options
      component = card
      return { options, card }
    })
    const slots = {
      inject: vi.fn((_name: string, callback: () => Iterable<unknown>) => {
        for (const _entry of callback()) void _entry
      }),
      register,
    }

    apply({ slots } as never)

    expect(inject).toEqual(['slots'])
    expect(slots.inject).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function))
    expect(registration).toMatchObject({
      name: 'settings.plugin.item',
      key: 'dsh-weixin',
    })
    expect(registration?.inject).toBeTypeOf('function')
    expect(component).toBeTypeOf('function')
  })
})
