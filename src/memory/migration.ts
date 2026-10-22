import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryFilesystem } from './filesystem.js'
import type { GraphStore } from './graph-store.js'
import type { VectorStore } from './vector-store.js'
import type { EventNode, FactNode, MemoryEntry } from './types.js'

/**
 * 旧数据兼容：将扁平 JSON 记忆迁移到 CogMem 图谱
 *
 * 1. 读取旧 episodic 条目 → 创建 Event 节点
 * 2. 读取旧 semantic 条目 → 创建 Fact 节点
 * 3. 写入 GraphStore + VectorStore
 * 4. 不删除旧文件（保留备份）
 */
export async function migrateToGraphStore(
  oldStore: MemoryFilesystem,
  graph: GraphStore,
  vectorStore: VectorStore,
): Promise<void> {
  const root = oldStore.getRoot()
  const [episodicEntries, semanticEntries] = await Promise.all([
    readOldTierEntries(root, 'episodic'),
    readOldTierEntries(root, 'semantic'),
  ])

  const vectorBatch: { id: string; text: string }[] = []

  for (const entry of episodicEntries) {
    const node: EventNode = {
      node_id: `event_${randomUUID().slice(0, 12)}`,
      node_type: 'event',
      title: entry.content.slice(0, 80),
      description: entry.content,
      participants: [],
      resolved_time: entry.createdAt,
      concepts: [],
      archived: false,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      source_session_id: entry.source?.sessionId ?? 'migration',
      embedding_text: `Event: ${entry.content.slice(0, 300)}`,
    }
    graph.addNode(node)
    vectorBatch.push({ id: node.node_id, text: node.embedding_text })
  }

  for (const entry of semanticEntries) {
    const node: FactNode = {
      node_id: `fact_${randomUUID().slice(0, 12)}`,
      node_type: 'fact',
      subject: entry.tags[0] ?? 'project',
      predicate: 'is_recorded_as',
      object: entry.content.slice(0, 200),
      description: entry.content,
      confidence: entry.confidence,
      supported_by_event_ids: [],
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      source_session_id: entry.source?.sessionId ?? 'migration',
      embedding_text: `Fact: ${entry.content.slice(0, 300)}`,
    }
    graph.addNode(node)
    vectorBatch.push({ id: node.node_id, text: node.embedding_text })
  }

  if (vectorBatch.length > 0) {
    await vectorStore.addBatch(vectorBatch)
  }
}

async function readOldTierEntries(root: string, tier: 'episodic' | 'semantic'): Promise<MemoryEntry[]> {
  const tierDir = path.join(root, tier)
  let files: string[]
  try {
    files = (await readdir(tierDir)).filter(file => /^[A-Za-z0-9_-]{1,64}\.json$/.test(file))
  } catch {
    return []
  }
  const entries: MemoryEntry[] = []
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(path.join(tierDir, file), 'utf8')) as Partial<MemoryEntry>
      if (
        typeof parsed === 'object' && parsed !== null &&
        typeof parsed.id === 'string' &&
        typeof parsed.content === 'string' &&
        parsed.tier === tier &&
        !parsed.obsolete
      ) {
        entries.push({
          ...parsed,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          source: parsed.source ?? { sessionId: 'migration', trigger: 'migration' },
        } as MemoryEntry)
      }
    } catch {
      // 单个损坏文件不阻塞整体迁移。
    }
  }
  return entries
}
