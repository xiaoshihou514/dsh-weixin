/** Weixin iLink HTTP protocol client. */

import { randomBytes, randomUUID } from 'node:crypto'

const CHANNEL_VERSION = '2.2.0'
const CLIENT_VERSION = (2 << 16) | (2 << 8)

interface ILinkTextItem {
  type: number
  text_item?: { text?: string }
}

interface ILinkMessage {
  message_id?: string | number
  from_user_id?: string
  to_user_id?: string
  room_id?: string
  chat_room_id?: string
  context_token?: string
  msg_type?: number
  item_list?: ILinkTextItem[]
}

interface UpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: ILinkMessage[]
  get_updates_buf?: string
}

/** Normalized inbound text message. */
export interface InboundMessage {
  id: string
  chatId: string
  userId: string
  group: boolean
  text: string
}

/** Configuration needed by the iLink client. */
export interface ILinkClientOptions {
  token: string
  accountId?: string
  apiBase: string
  fetch?: typeof globalThis.fetch
  state?: ILinkClientState
  onStateChange?: (state: ILinkClientState) => Promise<void> | void
}

/** Poll cursor and conversation tokens safe to persist without credentials. */
export interface ILinkClientState {
  updatesBuffer: string
  contextTokens: Record<string, string>
}

/** Minimal iLink client for polling and sending plain text. */
export class ILinkClient {
  readonly #token: string
  readonly #accountId: string
  readonly #apiBase: string
  readonly #fetch: typeof globalThis.fetch
  readonly #onStateChange: ((state: ILinkClientState) => Promise<void> | void) | undefined
  readonly #contextTokens = new Map<string, string>()
  #updatesBuffer: string

  /** Create an iLink protocol client. */
  constructor(options: ILinkClientOptions) {
    this.#token = options.token
    this.#accountId = options.accountId ?? ''
    this.#apiBase = options.apiBase.replace(/\/$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#updatesBuffer = options.state?.updatesBuffer ?? ''
    this.#onStateChange = options.onStateChange
    for (const [chatId, token] of Object.entries(options.state?.contextTokens ?? {})) this.#contextTokens.set(chatId, token)
  }

  /** Poll once, waiting on the server until updates are available. */
  async poll(signal: AbortSignal): Promise<InboundMessage[]> {
    const result = await this.#post<UpdatesResponse>('/ilink/bot/getupdates', {
      get_updates_buf: this.#updatesBuffer,
      base_info: { channel_version: CHANNEL_VERSION },
    }, signal)
    this.#assertSuccess(result, 'getupdates')
    let stateChanged = false
    if (result.get_updates_buf !== undefined && result.get_updates_buf !== this.#updatesBuffer) {
      this.#updatesBuffer = result.get_updates_buf
      stateChanged = true
    }
    const messages: InboundMessage[] = []
    for (const message of result.msgs ?? []) {
      const userId = message.from_user_id ?? ''
      if (userId === '' || userId === this.#accountId) continue
      const text = (message.item_list ?? [])
        .filter(item => item.type === 1)
        .map(item => item.text_item?.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim()
      if (text === '') continue
      const roomId = message.room_id || message.chat_room_id
      const group = roomId !== undefined && roomId !== ''
      const chatId = group ? roomId : userId
      if (message.context_token !== undefined && message.context_token !== '') {
        this.#contextTokens.set(chatId, message.context_token)
        stateChanged = true
      }
      messages.push({
        id: String(message.message_id ?? ''),
        chatId,
        userId,
        group,
        text,
      })
    }
    if (stateChanged) await this.#notifyStateChange()
    return messages
  }

  /** Send one plain-text response to a conversation. */
  async sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    const msg: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `dsh-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    }
    const contextToken = this.#contextTokens.get(chatId)
    if (contextToken !== undefined) msg.context_token = contextToken
    const result = await this.#post<UpdatesResponse>('/ilink/bot/sendmessage', {
      base_info: { channel_version: CHANNEL_VERSION },
      msg,
    }, signal)
    try {
      this.#assertSuccess(result, 'sendmessage')
    } catch (error) {
      if (contextToken === undefined) throw error
      this.#contextTokens.delete(chatId)
      await this.#notifyStateChange()
      await this.sendText(chatId, text, signal)
    }
  }

  #state(): ILinkClientState {
    return { updatesBuffer: this.#updatesBuffer, contextTokens: Object.fromEntries(this.#contextTokens) }
  }

  async #notifyStateChange(): Promise<void> {
    await this.#onStateChange?.(this.#state())
  }

  async #post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const body = JSON.stringify(payload)
    const uin = randomBytes(4).readUInt32BE().toString()
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorizationtype: 'ilink_bot_token',
        authorization: `Bearer ${this.#token}`,
        'x-wechat-uin': Buffer.from(uin).toString('base64'),
        'ilink-app-id': 'bot',
        'ilink-app-clientversion': String(CLIENT_VERSION),
      },
      body,
    })
    if (!response.ok) throw new Error(`Weixin HTTP ${response.status}: ${await response.text()}`)
    return await response.json() as T
  }

  #assertSuccess(result: UpdatesResponse, operation: string): void {
    if ((result.ret ?? 0) !== 0 || (result.errcode ?? 0) !== 0) {
      throw new Error(`${operation} failed (ret=${result.ret ?? 0}, errcode=${result.errcode ?? 0}): ${result.errmsg ?? 'unknown error'}`)
    }
  }
}
