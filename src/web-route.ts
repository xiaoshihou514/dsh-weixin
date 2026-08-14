/** Harness Web-server route for convenient in-app Weixin QR login. */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { writePrivateJson } from './files.js'
import { adoptBoundCredential, pollLoginSession, startLoginSession, type LoginSession } from './login.js'
import { loginPageHtml } from './web-login.js'

interface LoginRouteOptions {
  credentialPath: string
  apiBase?: string
  onCredential: () => Promise<void>
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Register a loopback-only page at `/dsh-weixin/login`. */
export function mountLoginRoute(ctx: Context, options: LoginRouteOptions): void {
  let session: LoginSession | undefined
  let polling: Promise<{ done: boolean; ok: boolean; message: string }> | undefined
  const status = async (): Promise<{ done: boolean; ok: boolean; message: string; needsCode?: boolean }> => {
    if (session === undefined) return { done: false, ok: false, message: '请打开登录页面开始连接。' }
    if (polling !== undefined) return await polling
    polling = (async () => {
      try {
        const result = await pollLoginSession(session!)
        if (result.status === 'confirmed') {
          await writePrivateJson(options.credentialPath, result.credential)
          await options.onCredential()
          session = undefined
          return { done: true, ok: true, message: '连接成功，可以关闭此页面。' }
        }
        if (result.status === 'expired') {
          session = undefined
          return { done: true, ok: false, message: '二维码已过期，请刷新页面重试。' }
        }
        if (result.status === 'needs-code') return { done: false, ok: false, needsCode: true, message: '请输入手机微信显示的数字。' }
        if (result.status === 'code-blocked') return { done: false, ok: false, needsCode: true, message: '输入错误次数过多，请稍后重新扫码。' }
        if (result.status === 'already-bound') {
          // The scanned Weixin account is already bound to a bot token this
          // machine declared in local_token_list (e.g. a saved Reasonix
          // account). Take over that binding: persist the credential and
          // start the gateway, which disconnects the previous owner.
          const adopted = await adoptBoundCredential()
          if (adopted === undefined) return { done: true, ok: false, message: '该连接已绑定到其他客户端，但本机没有可接管的凭据。' }
          await writePrivateJson(options.credentialPath, adopted)
          await options.onCredential()
          session = undefined
          return { done: true, ok: true, message: '连接成功，已接管既有绑定。' }
        }
        return { done: false, ok: false, message: result.status === 'scanned' ? '已扫码，请在手机上确认。' : '等待扫码…' }
      } catch (error) {
        void error
        return { done: false, ok: false, message: '暂时无法连接，请稍后刷新重试。' }
      } finally {
        polling = undefined
      }
    })()
    return await polling
  }
  ctx.inject(['webServer'], (webCtx) => {
    const route: WebRoute = {
      kind: 'prefix',
      path: '/dsh-weixin',
      handler: async (request, response) => {
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        if (!isLoopback(request.socket.remoteAddress)) {
          response.writeHead(403).end('微信登录页面仅允许在本机访问。')
          return
        }
        if (request.url?.split('?')[0] === '/dsh-weixin/status') {
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(JSON.stringify(await status()))
          return
        }
        if (request.url?.split('?')[0] === '/dsh-weixin/verify') {
          response.setHeader('content-type', 'application/json; charset=utf-8')
          if (request.method !== 'POST') {
            response.writeHead(405).end(JSON.stringify({ ok: false, message: '请求方式不正确。' }))
            return
          }
          const code = new URL(request.url ?? '', 'http://localhost').searchParams.get('code')?.trim()
          if (session === undefined || code === undefined || !/^\d{4,8}$/.test(code)) {
            response.writeHead(400).end(JSON.stringify({ ok: false, message: '请输入手机微信显示的数字。' }))
            return
          }
          session.verifyCode = code
          response.end(JSON.stringify({ ok: true, message: '正在验证…' }))
          return
        }
        session ??= await startLoginSession({ apiBase: options.apiBase })
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(loginPageHtml(session.display, '/dsh-weixin/status', '/dsh-weixin/verify'))
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'dsh-weixin: browser login')
  })
}
