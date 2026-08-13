import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './index.js'
import type { Config } from './index.js'

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
    context.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'provider', model: 'model' }) } as never)
    context.provide('agents', { get: () => undefined } as never)
    context.provide('sessions', { flush: () => Promise.resolve() } as never)
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
})
