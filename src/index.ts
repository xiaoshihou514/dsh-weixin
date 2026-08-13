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

/** Stable Cordis plugin name. */
export const name = 'weixin'

/** Harness services needed to create and drive remote agents. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Weixin gateway configuration. */
export interface Config {
  tokenEnv: string
  credentialPath: string
  accountId?: string
  apiBase: string
  workspace: string
  allowedUsers: string[]
  allowedGroups: string[]
  retryDelayMs: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  tokenEnv: z.string().default('WEIXIN_BOT_TOKEN'),
  credentialPath: z.string().default(defaultCredentialPath()),
  accountId: z.string(),
  apiBase: z.string().default(''),
  workspace: z.string().required(),
  allowedUsers: z.array(String).default([]),
  allowedGroups: z.array(String).default([]),
  retryDelayMs: z.number().min(100).default(5_000),
})

interface ChatState {
  handle: AgentHandle
  sentThroughSeq: number
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

function isAllowed(message: InboundMessage, config: Config): boolean {
  return message.group
    ? config.allowedGroups.includes(message.chatId)
    : config.allowedUsers.includes(message.userId)
}

class WeixinGateway {
  readonly #ctx: Context
  readonly #config: Config
  readonly #client: ILinkClient
  readonly #abort = new AbortController()
  readonly #chats = new Map<string, ChatState>()
  readonly #agentChats = new Map<Agent, string>()
  readonly #seen = new Set<string>()

  constructor(ctx: Context, config: Config, connection: { token: string; accountId?: string; apiBase: string }) {
    this.#ctx = ctx
    this.#config = config
    this.#client = new ILinkClient(connection)
  }

  start(): void {
    this.#ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = this.#ctx.agents.get(session.id)
      const chatId = agent === undefined ? undefined : this.#agentChats.get(agent)
      if (chatId === undefined) return
      const state = this.#chats.get(chatId)
      if (state === undefined) return
      const output = assistantText(session.events, state.sentThroughSeq)
      state.sentThroughSeq = output.seq
      if (output.text !== '') void this.#send(chatId, output.text)
    })
    void this.#pollLoop()
  }

  async dispose(): Promise<void> {
    this.#abort.abort()
    await Promise.all([...this.#chats.values()].map(async state => { await state.handle.dispose() }))
  }

  async #send(chatId: string, text: string): Promise<void> {
    try {
      await this.#client.sendText(chatId, text, this.#abort.signal)
    } catch (error) {
      if (!this.#abort.signal.aborted) {
        process.stderr.write(`dsh-weixin: send failed: ${error instanceof Error ? error.message : String(error)}\n`)
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
    }
    if (!isAllowed(message, this.#config)) return
    if (message.text === '/status') {
      const state = this.#chats.get(message.chatId)
      await this.#client.sendText(message.chatId, state === undefined ? 'No active dsh session.' : `dsh session is ${state.handle.agent.status}.`, this.#abort.signal)
      return
    }
    if (message.text === '/stop') {
      this.#chats.get(message.chatId)?.handle.agent.cancel({ kind: 'user' })
      await this.#client.sendText(message.chatId, 'Stop requested.', this.#abort.signal)
      return
    }
    if (message.text === '/new') {
      await this.#dropChat(message.chatId)
      await this.#client.sendText(message.chatId, 'Started a new dsh session.', this.#abort.signal)
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
    const handle = await this.#ctx.agents.create({
      sessionId: SessionId(`weixin-${randomUUID()}`),
      meta: { cwd: this.#config.workspace },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    const state = { handle, sentThroughSeq: handle.agent.session.seq }
    this.#chats.set(chatId, state)
    this.#agentChats.set(handle.agent, chatId)
    return state
  }

  async #dropChat(chatId: string): Promise<void> {
    const state = this.#chats.get(chatId)
    if (state === undefined) return
    this.#chats.delete(chatId)
    this.#agentChats.delete(state.handle.agent)
    await state.handle.dispose()
  }
}

/** Mount the Weixin gateway and tie it to the Cordis lifecycle. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.allowedUsers.length === 0 && config.allowedGroups.length === 0) {
    throw new Error('dsh-weixin: configure at least one allowed user or group')
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
  const gateway = new WeixinGateway(ctx, config, {
    token: environmentToken ?? credential!.token,
    accountId: config.accountId ?? credential?.accountId,
    apiBase: config.apiBase || credential?.apiBase || 'https://ilinkai.weixin.qq.com',
  })
  gateway.start()
  ctx.effect(() => async () => { await gateway.dispose() })
}

export { ILinkClient } from './protocol.js'
export type { InboundMessage, ILinkClientOptions } from './protocol.js'
