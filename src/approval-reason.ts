/**
 * 审批原因的短暂暂存, 让 abort / 超时路径也能把 asker 的原因带回模型.
 *
 * 只有 auto-review 的 ask 原因会被采纳. 原生审批点拒绝时由 Client 预填描述走
 * `record` 通道; 审批还没被回答就被取消 (例如 PTC 的 run_code 预算到点) 时没有
 * 任何用户交互, 只能由 Host 记住原因, 等工具结果进入 post-execute 时再附加.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis `approval/request` 事件里本插件要读的最小字段. */
export interface ApprovalAskLike {
  /** 被询问的工具. */
  readonly toolName: string
  /** 精确的工具调用 id; 没有它就无法把原因和结果对上. */
  readonly callId?: string
  /** asker 给出的审计原因. */
  readonly reason?: string
  /** 发起询问的 agent (取其会话 id 作为键的一部分). */
  readonly agent?: { readonly session: { readonly id: string } }
}

/** 审批 waterfall 的封闭结果集合. */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 询问组合好的 answerer 如何决定. 本插件只旁听 (返回 `next()`), 记录原因.
     * @param req - 待决定请求.
     * @param next - 交给下一个 listener.
     */
    'approval/request'(
      this: Context,
      req: ApprovalAskLike,
      next: () => Promise<ApprovalOutcomeLike>,
    ): Promise<ApprovalOutcomeLike>
  }
}

/** auto-review 审批的审计原因前缀. */
const AUTO_REVIEW_ASK = /^Auto review denied tool "[^"]*": /

/** 审批原因的存活时间: 覆盖 run_code 的 300s 预算与排队时间. */
export const ABANDONED_APPROVAL_TTL_MS = 15 * 60_000

/** 取消类工具结果的错误码. */
export const ABORTED_CODES: readonly string[] = ['ABORTED', 'ABORTED_BEFORE_DISPATCH']

/** run_code 自身失败的错误码 (`CodeRunFailedError`). */
export const CODE_RUN_FAILED = 'CODE_RUN_FAILED'

/**
 * 从审批的审计原因里取出可以直接交给模型的复核理由.
 *
 * 只采纳 auto-review 的 ask 原因; 沙箱提权等其它问法返回 `undefined`, 由它们
 * 各自的流程处理. 前缀里的工具名会被剥掉, 因为附加正文已经带了工具名.
 *
 * @param reason - `ApprovalAskLike.reason`.
 * @returns reviewer 的原始理由, 或不适配时的 `undefined`.
 */
export function autoReviewAskReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  if (!AUTO_REVIEW_ASK.test(reason)) return undefined
  const detail = reason.replace(AUTO_REVIEW_ASK, '').trim()
  return detail.length === 0 ? undefined : detail
}

/** 被放弃的审批: 工具名与 asker 原因. */
export interface CapturedApproval {
  /** 被询问的工具. */
  toolName: string
  /** 已剥离前缀的复核理由. */
  reason: string
  /** 写入时刻. */
  storedAt: number
}

/** 按会话与工具调用索引的审批原因暂存. */
export class ApprovalReasonStore {
  private readonly records = new Map<string, CapturedApproval>()
  private readonly ttlMs: number

  /**
   * @param ttlMs - 条目存活时间, 超时后 take 视为未命中.
   */
  constructor(ttlMs = ABANDONED_APPROVAL_TTL_MS) {
    this.ttlMs = ttlMs
  }

  /**
   * 生成暂存键.
   * @param sessionId - 审批所属会话.
   * @param callId - 工具调用 id.
   */
  key(sessionId: string, callId: string): string {
    return `${sessionId}\u0000${callId}`
  }

  /**
   * 写入或覆盖一条审批原因.
   * @param sessionId - 审批所属会话.
   * @param callId - 工具调用 id.
   * @param toolName - 被询问的工具.
   * @param reason - 已剥离前缀的复核理由.
   * @param now - 可注入的当前时间, 便于测试.
   */
  capture(
    sessionId: string,
    callId: string,
    toolName: string,
    reason: string,
    now = Date.now(),
  ): void {
    this.records.set(this.key(sessionId, callId), { toolName, reason, storedAt: now })
  }

  /**
   * 取出并删除一条审批原因; 缺失或过期返回 `undefined`.
   * @param sessionId - 审批所属会话.
   * @param callId - 工具调用 id.
   * @param now - 可注入的当前时间, 便于测试.
   */
  take(sessionId: string, callId: string, now = Date.now()): CapturedApproval | undefined {
    const key = this.key(sessionId, callId)
    const record = this.records.get(key)
    if (record === undefined) return undefined
    this.records.delete(key)
    if (now - record.storedAt > this.ttlMs) return undefined
    return { toolName: record.toolName, reason: record.reason, storedAt: record.storedAt }
  }

  /** 清空暂存 (插件卸载时用). */
  clear(): void {
    this.records.clear()
  }
}

/** 归并到一次 `run_code` 调用下的被放弃审批. */
export interface AbandonedApproval {
  /** 内层工具调用 id. */
  callId: string
  /** 内层工具名. */
  toolName: string
  /** asker 原因. */
  reason: string
}

/**
 * 按外层 `run_code` 调用归并内层被放弃的审批.
 *
 * 内层工具结果不直接进模型上下文, 所以原因先在这里按 `rootCallId` 攒着, 等外层
 * `run_code` 的失败结果进入 post-execute 时再统一写进模型可见正文.
 */
export class AbandonedApprovalStash {
  private readonly byRoot = new Map<string, AbandonedApproval[]>()

  /**
   * 归并一条内层被放弃审批; 同一个内层调用只保留一次.
   * @param sessionId - 会话 id.
   * @param rootCallId - 外层 run_code 的调用 id.
   * @param entry - 内层调用与原因.
   */
  add(sessionId: string, rootCallId: string, entry: AbandonedApproval): void {
    const key = `${sessionId}\u0000${rootCallId}`
    const bucket = this.byRoot.get(key) ?? []
    if (bucket.some((item) => item.callId === entry.callId)) return
    bucket.push(entry)
    this.byRoot.set(key, bucket)
  }

  /**
   * 取出并删除一次外层调用下的全部条目.
   * @param sessionId - 会话 id.
   * @param rootCallId - 外层 run_code 的调用 id.
   * @returns 归并到的被放弃审批, 没有时为空数组.
   */
  take(sessionId: string, rootCallId: string): AbandonedApproval[] {
    const key = `${sessionId}\u0000${rootCallId}`
    const bucket = this.byRoot.get(key) ?? []
    this.byRoot.delete(key)
    return bucket
  }

  /** 清空暂存 (插件卸载时用). */
  clear(): void {
    this.byRoot.clear()
  }
}

/**
 * 单条被放弃审批的模型可见正文.
 * @param toolName - 内层工具名.
 * @param reason - asker 原因.
 */
export function formatAbandonedApproval(toolName: string, reason: string): string {
  return `The approval for tool "${toolName}" was abandoned before a decision (cancelled or timed out).\nAuto review reason: ${reason}`
}

/**
 * 外层 run_code 失败时, 把该次运行里被放弃的审批原因汇成一段正文.
 * @param entries - 该次 run_code 下归并到的条目.
 */
export function formatAbandonedApprovals(entries: readonly AbandonedApproval[]): string {
  const lines = entries.map((entry) => `- "${entry.toolName}": ${entry.reason}`)
  return `Approval requests abandoned before a decision (cancelled or timed out):\n${lines.join('\n')}`
}
