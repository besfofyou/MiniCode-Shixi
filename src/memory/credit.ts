import type { ChatMessage, AgentTurnOutcome } from '../types.js'

export type CreditSignal = 'success' | 'failure' | null   // null = 不计分

const NEGATIVE = [
  /不对|错了|不行|还是(报错|不行|失败)|没(用|生效)|回滚|撤销|重来/,
  /\b(wrong|broken|doesn'?t work|not working|still (fails?|errors?)|revert|undo)\b/i,
]
const POSITIVE = [
  /谢谢|可以了|好了|没问题|完美|搞定|成功了/,
  /\b(thanks|works|perfect|lgtm|looks good)\b/i,
]

/** 用下一条用户消息作为隐式反馈 */
export function feedbackFromNextUserMessage(text: string): CreditSignal {
  const t = text.slice(0, 300)
  if (NEGATIVE.some(r => r.test(t))) return 'failure'
  if (POSITIVE.some(r => r.test(t))) return 'success'
  return null
}

/** 只依据 outcome 能直接判定的部分 */
export function immediateSignal(outcome: AgentTurnOutcome): CreditSignal | 'defer' {
  switch (outcome) {
    case 'failed':
    case 'max_steps': return 'failure'
    case 'final': return 'defer'            // 等下一条用户消息再定
    default: return null                    // aborted / awaiting_user / controlled_stop 不计分
  }
}

/** 从末尾向前扫描到本轮起点（跳过 continuation），生成带错误信息的轨迹 */
export function summarizeLastTurn(messages: ChatMessage[]) {
  let start = messages.length - 1
  while (start >= 0) {
    const m = messages[start] as ChatMessage & { internal?: string }
    if (m.role === 'user' && m.internal !== 'continuation') break
    start--
  }
  const parts: string[] = []
  let toolErrors = 0
  let lastToolOk: boolean | null = null
  for (const m of messages.slice(Math.max(0, start))) {
    if (m.role !== 'tool_result') continue
    lastToolOk = !m.isError
    if (m.isError) {
      toolErrors++
      parts.push(`${m.toolName}✗ ${String(m.content).replace(/\s+/g, ' ').slice(0, 120)}`)
    } else parts.push(`${m.toolName}✓`)
  }
  return { trajectory: parts.join(' → ').slice(0, 1000), toolErrors, lastToolOk }
}
