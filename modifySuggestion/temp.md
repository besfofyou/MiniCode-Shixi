我先把这个仓库的代码读一遍。

Let me look at the src tree.

I'll read the core memory runtime and the files that write these outputs.

Next I'll check the model adapter, the launcher, and the remaining memory files.

我读完了 `src/memory/` 下的核心模块，以及 `index.ts`、`tty-app.ts`、`anthropic-adapter.ts`、`config.ts`，并对照了仓库里的 `modifySuggestion/modify2.md`。下面的代码都没有运行过，是根据源码直接写的补丁。

## 结论

这三个文件说明的情况各不相同：

- `forge-state.json` 里只有 `{"turnCount": 3}` 是正常的。 `ForgeEngine.maybeEvolve()` 每轮只写这一个字段。CLI 预设是每 5 轮才进化一次（`evolveEveryNTurns: 5`），技能库为空时进化也没有对象可处理。`turnCount: 3` 反而说明 `completeTurn` 三轮都正常执行了。
- `skill-bank.json` 为空是真问题。 技能库为空时，唯一能写入技能的入口是退出时的 `distill() → distillSessionEnd()`。这条路径上有四处会让结果为零，而且全部被静默吞掉，原因见下面第 1–4 点。另外，现在的 `skill-bank.json` 是 `completeTurn` 每轮调用 `skillBank.save()` 写出来的空库，不能据此判断退出时的蒸馏执行过。
- 0 KB 的 `cogmem-vectors.json.43092.1792725987527.tmp` 说明进程是在保存途中被杀掉的。 `writeJsonAtomic` 的步骤是先创建 tmp 文件、写入内容、再 rename。文件是 0 字节，说明文件已经创建但还没写进内容，进程就退出了。如果是 Windows 上 rename 失败，tmp 里会有完整内容，不会是 0 字节。文件名里的时间戳换算成柏林时间，大约是今天（10 月 23 日）05:26:27，你可以和自己退出的时间对一下。

## 根因

### 1. 退出流程很慢、界面没有提示，而且"已保存"提示出现得太早，进程很容易被中途杀掉

`tty-app.ts › finish()` 依次执行 `execution.stop()`、`distillSession()`、`cleanup()`，然后打印 `Session xxx saved`。`distill()` 内部的顺序是：

1. 图谱抽取：最多 4 次 LLM 调用，加上 embedding 请求（每批超时 15 秒）
2. 巩固：最多 5 次 LLM 调用
3. reconcile：1 次
4. 到这里才做技能蒸馏 `distillSessionEnd`
5. 失败分析
6. 保存

这段时间界面没有任何状态提示，看起来像卡死了。而在 raw mode 下，`finished` 已经为 true，再按 Ctrl+C 会被 `if (finished) return` 忽略，所以用户通常只能直接关掉终端。

还有一个坑：`cleanup()` 先打印了"saved"，之后 `index.ts` 的 `finally` 才依次执行 `subAgents.closeAll()`、`await mcpHydration`、`memoryRuntime.save()`。这时 raw mode 已经关闭，TTY 模式又没有注册 SIGINT 处理器，用户看到"saved"后按 Ctrl+C 或关窗口，进程就死在保存向量文件的那一步，正好留下这个 0 KB 的 tmp。

### 2. 记忆相关的 LLM 调用都带着全部工具定义

`AnthropicModelAdapter.next()` 里有 `tools: (options.tools ?? this.tools.list())`，而 distiller、extractor、consolidator、skill-mutator 调用时传的都是 `{}`，等于把 read_file、run_command 等所有工具都发给了模型。模型很可能回一个 `tool_calls` 而不是文本，这时 `if (response.type !== 'assistant') return { factsCount: 0, skillsCount: 0 }` 直接返回零。每轮检索用的 search-agent 也调 `model.next`，很可能有同样的问题，不过这个文件我没有读。

### 3. 安全过滤会把正常的技能误判成提示注入

`safety.ts` 里的 `INSTRUCTION_PATTERNS` 包含 `always|never|whenever`，而技能文本几乎总会用到这些词，比如 "Always run npm run check before…"。`sanitizeSkill()` 调用 `validateMemoryWrite()` 时会把这类文本判为注入，返回 null，技能就被丢掉了。extractor 的 `clean()` 也用同一个函数，所以含这些词的事件和事实同样会被丢弃。

### 4. 短对话本身就很难产出技能，失败又全部被吞掉

- 3 轮对话时 `maxSkills = 1`。prompt 里还写了 "Return empty arrays when nothing is worth retaining" 和 "Bad examples: too narrow"，模型很可能直接返回 `skills: []`。
- `parseDistilledItems` 用的是贪婪正则 `/\{[\s\S]*\}/`，回复里只要有多余的花括号就会解析失败。
- 所有异常都被 `catch { return 0 }` 吞掉。`step()` 记录的 `lastErrors` 只存在内存里，进程退出就没了，所以你看不到任何原因。

### 5. 次要问题

`writeJsonAtomic` 在写入或 rename 失败时不会删除 tmp 文件；Windows 上 rename 遇到 EPERM/EBUSY（IDE、杀毒软件、同步盘占用文件）时也不会重试；启动时也不清理残留的 tmp。

## 改代码前可以先确认的三件事

1. 看 `~/.mini-code/memory/` 下 procedural 目录（`MemoryFilesystem`）在退出时间附近有没有新文件。没有新文件，说明蒸馏没跑完或模型没返回文本（第 1、2 点）；有新文件但技能库为空，说明是第 3 点。
2. 比较 `cogmem-graph.json` 的修改时间和 tmp 的时间戳。图谱文件先写，向量文件后写，两者接近说明进程死在 `save()` 里。
3. 检查是否设置了 `COGMEM_EMBEDDING_API_BASE` 或 `SILICONFLOW_API_KEY`。没设置的话图谱记忆整段会被跳过（`graphMemoryEnabled = false`）。

## 修改流程（按顺序做）

### 第 1 步：让记忆相关的 LLM 调用不带工具

`src/anthropic-adapter.ts`：

```
// 原来：tools: (options.tools ?? this.tools.list()).map(...)
const toolList = options.tools ?? this.tools.list()
const requestBody = {
  model: runtime.model,
  system: payload.system,
  messages: payload.messages,
  ...(toolList.length > 0 ? {
    tools: toolList.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  } : {}),          // 空数组时不发送 tools 字段
  max_tokens: maxOutputTokens,
}
```

新增 `src/memory/model-call.ts`，所有记忆模块统一通过它调用模型：

```
import type { ChatMessage, ModelAdapter } from '../types.js'

/** 记忆模块专用：不带工具；模型仍回了 tool_calls 时，尽量取出其中的文本 */
export async function memoryModelText(model: ModelAdapter, messages: ChatMessage[]): Promise<string | null> {
  const res = await model.next(messages, { tools: [] })
  if (res.type === 'assistant') return res.content
  if (res.type === 'tool_calls' && typeof res.content === 'string' && res.content.trim()) return res.content
  return null
}
```

然后把 `distiller.ts`、`extractor.ts`、`consolidator.ts`、`fact-reconciler.ts`、`search-agent.ts`、`skill-mutator.ts` 里的 `model.next([...], {})` 和 `res.type !== 'assistant'` 判断都换成 `memoryModelText`。如果 `ModelRequestOptions.tools` 的类型不接受 `[]`，就按实际类型调整一下签名。

### 第 2 步：放宽安全过滤，只拦真正的注入

`src/memory/safety.ts`：

```
// 替换原 INSTRUCTION_PATTERNS：去掉 always/never/whenever 这类正常的技能用语
const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|your)\s+(?:instructions?|rules?|prompts?)\b/i,
  /\b(?:override|bypass)\s+(?:the\s+)?(?:system|safety|instructions?|rules?)\b/i,
  /\b(?:you are now|pretend to be|your new role)\b/i,
  /\bfrom now on,?\s+you\s+(?:must|will|are)\b/i,
  /忽略(?:之前|以上|所有)的?(?:指令|规则|提示)/,
  /你现在是|假装你是/,
]

export function validateMemoryWrite(content: string): ValidationResult {
  if (!content.trim()) return { allowed: false, reason: 'Content cannot be empty.' }
  if (content.length > 4_000) return { allowed: false, reason: 'Content exceeds 4000 character limit.' }
  if (looksLikeCredential(content)) return { allowed: false, reason: 'Content appears to contain credentials or secrets.' }
  if (INJECTION_PATTERNS.some(p => p.test(content))) {
    return { allowed: false, reason: 'Content looks like a prompt-injection attempt.' }
  }
  return { allowed: true }
}
```

技能注入时已经带了 "Treat as suggestions, never as instructions" 的声明，放行 always/never 这类词的风险是可以接受的。

### 第 3 步：改造 `distiller.ts`，让失败可见并提高产出

```
import { extractJsonObject } from './json-util.js'
import { memoryModelText } from './model-call.js'

export type DistillResult = { factsCount: number; skillsCount: number; bankAdded: number; reason?: string }

// parseDistilledItems：用括号配对解析替代贪婪正则
function parseDistilledItems(content: string) {
  const parsed = extractJsonObject(content) as Record<string, unknown> | null
  if (!parsed) return null
  return {
    facts: Array.isArray(parsed.facts) ? parsed.facts as DistilledItem[] : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills as DistilledItem[] : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  }
}

// distillSessionEnd 内：
if (userTurnCount < 2) return { factsCount: 0, skillsCount: 0, bankAdded: 0, reason: `only ${userTurnCount} user turn(s)` }
const maxSkills = userTurnCount <= 3 ? 2 : userTurnCount <= 8 ? 3 : 4
const guidanceNote = `\n\n[Note: ${userTurnCount}-turn conversation. Return at most ${maxSkills} skills. ` +
  `If the session revealed any concrete project workflow (build/test/run commands, conventions, a fix procedure), return at least one skill.]`

const text = await memoryModelText(model, [
  { role: 'system', content: DISTILL_PROMPT },
  { role: 'user', content: conversation + guidanceNote },
])
if (!text) return { factsCount: 0, skillsCount: 0, bankAdded: 0, reason: 'model returned no text (tool_calls?)' }
const extracted = parseDistilledItems(text)
if (!extracted) return { factsCount: 0, skillsCount: 0, bankAdded: 0, reason: `unparseable: ${text.slice(0, 200)}` }
if (!extracted.skills.length) return { factsCount: 0, skillsCount: 0, bankAdded: 0, reason: 'model returned empty skills' }

// ……原有写入逻辑；写入 SkillBank 的循环里统计 bankAdded：
let bankAdded = 0
// if (candidate && options.skillBank.add(candidate, 'general')) bankAdded++
// if (!candidate) 记录 reason = 'rejected by sanitizeSkill'
return { factsCount: 0, skillsCount, bankAdded }
// 外层 catch 改为：catch (e) { return { factsCount: 0, skillsCount: 0, bankAdded: 0, reason: String(e) } }
```

### 第 4 步：重排 `runtime.ts › distill()`，加超时、持久化日志和串行保存

```
import { appendFile } from 'node:fs/promises'
import { cleanupStaleTmp } from './fs-util.js'

private saveChain: Promise<void> = Promise.resolve()

private async log(msg: string) {
  this.lastErrors.push(msg)
  await appendFile(path.join(this.root, 'memory-debug.log'), `[${new Date().toISOString()}] ${msg}\n`).catch(() => {})
}

// create() 里，加载之前：
await cleanupStaleTmp(r)

/** 所有保存操作串行执行，避免并发写同一文件 */
save(): Promise<void> {
  const run = this.saveChain.then(async () => {
    await this.skillBank.save()
    await this.graph.save(this.graphPath)
    await this.vectorStore.save(this.vectorPath)
  })
  this.saveChain = run.catch(e => this.log(`save FAILED: ${e instanceof Error ? e.message : e}`))
  return run
}

async distill(messages: ChatMessage[], model: ModelAdapter, sessionId: string,
              opts: { onProgress?: (s: string) => void } = {}): Promise<void> {
  if (process.env.MINI_CODE_MEMORY_DISTILL === '0' || this.distilledSessions.has(sessionId)) return
  this.distilledSessions.add(sessionId)
  if (!this.extractor) this.initModel(model)

  const step = async <T>(name: string, fn: () => Promise<T>, ms = 60_000): Promise<T | undefined> => {
    const t0 = Date.now()
    let timer: NodeJS.Timeout | undefined
    try {
      const r = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms) }),
      ])
      await this.log(`${name} ok (${Date.now() - t0}ms) ${r && typeof r === 'object' ? JSON.stringify(r).slice(0, 300) : ''}`)
      return r
    } catch (e) {
      await this.log(`${name} FAILED (${Date.now() - t0}ms): ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    } finally { clearTimeout(timer) }
  }

  // ① 程序记忆优先：只需 1 次 LLM 调用，完成后立即落盘
  this.resolvePendingEpisode()
  opts.onProgress?.('正在提取技能…')
  await step('procedural', () => distillSessionEnd(messages, model, this.proceduralStore, sessionId, { skillBank: this.skillBank }))
  await step('skill-failures', () => this.learnFromSessionFailures())
  await step('save-skills', () => this.skillBank.save(), 10_000)

  // ② 图谱记忆耗时长，放在后面；每一步都有超时
  if (this.graphMemoryEnabled) {
    opts.onProgress?.('正在写入知识图谱…')
    const ext = await step('extract', () => this.extractor!.extractFromMessages(messages, sessionId), 90_000)
    const cons = await step('consolidate', () => this.consolidator!.consolidate(), 60_000)
    await step('reconcile', () => this.reconciler!.reconcile([...(ext?.touchedFactIds ?? []), ...(cons?.touchedFactIds ?? [])]))
    await step('flush-vectors', () => this.vectorStore.flushPending(), 30_000)
  } else {
    await this.log(`graph skipped: ${this.embedClient.unavailableReason}`)
  }
  opts.onProgress?.('正在保存…')
  await step('save-all', () => this.save(), 15_000)
}
```

`index.ts` 里的 `distillSession` 回调相应改为接收并转发 `onProgress` 参数。

### 第 5 步：让 `fs-util.ts` 的写入更稳

```
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
```

进程被强杀时 tmp 残留是没法避免的，这里能做的是不损坏正式文件，并在下次启动时清理残留。

### 第 6 步：修好退出流程（`tty-app.ts` 和 `index.ts`）

`tty-app.ts › finish()`：

```
const finish = () => {
  if (finished) return
  finished = true
  setStatus(state, '正在保存记忆，请勿关闭终端…')
  scheduleRender()
  void permissionArgs.execution!.stop()
    .then(async () => {
      await permissionArgs.distillSession?.(permissionArgs.messages, permissionArgs.sessionId,
        (s: string) => { setStatus(state, `${s}（请勿关闭终端）`); scheduleRender() })
      await permissionArgs.memoryRuntime?.save()        // 保存完成后才打印"saved"
    })
    .catch(() => {})
    .finally(() => {
      permissionArgs.execution!.goal.manager.dispose()
      cleanup()
      resolve()
    })
}
```

把 `handleEvent` 开头的 `if (finished) return` 改成：

```
if (finished) {
  if (event.kind === 'text' && event.ctrl && event.text === 'c') {
    setStatus(state, '仍在保存记忆（各步骤均有超时上限），请稍候…'); scheduleRender()
  }
  return
}
```

`TtyAppArgs.distillSession` 的类型同步加上第三个参数 `onProgress?: (s: string) => void`。

`index.ts` 的 `finally`：先保存，再做可能卡住的清理；MCP 等待加上限：

```
} finally {
  const onSig = () => process.stderr.write('\n[minicode] 正在保存记忆，请稍候…\n')
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig)
  await memoryRuntime?.save().catch(() => {})
  await subAgents.closeAll()
  await Promise.race([mcpHydration, new Promise(r => setTimeout(r, 3000))])
  await tools.dispose()
  process.off('SIGINT', onSig); process.off('SIGTERM', onSig)
}
```

### 第 7 步（可选，但最符合"三轮后就应该有技能"的预期）：会话中途增量提取技能

在 `runtime.ts › completeTurn` 末尾加上：

```
private turnsSinceSkillDistill = 0
private bgSkillDistill: Promise<unknown> | null = null

// completeTurn 末尾（skillBank.save() 之前）：
const every = Number(process.env.MINI_CODE_SKILL_DISTILL_EVERY ?? 3)
if (this.model && ++this.turnsSinceSkillDistill >= every && !this.bgSkillDistill) {
  this.turnsSinceSkillDistill = 0
  const snapshot = [...args.messages]
  this.bgSkillDistill = distillSessionEnd(snapshot, this.model, this.proceduralStore, `turn-${this.turnIndex}`, { skillBank: this.skillBank })
    .then(r => this.log(`incremental-skill ${JSON.stringify(r)}`))
    .then(() => this.skillBank.save())
    .catch(e => this.log(`incremental-skill FAILED: ${e}`))
    .finally(() => { this.bgSkillDistill = null })
}
```

在 `distill()` 开头加 `await this.bgSkillDistill`，避免和退出时的蒸馏并发执行。重复的技能会被 `findNearDuplicate` 挡掉。



### 补充 1：`model-call.ts` 加诊断日志，并列出全部替换点

```
// src/memory/model-call.ts
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_MEMORY_PATH } from '../config.js'
import type { ChatMessage, ModelAdapter } from '../types.js'

export async function memoryModelText(model: ModelAdapter, messages: ChatMessage[]): Promise<string | null> {
  const res = await model.next(messages, { tools: [] })
  if (res.type === 'assistant') return res.content
  await appendFile(
    path.join(MINI_CODE_MEMORY_PATH, 'memory-debug.log'),
    `[${new Date().toISOString()}] memory call returned tool_calls: ${res.calls.map(c => c.toolName).join(',')}\n`,
  ).catch(() => {})
  return res.content?.trim() ? res.content : null
}
```

逐个文件替换（所有 `{}` 都换成通过 `memoryModelText` 调用）：

```
// distiller.ts › distillSessionEnd
const text = await memoryModelText(model, [
  { role: 'system', content: DISTILL_PROMPT },
  { role: 'user', content: conversation + guidanceNote },
])

// extractor.ts › callLLM
const content = await memoryModelText(this.model, [
  { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
  { role: 'user', content: fill(EXTRACTION_USER_PROMPT, { text, session_date: sessionDate }) },
])
if (!content) return null
const p = extractJsonObject(content) as Partial<ExtractionResult> | null

// consolidator.ts › synthesize
const content = await memoryModelText(this.model, [
  { role: 'system', content: CONSOLIDATION_CLUSTER_SYSTEM }, { role: 'user', content: user },
])
if (!content) return null
const d = extractJsonObject(content) as { ... } | null

// fact-reconciler.ts › confirmConflicts
const content = await memoryModelText(this.model, [ /* 原来的两条消息 */ ])
if (!content) return []
const d = extractJsonObject(content) as { conflicts?: unknown[] } | null

// search-agent.ts › search 循环内
out = (await memoryModelText(this.model, [ /* 原来的两条消息 */ ])) ?? ''

// skill-mutator.ts › mutate / analyzeFailures
const text = await memoryModelText(this.model, [{ role: 'user', content: prompt }])
if (!text) return null            // analyzeFailures 里改成 return []
const parsed = this.extractJSON(text, false)   // analyzeFailures 里第二个参数是 true
```

### 补充 2：`distiller.ts` 中，程序记忆写入失败时不再连带技能库

```
const reasons: string[] = []
for (const skill of extracted.skills.slice(0, maxSkills)) {
  try {
    if (await writeIfNotRedundant(skill.content, skill.tags, skill.durability)) skillsCount++
  } catch (e) {
    reasons.push(`procedural write failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
// 下面写 SkillBank 的循环保持独立；sanitizeSkill 返回 null 时 reasons.push('rejected by sanitizeSkill')
return { factsCount: 0, skillsCount, bankAdded, reason: reasons.join('; ') || undefined }
```

### 补充 3：`runtime.ts › completeTurn` 中，没有检索到技能时也记录失败

```
// 原来：if (skills.length > 0 && args.userQuery) {
if (args.userQuery) {
  const task = args.userQuery.slice(0, 500)
  const { trajectory, toolErrors, lastToolOk } = summarizeLastTurn(args.messages)
  const sig = immediateSignal(args.outcome)
  if (sig === 'defer') {
    const provisional: CreditSignal = lastToolOk === false ? 'failure' : toolErrors === 0 ? 'success' : null
    this.pendingEpisode = { skills, task, trajectory, provisional }
  } else if (sig !== null) {
    this.credit(skills, sig === 'success', task, trajectory)
  }
}
```

`skills` 为空时，`recordEpisode` 里的循环什么也不做，但失败会被推进 `sessionFailures`。这样同一会话里累计 2 次失败，`analyzeFailures` 就能从零生成技能。

### 补充 4：`memory-tools.ts` 中，`memory_read` 过滤掉已归档的节点

```
import { isRetrievable } from '../memory/retrieval-policy.js'
// run() 内：
results = await vectorStore.search(input.query, input.limit, id => {
  const n = graph.getNode(id)
  return !!n && isRetrievable(n)
})
```

### 补充 5：`mock-model.ts` 加上记忆任务的固定回复，方便离线验证

在 `next()` 函数的最开头插入：

```
const system = messages.find(m => m.role === 'system')?.content ?? ''
if (system.startsWith('Extract concise, durable information')) {        // DISTILL_PROMPT
  return { type: 'assistant', content: JSON.stringify({
    facts: [],
    skills: [{ content: '该项目的验证命令是 npm run check && npm test', when_to_apply: '修改代码之后、提交之前',
               tags: ['workflow'], durability: 'durable' }],
    summary: '',
  }) }
}
if (system.startsWith('You extract long-term memory')) {                // EXTRACTION_SYSTEM_PROMPT
  return { type: 'assistant', content: '{"persons":[],"concepts":[],"events":[],"facts":[],"claims":[]}' }
}
```