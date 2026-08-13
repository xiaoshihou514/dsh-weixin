/** Weixin iLink QR login flow. */

import { setTimeout as delay } from 'node:timers/promises'
import { defaultCredentialPath, writePrivateJson } from './files.js'
import type { StoredCredential } from './files.js'
import { validateApiBase } from './protocol.js'

const DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com'
const APP_ID = 'bot'
const CLIENT_VERSION = (2 << 16) | (2 << 8)

interface LoginSession {
  qrcode: string
  display: string
  apiBase: string
}

interface LoginOptions {
  apiBase?: string
  credentialPath?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  signal?: AbortSignal
}

async function getJson(fetch: typeof globalThis.fetch, apiBase: string, path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  validateApiBase(apiBase)
  const timeout = AbortSignal.timeout(30_000)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, {
    signal: requestSignal,
    redirect: 'error',
    headers: {
      'ilink-app-id': APP_ID,
      'ilink-app-clientversion': String(CLIENT_VERSION),
    },
  })
  const responseText = await response.text()
  if (responseText.length > 2 * 1024 * 1024) throw new Error('Weixin login response exceeded 2 MiB')
  if (!response.ok) throw new Error(`Weixin login HTTP ${response.status}: ${responseText.slice(0, 500)}`)
  const value: unknown = JSON.parse(responseText)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Weixin login returned a non-object response')
  return value as Record<string, unknown>
}

async function startLogin(fetch: typeof globalThis.fetch, apiBase: string, signal?: AbortSignal): Promise<LoginSession> {
  const result = await getJson(fetch, apiBase, '/ilink/bot/get_bot_qrcode?bot_type=3', signal)
  const qrcode = typeof result.qrcode === 'string' ? result.qrcode : ''
  const display = typeof result.qrcode_img_content === 'string' ? result.qrcode_img_content : qrcode
  if (qrcode === '') throw new Error('Weixin QR response did not include qrcode')
  return { qrcode, display, apiBase }
}

function confirmedCredential(result: Record<string, unknown>, fallbackApiBase: string): StoredCredential | undefined {
  if (result.status !== 'confirmed') return undefined
  const accountId = typeof result.ilink_bot_id === 'string' ? result.ilink_bot_id : ''
  const token = typeof result.bot_token === 'string' ? result.bot_token : ''
  if (accountId === '' || token === '') throw new Error('Weixin confirmed the login without complete credentials')
  return {
    accountId,
    token,
    apiBase: typeof result.baseurl === 'string' && result.baseurl !== '' ? result.baseurl : fallbackApiBase,
    userId: typeof result.ilink_user_id === 'string' ? result.ilink_user_id : undefined,
    savedAt: new Date().toISOString(),
  }
}

/** Complete QR login and save the credential to a private file. */
export async function login(options: LoginOptions = {}): Promise<{ credentialPath: string; credential: StoredCredential }> {
  const fetch = options.fetch ?? globalThis.fetch
  const stdout = options.stdout ?? process.stdout
  const credentialPath = options.credentialPath ?? defaultCredentialPath()
  const timeoutMs = options.timeoutMs ?? 8 * 60_000
  const session = await startLogin(fetch, options.apiBase ?? DEFAULT_API_BASE, options.signal)
  stdout.write(`Open or scan this Weixin QR code:\n${session.display}\n`)
  const deadline = Date.now() + timeoutMs
  let apiBase = session.apiBase
  while (Date.now() < deadline) {
    await delay(1_000, undefined, { signal: options.signal })
    const result = await getJson(fetch, apiBase, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`, options.signal)
    if (result.status === 'expired') throw new Error('Weixin QR code expired; run login again')
    if (result.status === 'scaned_but_redirect' && typeof result.redirect_host === 'string' && result.redirect_host !== '') {
      apiBase = `https://${result.redirect_host}`
      continue
    }
    const credential = confirmedCredential(result, apiBase)
    if (credential === undefined) continue
    await writePrivateJson(credentialPath, credential)
    return { credentialPath, credential }
  }
  throw new Error('Weixin login timed out')
}
