/** Weixin remote-control bundle for DeepSeek Harness. */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ILinkClient } from './protocol.js'
import type { InboundMessage } from './protocol.js'
import { defaultCredentialPath, pathExists, readCredential } from './files.js'
import { defaultStatePath, GatewayStateStore, loadGatewayState } from './state.js'
import { contentUserMessage, installSelection, sessionId } from './harness.js'
import { extractFileDirectives, resolveWorkspaceFile, saveInboundMedia } from './media.js'
import { mountLoginRoute } from './web-route.js'

/** Stable Cordis plugin name. */
export const name = 'weixin'

/** Harness services needed to create and drive remote agents. */
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'permissionPresets', 'sessions', 'sessionTitle']

/** Weixin gateway configuration. */
export interface Config {
  tokenEnv: string
  credentialPath: string
  statePath: string
  accountId?: string
  apiBase: string
  cdnBase: string
  workspace: string
  mediaDir: string
  allowedUsers: string[]
  allowedGroups: string[]
  retryDelayMs: number
  emptyPollDelayMs: number
  maxMessageChars: number
  maxMediaBytes: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  tokenEnv: z.string().default('WEIXIN_BOT_TOKEN'),
  credentialPath: z.string().default(defaultCredentialPath()),
  statePath: z.string().default(defaultStatePath()),
  accountId: z.string(),
  apiBase: z.string().default(''),
  cdnBase: z.string().default('https://novac2c.cdn.weixin.qq.com/c2c'),
  workspace: z.string().default(homedir()),
  mediaDir: z.string().default(''),
  allowedUsers: z.array(String).default([]),
  allowedGroups: z.array(String).default([]),
  retryDelayMs: z.number().min(100).default(5_000),
  emptyPollDelayMs: z.number().min(10).default(250),
  maxMessageChars: z.number().min(100).max(10_000).default(3_500),
  maxMediaBytes: z.number().min(1_024).max(512 * 1024 * 1024).default(100 * 1024 * 1024),
})

interface ChatState {
  handle: AgentHandle
  sentThroughSeq: number
  delivery: Promise<void>
  typing: Promise<void>
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
      cdnBase: config.cdnBase,
      maxMediaBytes: config.maxMediaBytes,
    })
  }

  start(): void {
    this.#ctx.on('agent/disposed', ({ agent }) => {
      const chatId = this.#agentChats.get(agent)
      if (chatId === undefined) return
      this.#agentChats.delete(agent)
      const state = this.#chats.get(chatId)
      if (state?.handle.agent === agent) this.#chats.delete(chatId)
      // Keep the durable chat -> session mapping. The next inbound message
      // attaches to a new Web-owned instance or resumes the persisted session.
    })
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
    await state.typing
    void this.#client.sendTyping(chatId, false, this.#abort.signal).catch(() => undefined)
    const output = assistantText(state.handle.agent.session.events, state.sentThroughSeq)
    if (output.text === '') {
      state.sentThroughSeq = output.seq
      return
    }
    const delivery = extractFileDirectives(output.text)
    const chunks = delivery.text === '' ? [] : splitText(delivery.text, this.#config.maxMessageChars)
    this.#store.state.outbox[chatId] = { chunks, files: delivery.files, next: 0, nextFile: 0 }
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
    while (item.nextFile < item.files.length && !this.#abort.signal.aborted) {
      const requested = item.files[item.nextFile]!
      try {
        const file = await resolveWorkspaceFile(this.#config.workspace, requested, this.#config.maxMediaBytes)
        await this.#sendMediaWithRetry(chatId, file.name, file.bytes)
      } catch (error) {
        if (this.#abort.signal.aborted) return
        process.stderr.write(`dsh-weixin: rejected outbound file ${JSON.stringify(requested)}: ${error instanceof Error ? error.message : String(error)}\n`)
        await this.#sendWithRetry(chatId, `I couldn't send the requested file ${JSON.stringify(requested)} because it is unavailable, outside the workspace, or too large.`)
      }
      if (this.#abort.signal.aborted) return
      item.nextFile += 1
      await this.#store.save()
    }
    if (item.next === item.chunks.length && item.nextFile === item.files.length) {
      delete this.#store.state.outbox[chatId]
      await this.#store.save()
    }
  }

  async #sendMediaWithRetry(chatId: string, name: string, data: Uint8Array): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        await this.#client.sendMedia(chatId, name, data, this.#abort.signal)
        return
      } catch (error) {
        if (this.#abort.signal.aborted) return
        process.stderr.write(`dsh-weixin: media send failed, retrying: ${error instanceof Error ? error.message : String(error)}\n`)
        await sleep(this.#config.retryDelayMs, this.#abort.signal)
      }
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
        const messages = await this.#client.poll(this.#abort.signal)
        for (const message of messages) await this.#receive(message)
        if (messages.length === 0) await sleep(this.#config.emptyPollDelayMs, this.#abort.signal)
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
    const blocks: Parameters<typeof contentUserMessage>[0] = []
    if (message.text !== '') blocks.push({ type: 'text', text: message.text })
    const paths: string[] = []
    const mediaRoot = this.#config.mediaDir || `${this.#config.workspace}/.dsh-weixin/inbox`
    for (const media of message.media) {
      const path = await saveInboundMedia(mediaRoot, message.chatId, media)
      paths.push(path)
      if (media.kind === 'image') {
        const attachments = this.#ctx.get('attachments')
        if (attachments !== undefined && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(media.mediaType)) {
          try {
            const attachment = await attachments.saveImage({ data: media.data, mediaType: media.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', name: media.name })
            blocks.push({ type: 'image', attachment })
          } catch (error) {
            process.stderr.write(`dsh-weixin: image attachment storage failed, using local file: ${error instanceof Error ? error.message : String(error)}\n`)
          }
        }
      }
    }
    if (message.mediaErrors.length > 0) blocks.push({ type: 'text', text: `Some Weixin attachments could not be received:\n${message.mediaErrors.map(error => `- ${error}`).join('\n')}` })
    if (paths.length > 0) blocks.push({ type: 'text', text: `Weixin attachments saved in the workspace:\n${paths.map(path => `- ${path}`).join('\n')}` })
    state.typing = this.#client.sendTyping(message.chatId, true, this.#abort.signal).catch(() => undefined)
    state.handle.agent.followup(contentUserMessage(blocks))
  }

  async #chat(chatId: string): Promise<ChatState> {
    const existing = this.#chats.get(chatId)
    if (existing !== undefined) return existing
    const selection = this.#ctx.agentDefaultModel.currentSelection()
    const setup = async (agentCtx: Context): Promise<void> => {
      const agentPresets = this.#ctx.get('agentPresets') as { mount(agentCtx: Context): Promise<unknown> } | undefined
      if (agentPresets === undefined) throw new Error('dsh-weixin: agentPresets service is unavailable')
      await agentPresets.mount(agentCtx)
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installSelection(agentCtx, selected, [
        'This session is connected to a Weixin chat and is visible in the Harness web UI.',
        'Files received from Weixin are saved in the workspace and listed by absolute path in the user message.',
        'To send a workspace file back to Weixin, put this directive on its own line in your final response: [[send-file:relative/or/absolute/path]].',
        'Only request a file delivery when the user asked for it or it is clearly necessary. The directive is removed from the text delivered to Weixin.',
      ].join('\n'))
    }
    const persistedSession = this.#store.state.chats[chatId]
    let handle: AgentHandle
    if (persistedSession !== undefined) {
      const active = this.#ctx.agents.get(sessionId(persistedSession))
      if (active !== undefined) {
        // The Web UI or another root consumer may already own this top-level
        // agent. Attach without acquiring its teardown capability: /new and
        // plugin unload must not destroy a session owned elsewhere.
        handle = { agent: active, dispose: () => Promise.resolve() }
      } else {
        try {
          handle = await this.#ctx.agents.resume({
            resumeSessionId: sessionId(persistedSession),
            agentOptions: { provider: selection.provider, model: selection.model },
            setup,
          })
        } catch (error) {
          process.stderr.write(`dsh-weixin: could not resume ${persistedSession}; starting a new session: ${error instanceof Error ? error.message : String(error)}\n`)
          delete this.#store.state.chats[chatId]
          handle = await this.#createAgent(selection, setup)
        }
      }
    } else {
      handle = await this.#createAgent(selection, setup)
    }
    const state = { handle, sentThroughSeq: handle.agent.session.seq, delivery: Promise.resolve(), typing: Promise.resolve() }
    const permissionPresets = this.#ctx.get('permissionPresets') as { set(session: Agent['session'], name: string): void } | undefined
    if (permissionPresets === undefined) throw new Error('dsh-weixin: permissionPresets service is unavailable')
    permissionPresets.set(handle.agent.session, 'workspace-write')
    const planMode = handle.agent.ctx.get('planMode') as { set(agent: Agent, active: boolean): unknown } | undefined
    planMode?.set(handle.agent, false)
    const sessionTitle = this.#ctx.get('sessionTitle') as { rename(session: Agent['session'], title: string): unknown } | undefined
    if (sessionTitle === undefined) throw new Error('dsh-weixin: sessionTitle service is unavailable')
    sessionTitle.rename(handle.agent.session, '微信')
    this.#chats.set(chatId, state)
    this.#agentChats.set(handle.agent, chatId)
    this.#store.state.chats[chatId] = handle.agent.id
    await this.#store.save()
    return state
  }

  async #createAgent(selection: { provider: string; model: string }, setup: (agentCtx: Context) => Promise<void>): Promise<AgentHandle> {
    return await this.#ctx.agents.create({
      sessionId: sessionId(`weixin-${randomUUID()}`),
      meta: { cwd: this.#config.workspace },
      agentOptions: selection,
      setup,
    })
  }

  async #dropChat(chatId: string): Promise<void> {
    const state = this.#chats.get(chatId)
    delete this.#store.state.chats[chatId]
    await this.#store.save()
    if (state === undefined) return
    this.#chats.delete(chatId)
    this.#agentChats.delete(state.handle.agent)
    await state.handle.dispose()
  }
}

/** Mount the Weixin gateway and tie it to the Cordis lifecycle. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let gateway: WeixinGateway | undefined
  const startGateway = async (): Promise<void> => {
    if (gateway !== undefined) return
    const environmentToken = process.env[config.tokenEnv]?.trim()
    const credential = await (pathExists(config.credentialPath).then(async exists => exists ? await readCredential(config.credentialPath) : undefined))
    const token = environmentToken || credential?.token
    if (token === undefined || token === '') return
    const allowedUsers = config.allowedUsers.length > 0
      ? config.allowedUsers
      : credential?.userId === undefined || credential.userId === '' ? [] : [credential.userId]
    if (allowedUsers.length === 0) return
    gateway = new WeixinGateway(ctx, { ...config, allowedUsers }, {
      token,
      accountId: config.accountId ?? credential?.accountId,
      apiBase: config.apiBase || credential?.apiBase || 'https://ilinkai.weixin.qq.com',
    }, new GatewayStateStore(config.statePath, await loadGatewayState(config.statePath)))
    gateway.start()
  }
  mountLoginRoute(ctx, { credentialPath: config.credentialPath, apiBase: config.apiBase || undefined, onCredential: startGateway })
  await startGateway()
  if (gateway === undefined) process.stderr.write('dsh-weixin: connect at /dsh-weixin/login in Harness Web, or run npx dsh-weixin login --web.\n')
  ctx.effect(() => async () => { await gateway?.dispose() })
}

export { ILinkClient } from './protocol.js'
export type { InboundMessage, ILinkClientOptions } from './protocol.js'
