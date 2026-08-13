import { describe, expect, it, vi } from 'vitest'
import { ILinkClient } from './protocol.js'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ILinkClient', () => {
  it('normalizes inbound text and carries its context token into replies', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({
        ret: 0,
        errcode: 0,
        get_updates_buf: 'next',
        msgs: [{
          message_id: 42,
          from_user_id: 'user-1',
          room_id: 'room-1',
          context_token: 'context-1',
          item_list: [{ type: 1, text_item: { text: 'hello' } }],
        }],
      }))
      .mockResolvedValueOnce(response({ ret: 0, errcode: 0 }))
    const client = new ILinkClient({ token: 'secret', apiBase: 'https://example.test', fetch })

    await expect(client.poll(new AbortController().signal)).resolves.toEqual([{
      id: '42',
      chatId: 'room-1',
      userId: 'user-1',
      group: true,
      text: 'hello',
    }])
    await client.sendText('room-1', 'world')

    const [, init] = fetch.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      msg: {
        to_user_id: 'room-1',
        context_token: 'context-1',
        item_list: [{ type: 1, text_item: { text: 'world' } }],
      },
    })
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret')
  })

  it('rejects API-level errors', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ret: 1, errcode: 7, errmsg: 'denied' }))
    const client = new ILinkClient({ token: 'secret', apiBase: 'https://example.test', fetch })

    await expect(client.poll(new AbortController().signal)).rejects.toThrow('getupdates failed (ret=1, errcode=7): denied')
  })

  it('drops a stale context token and retries a reply once', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({
        ret: 0,
        msgs: [{
          message_id: 'message-1',
          from_user_id: 'user-1',
          context_token: 'stale',
          item_list: [{ type: 1, text_item: { text: 'hello' } }],
        }],
      }))
      .mockResolvedValueOnce(response({ ret: 1, errmsg: 'expired context' }))
      .mockResolvedValueOnce(response({ ret: 0 }))
    const client = new ILinkClient({ token: 'secret', apiBase: 'https://example.test', fetch })
    await client.poll(new AbortController().signal)

    await expect(client.sendText('user-1', 'reply')).resolves.toBeUndefined()
    expect(JSON.parse(String((fetch.mock.calls[1]?.[1] as RequestInit).body)).msg.context_token).toBe('stale')
    expect(JSON.parse(String((fetch.mock.calls[2]?.[1] as RequestInit).body)).msg.context_token).toBeUndefined()
  })

  it('restores and publishes cursor state', async () => {
    const states: unknown[] = []
    const fetch = vi.fn().mockResolvedValue(response({ ret: 0, get_updates_buf: 'cursor-2', msgs: [] }))
    const client = new ILinkClient({
      token: 'secret',
      apiBase: 'https://example.test',
      fetch,
      state: { updatesBuffer: 'cursor-1', contextTokens: { room: 'context-1' } },
      onStateChange: state => states.push(state),
    })

    await client.poll(new AbortController().signal)

    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body)).get_updates_buf).toBe('cursor-1')
    expect(states).toEqual([{ updatesBuffer: 'cursor-2', contextTokens: { room: 'context-1' } }])
  })
})
