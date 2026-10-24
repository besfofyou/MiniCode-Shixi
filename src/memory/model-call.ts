// src/memory/model-call.ts
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_MEMORY_PATH } from '../config.js'
import type { ChatMessage, ModelAdapter } from '../types.js'

/** 记忆模块专用：不带工具；模型仍回了 tool_calls 时，尽量取出其中的文本 */
export async function memoryModelText(model: ModelAdapter, messages: ChatMessage[]): Promise<string | null> {
  const res = await model.next(messages, { tools: [] })
  if (res.type === 'assistant') return res.content
  await appendFile(
    path.join(MINI_CODE_MEMORY_PATH, 'memory-debug.log'),
    `[${new Date().toISOString()}] memory call returned tool_calls: ${res.calls.map(c => c.toolName).join(',')}\n`,
  ).catch(() => {})
  return res.content?.trim() ? res.content : null
}
