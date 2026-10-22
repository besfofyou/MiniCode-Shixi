import { readFile, rename } from 'node:fs/promises'
import { writeJsonAtomic } from './fs-util.js'
import type { EmbeddingClient } from './embedding-client.js'
import type { GraphStore } from './graph-store.js'
import { isRetrievable } from './retrieval-policy.js'

interface VectorEntry {
  id: string         // node_id
  text: string       // 原始文本（用于重建 embedding）
  vector: number[]
}

type VectorFile = {
  version: 2
  model: string
  dim: number
  entries: VectorEntry[]
  pending: { id: string; text: string }[]
}

/**
 * 轻量向量存储 — 纯 JS 实现
 *
 * 对应 CogMem 的 VectorStore/TypedVectorStore。
 * 使用余弦相似度暴力检索，适合 < 10K 条目。
 * 若需更大规模，可换用 hnswlib-node 或调远程 API。
 */
export class VectorStore {
  private entries = new Map<string, VectorEntry>()
  private pending = new Map<string, string>()          // 已写入图、但向量还没生成的节点
  private meta: { model: string; dim: number } | null = null
  lastError: string | null = null

  constructor(private readonly embedClient: EmbeddingClient) {}

  async add(id: string, text: string): Promise<void> {
    await this.addBatch([{ id, text }])
  }

  async addBatch(items: { id: string; text: string }[]): Promise<void> {
    if (items.length === 0) return
    try {
      const vecs = await this.embedClient.encode(items.map(i => i.text))
      if (vecs.length !== items.length) throw new Error('embedding count mismatch')
      items.forEach((it, i) => this.put(it.id, it.text, vecs[i]))
    } catch (err) {
      for (const it of items) this.pending.set(it.id, it.text)     // 不抛出：图节点已写入，向量之后补
      this.lastError = err instanceof Error ? err.message : String(err)
    }
  }

  private put(id: string, text: string, vector: number[]) {
    if (!this.meta) this.meta = { model: this.embedClient.modelId(), dim: vector.length }
    if (vector.length !== this.meta.dim) throw new Error(`embedding dim ${vector.length} ≠ index dim ${this.meta.dim}`)
    this.entries.set(id, { id, text, vector })
    this.pending.delete(id)
  }

  remove(id: string) { this.entries.delete(id); this.pending.delete(id) }
  getVector(id: string) { return this.entries.get(id)?.vector }
  size() { return this.entries.size }
  pendingCount() { return this.pending.size }

  async flushPending(limit = 64) {
    const items = [...this.pending].slice(0, limit).map(([id, text]) => ({ id, text }))
    if (items.length) await this.addBatch(items)
  }

  /** 启动时调用：图里有但缺向量的节点进入 pending；图里已删除的节点，向量也删除 */
  syncWithGraph(graph: GraphStore) {
    for (const n of graph.getAllNodes()) {
      if (!isRetrievable(n)) { this.remove(n.node_id); continue }
      if (!this.entries.has(n.node_id)) this.pending.set(n.node_id, n.embedding_text)
    }
    for (const id of [...this.entries.keys()]) if (!graph.getNode(id)) this.entries.delete(id)
  }

  async search(query: string, topK = 10, filter?: (id: string) => boolean): Promise<{ id: string; score: number }[]> {
    if (this.entries.size === 0) return []
    const [q] = await this.embedClient.encode([query])
    const scored: { id: string; score: number }[] = []
    for (const e of this.entries.values()) {
      if (filter && !filter(e.id)) continue
      if (e.vector.length !== q.length) continue          // 维度不一致直接跳过，避免得到 NaN
      scored.push({ id: e.id, score: cosineSimilarity(q, e.vector) })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK)
  }

  // ---- 持久化 ----

  async save(filePath: string): Promise<void> {
    await writeJsonAtomic(filePath, {
      version: 2,
      model: this.meta?.model ?? this.embedClient.modelId(),
      dim: this.meta?.dim ?? 0,
      entries: [...this.entries.values()],
      pending: [...this.pending].map(([id, text]) => ({ id, text })),
    } satisfies VectorFile)
  }

  async load(filePath: string): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'))
    } catch (e: any) {
      if (e?.code !== 'ENOENT') await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {})
      return
    }
    const data: VectorFile = Array.isArray(raw)                                  // 兼容旧格式（纯数组）
      ? { version: 2, model: 'legacy', dim: (raw[0] as VectorEntry | undefined)?.vector?.length ?? 0, entries: raw as VectorEntry[], pending: [] }
      : raw as VectorFile
    if (data.model !== 'legacy' && data.model !== this.embedClient.modelId()) {
      for (const e of data.entries) this.pending.set(e.id, e.text)             // 换了模型：旧向量全部作废并重建
      return
    }
    this.meta = data.dim ? { model: data.model, dim: data.dim } : null
    for (const e of data.entries) if (!this.meta || e.vector.length === this.meta.dim) this.entries.set(e.id, e)
    for (const p of data.pending ?? []) this.pending.set(p.id, p.text)
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
