/**
 * 把暂存的拒绝描述折进 tools/post-execute 决策, 并改写宿主那句 "拒绝即终结" 的尾句.
 * 错误结果会把描述追加到模型可见 content, 并额外挂一条 additionalContext.
 */

import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { rewriteEscalationTailBlocks } from './escalation-tail.ts'
import { formatAutoReviewNote, formatRejectNote, PLUGIN_NAME } from './shared.ts'
import type { RejectMessageStore } from './store.ts'

/** 从工具执行里取出会话 id. */
export function sessionIdOf(exec: Pick<ToolExecution, 'agent'>): string | undefined {
  const id = exec.agent?.session.id
  return id === undefined ? undefined : String(id)
}

/**
 * 把一段拒绝描述追加到已有 content blocks 末尾.
 * 末块是 text 时直接拼接, 否则再开一块, 避免打散原有投影.
 */
export function appendRejectContent(content: readonly ContentBlock[], note: string): ContentBlock[] {
  const last = content[content.length - 1]
  if (last !== undefined && last.type === 'text') {
    return [...content.slice(0, -1), { type: 'text', text: `${last.text}\n\n${note}` }]
  }
  return [...content, { type: 'text', text: note }]
}

function existingContexts(decision: PostToolDecision): NonNullable<PostToolDecision['additionalContexts']> {
  return decision.additionalContexts ?? []
}

/** 只在真有上下文时改决策对象, 否则原样返回, 保住下游决策的身份. */
function withContexts(
  decision: PostToolDecision,
  contexts: NonNullable<PostToolDecision['additionalContexts']>,
): PostToolDecision {
  return contexts.length === 0 ? decision : { ...decision, additionalContexts: contexts }
}

/** auto-review 最终拒绝的错误标识, 见 `@deepseek-ai/dsh-experimental-auto-review`. */
const AUTO_REVIEW_DENIED_NAME = 'AutoReviewDeniedError'

/**
 * 读取 auto-review 最终拒绝在错误详情里保存的复核原因.
 *
 * `never` 策略 (例如 in-process 子代理) 不经过审批窗口, 原因只存在于
 * `error.info.reason`; 这里把它取出来, 由 post-execute 追加进模型可见结果.
 *
 * @param result - 进入 post-execute 的规范结果.
 * @returns 非空复核原因, 或不是该错误时 `undefined`.
 */
export function autoReviewDenialReason(result: ToolExecutionResult): string | undefined {
  if (!result.isError) return undefined
  const info: unknown = result.error.info
  if (typeof info !== 'object' || info === null) return undefined
  const record = info as Record<string, unknown>
  if (record.name !== AUTO_REVIEW_DENIED_NAME) return undefined
  if (typeof record.reason !== 'string') return undefined
  const reason = record.reason.trim()
  return reason.length === 0 ? undefined : reason
}

/**
 * 把拒绝描述折进下游决策, 并改写宿主拒绝升权的终结尾句.
 *
 * 描述要有会话与 callId 才认得出来, 尾句改写则只看文本, 所以没有描述时同样生效.
 * 下游已经给出 block 或 value, 以及结果本身是成功时, 都不动 content.
 *
 * 两条通道互相独立: 用户填写的描述来自 Host 暂存 (ask 路径), auto-review 的复核原因
 * 来自错误详情 (never 路径); 两条都命中时按顺序拼进同一段正文.
 *
 * `never` 路径只追加 content, 不再挂一条 additionalContext: 那里没有用户要通知, 也没有
 * 审批卡; 让子代理后续 review 看到历史拒绝原因的价值很弱 (会话通常很短), 而把系统自动
 * 决定包装成 user-role notice 语义上也多余. 需要时补一条 context 只是一个循环的事.
 *
 * @param store - Host 暂存.
 * @param exec - 当前工具执行.
 * @param result - 进入 post-execute 的规范结果.
 * @param downstream - 下游 listener 返回的决策.
 */
export function attachRejectMessage(
  store: RejectMessageStore,
  exec: ToolExecution,
  result: ToolExecutionResult,
  downstream: PostToolDecision,
): PostToolDecision {
  const sessionId = sessionIdOf(exec)
  const note = sessionId === undefined ? undefined : store.takeFor(sessionId, exec.name, exec.callId)
  const noteText = note === undefined ? undefined : formatRejectNote(exec.name, note)
  const denialReason = autoReviewDenialReason(result)
  const denialText = denialReason === undefined ? undefined : formatAutoReviewNote(denialReason)
  const extra = noteText === undefined ? undefined : createUserMessage({
    content: [{ type: 'text', text: noteText }],
    source: {
      kind: PLUGIN_NAME,
      form: 'notice',
      summary: `The user rejected ${exec.name}.`,
    },
  })
  const contexts = [...existingContexts(downstream), ...extra === undefined ? [] : [extra]]
  const appended = [noteText, denialText].filter((text): text is string => text !== undefined).join('\n\n')

  if (downstream.kind === 'block' || 'value' in downstream || !result.isError) {
    return withContexts(downstream, contexts)
  }

  const baseContent = downstream.content ?? result.content
  const rewritten = rewriteEscalationTailBlocks(baseContent)
  const content = appended.length === 0
    ? rewritten
    : appendRejectContent(rewritten ?? baseContent, appended)
  if (content === undefined) return withContexts(downstream, contexts)
  return contexts.length === 0
    ? { kind: 'accept', content }
    : { kind: 'accept', content, additionalContexts: contexts }
}
