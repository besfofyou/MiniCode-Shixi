import type { ModelAdapter, AgentStep, ChatMessage, ModelRequestOptions } from '../../src/types.js'
import type { EmbeddingClient } from '../../src/memory/embedding-client.js'

/** 确定性 mock embedding：共享 token 的文本余弦相似度更高 */
export class MockEmbeddingClient implements EmbeddingClient {
  async encode(texts: string[]): Promise<number[][]> {
    return texts.map(text => vectorFor(text))
  }

  dimension(): number {
    return 32
  }

  modelId(): string {
    return 'mock'
  }
}

function vectorFor(text: string): number[] {
  const dim = 32
  const vec = new Array<number>(dim).fill(0)
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const token of tokens) {
    let hash = 0
    for (const ch of token) {
      hash = (hash * 31 + ch.charCodeAt(0)) % dim
    }
    vec[hash] += 1
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1
  return vec.map(v => v / norm)
}

/** 按顺序返回预设回复的 mock model */
export class FixedModel implements ModelAdapter {
  private index = 0

  constructor(private readonly responses: string[]) {}

  async next(_messages: ChatMessage[], _options?: ModelRequestOptions): Promise<AgentStep> {
    const content = this.responses[this.index] ?? ''
    this.index++
    return { type: 'assistant', content }
  }
}
