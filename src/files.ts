/** Private local JSON storage for credentials and gateway state. */

import { constants } from 'node:fs'
import { access, chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Default directory for dsh-weixin private data. */
export function defaultDataDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'weixin')
}

/** Default credential file written by the login command. */
export function defaultCredentialPath(): string {
  return join(defaultDataDir(), 'account.json')
}

/** Parsed credential stored by QR login. */
export interface StoredCredential {
  accountId: string
  token: string
  apiBase: string
  userId?: string
  savedAt: string
}

/** Read a credential file and validate every required field. */
export async function readCredential(path: string): Promise<StoredCredential> {
  const value = await readPrivateJson<Record<string, unknown>>(path)
  if (typeof value.accountId !== 'string' || value.accountId === '') throw new Error(`${path} is missing accountId`)
  if (typeof value.token !== 'string' || value.token === '') throw new Error(`${path} is missing token`)
  if (typeof value.apiBase !== 'string' || !/^https?:\/\//.test(value.apiBase)) throw new Error(`${path} has an invalid apiBase`)
  if (typeof value.savedAt !== 'string' || Number.isNaN(Date.parse(value.savedAt))) throw new Error(`${path} has an invalid savedAt`)
  if (value.userId !== undefined && typeof value.userId !== 'string') throw new Error(`${path} has an invalid userId`)
  return {
    accountId: value.accountId,
    token: value.token,
    apiBase: value.apiBase,
    userId: value.userId,
    savedAt: value.savedAt,
  }
}

/** Read and validate a private JSON file. */
export async function readPrivateJson<T>(path: string): Promise<T> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error(`${path} is not a regular file`)
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${path} permissions are too broad; run chmod 600 ${JSON.stringify(path)}`)
  }
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return value as T
}

/** Atomically write JSON with user-only permissions. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(parent, 0o700)
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** Return whether a path exists without hiding other access errors. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
