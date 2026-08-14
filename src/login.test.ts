import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectLocalBotTokens, login, pollLoginSession, startLoginSession } from './login.js'
import { readPrivateJson } from './files.js'
import type { StoredCredential } from './files.js'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

afterEach(() => vi.unstubAllEnvs())

describe('login', () => {
  it('follows a regional redirect and saves a private credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-login-'))
    vi.stubEnv('HOME', directory)
    const credentialPath = join(directory, 'account.json')
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.test/1' }))
      .mockResolvedValueOnce(response({ status: 'scaned_but_redirect', redirect_host: 'region.test' }))
      .mockResolvedValueOnce(response({
        status: 'confirmed',
        ilink_bot_id: 'bot-1',
        bot_token: 'secret',
        ilink_user_id: 'user-1',
        baseurl: 'https://region.test',
      }))
    const output: string[] = []

    const result = await login({ credentialPath, fetch, timeoutMs: 5_000, stdout: { write: chunk => output.push(String(chunk)) } })

    expect(result.credential.accountId).toBe('bot-1')
    expect(output.join('')).toContain('https://qr.test/1')
    expect(await readPrivateJson<StoredCredential>(credentialPath)).toEqual(result.credential)
    if (process.platform !== 'win32') expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)
    expect(fetch.mock.calls[2]?.[0]).toContain('https://region.test/')
  }, 10_000)

  it('treats a long-poll timeout as still waiting instead of failing the login', async () => {
    // The iLink server holds get_qrcode_status for ~30s before answering
    // "wait"; our own request deadline may hit first. That must not abort the
    // whole login — the scan state is simply unknown, so keep polling.
    const session = { qrcode: 'qr-1', display: 'https://qr.test/1', apiBase: 'https://ilinkai.weixin.qq.com' }
    const fetch = vi.fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
      .mockResolvedValueOnce(response({ status: 'wait' }))
    expect(await pollLoginSession(session, { fetch })).toEqual({ status: 'waiting' })
    expect(await pollLoginSession(session, { fetch })).toEqual({ status: 'waiting' })
  })

  it('propagates a caller abort instead of treating it as a transient wait', async () => {
    const controller = new AbortController()
    controller.abort()
    const session = { qrcode: 'qr-1', display: 'https://qr.test/1', apiBase: 'https://ilinkai.weixin.qq.com' }
    const fetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    await expect(pollLoginSession(session, { fetch, signal: controller.signal })).rejects.toThrow()
  })

  it('sends known local bot tokens in local_token_list so the scan can take over a bound account', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-login-tokens-'))
    vi.stubEnv('HOME', directory)
    const accounts = join(directory, '.reasonix', 'weixin', 'accounts')
    await mkdir(accounts, { recursive: true })
    await writeFile(join(accounts, 'old-bot@im.bot.json'), JSON.stringify({
      token: 'old-bot@im.bot:old-secret', base_url: 'https://ilinkai.weixin.qq.com', user_id: 'user-old', saved_at: '2026-07-20T01:16:48Z',
    }), { mode: 0o600 })
    const fetch = vi.fn().mockImplementation(async () => response({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.test/1' }))
    await startLoginSession({ fetch }, [])
    await startLoginSession({ fetch })
    const bodies = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
    expect(bodies[0]?.local_token_list).toEqual([])
    expect(bodies[1]?.local_token_list).toContain('old-bot@im.bot:old-secret')
    expect(await collectLocalBotTokens()).toContain('old-bot@im.bot:old-secret')
  })

  it('adopts the existing binding when the server reports already-bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-login-adopt-'))
    vi.stubEnv('HOME', directory)
    const accounts = join(directory, '.reasonix', 'weixin', 'accounts')
    await mkdir(accounts, { recursive: true })
    await writeFile(join(accounts, 'old-bot@im.bot.json'), JSON.stringify({
      token: 'old-bot@im.bot:old-secret', base_url: 'https://region.test', user_id: 'user-old', saved_at: '2026-07-20T01:16:48Z',
    }), { mode: 0o600 })
    const credentialPath = join(directory, 'account.json')
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.test/1' }))
      .mockResolvedValueOnce(response({ status: 'binded_redirect' }))
    const result = await login({ credentialPath, fetch, timeoutMs: 5_000, stdout: { write: () => undefined } })
    expect(result.credential).toMatchObject({ accountId: 'old-bot@im.bot', token: 'old-bot@im.bot:old-secret', userId: 'user-old' })
    expect(await readPrivateJson<StoredCredential>(credentialPath)).toEqual(result.credential)
  })
})
