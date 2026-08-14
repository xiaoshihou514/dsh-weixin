#!/usr/bin/env node
/** Command-line setup for dsh-weixin. */

import { resolve } from 'node:path'
import { login } from './login.js'
import { webLogin } from './web-login.js'

interface CliOptions {
  credentialPath?: string
  apiBase?: string
  timeoutMs?: number
  web?: boolean
  port?: number
}

function usage(): string {
  return `Usage: dsh-weixin login [options]

Options:
  --credential <path>  credential file (default: $DSH_HOME/weixin/account.json)
  --api-base <url>     iLink API base URL
  --timeout <seconds>  login timeout (default: 480)
  --web                show the QR flow in a private browser page
  --port <number>      browser page port (default: an available port)
  -h, --help           show this help
`
}

function parse(args: string[]): CliOptions | 'help' {
  if (args[0] !== 'login') {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return 'help'
    throw new Error('expected the login command')
  }
  const options: CliOptions = {}
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') return 'help'
    if (arg === '--web') {
      options.web = true
      continue
    }
    const value = args[index + 1]
    if (value === undefined) throw new Error(`${arg} requires a value`)
    if (arg === '--credential') options.credentialPath = resolve(value)
    else if (arg === '--api-base') options.apiBase = value
    else if (arg === '--timeout') {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be a positive number')
      options.timeoutMs = seconds * 1_000
    } else if (arg === '--port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be an integer from 0 to 65535')
      options.port = port
    } else throw new Error(`unknown option: ${arg}`)
    index += 1
  }
  return options
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2))
  if (options === 'help') {
    process.stdout.write(usage())
    return
  }
  if (options.web === true) {
    const result = await webLogin(options)
    process.stdout.write(`Credential saved to ${result.credentialPath}\nAccount: ${result.accountId}\n`)
  } else {
    const result = await login(options)
    process.stdout.write(`Credential saved to ${result.credentialPath}\nAccount: ${result.credential.accountId}\n`)
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`dsh-weixin: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
