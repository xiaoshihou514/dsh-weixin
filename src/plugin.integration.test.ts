import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './index.js'
import type { Config } from './index.js'
import { writePrivateJson } from './files.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => { await context.fiber.dispose() }))
  vi.unstubAllEnvs()
})

describe('assembled plugin lifecycle', () => {
  it('polls through Cordis and stops when its fiber is disposed', async () => {
    let polls = 0
    const server = createServer((request, response) => {
      if (request.url !== '/ilink/bot/getupdates') {
        response.writeHead(404).end()
        return
      }
      polls += 1
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ret: 0, get_updates_buf: `cursor-${polls}`, msgs: [] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-plugin-'))
    const context = new Context()
    contexts.push(context)
    // A plugin must never await Loader completion from inside its own apply;
    // Loader completion includes this plugin and would deadlock production boot.
    context.provide('loader', { await: () => new Promise<void>(() => undefined) } as never)
    context.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'provider', model: 'model' }) } as never)
    context.provide('agents', { get: () => undefined } as never)
    context.provide('sessions', { flush: () => Promise.resolve() } as never)
    context.provide('sessionTitle', { rename: vi.fn() } as never)
    vi.stubEnv('TEST_WEIXIN_TOKEN', 'token')
    const config: Config = {
      tokenEnv: 'TEST_WEIXIN_TOKEN',
      credentialPath: join(directory, 'credential.json'),
      statePath: join(directory, 'state.json'),
      accountId: 'bot',
      apiBase: `http://127.0.0.1:${address.port}`,
      workspace: directory,
      allowedUsers: ['user'],
      allowedGroups: [],
      retryDelayMs: 100,
      emptyPollDelayMs: 20,
      maxMessageChars: 3_500,
    }

    await apply(context, config)
    await vi.waitFor(() => { expect(polls).toBeGreaterThan(0) })
    await context.fiber.dispose()
    contexts.splice(contexts.indexOf(context), 1)
    const afterDispose = polls
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(polls).toBe(afterDispose)
    await new Promise<void>((resolve, reject) => server.close(error => { if (error === undefined) resolve(); else reject(error) }))
  })

  it('attaches a persisted Weixin chat to an agent already resumed by the Web UI', async () => {
    let polls = 0
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/ilink/bot/getupdates') {
        polls += 1
        response.end(JSON.stringify({
          ret: 0,
          get_updates_buf: `cursor-${polls}`,
          msgs: polls === 1 ? [{
            message_id: 'message-1', from_user_id: 'owner', context_token: 'context-1',
            item_list: [{ type: 1, text_item: { text: 'continue from Weixin' } }],
          }] : [],
        }))
        return
      }
      if (request.url === '/ilink/bot/getconfig') {
        response.end(JSON.stringify({ ret: 0, typing_ticket: 'typing-1' }))
        return
      }
      if (request.url === '/ilink/bot/sendtyping') {
        response.end(JSON.stringify({ ret: 0 }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-global-session-'))
    const statePath = join(directory, 'state.json')
    await writePrivateJson(statePath, {
      version: 1,
      chats: { owner: 'weixin-existing-session' },
      seenMessageIds: [],
      protocol: { updatesBuffer: '', contextTokens: {} },
      outbox: {},
    })
    const followup = vi.fn()
    const active = {
      id: 'weixin-existing-session', status: 'idle', followup, cancel: vi.fn(),
      session: { id: 'weixin-existing-session', seq: 0, events: [] },
    }
    const create = vi.fn()
    const resume = vi.fn()
    const context = new Context()
    contexts.push(context)
    context.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'provider', model: 'model' }) } as never)
    context.provide('agents', { get: (id: string) => id === active.id ? active : undefined, create, resume } as never)
    context.provide('sessions', { flush: () => Promise.resolve() } as never)
    const rename = vi.fn()
    context.provide('sessionTitle', { rename } as never)
    vi.stubEnv('TEST_WEIXIN_TOKEN', 'token')
    await apply(context, {
      tokenEnv: 'TEST_WEIXIN_TOKEN', credentialPath: join(directory, 'credential.json'), statePath,
      accountId: 'bot', apiBase: `http://127.0.0.1:${address.port}`, cdnBase: 'https://novac2c.cdn.weixin.qq.com/c2c',
      workspace: directory, mediaDir: '', allowedUsers: ['owner'], allowedGroups: [], retryDelayMs: 100,
      emptyPollDelayMs: 20, maxMessageChars: 3_500, maxMediaBytes: 1024 * 1024,
    })

    await vi.waitFor(() => { expect(followup).toHaveBeenCalledOnce() })
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(rename).toHaveBeenCalledWith(active.session, 'DeepSeek')
    expect(followup.mock.calls[0]?.[0]).toMatchObject({ content: [{ type: 'text', text: 'continue from Weixin' }] })

    await context.fiber.dispose()
    contexts.splice(contexts.indexOf(context), 1)
    expect(active.status).toBe('idle')
    await new Promise<void>((resolve, reject) => server.close(error => { if (error === undefined) resolve(); else reject(error) }))
  })

  it('does not start the gateway without any credential (no silent Reasonix reuse)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-no-reuse-'))
    vi.stubEnv('HOME', directory)
    await writePrivateJson(join(directory, '.reasonix', 'weixin', 'accounts', 'reasonix-bot.json'), {
      token: 'reasonix-secret-token',
      base_url: 'https://ilinkai.weixin.qq.com',
      user_id: 'reasonix-owner',
      saved_at: new Date().toISOString(),
    })
    const polls: string[] = []
    const server = createServer((request, response) => {
      if (request.url !== '/ilink/bot/getupdates') {
        response.writeHead(404).end()
        return
      }
      polls.push(String(request.headers.authorization ?? ''))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ret: 0, get_updates_buf: 'cursor-1', msgs: [] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
    const context = new Context()
    contexts.push(context)
    context.provide('loader', { await: () => new Promise<void>(() => undefined) } as never)
    context.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'provider', model: 'model' }) } as never)
    context.provide('agents', { get: () => undefined } as never)
    context.provide('sessions', { flush: () => Promise.resolve() } as never)
    context.provide('sessionTitle', { rename: vi.fn() } as never)
    vi.stubEnv('MISSING_WEIXIN_TOKEN', '')

    await apply(context, {
      tokenEnv: 'MISSING_WEIXIN_TOKEN',
      credentialPath: join(directory, 'account.json'),
      statePath: join(directory, 'state.json'),
      accountId: 'bot',
      apiBase: `http://127.0.0.1:${address.port}`,
      workspace: directory,
      mediaDir: '',
      allowedUsers: [],
      allowedGroups: [],
      retryDelayMs: 100,
      emptyPollDelayMs: 20,
      maxMessageChars: 3_500,
    })

    // A saved Reasonix account alone must not start the gateway; only the QR
    // login flow may take over a binding after an explicit scan.
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(polls).toEqual([])
    await context.fiber.dispose()
    contexts.splice(contexts.indexOf(context), 1)
    await new Promise<void>((resolve, reject) => server.close(error => { if (error === undefined) resolve(); else reject(error) }))
  })
})
