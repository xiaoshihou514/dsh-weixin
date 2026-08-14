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
  outbox: Record<string, { chunks: string[]; files: string[]; next: number; nextFile: number }>
}

/** Default gateway state file under the Harness home. */
export function defaultStatePath(): string {
  return join(defaultDataDir(), 'gateway-state.json')
}

function emptyState(): GatewayState {
  return { version: STATE_VERSION, chats: {}, seenMessageIds: [], protocol: { updatesBuffer: '', contextTokens: {} }, outbox: {} }
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
    outbox: (() => {
      if (value.outbox === undefined) return {}
      if (value.outbox === null || typeof value.outbox !== 'object' || Array.isArray(value.outbox)) throw new Error('gateway state outbox must be an object')
      const output: GatewayState['outbox'] = {}
      for (const [chatId, item] of Object.entries(value.outbox)) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`gateway state outbox.${chatId} must be an object`)
        const record = item as Record<string, unknown>
        if (!Array.isArray(record.chunks) || record.chunks.some(chunk => typeof chunk !== 'string')) throw new Error(`gateway state outbox.${chatId}.chunks must be strings`)
        if (!Number.isInteger(record.next) || (record.next as number) < 0 || (record.next as number) > record.chunks.length) throw new Error(`gateway state outbox.${chatId}.next is invalid`)
        const files = record.files === undefined ? [] : record.files
        const nextFile = record.nextFile === undefined ? 0 : record.nextFile
        if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error(`gateway state outbox.${chatId}.files must be strings`)
        if (!Number.isInteger(nextFile) || (nextFile as number) < 0 || (nextFile as number) > files.length) throw new Error(`gateway state outbox.${chatId}.nextFile is invalid`)
        output[chatId] = { chunks: [...record.chunks], files: [...files], next: record.next as number, nextFile: nextFile as number }
      }
      return output
    })(),
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
