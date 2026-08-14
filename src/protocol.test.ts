import { describe, expect, it, vi } from 'vitest'
import { ILinkClient } from './protocol.js'
import { encryptMedia } from './media.js'

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
      media: [],
      mediaErrors: [],
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

  it('normalizes the legacy updates response', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      ret: 0,
      updates: [{
        update_type: 'message',
        message: {
          message_id: 'legacy-1',
          chat_id: 'group-1',
          chat_type: 'group',
          from: { user_id: 'user-1' },
          text: 'legacy text',
        },
      }],
    }))
    const client = new ILinkClient({ token: 'secret', apiBase: 'https://example.test', fetch })

    await expect(client.poll(new AbortController().signal)).resolves.toEqual([{
      id: 'legacy-1', chatId: 'group-1', userId: 'user-1', group: true, text: 'legacy text', media: [], mediaErrors: [],
    }])
  })

  it('rejects a non-TLS remote API base', () => {
    expect(() => new ILinkClient({ token: 'secret', apiBase: 'http://example.test' })).toThrow('must use HTTPS')
  })

  it('downloads and decrypts native inbound files', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const encrypted = encryptMedia(Buffer.from('%PDF-test'), key)
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({
        ret: 0,
        msgs: [{
          message_id: 'file-1', from_user_id: 'user-1', context_token: 'ctx',
          item_list: [{ type: 4, file_item: { file_name: 'report.pdf', media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=1', aes_key: Buffer.from(key.toString('hex')).toString('base64') } } }],
        }],
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array(encrypted), { status: 200 }))
    const client = new ILinkClient({ token: 'secret', apiBase: 'https://example.test', fetch })

    const [message] = await client.poll(new AbortController().signal)
    expect(message?.media).toHaveLength(1)
    expect(message?.media[0]).toMatchObject({ kind: 'file', name: 'report.pdf', mediaType: 'application/pdf' })
    expect(Buffer.from(message!.media[0]!.data).toString()).toBe('%PDF-test')
  })

  it('uploads encrypted media then sends a native file item', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?id=1' }))
      .mockResolvedValueOnce(new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-1' } }))
      .mockResolvedValueOnce(response({ ret: 0 }))
    const client = new ILinkClient({ token: 'secret', apiBase: 'https://example.test', fetch })

    await client.sendMedia('user-1', 'report.pdf', Buffer.from('%PDF-test'))

    expect(fetch.mock.calls[0]?.[0]).toBe('https://example.test/ilink/bot/getuploadurl')
    const uploadRequest = JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))
    expect(uploadRequest).toMatchObject({ media_type: 3, to_user_id: 'user-1', rawsize: 9, no_need_thumb: true })
    const sendRequest = JSON.parse(String((fetch.mock.calls[2]?.[1] as RequestInit).body))
    expect(sendRequest.msg.item_list[0]).toMatchObject({ type: 4, file_item: { file_name: 'report.pdf', len: '9', media: { encrypt_query_param: 'download-1' } } })
  })

  it('uses the configuration ticket for typing state', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ret: 0, typing_ticket: 'ticket-1' }))
      .mockResolvedValueOnce(response({ ret: 0 }))
    const client = new ILinkClient({ token: 'secret', apiBase: 'https://example.test', fetch })

    await client.sendTyping('user-1', true)

    expect(fetch.mock.calls[0]?.[0]).toBe('https://example.test/ilink/bot/getconfig')
    expect(JSON.parse(String((fetch.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      ilink_user_id: 'user-1', typing_ticket: 'ticket-1', status: 1,
    })
  })

  it('advances the poll cursor and reports a broken attachment without wedging polling', async () => {
    const states: unknown[] = []
    const fetch = vi.fn().mockResolvedValue(response({
      ret: 0,
      get_updates_buf: 'cursor-after-broken-file',
      msgs: [{
        message_id: 'broken-1', from_user_id: 'user-1',
        item_list: [{ type: 4, file_item: { file_name: 'broken.pdf', media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=1' } } }],
      }],
    }))
    const client = new ILinkClient({
      token: 'secret', apiBase: 'https://example.test', fetch,
      onStateChange: state => states.push(state),
    })

    const [message] = await client.poll(new AbortController().signal)

    expect(states[0]).toMatchObject({ updatesBuffer: 'cursor-after-broken-file' })
    expect(message?.media).toEqual([])
    expect(message?.mediaErrors).toEqual(['broken.pdf: media AES key is missing'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
