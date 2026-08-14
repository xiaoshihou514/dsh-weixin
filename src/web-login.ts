/** Loopback browser UI for the same QR login used by the standalone CLI. */

import { createServer, type Server } from 'node:http'
import QRCode from 'qrcode'
import { writePrivateJson } from './files.js'
import { defaultCredentialPath } from './files.js'
import { adoptBoundCredential, pollLoginSession, startLoginSession, type LoginPollResult } from './login.js'

export interface WebLoginOptions {
  apiBase?: string
  credentialPath?: string
  port?: number
  timeoutMs?: number
  signal?: AbortSignal
  stdout?: Pick<NodeJS.WriteStream, 'write'>
}

export function loginPageHtml(display: string, statusPath = '/status', verifyPath = '/verify'): string {
  const encodedStatus = JSON.stringify(statusPath).replace(/</g, '\\u003c')
  const encodedVerify = JSON.stringify(verifyPath).replace(/</g, '\\u003c')
  // Match Reasonix's qrcode.react defaults: level L with a one-module margin.
  const qr = QRCode.create(display, { errorCorrectionLevel: 'L' })
  const margin = 1
  const size = qr.modules.size
  const cells: string[] = []
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (qr.modules.get(row, column)) cells.push(`M${column + margin} ${row + margin}h1v1h-1z`)
    }
  }
  const viewBox = size + margin * 2
  const svg = `<svg class="qr" viewBox="0 0 ${viewBox} ${viewBox}" role="img" aria-label="微信登录二维码" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${cells.join('')}" fill="#111"/></svg>`
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接微信</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f5;color:#1f2321}.card{width:min(420px,calc(100vw - 32px));background:#fff;padding:32px;border:1px solid #e5e7e5;border-radius:16px;box-shadow:0 12px 36px #00000012;text-align:center}.brand{display:inline-flex;align-items:center;gap:8px;color:#07c160;font-weight:650}.dot{width:10px;height:10px;border-radius:50%;background:#07c160}h1{font-size:22px;margin:14px 0 4px}p{margin:0;color:#737975}.existing{margin-top:12px}.fresh{margin-top:24px;padding-top:20px;border-top:1px solid #e8eae8}.existing+.fresh h1{font-size:17px}.qr-wrap{width:min(280px,72vw);margin:24px auto 16px;padding:12px;background:#fff;border-radius:12px}.qr{display:block;width:100%;height:auto}button{margin:20px 0 10px;padding:10px 18px;border:0;border-radius:8px;background:#07c160;color:#fff;font:inherit;font-weight:650;cursor:pointer}button:disabled{opacity:.55;cursor:default}.warning{font-size:13px;color:#a66a19}#status{min-height:24px;margin-top:16px;color:#4e5651}.tip{font-size:13px;margin-top:8px;color:#929892}@media(prefers-color-scheme:dark){body{background:#171817;color:#f1f2f1}.card{background:#242624;border-color:#3a3d3a;box-shadow:0 12px 36px #0006}.fresh{border-color:#3a3d3a}p,#status{color:#b8bdb9}.warning{color:#d6a45e}.tip{color:#8f958f}}</style>
<main class="card"><div class="brand"><span class="dot"></span>微信</div><section class="fresh"><h1>扫码连接微信</h1><p>请使用微信扫描二维码，并在手机上确认登录。</p><div class="qr-wrap">${svg}</div></section><form id="verify" hidden><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" placeholder="输入手机显示的数字" required><button type="submit">确认</button></form><p id="status">等待扫码…</p><p class="tip">连接成功后，此页面会自动提示。</p></main>
<script>const statusPath=${encodedStatus};const verifyPath=${encodedVerify};const form=document.querySelector('#verify');const poll=async()=>{try{const r=await fetch(statusPath,{cache:'no-store'});const x=await r.json();document.querySelector('#status').textContent=x.message;form.hidden=!x.needsCode;if(x.done)clearInterval(timer)}catch{}};const timer=setInterval(poll,1000);form.addEventListener('submit',async e=>{e.preventDefault();const code=document.querySelector('#code').value.trim();const r=await fetch(verifyPath+'?code='+encodeURIComponent(code),{method:'POST',cache:'no-store'});const x=await r.json();document.querySelector('#status').textContent=x.message;if(x.ok)form.hidden=true})</script></html>`
}

/** Serve a private loopback login page until confirmed, expired, aborted, or timed out. */
export async function webLogin(options: WebLoginOptions = {}): Promise<{ credentialPath: string; accountId: string }> {
  const session = await startLoginSession({ apiBase: options.apiBase, signal: options.signal })
  const credentialPath = options.credentialPath ?? defaultCredentialPath()
  const stdout = options.stdout ?? process.stdout
  let latest: LoginPollResult = { status: 'waiting' }
  let done = false
  let failure: Error | undefined
  const server: Server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    if (request.url === '/status') {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      const message = failure !== undefined ? '登录失败，请刷新后重试。' : latest.status === 'confirmed' || latest.status === 'already-bound' ? '连接成功，可以关闭此页面。' : latest.status === 'scanned' ? '已扫码，请在手机上确认。' : latest.status === 'expired' ? '二维码已过期，请刷新页面重试。' : '等待扫码…'
      response.end(JSON.stringify({ done, ok: latest.status === 'confirmed' || latest.status === 'already-bound', message }))
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(loginPageHtml(session.display))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('could not determine browser login address')
  stdout.write(`Open http://127.0.0.1:${address.port} to connect Weixin.\n`)
  const deadline = Date.now() + (options.timeoutMs ?? 8 * 60_000)
  try {
    while (Date.now() < deadline && options.signal?.aborted !== true) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      latest = await pollLoginSession(session, { signal: options.signal })
      if (latest.status === 'expired') throw new Error('Weixin QR code expired; start login again')
      if (latest.status === 'confirmed') {
        await writePrivateJson(credentialPath, latest.credential)
        done = true
        await new Promise(resolve => setTimeout(resolve, 1_500))
        return { credentialPath, accountId: latest.credential.accountId }
      }
      if (latest.status === 'already-bound') {
        // The scanned Weixin account is already bound to a bot token this
        // machine declared in local_token_list (e.g. a saved Reasonix
        // account). Take over that binding and connect with it.
        const adopted = await adoptBoundCredential()
        if (adopted === undefined) throw new Error('Weixin confirmed an existing binding, but no usable local credential was found')
        await writePrivateJson(credentialPath, adopted)
        done = true
        await new Promise(resolve => setTimeout(resolve, 1_500))
        return { credentialPath, accountId: adopted.accountId }
      }
    }
    throw new Error('Weixin login timed out')
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    done = true
    throw failure
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
