/** Durable gateway routing and iLink cursor state. */

import { defaultDataDir, pathExists, readPrivateJson, writePrivateJson } from './files.js'
import { join } from 'node:path'
import type { ILinkClientState } from './protocol.js'

const STATE_VERSION = 1

/** State needed to reconnect chats and continue polling after restart. */
export interface GatewayState {
  version: 1
  chats: Record<string, string>
  seenMessageIds: string[]
  protocol: ILinkClientState
}

/** Default gateway state file under the Harness home. */
export function defaultStatePath(): string {
  return join(defaultDataDir(), 'gateway-state.json')
}

function emptyState(): GatewayState {
  return { version: STATE_VERSION, chats: {}, seenMessageIds: [], protocol: { updatesBuffer: '', contextTokens: {} } }
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`gateway state ${field} must be an object`)
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`gateway state ${field}.${key} must be a string`)
    output[key] = item
  }
  return output
}

/** Load and validate gateway state, or return a fresh state when absent. */
export async function loadGatewayState(path: string): Promise<GatewayState> {
  if (!await pathExists(path)) return emptyState()
  const value = await readPrivateJson<Record<string, unknown>>(path)
  if (value.version !== STATE_VERSION) throw new Error(`unsupported gateway state version: ${String(value.version)}`)
  if (!Array.isArray(value.seenMessageIds) || value.seenMessageIds.some(item => typeof item !== 'string')) {
    throw new Error('gateway state seenMessageIds must be an array of strings')
  }
  const protocol = value.protocol
  if (protocol === null || typeof protocol !== 'object' || Array.isArray(protocol)) throw new Error('gateway state protocol must be an object')
  const protocolRecord = protocol as Record<string, unknown>
  if (typeof protocolRecord.updatesBuffer !== 'string') throw new Error('gateway state protocol.updatesBuffer must be a string')
  return {
    version: STATE_VERSION,
    chats: stringRecord(value.chats, 'chats'),
    seenMessageIds: [...value.seenMessageIds],
    protocol: {
      updatesBuffer: protocolRecord.updatesBuffer,
      contextTokens: stringRecord(protocolRecord.contextTokens, 'protocol.contextTokens'),
    },
  }
}

/** Serialized atomic writer for mutable gateway state. */
export class GatewayStateStore {
  readonly path: string
  readonly state: GatewayState
  #pending: Promise<void> = Promise.resolve()

  constructor(path: string, state: GatewayState) {
    this.path = path
    this.state = state
  }

  /** Persist the latest in-memory snapshot after earlier writes settle. */
  save(): Promise<void> {
    this.#pending = this.#pending.then(async () => {
      const snapshot = structuredClone(this.state)
      await writePrivateJson(this.path, snapshot)
    })
    return this.#pending
  }
}
