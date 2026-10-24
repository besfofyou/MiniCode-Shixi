import { mkdir, open, rename, unlink, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES'])   // Windows 文件占用
let seq = 0

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const json = JSON.stringify(data, null, 2)              // 先序列化，失败时不会留下空文件
  const tmp = `${file}.${process.pid}.${Date.now()}.${seq++}.tmp`
  try {
    const fh = await open(tmp, 'w')
    try { await fh.writeFile(json, 'utf8'); await fh.sync() } finally { await fh.close() }
    for (let i = 0; ; i++) {
      try { await rename(tmp, file); return }
      catch (e: any) {
        if (!RETRY.has(e?.code) || i >= 5) throw e
        await new Promise(r => setTimeout(r, 50 * 2 ** i))
      }
    }
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

/** 启动时清理被杀进程留下的 tmp 文件 */
export async function cleanupStaleTmp(dir: string, maxAgeMs = 60_000): Promise<void> {
  let names: string[] = []
  try { names = await readdir(dir) } catch { return }
  for (const n of names) {
    if (!n.endsWith('.tmp')) continue
    const p = path.join(dir, n)
    try { if (Date.now() - (await stat(p)).mtimeMs > maxAgeMs) await unlink(p) } catch {}
  }
}
