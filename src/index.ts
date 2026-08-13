/** Weixin remote-control bundle for DeepSeek Harness. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ILinkClient } from './protocol.js'
import type { InboundMessage } from './protocol.js'
import { defaultCredentialPath, pathExists, readCredential } from './files.js'
import { defaultStatePath, GatewayStateStore, loadGatewayState } from './state.js'

/** Stable Cordis plugin name. */
export const name = 'weixin'

/** Harness services needed to create and drive remote agents. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Weixin gateway configuration. */
export interface Config {
  tokenEnv: string
  credentialPath: string
  statePath: string
  accountId?: string
  apiBase: string
  workspace: string
  allowedUsers: string[]
  allowedGroups: string[]
  retryDelayMs: number
  maxMessageChars: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  tokenEnv: z.string().default('WEIXIN_BOT_TOKEN'),
  credentialPath: z.string().default(defaultCredentialPath()),
  statePath: z.string().default(defaultStatePath()),
  accountId: z.string(),
  apiBase: z.string().default(''),
  workspace: z.string().required(),
  allowedUsers: z.array(String).default([]),
  allowedGroups: z.array(String).default([]),
  retryDelayMs: z.number().min(100).default(5_000),
  maxMessageChars: z.number().min(100).max(10_000).default(3_500),
})

interface ChatState {
  handle: AgentHandle
  sentThroughSeq: number
  delivery: Promise<void>
}

/** Split a response without breaking Unicode code points. */
export function splitText(text: string, limit: number): string[] {
  const characters = Array.from(text)
  const chunks: string[] = []
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''))
  }
  return chunks
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function assistantText(events: readonly SessionEvent[], afterSeq: number): { text: string; seq: number } {
  let text = ''
  let seq = afterSeq
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    seq = Math.max(seq, event.seq)
    if (event.type !== 'assistant/message') continue
    text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return { text, seq }
}

export function isAllowed(message: InboundMessage, config: Config): boolean {
  return message.group
    ? config.allowedGroups.includes(message.chatId) && config.allowedUsers.includes(message.userId)
    : config.allowedUsers.includes(message.userId)
}

class WeixinGateway {
  readonly #ctx: Context
  readonly #config: Config
  readonly #client: ILinkClient
  readonly #store: GatewayStateStore
  readonly #abort = new AbortController()
  readonly #chats = new Map<string, ChatState>()
  readonly #agentChats = new Map<Agent, string>()
  readonly #seen: Set<string>

  constructor(ctx: Context, config: Config, connection: { token: string; accountId?: string; apiBase: string }, store: GatewayStateStore) {
    this.#ctx = ctx
    this.#config = config
    this.#store = store
    this.#seen = new Set(store.state.seenMessageIds)
    this.#client = new ILinkClient({
      ...connection,
      state: store.state.protocol,
      onStateChange: async (state) => {
        store.state.protocol = state
        await store.save()
      },
    })
  }

  start(): void {
    this.#ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = this.#ctx.agents.get(session.id)
      const chatId = agent === undefined ? undefined : this.#agentChats.get(agent)
      if (chatId === undefined) return
      const state = this.#chats.get(chatId)
      if (state === undefined) return
      state.delivery = state.delivery
        .then(async () => {
          await this.#ctx.sessions.flush(session)
          await this.#deliver(chatId, state)
        })
        .catch((error: unknown) => {
          if (!this.#abort.signal.aborted) process.stderr.write(`dsh-weixin: delivery failed: ${error instanceof Error ? error.message : String(error)}\n`)
        })
    })
    void this.#startLoop().catch((error: unknown) => {
      if (!this.#abort.signal.aborted) process.stderr.write(`dsh-weixin: gateway stopped: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }

  async #startLoop(): Promise<void> {
    await this.#drainStoredOutbox()
    await this.#pollLoop()
  }

  async dispose(): Promise<void> {
    this.#abort.abort()
    await Promise.all([...this.#chats.values()].map(async state => { await state.handle.dispose() }))
  }

  async #deliver(chatId: string, state: ChatState): Promise<void> {
    const output = assistantText(state.handle.agent.session.events, state.sentThroughSeq)
    if (output.text === '') {
      state.sentThroughSeq = output.seq
      return
    }
    this.#store.state.outbox[chatId] = { chunks: splitText(output.text, this.#config.maxMessageChars), next: 0 }
    await this.#store.save()
    await this.#drainOutbox(chatId)
    if (!this.#abort.signal.aborted && this.#store.state.outbox[chatId] === undefined) state.sentThroughSeq = output.seq
  }

  async #drainStoredOutbox(): Promise<void> {
    for (const chatId of Object.keys(this.#store.state.outbox)) {
      if (this.#abort.signal.aborted) return
      await this.#drainOutbox(chatId)
    }
  }

  async #drainOutbox(chatId: string): Promise<void> {
    const item = this.#store.state.outbox[chatId]
    if (item === undefined) return
    while (item.next < item.chunks.length && !this.#abort.signal.aborted) {
      await this.#sendWithRetry(chatId, item.chunks[item.next]!)
      if (this.#abort.signal.aborted) return
      item.next += 1
      await this.#store.save()
    }
    if (item.next === item.chunks.length) {
      delete this.#store.state.outbox[chatId]
      await this.#store.save()
    }
  }

  async #sendWithRetry(chatId: string, text: string): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        await this.#client.sendText(chatId, text, this.#abort.signal)
        return
      } catch (error) {
        if (this.#abort.signal.aborted) return
        process.stderr.write(`dsh-weixin: send failed, retrying: ${error instanceof Error ? error.message : String(error)}\n`)
        await sleep(this.#config.retryDelayMs, this.#abort.signal)
      }
    }
  }

  async #pollLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        for (const message of await this.#client.poll(this.#abort.signal)) await this.#receive(message)
      } catch (error) {
        if (this.#abort.signal.aborted) return
        process.stderr.write(`dsh-weixin: ${error instanceof Error ? error.message : String(error)}\n`)
        await sleep(this.#config.retryDelayMs, this.#abort.signal)
      }
    }
  }

  async #receive(message: InboundMessage): Promise<void> {
    if (message.id !== '' && this.#seen.has(message.id)) return
    if (message.id !== '') {
      this.#seen.add(message.id)
      if (this.#seen.size > 2_000) this.#seen.delete(this.#seen.values().next().value!)
      this.#store.state.seenMessageIds = [...this.#seen]
      await this.#store.save()
    }
    if (!isAllowed(message, this.#config)) return
    if (message.text === '/status') {
      const state = this.#chats.get(message.chatId)
      await this.#sendWithRetry(message.chatId, state === undefined ? 'No active dsh session.' : `dsh session is ${state.handle.agent.status}.`)
      return
    }
    if (message.text === '/stop') {
      this.#chats.get(message.chatId)?.handle.agent.cancel({ kind: 'user' })
      await this.#sendWithRetry(message.chatId, 'Stop requested.')
      return
    }
    if (message.text === '/new') {
      await this.#dropChat(message.chatId)
      await this.#sendWithRetry(message.chatId, 'The next message will start a new dsh session.')
      return
    }
    const state = await this.#chat(message.chatId)
    state.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    }))
  }

  async #chat(chatId: string): Promise<ChatState> {
    const existing = this.#chats.get(chatId)
    if (existing !== undefined) return existing
    const selection = this.#ctx.agentDefaultModel.currentSelection()
    const setup = (agentCtx: Context): void => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    const persistedSession = this.#store.state.chats[chatId]
    let handle: AgentHandle
    if (persistedSession !== undefined) {
      try {
        handle = await this.#ctx.agents.resume({
          resumeSessionId: SessionId(persistedSession),
          agentOptions: { provider: selection.provider, model: selection.model },
          setup,
        })
      } catch (error) {
        process.stderr.write(`dsh-weixin: could not resume ${persistedSession}; starting a new session: ${error instanceof Error ? error.message : String(error)}\n`)
        delete this.#store.state.chats[chatId]
        handle = await this.#createAgent(selection, setup)
      }
    } else {
      handle = await this.#createAgent(selection, setup)
    }
    const state = { handle, sentThroughSeq: handle.agent.session.seq, delivery: Promise.resolve() }
    this.#chats.set(chatId, state)
    this.#agentChats.set(handle.agent, chatId)
    this.#store.state.chats[chatId] = handle.agent.id
    await this.#store.save()
    return state
  }

  async #createAgent(selection: { provider: string; model: string }, setup: (agentCtx: Context) => void): Promise<AgentHandle> {
    return await this.#ctx.agents.create({
      sessionId: SessionId(`weixin-${randomUUID()}`),
      meta: { cwd: this.#config.workspace },
      agentOptions: selection,
      setup,
    })
  }

  async #dropChat(chatId: string): Promise<void> {
    const state = this.#chats.get(chatId)
    if (state === undefined) return
    this.#chats.delete(chatId)
    this.#agentChats.delete(state.handle.agent)
    delete this.#store.state.chats[chatId]
    await this.#store.save()
    await state.handle.dispose()
  }
}

/** Mount the Weixin gateway and tie it to the Cordis lifecycle. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.allowedUsers.length === 0) {
    throw new Error('dsh-weixin: configure at least one allowed user')
  }
  const environmentToken = process.env[config.tokenEnv]?.trim()
  const credential = environmentToken === undefined || environmentToken === ''
    ? await (async () => {
        if (!await pathExists(config.credentialPath)) {
          throw new Error(`dsh-weixin: ${config.tokenEnv} is not set and ${config.credentialPath} does not exist; run dsh-weixin login`)
        }
        return await readCredential(config.credentialPath)
      })()
    : undefined
  await ctx.get('loader')?.await()
  const gatewayState = await loadGatewayState(config.statePath)
  const gateway = new WeixinGateway(ctx, config, {
    token: environmentToken ?? credential!.token,
    accountId: config.accountId ?? credential?.accountId,
    apiBase: config.apiBase || credential?.apiBase || 'https://ilinkai.weixin.qq.com',
  }, new GatewayStateStore(config.statePath, gatewayState))
  gateway.start()
  ctx.effect(() => async () => { await gateway.dispose() })
}

export { ILinkClient } from './protocol.js'
export type { InboundMessage, ILinkClientOptions } from './protocol.js'
