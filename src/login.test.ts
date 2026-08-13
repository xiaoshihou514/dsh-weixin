import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { login } from './login.js'
import { readPrivateJson } from './files.js'
import type { StoredCredential } from './files.js'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('login', () => {
  it('follows a regional redirect and saves a private credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-login-'))
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
})
