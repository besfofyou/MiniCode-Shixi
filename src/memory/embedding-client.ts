export interface EmbeddingClient {
  encode(texts: string[]): Promise<number[][]>
  dimension(): number
  modelId(): string
}

/**
 * 远程 Embedding API 客户端
 * 支持 OpenAI 兼容接口（SiliconFlow、OpenAI、Ollama /v1 等）
 */
export class RemoteEmbeddingClient implements EmbeddingClient {
  readonly available: boolean
  readonly unavailableReason?: string
  private readonly apiBase: string
  private readonly apiKey: string
  private readonly model: string
  private dim: number | null = null

  constructor(options?: {
    apiBase?: string
    apiKey?: string
    model?: string
  }) {
    // 不再从 ANTHROPIC_BASE_URL 推导：Anthropic 兼容端点没有 /embeddings
    this.apiBase = (options?.apiBase
      ?? process.env.COGMEM_EMBEDDING_API_BASE
      ?? (process.env.SILICONFLOW_API_KEY ? 'https://api.siliconflow.cn/v1' : '')).replace(/\/+$/, '')
    this.apiKey = options?.apiKey
      ?? process.env.COGMEM_EMBEDDING_API_KEY
      ?? process.env.SILICONFLOW_API_KEY
      ?? ''
    this.model = options?.model
      ?? process.env.COGMEM_EMBEDDING_MODEL
      ?? 'BAAI/bge-m3'
    const isLocal = /\/\/(localhost|127\.0\.0\.1)/.test(this.apiBase)       // 本地 Ollama 不需要 key
    this.available = !!this.apiBase && (!!this.apiKey || isLocal)
    if (!this.available) this.unavailableReason = 'COGMEM_EMBEDDING_API_BASE / COGMEM_EMBEDDING_API_KEY not configured; graph memory disabled'
  }

  modelId(): string { return `${this.apiBase}#${this.model}` }

  async encode(texts: string[]): Promise<number[][]> {
    if (!this.available) throw new Error(this.unavailableReason)
    if (texts.length === 0) return []
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += 32) {                           // 分批请求并设置超时
      const res = await fetch(`${this.apiBase}/embeddings`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          input: texts.slice(i, i + 32),
        }),
      })
      if (!res.ok) throw new Error(`Embedding API error: ${res.status} ${(await res.text()).slice(0, 200)}`)
      const data = await res.json() as {
        data: { embedding: number[]; index: number }[]
      }
      out.push(...data.data.sort((a, b) => a.index - b.index).map(d => d.embedding))
    }
    if (!this.dim && out[0]) this.dim = out[0].length
    return out
  }

  dimension(): number {
    return this.dim ?? 1024  // BGE-M3 默认 1024 维
  }
}
