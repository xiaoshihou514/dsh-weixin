/** Small runtime adapters for the public DeepSeek Harness service contracts. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Brand a generated id for the Harness session service. */
export function sessionId(value: string): SessionId {
  return value as SessionId
}

/** Create the immutable user message accepted by an Agent inbox. */
export function textUserMessage(text: string): UserMessage {
  return contentUserMessage([{ type: 'text', text }])
}

/** Create an immutable user message containing provider-neutral text/image blocks. */
export function contentUserMessage(content: UserMessage['content']): UserMessage {
  return Object.freeze({
    id: randomUUID() as UserMessage['id'],
    role: 'user',
    content: Object.freeze(content.map(block => Object.freeze(block))),
    source: Object.freeze({ kind: 'user' }),
  }) as unknown as UserMessage
}

/** Install one model selection into a newly created Agent scope. */
export function installSelection(agentCtx: Context, selection: ModelSelectionRef, extraInstructions?: string): () => void {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      sections: extraInstructions === undefined
        ? assembled.sections
        : [...assembled.sections, { name: 'weixin:delivery', text: extraInstructions }],
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
