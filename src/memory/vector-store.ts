import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { EmbeddingClient } from './embedding-client.js'

interface VectorEntry {
  id: string         // node_id
  text: string       // 原始文本（用于重建 embedding）
  vector: number[]
}

/**
 * 轻量向量存储 — 纯 JS 实现
 *
 * 对应 CogMem 的 VectorStore/TypedVectorStore。
 * 使用余弦相似度暴力检索，适合 < 10K 条目。
 * 若需更大规模，可换用 hnswlib-node 或调远程 API。
 */
export class VectorStore {
  private entries: VectorEntry[] = []
  private readonly embedClient: EmbeddingClient

  constructor(embedClient: EmbeddingClient) {
    this.embedClient = embedClient
  }

  async add(id: string, text: string): Promise<void> {
    // 去重
    this.entries = this.entries.filter(e => e.id !== id)
    const [vector] = await this.embedClient.encode([text])
    this.entries.push({ id, text, vector })
  }

  async addBatch(items: { id: string; text: string }[]): Promise<void> {
    if (items.length === 0) return
    const texts = items.map(i => i.text)
    const vectors = await this.embedClient.encode(texts)
    for (let i = 0; i < items.length; i++) {
      this.entries = this.entries.filter(e => e.id !== items[i].id)
      this.entries.push({
        id: items[i].id,
        text: items[i].text,
        vector: vectors[i],
      })
    }
  }

  remove(id: string): void {
    this.entries = this.entries.filter(e => e.id !== id)
  }

  async search(query: string, topK = 10): Promise<{ id: string; score: number }[]> {
    if (this.entries.length === 0) return []
    const [queryVec] = await this.embedClient.encode([query])
    const scored = this.entries.map(entry => ({
      id: entry.id,
      score: cosineSimilarity(queryVec, entry.vector),
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  size(): number { return this.entries.length }

  // ---- 持久化 ----

  async save(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(this.entries), 'utf8')
  }

  async load(filePath: string): Promise<void> {
    try {
      this.entries = JSON.parse(await readFile(filePath, 'utf8'))
    } catch {
      this.entries = []
    }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
