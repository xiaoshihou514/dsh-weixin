/** Weixin iLink HTTP protocol client. */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  classifyOutbound,
  decryptMedia,
  encryptMedia,
  mediaTypeForName,
  paddedSize,
  safeFileName,
  uploadMediaType,
  type CdnMediaRef,
  type InboundMedia,
  type MediaKind,
  type WireMediaItem,
} from './media.js'

const CHANNEL_VERSION = '2.2.0'
const CLIENT_VERSION = (2 << 16) | (2 << 8)
const BOT_AGENT = 'DeepSeek'

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

interface ILinkTextItem {
  type: number
  text_item?: { text?: string }
  image_item?: WireMediaItem['image_item']
  voice_item?: WireMediaItem['voice_item']
  file_item?: WireMediaItem['file_item']
  video_item?: WireMediaItem['video_item']
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
  updates?: Array<{
    update_type?: string
    message?: {
      message_id?: string | number
      chat_id?: string
      chat_type?: string
      from?: { user_id?: string }
      text?: string
    }
  }>
}

interface UploadResponse extends UpdatesResponse {
  upload_param?: string
  upload_full_url?: string
}

interface ConfigResponse extends UpdatesResponse {
  typing_ticket?: string
}

interface DownloadSpec {
  kind: MediaKind
  ref?: CdnMediaRef
  key?: string
  name: string
}

function downloadSpec(item: ILinkTextItem): DownloadSpec | undefined {
  switch (item.type) {
    case 2:
      return {
        kind: 'image',
        ref: item.image_item?.media,
        key: item.image_item?.aeskey === undefined
          ? item.image_item?.media?.aes_key
          : Buffer.from(item.image_item.aeskey, 'hex').toString('base64'),
        name: 'image.jpg',
      }
    case 3:
      return { kind: 'voice', ref: item.voice_item?.media, key: item.voice_item?.media?.aes_key, name: 'voice.silk' }
    case 4:
      return { kind: 'file', ref: item.file_item?.media, key: item.file_item?.media?.aes_key, name: safeFileName(item.file_item?.file_name ?? '', 'file.bin') }
    case 5:
      return { kind: 'video', ref: item.video_item?.media, key: item.video_item?.media?.aes_key, name: 'video.mp4' }
    default:
      return undefined
  }
}

const MAX_RESPONSE_CHARS = 2 * 1024 * 1024

/** Validate an iLink API base before credentials can be sent to it. */
export function validateApiBase(apiBase: string): void {
  const parsed = new URL(apiBase)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'))) {
    throw new Error('Weixin API base must use HTTPS (HTTP is allowed only for loopback tests)')
  }
}

/** Normalized inbound text message. */
export interface InboundMessage {
  id: string
  chatId: string
  userId: string
  group: boolean
  text: string
  media: InboundMedia[]
  mediaErrors: string[]
}

/** Configuration needed by the iLink client. */
export interface ILinkClientOptions {
  token: string
  accountId?: string
  apiBase: string
  fetch?: typeof globalThis.fetch
  state?: ILinkClientState
  onStateChange?: (state: ILinkClientState) => Promise<void> | void
  requestTimeoutMs?: number
  cdnBase?: string
  maxMediaBytes?: number
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
  readonly #requestTimeoutMs: number
  readonly #cdnBase: string
  readonly #maxMediaBytes: number
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
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 90_000
    this.#cdnBase = (options.cdnBase ?? 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/$/, '')
    this.#maxMediaBytes = options.maxMediaBytes ?? 100 * 1024 * 1024
    validateApiBase(this.#apiBase)
    validateApiBase(this.#cdnBase)
    for (const [chatId, token] of Object.entries(options.state?.contextTokens ?? {})) this.#contextTokens.set(chatId, token)
  }

  /** Poll once, waiting on the server until updates are available. */
  async poll(signal: AbortSignal): Promise<InboundMessage[]> {
    const result = await this.#post<UpdatesResponse>('/ilink/bot/getupdates', {
      get_updates_buf: this.#updatesBuffer,
      base_info: baseInfo(),
    }, signal)
    this.#assertSuccess(result, 'getupdates')
    let stateChanged = false
    if (result.get_updates_buf !== undefined && result.get_updates_buf !== this.#updatesBuffer) {
      this.#updatesBuffer = result.get_updates_buf
      stateChanged = true
    }
    if (stateChanged) {
      await this.#notifyStateChange()
      stateChanged = false
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
      const downloaded = await this.#downloadItems(message.item_list ?? [], signal)
      if (text === '' && downloaded.media.length === 0 && downloaded.errors.length === 0) continue
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
        media: downloaded.media,
        mediaErrors: downloaded.errors,
      })
    }
    for (const update of result.updates ?? []) {
      const message = update.message
      if (update.update_type !== 'message' || message === undefined) continue
      const userId = message.from?.user_id ?? ''
      const chatId = message.chat_id ?? ''
      const text = message.text?.trim() ?? ''
      if (userId === '' || userId === this.#accountId || chatId === '' || text === '') continue
      messages.push({ id: String(message.message_id ?? ''), chatId, userId, group: message.chat_type === 'group', text, media: [], mediaErrors: [] })
    }
    if (stateChanged) await this.#notifyStateChange()
    return messages
  }

  /** Send one plain-text response to a conversation. */
  async sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.#sendItems(chatId, [{ type: 1, text_item: { text } }], signal)
  }

  /** Send or clear Weixin's typing indicator using the required per-chat ticket. */
  async sendTyping(chatId: string, typing: boolean, signal?: AbortSignal): Promise<void> {
    const typingTimeout = AbortSignal.timeout(Math.min(this.#requestTimeoutMs, 5_000))
    const requestSignal = signal === undefined ? typingTimeout : AbortSignal.any([signal, typingTimeout])
    const contextToken = this.#contextTokens.get(chatId)
    const config = await this.#post<ConfigResponse>('/ilink/bot/getconfig', {
      ilink_user_id: chatId,
      ...(contextToken === undefined ? {} : { context_token: contextToken }),
      base_info: baseInfo(),
    }, requestSignal)
    this.#assertSuccess(config, 'getconfig')
    if (config.typing_ticket === undefined || config.typing_ticket === '') throw new Error('getconfig omitted typing_ticket')
    const result = await this.#post<UpdatesResponse>('/ilink/bot/sendtyping', {
      ilink_user_id: chatId,
      typing_ticket: config.typing_ticket,
      status: typing ? 1 : 2,
      base_info: baseInfo(),
    }, requestSignal)
    this.#assertSuccess(result, 'sendtyping')
  }

  /** Encrypt, upload, and send one local attachment through the native Weixin media path. */
  async sendMedia(chatId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (data.byteLength > this.#maxMediaBytes) throw new Error(`Weixin media exceeds ${this.#maxMediaBytes} bytes`)
    const kind = classifyOutbound(name)
    const filekey = randomBytes(16).toString('hex')
    const key = randomBytes(16)
    const ciphertext = encryptMedia(data, key)
    const upload = await this.#post<UploadResponse>('/ilink/bot/getuploadurl', {
      filekey,
      media_type: uploadMediaType(kind),
      to_user_id: chatId,
      rawsize: data.byteLength,
      rawfilemd5: createHash('md5').update(data).digest('hex'),
      filesize: paddedSize(data.byteLength),
      no_need_thumb: true,
      aeskey: key.toString('hex'),
      base_info: baseInfo(),
    }, signal)
    this.#assertSuccess(upload, 'getuploadurl')
    const uploadUrl = upload.upload_full_url?.trim() || (upload.upload_param === undefined ? '' : `${this.#cdnBase}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`)
    if (uploadUrl === '') throw new Error('getuploadurl did not return an upload URL')
    this.#validateMediaUrl(uploadUrl)
    const response = await this.#fetch(uploadUrl, {
      method: 'POST', signal, redirect: 'error', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(ciphertext),
    })
    if (!response.ok) throw new Error(`Weixin CDN upload failed with HTTP ${response.status}`)
    const downloadParam = response.headers.get('x-encrypted-param')
    if (downloadParam === null || downloadParam === '') throw new Error('Weixin CDN upload omitted x-encrypted-param')
    const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }
    const item = kind === 'image'
      ? { type: 2, image_item: { media, mid_size: ciphertext.byteLength } }
      : kind === 'video'
        ? { type: 5, video_item: { media, video_size: ciphertext.byteLength } }
        : { type: 4, file_item: { media, file_name: safeFileName(name, 'file.bin'), len: String(data.byteLength) } }
    await this.#sendItems(chatId, [item], signal)
  }

  async #sendItems(chatId: string, items: unknown[], signal?: AbortSignal): Promise<void> {
    const msg: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `dsh-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: items,
    }
    const contextToken = this.#contextTokens.get(chatId)
    if (contextToken !== undefined) msg.context_token = contextToken
    const result = await this.#post<UpdatesResponse>('/ilink/bot/sendmessage', {
      base_info: baseInfo(),
      msg,
    }, signal)
    try {
      this.#assertSuccess(result, 'sendmessage')
    } catch (error) {
      if (contextToken === undefined) throw error
      this.#contextTokens.delete(chatId)
      await this.#notifyStateChange()
      await this.#sendItems(chatId, items, signal)
    }
  }

  async #downloadItems(items: ILinkTextItem[], signal: AbortSignal): Promise<{ media: InboundMedia[]; errors: string[] }> {
    const output: InboundMedia[] = []
    const errors: string[] = []
    for (const item of items) {
      const spec = downloadSpec(item)
      if (spec === undefined || spec.ref === undefined) continue
      try {
        if (spec.key === undefined) throw new Error('media AES key is missing')
        const url = spec.ref.full_url?.trim() || (spec.ref.encrypt_query_param === undefined ? '' : `${this.#cdnBase}/download?encrypted_query_param=${encodeURIComponent(spec.ref.encrypt_query_param)}`)
        if (url === '') throw new Error('media download URL is missing')
        this.#validateMediaUrl(url)
        const response = await this.#fetch(url, { signal, redirect: 'error' })
        if (!response.ok) throw new Error(`CDN download failed with HTTP ${response.status}`)
        const declared = Number(response.headers.get('content-length') ?? 0)
        if (declared > this.#maxMediaBytes + 16) throw new Error(`media exceeds ${this.#maxMediaBytes} bytes`)
        const encrypted = new Uint8Array(await response.arrayBuffer())
        if (encrypted.byteLength > this.#maxMediaBytes + 16) throw new Error(`media exceeds ${this.#maxMediaBytes} bytes`)
        const data = decryptMedia(encrypted, spec.key)
        if (data.byteLength > this.#maxMediaBytes) throw new Error(`media exceeds ${this.#maxMediaBytes} bytes`)
        output.push({ kind: spec.kind, name: spec.name, mediaType: mediaTypeForName(spec.name, spec.kind), data })
      } catch (error) {
        if (signal.aborted) throw error
        errors.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { media: output, errors }
  }

  #validateMediaUrl(value: string): void {
    const parsed = new URL(value)
    const cdn = new URL(this.#cdnBase)
    if (parsed.protocol !== cdn.protocol || parsed.hostname !== cdn.hostname || parsed.port !== cdn.port) {
      throw new Error('Weixin media URL is outside the configured CDN origin')
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
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method: 'POST',
      signal: requestSignal,
      redirect: 'error',
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
    const responseText = await response.text()
    if (responseText.length > MAX_RESPONSE_CHARS) throw new Error('Weixin response exceeded 2 MiB')
    if (!response.ok) throw new Error(`Weixin HTTP ${response.status}: ${responseText.slice(0, 500)}`)
    return JSON.parse(responseText) as T
  }

  #assertSuccess(result: UpdatesResponse, operation: string): void {
    if ((result.ret ?? 0) !== 0 || (result.errcode ?? 0) !== 0) {
      throw new Error(`${operation} failed (ret=${result.ret ?? 0}, errcode=${result.errcode ?? 0}): ${result.errmsg ?? 'unknown error'}`)
    }
  }
}
