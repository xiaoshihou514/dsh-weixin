/** Weixin iLink QR login flow. */

import { setTimeout as delay } from 'node:timers/promises'
import { defaultCredentialPath, pathExists, readCredential, writePrivateJson } from './files.js'
import type { StoredCredential } from './files.js'
import { findReasonixAccountFiles, readReasonixCredential } from './reasonix.js'
import { validateApiBase } from './protocol.js'

const DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com'
const APP_ID = 'bot'
// Same channel generation as the polling protocol in protocol.ts and the
// Reasonix adapter (2.2.0). QR requests must not advertise a different
// protocol generation than the rest of the bot traffic.
const CLIENT_VERSION = (2 << 16) | (2 << 8)

// The iLink server long-polls get_qrcode_status: for an unscanned QR it holds
// the connection for ~30s before answering {status: "wait"}. The request
// timeout must be longer than that hold or every poll would be aborted by our
// own deadline and login could never observe a scan.
const STATUS_POLL_TIMEOUT_MS = 45_000

export interface LoginSession {
  qrcode: string
  display: string
  apiBase: string
  verifyCode?: string
}

interface LoginOptions {
  apiBase?: string
  credentialPath?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  signal?: AbortSignal
}

/** Collect every bot token this machine already owns so the iLink server can
 *  attribute (or replace) the scanned binding. Includes dsh-weixin's own
 *  credential and any saved Reasonix account. */
export async function collectLocalBotTokens(): Promise<string[]> {
  const tokens: string[] = []
  const ownPath = defaultCredentialPath()
  if (await pathExists(ownPath)) {
    try {
      const own = await readCredential(ownPath)
      if (own.token !== '') tokens.push(own.token)
    } catch {
      // Ignore a malformed own credential here; login will surface real errors.
    }
  }
  for (const path of await findReasonixAccountFiles()) {
    try {
      const account = await readReasonixCredential(path)
      if (account.token !== '') tokens.push(account.token)
    } catch {
      // Skip unusable Reasonix account files.
    }
  }
  return tokens
}

/** Adopt the credential for an already-bound Weixin account: dsh-weixin's own
 *  saved credential first, then the first usable saved Reasonix account. */
export async function adoptBoundCredential(): Promise<StoredCredential | undefined> {
  const ownPath = defaultCredentialPath()
  if (await pathExists(ownPath)) {
    try {
      return await readCredential(ownPath)
    } catch {
      // Fall through to Reasonix accounts.
    }
  }
  for (const path of await findReasonixAccountFiles()) {
    try {
      return await readReasonixCredential(path)
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

async function requestJson(fetch: typeof globalThis.fetch, apiBase: string, path: string, signal?: AbortSignal, body?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
  validateApiBase(apiBase)
  const timeout = AbortSignal.timeout(timeoutMs ?? 30_000)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: requestSignal,
    redirect: 'error',
    headers: {
      'ilink-app-id': APP_ID,
      'ilink-app-clientversion': String(CLIENT_VERSION),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const responseText = await response.text()
  if (responseText.length > 2 * 1024 * 1024) throw new Error('Weixin login response exceeded 2 MiB')
  if (!response.ok) throw new Error(`Weixin login HTTP ${response.status}: ${responseText.slice(0, 500)}`)
  const value: unknown = JSON.parse(responseText)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Weixin login returned a non-object response')
  return value as Record<string, unknown>
}

async function startLogin(fetch: typeof globalThis.fetch, apiBase: string, signal: AbortSignal | undefined, localTokenList: string[]): Promise<LoginSession> {
  // POST with the machine's known bot tokens. The iLink server uses
  // local_token_list to decide whether the scanned Weixin account is already
  // bound to this client: with a matching token it answers binded_redirect
  // (transfer the binding), otherwise it issues a fresh binding that replaces
  // the previous one — either way the old Reasonix connection is taken over.
  const result = await requestJson(fetch, apiBase, '/ilink/bot/get_bot_qrcode?bot_type=3', signal, { local_token_list: localTokenList })
  const qrcode = typeof result.qrcode === 'string' ? result.qrcode : ''
  const display = typeof result.qrcode_img_content === 'string' ? result.qrcode_img_content : qrcode
  if (qrcode === '') throw new Error('Weixin QR response did not include qrcode')
  return { qrcode, display, apiBase }
}

/** Start a reusable QR login session for a CLI or Web UI. */
export async function startLoginSession(options: Pick<LoginOptions, 'apiBase' | 'fetch' | 'signal'> = {}, localTokenList?: string[]): Promise<LoginSession> {
  const tokens = localTokenList ?? await collectLocalBotTokens()
  return await startLogin(options.fetch ?? globalThis.fetch, options.apiBase ?? DEFAULT_API_BASE, options.signal, tokens)
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

export type LoginPollResult =
  | { status: 'waiting' | 'scanned'; credential?: never }
  | { status: 'redirected'; credential?: never }
  | { status: 'needs-code' | 'code-blocked'; credential?: never }
  | { status: 'already-bound'; credential?: never }
  | { status: 'confirmed'; credential: StoredCredential }
  | { status: 'expired'; credential?: never }

/** Poll one QR session step; callers retain the mutable regional API base. */
export async function pollLoginSession(session: LoginSession, options: Pick<LoginOptions, 'fetch' | 'signal'> = {}): Promise<LoginPollResult> {
  const verify = session.verifyCode === undefined ? '' : `&verify_code=${encodeURIComponent(session.verifyCode)}`
  let result: Record<string, unknown>
  try {
    result = await requestJson(options.fetch ?? globalThis.fetch, session.apiBase, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}${verify}`, options.signal, undefined, STATUS_POLL_TIMEOUT_MS)
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    // The server long-polls this endpoint (~30s hold) before answering
    // "wait". A client-side timeout or a transient network error means the
    // scan state is simply not known yet — treat it as still waiting and let
    // the caller keep polling, matching the Reasonix and OpenClaw adapters.
    return { status: 'waiting' }
  }
  if (result.status === 'expired') return { status: 'expired' }
  if (result.status === 'need_verifycode') return { status: 'needs-code' }
  if (result.status === 'verify_code_blocked') {
    session.verifyCode = undefined
    return { status: 'code-blocked' }
  }
  if (result.status === 'binded_redirect') return { status: 'already-bound' }
  if (result.status === 'scaned_but_redirect' && typeof result.redirect_host === 'string' && result.redirect_host !== '') {
    session.apiBase = `https://${result.redirect_host}`
    return { status: 'redirected' }
  }
  const credential = confirmedCredential(result, session.apiBase)
  if (credential !== undefined) return { status: 'confirmed', credential }
  if (result.status === 'scaned') session.verifyCode = undefined
  return { status: result.status === 'scaned' ? 'scanned' : 'waiting' }
}

/** Complete QR login and save the credential to a private file. */
export async function login(options: LoginOptions = {}): Promise<{ credentialPath: string; credential: StoredCredential }> {
  const fetch = options.fetch ?? globalThis.fetch
  const stdout = options.stdout ?? process.stdout
  const credentialPath = options.credentialPath ?? defaultCredentialPath()
  const timeoutMs = options.timeoutMs ?? 8 * 60_000
  const session = await startLoginSession({ fetch, apiBase: options.apiBase, signal: options.signal })
  stdout.write(`Open or scan this Weixin QR code:\n${session.display}\n`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await delay(1_000, undefined, { signal: options.signal })
    const result = await pollLoginSession(session, { fetch, signal: options.signal })
    if (result.status === 'expired') throw new Error('Weixin QR code expired; run login again')
    if (result.status === 'confirmed') {
      await writePrivateJson(credentialPath, result.credential)
      return { credentialPath, credential: result.credential }
    }
    if (result.status === 'already-bound') {
      // The scanned Weixin account is already bound to a bot token this
      // machine declared (e.g. a saved Reasonix account). Take over that
      // binding: persist the existing credential and connect with it.
      const adopted = await adoptBoundCredential()
      if (adopted !== undefined) {
        await writePrivateJson(credentialPath, adopted)
        return { credentialPath, credential: adopted }
      }
      continue
    }
  }
  throw new Error('Weixin login timed out')
}
