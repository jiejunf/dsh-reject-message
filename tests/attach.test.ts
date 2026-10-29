import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { AbandonedApprovalStash, ApprovalReasonStore } from '../src/approval-reason.ts'
import { appendRejectContent, attachRejectMessage, autoReviewDenialReason } from '../src/attach.ts'
import { formatRejectNote } from '../src/shared.ts'
import { RejectMessageStore } from '../src/store.ts'

function exec(partial: {
  sessionId?: string
  name?: string
  callId?: string
  rootCallId?: string
  parent?: boolean
}): ToolExecution {
  return {
    name: partial.name ?? 'bash',
    callId: (partial.callId ?? 'c1') as ToolExecution['callId'],
    rootCallId: (partial.rootCallId ?? partial.callId ?? 'c1') as ToolExecution['callId'],
    ...partial.parent === true ? { parent: {} } : {},
    agent: partial.sessionId === undefined
      ? undefined
      : { session: { id: partial.sessionId } },
  } as unknown as ToolExecution
}

function failure(text: string): ToolExecutionResult {
  return {
    isError: true,
    error: { message: text },
    content: [{ type: 'text', text }],
  } as ToolExecutionResult
}

/** auto-review `never` 路径的最终拒绝: 原因只在 `error.info.reason` 里. */
function autoReviewFailure(reason: string): ToolExecutionResult {
  const text = 'Auto review rejected tool "bash"; its body was not executed'
  return {
    isError: true,
    error: {
      message: text,
      info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason },
    },
    content: [{ type: 'text', text: `Error: ${text}` }],
  } as unknown as ToolExecutionResult
}

/** 审批等待被取消时的工具结果 (`AbortError` / `ABORTED` 或未派发变体). */
function abortedFailure(code = 'ABORTED'): ToolExecutionResult {
  return {
    isError: true,
    error: { message: 'tool call aborted', info: { name: 'AbortError', code } },
    content: [{ type: 'text', text: 'Error: tool call aborted' }],
  } as unknown as ToolExecutionResult
}

/** PTC 外层 `run_code` 的失败结果 (`CodeRunFailedError`). */
function runCodeFailure(): ToolExecutionResult {
  const message = 'code run failed (timeout): execution deadline reached (300000ms)'
  return {
    isError: true,
    error: {
      message,
      info: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' },
    },
    content: [{ type: 'text', text: `Error: ${message}` }],
  } as unknown as ToolExecutionResult
}

/** 宿主拒绝升权的原文, 尾句由 dsh-sandbox 的 approveEscalation 固定. */
const HOST_REJECTION = 'the user rejected escalating this command to "danger-full-access"; '
  + 'it stays denied, so stop and explain instead of working around it'

/** 改写后的同一句: 前段与原档位不动, 尾句换成可重新发起的表述. */
const RETRYABLE_REJECTION = 'the user rejected escalating this command to "danger-full-access"; '
  + 'if this command is still necessary, re-request it with a clearer justification, '
  + 'though a repeat ask may be rejected again'

describe('appendRejectContent', () => {
  it('appends to the last text block', () => {
    const next = appendRejectContent([{ type: 'text', text: 'denied' }], 'note')
    assert.deepEqual(next, [{ type: 'text', text: 'denied\n\nnote' }])
  })

  it('adds a text block when the last block is not text', () => {
    const next = appendRejectContent([], 'note')
    assert.deepEqual(next, [{ type: 'text', text: 'note' }])
  })
})

describe('attachRejectMessage', () => {
  it('returns the downstream decision when nothing is stored', () => {
    const store = new RejectMessageStore(1000)
    const downstream = { kind: 'accept' as const }
    const attached = attachRejectMessage(store, exec({ sessionId: 's1' }), failure('denied'), downstream)
    assert.equal(attached, downstream)
  })

  it('appends the description to an error result', () => {
    const store = new RejectMessageStore(1000)
    store.put(store.key('s1', 'bash', 'c1'), 'stay in workspace')
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'c1' }),
      failure('the user rejected tool "bash"'),
      { kind: 'accept' },
    )
    assert.equal(attached.kind, 'accept')
    if (attached.kind !== 'accept' || !('content' in attached)) {
      throw new Error('expected content replacement')
    }
    const text = attached.content?.[0]
    assert.equal(text?.type, 'text')
    if (text?.type !== 'text') throw new Error('expected text')
    assert.equal(text.text.includes('the user rejected tool "bash"'), true)
    assert.equal(text.text.includes(formatRejectNote('bash', 'stay in workspace')), true)
    assert.equal(attached.additionalContexts?.length, 1)
  })

  it('rewrites the host final tail even without a description', () => {
    const store = new RejectMessageStore(1000)
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'c2' }),
      failure(`Error: ${HOST_REJECTION}`),
      { kind: 'accept' },
    )
    assert.deepEqual(attached, {
      kind: 'accept',
      content: [{ type: 'text', text: `Error: ${RETRYABLE_REJECTION}` }],
    })
  })

  it('rewrites the tail in place and keeps the appended description', () => {
    const store = new RejectMessageStore(1000)
    store.put(store.key('s1', 'bash', 'c3'), '提权干什么')
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'c3' }),
      failure(`Error: ${HOST_REJECTION}`),
      { kind: 'accept' },
    )
    if (attached.kind !== 'accept' || !('content' in attached)) {
      throw new Error('expected content replacement')
    }
    const text = attached.content?.[0]
    if (text?.type !== 'text') throw new Error('expected text')
    assert.equal(text.text.includes(RETRYABLE_REJECTION), true)
    assert.equal(text.text.includes('it stays denied'), false)
    assert.equal(text.text.includes(formatRejectNote('bash', '提权干什么')), true)
    assert.equal(attached.additionalContexts?.length, 1)
  })

  it('keeps a non-matching failure untouched', () => {
    const store = new RejectMessageStore(1000)
    const downstream = { kind: 'accept' as const }
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'c4' }),
      failure('tool call aborted'),
      downstream,
    )
    assert.equal(attached, downstream)
  })

  it('appends the auto-review reason of a final denial', () => {
    const store = new RejectMessageStore(1000)
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'c5' }),
      autoReviewFailure('production read is not authorized'),
      { kind: 'accept' },
    )
    assert.equal(attached.kind, 'accept')
    if (attached.kind !== 'accept' || !('content' in attached)) {
      throw new Error('expected content replacement')
    }
    const text = attached.content?.[0]
    if (text?.type !== 'text') throw new Error('expected text')
    assert.equal(text.text.includes('Auto review denied this call: production read is not authorized'), true)
    assert.equal(attached.additionalContexts, undefined)
  })

  it('keeps a success and an already-handled decision untouched', () => {
    const store = new RejectMessageStore(1000)
    const success = { isError: false, value: {}, content: [] } as unknown as ToolExecutionResult
    const downstream = { kind: 'accept' as const }
    assert.equal(attachRejectMessage(store, exec({ sessionId: 's1' }), success, downstream), downstream)
    const blocked = { kind: 'block' as const, feedback: [] }
    const attached = attachRejectMessage(store, exec({ sessionId: 's1' }), autoReviewFailure('nope'), blocked)
    assert.equal(attached, blocked)
  })
})

describe('autoReviewDenialReason', () => {
  it('reads the reviewer reason from the structured error detail', () => {
    assert.equal(autoReviewDenialReason(autoReviewFailure(' needs explicit approval ')), 'needs explicit approval')
  })

  it('ignores other errors and empty reasons', () => {
    assert.equal(autoReviewDenialReason(failure('tool call aborted')), undefined)
    assert.equal(autoReviewDenialReason(autoReviewFailure('   ')), undefined)
  })
})

describe('attachRejectMessage abandoned approvals', () => {
  function runtime(): { reasons: ApprovalReasonStore, stash: AbandonedApprovalStash } {
    return { reasons: new ApprovalReasonStore(1000), stash: new AbandonedApprovalStash() }
  }

  it('appends the captured reason to a native aborted result', () => {
    const store = new RejectMessageStore(1000)
    const abandoned = runtime()
    abandoned.reasons.capture('s1', 'c6', 'bash', 'production read is not authorized')
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'c6' }),
      abortedFailure(),
      { kind: 'accept' },
      abandoned,
    )
    if (attached.kind !== 'accept' || !('content' in attached)) {
      throw new Error('expected content replacement')
    }
    const text = attached.content?.[0]
    if (text?.type !== 'text') throw new Error('expected text')
    assert.equal(text.text.includes('The approval for tool "bash" was abandoned'), true)
    assert.equal(text.text.includes('production read is not authorized'), true)
    assert.equal(attached.additionalContexts?.length, 1)
  })

  it('defers a PTC inner reason to the outer run_code failure', () => {
    const store = new RejectMessageStore(1000)
    const abandoned = runtime()
    abandoned.reasons.capture('s1', 'root1:ptc:1', 'bash', 'needs explicit approval')
    const inner = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'root1:ptc:1', parent: true, rootCallId: 'root1' }),
      abortedFailure('ABORTED_BEFORE_DISPATCH'),
      { kind: 'accept' },
      abandoned,
    )
    if (inner.kind !== 'accept') throw new Error('expected accept')
    assert.equal((inner as { content?: unknown }).content, undefined)
    assert.equal(inner.additionalContexts?.length, 1)

    const outer = attachRejectMessage(
      store,
      exec({ sessionId: 's1', name: 'run_code', callId: 'root1' }),
      runCodeFailure(),
      { kind: 'accept' },
      abandoned,
    )
    if (outer.kind !== 'accept' || !('content' in outer)) {
      throw new Error('expected content replacement')
    }
    const text = outer.content?.[0]
    if (text?.type !== 'text') throw new Error('expected text')
    assert.equal(text.text.includes('Approval requests abandoned before a decision'), true)
    assert.equal(text.text.includes('- "bash": needs explicit approval'), true)
  })

  it('leaves an aborted result untouched without a captured reason', () => {
    const store = new RejectMessageStore(1000)
    const downstream = { kind: 'accept' as const }
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'c7' }),
      abortedFailure(),
      downstream,
      runtime(),
    )
    assert.equal(attached, downstream)
  })

  it('does not claim an abandoned approval for a cancellation without approval', () => {
    const store = new RejectMessageStore(1000)
    const abandoned = runtime()
    abandoned.reasons.capture('s1', 'c8', 'bash', 'unused')
    const attached = attachRejectMessage(
      store,
      exec({ sessionId: 's1', callId: 'other' }),
      abortedFailure(),
      { kind: 'accept' },
      abandoned,
    )
    assert.equal(attached.additionalContexts, undefined)
    assert.equal(abandoned.reasons.take('s1', 'c8')?.reason, 'unused')
  })
})
