import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GatewayStateStore, loadGatewayState } from './state.js'

describe('gateway state', () => {
  it('persists routing and protocol state atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-state-'))
    const path = join(directory, 'gateway.json')
    const state = await loadGatewayState(path)
    const store = new GatewayStateStore(path, state)
    state.chats.room = 'session-1'
    state.protocol.updatesBuffer = 'cursor-1'
    state.protocol.contextTokens.room = 'context-1'
    state.outbox.room = { chunks: ['reply'], next: 0 }
    await store.save()

    await expect(loadGatewayState(path)).resolves.toEqual(state)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(state)
  })

  it.runIf(process.platform !== 'win32')('rejects a state file readable by other users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-state-mode-'))
    const path = join(directory, 'gateway.json')
    const state = await loadGatewayState(path)
    await new GatewayStateStore(path, state).save()
    await chmod(path, 0o644)

    await expect(loadGatewayState(path)).rejects.toThrow('permissions are too broad')
  })
})
