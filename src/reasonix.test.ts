import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findReasonixAccountFiles, readReasonixCredential } from './reasonix.js'

afterEach(() => vi.unstubAllEnvs())

describe('reasonix credential import', () => {
  it('reads and translates a saved Reasonix account without exposing the token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-reasonix-'))
    const accounts = join(directory, 'weixin', 'accounts')
    await mkdir(accounts, { recursive: true })
    await writeFile(join(accounts, 'bot-1@im.bot.json'), JSON.stringify({
      token: 'bot-1@im.bot:secret',
      base_url: 'https://ilinkai.weixin.qq.com',
      user_id: 'user-1',
      saved_at: '2026-07-20T01:16:48Z',
    }), { mode: 0o600 })
    await writeFile(join(accounts, 'default.json'), JSON.stringify({ token: 'x' }), { mode: 0o600 })

    const files = await findReasonixAccountFiles(accounts)
    expect(files).toHaveLength(1)
    const credential = await readReasonixCredential(files[0]!)
    expect(credential).toEqual({
      accountId: 'bot-1@im.bot',
      token: 'bot-1@im.bot:secret',
      apiBase: 'https://ilinkai.weixin.qq.com',
      userId: 'user-1',
      savedAt: '2026-07-20T01:16:48Z',
    })
  })

  it('returns an empty list when no Reasonix account directory exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-reasonix-empty-'))
    expect(await findReasonixAccountFiles(join(directory, 'missing'))).toEqual([])
  })

  it('resolves the default accounts directory under the configured home', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-reasonix-home-'))
    vi.stubEnv('HOME', directory)
    const { defaultReasonixAccountsDir } = await import('./reasonix.js')
    expect(defaultReasonixAccountsDir()).toBe(join(directory, '.reasonix', 'weixin', 'accounts'))
  })
})
