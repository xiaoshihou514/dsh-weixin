import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginPageHtml } from './web-login.js'
import { mountLoginRoute } from './web-route.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('browser login page', () => {
  it('renders an embedded QR code and polls the Harness-scoped status route in Chinese', () => {
    const page = loginPageHtml('https://example.test/qr?id=1', '/dsh-weixin/status')
    expect(page).toContain("statusPath=\"/dsh-weixin/status\"")
    expect(page).toContain('aria-label="微信登录二维码"')
    expect(page).toContain('<path d="M')
    expect(page).toContain('扫码连接微信')
    expect(page).toContain('void poll()')
    expect(page).toContain('window.location.reload()')
    expect(page).not.toContain('setInterval')
    expect(page).not.toContain('Connect Weixin')
  })

  it('replaces an expired QR session and tells the browser to reload it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-web-refresh-'))
    const routes: any[] = []
    const context = new Context()
    context.provide('webServer', { register: (route: unknown) => { routes.push(route); return () => undefined } } as never)
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: 'old-key', qrcode_img_content: 'https://example.test/old' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'expired' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: 'new-key', qrcode_img_content: 'https://example.test/new' })))
    vi.stubGlobal('fetch', fetch)
    mountLoginRoute(context, { credentialPath: join(directory, 'account.json'), onCredential: vi.fn() })
    await vi.waitFor(() => { expect(routes).toHaveLength(1) })
    const route = routes[0]
    const response = () => {
      const chunks: string[] = []
      return { chunks, value: { setHeader: vi.fn(), writeHead: vi.fn().mockReturnThis(), end: (chunk?: unknown) => { chunks.push(String(chunk ?? '')) } } }
    }
    const page = response()
    await route.handler({ url: '/dsh-weixin/login', socket: { remoteAddress: '127.0.0.1' } }, page.value)
    const status = response()
    await route.handler({ url: '/dsh-weixin/status', socket: { remoteAddress: '127.0.0.1' } }, status.value)
    expect(JSON.parse(status.chunks.join(''))).toMatchObject({ done: false, refresh: true })
    const refreshed = response()
    await route.handler({ url: '/dsh-weixin/login', socket: { remoteAddress: '127.0.0.1' } }, refreshed.value)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(refreshed.chunks.join('')).not.toEqual(page.chunks.join(''))
    await context.fiber.dispose()
  })

  it('does not permit QR content to break out of the script', () => {
    const page = loginPageHtml('</script><script>bad()</script>')
    expect(page).not.toContain('</script><script>bad()')
    expect(page).not.toContain('bad()')
  })

  it('mounts in Harness Web, completes login, and saves without exposing the token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-web-route-'))
    vi.stubEnv('HOME', directory)
    const credentialPath = join(directory, 'account.json')
    const routes: any[] = []
    const context = new Context()
    context.provide('webServer', { register: (route: unknown) => { routes.push(route); return () => undefined } } as never)
    const connected = vi.fn().mockResolvedValue(undefined)
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ qrcode: 'qr-key', qrcode_img_content: 'https://example.test/qr.png' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'confirmed', ilink_bot_id: 'bot-1', ilink_user_id: 'owner-1', bot_token: 'top-secret', baseurl: 'https://ilinkai.weixin.qq.com',
      })))
    vi.stubGlobal('fetch', fetch)
    mountLoginRoute(context, { credentialPath, onCredential: connected })
    await vi.waitFor(() => { expect(routes).toHaveLength(1) })
    const route = routes[0]
    const pageChunks: string[] = []
    const pageResponse = { setHeader: vi.fn(), writeHead: vi.fn().mockReturnThis(), end: (chunk?: unknown) => { pageChunks.push(String(chunk ?? '')) } }
    await route.handler({ url: '/dsh-weixin/login', socket: { remoteAddress: '127.0.0.1' } }, pageResponse)
    expect(pageChunks.join('')).toContain('/dsh-weixin/status')
    expect(pageChunks.join('')).not.toContain('top-secret')

    const statusChunks: string[] = []
    const statusResponse = { setHeader: vi.fn(), writeHead: vi.fn().mockReturnThis(), end: (chunk?: unknown) => { statusChunks.push(String(chunk ?? '')) } }
    await route.handler({ url: '/dsh-weixin/status', socket: { remoteAddress: '::1' } }, statusResponse)
    expect(JSON.parse(statusChunks.join(''))).toMatchObject({ done: true, ok: true })
    expect(connected).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(credentialPath, 'utf8'))).toMatchObject({ accountId: 'bot-1', userId: 'owner-1', token: 'top-secret' })
    await context.fiber.dispose()
  })

})
