export interface EmbeddingClient {
  encode(texts: string[]): Promise<number[][]>
  dimension(): number
}

/**
 * 远程 Embedding API 客户端
 * 支持 OpenAI 兼容接口（SiliconFlow、OpenAI、Ollama /v1 等）
 */
export class RemoteEmbeddingClient implements EmbeddingClient {
  private readonly apiBase: string
  private readonly apiKey: string
  private readonly model: string
  private dim: number | null = null

  constructor(options?: {
    apiBase?: string
    apiKey?: string
    model?: string
  }) {
    // 优先使用 CogMem 专用配置，否则复用 MiniCode 的 API 配置
    this.apiBase = options?.apiBase
      ?? process.env.COGMEM_EMBEDDING_API_BASE
      ?? process.env.ANTHROPIC_BASE_URL?.replace('/messages', '')
      ?? 'https://api.siliconflow.cn/v1'
    this.apiKey = options?.apiKey
      ?? process.env.COGMEM_EMBEDDING_API_KEY
      ?? process.env.SILICONFLOW_API_KEY
      ?? ''
    this.model = options?.model
      ?? process.env.COGMEM_EMBEDDING_MODEL
      ?? 'BAAI/bge-m3'
  }

  async encode(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const url = `${this.apiBase}/embeddings`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    })
    if (!response.ok) {
      throw new Error(
        `Embedding API error: ${response.status} ${await response.text()}`
      )
    }
    const data = await response.json() as {
      data: { embedding: number[]; index: number }[]
    }
    // 按 index 排序确保对齐
    const sorted = data.data.sort((a, b) => a.index - b.index)
    const embeddings = sorted.map(item => item.embedding)
    if (!this.dim && embeddings.length > 0) {
      this.dim = embeddings[0].length
    }
    return embeddings
  }

  dimension(): number {
    return this.dim ?? 1024  // BGE-M3 默认 1024 维
  }
}
