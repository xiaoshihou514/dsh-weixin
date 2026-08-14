/**
 * Read-only access to a local Reasonix Weixin account store.
 *
 * Used exclusively by the QR login flow, never to start the gateway on its
 * own: the saved bot token is (a) declared in `local_token_list` so the iLink
 * server attributes the scanned binding to this machine, and (b) adopted only
 * after an explicit scan when the server answers `binded_redirect` — taking
 * the binding over from the previous owner.
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { readPrivateJson } from './files.js'
import type { StoredCredential } from './files.js'

/** Default Reasonix account directory (its own private store). */
export function defaultReasonixAccountsDir(): string {
  return join(process.env.REASONIX_HOME ?? join(homedir(), '.reasonix'), 'weixin', 'accounts')
}

/** Find named Reasonix accounts. `default.json` is only an alias and has no account id. */
export async function findReasonixAccountFiles(accountsDir: string = defaultReasonixAccountsDir()): Promise<string[]> {
  try {
    const entries = await readdir(accountsDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'default.json')
      .map(entry => join(accountsDir, entry.name))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Read and translate Reasonix's private account format. */
export async function readReasonixCredential(path: string): Promise<StoredCredential> {
  const value = await readPrivateJson<Record<string, unknown>>(path)
  const accountId = basename(path, '.json')
  if (accountId === '' || accountId === 'default') throw new Error('Reasonix account file has no account id')
  if (typeof value.token !== 'string' || value.token === '') throw new Error('Reasonix account is missing token')
  if (typeof value.base_url !== 'string' || !/^https?:\/\//.test(value.base_url)) throw new Error('Reasonix account has an invalid base URL')
  if (typeof value.saved_at !== 'string' || Number.isNaN(Date.parse(value.saved_at))) throw new Error('Reasonix account has an invalid save time')
  if (value.user_id !== undefined && typeof value.user_id !== 'string') throw new Error('Reasonix account has an invalid user id')
  return {
    accountId,
    token: value.token,
    apiBase: value.base_url,
    userId: value.user_id,
    savedAt: value.saved_at,
  }
}
