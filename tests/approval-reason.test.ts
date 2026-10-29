import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AbandonedApprovalStash,
  ABANDONED_APPROVAL_TTL_MS,
  ApprovalReasonStore,
  autoReviewAskReason,
  formatAbandonedApproval,
  formatAbandonedApprovals,
} from '../src/approval-reason.ts'

describe('autoReviewAskReason', () => {
  it('strips the audited prefix from an auto-review ask', () => {
    assert.equal(
      autoReviewAskReason('Auto review denied tool "bash": production read is not authorized'),
      'production read is not authorized',
    )
  })

  it('ignores other askers and empty reasons', () => {
    assert.equal(autoReviewAskReason(undefined), undefined)
    assert.equal(autoReviewAskReason('escalate sandbox to danger-full-access: because'), undefined)
    assert.equal(autoReviewAskReason('Auto review denied tool "bash":   '), undefined)
  })
})

describe('ApprovalReasonStore', () => {
  it('takes a captured reason exactly once', () => {
    const store = new ApprovalReasonStore(1000)
    store.capture('s1', 'c1', 'bash', 'needs authorization')
    const taken = store.take('s1', 'c1')
    assert.equal(taken?.toolName, 'bash')
    assert.equal(taken?.reason, 'needs authorization')
    assert.equal(store.take('s1', 'c1'), undefined)
  })

  it('expires an overdue record', () => {
    const store = new ApprovalReasonStore(1000)
    store.capture('s1', 'c1', 'bash', 'needs authorization', 0)
    assert.equal(store.take('s1', 'c1', 1001), undefined)
  })

  it('keeps the default lifetime long enough for the run_code budget', () => {
    assert.equal(ABANDONED_APPROVAL_TTL_MS >= 5 * 60_000, true)
  })
})

describe('AbandonedApprovalStash', () => {
  it('merges entries by root call and dedupes by inner call id', () => {
    const stash = new AbandonedApprovalStash()
    stash.add('s1', 'root1', { callId: 'root1:ptc:1', toolName: 'bash', reason: 'why' })
    stash.add('s1', 'root1', { callId: 'root1:ptc:1', toolName: 'bash', reason: 'why' })
    stash.add('s1', 'root1', { callId: 'root1:ptc:2', toolName: 'read', reason: 'because' })
    const taken = stash.take('s1', 'root1')
    assert.equal(taken.length, 2)
    assert.deepEqual(stash.take('s1', 'root1'), [])
  })

  it('keeps different sessions apart', () => {
    const stash = new AbandonedApprovalStash()
    stash.add('s1', 'root1', { callId: 'a', toolName: 'bash', reason: 'why' })
    assert.deepEqual(stash.take('s2', 'root1'), [])
    assert.equal(stash.take('s1', 'root1').length, 1)
  })
})

describe('formatAbandonedApproval', () => {
  it('names the tool and keeps the reason', () => {
    const text = formatAbandonedApproval('bash', 'needs authorization')
    assert.equal(text.includes('bash'), true)
    assert.equal(text.includes('needs authorization'), true)
  })
})

describe('formatAbandonedApprovals', () => {
  it('lists every abandoned call', () => {
    const text = formatAbandonedApprovals([
      { callId: 'a', toolName: 'bash', reason: 'why' },
      { callId: 'b', toolName: 'read', reason: 'because' },
    ])
    assert.equal(text.includes('- "bash": why'), true)
    assert.equal(text.includes('- "read": because'), true)
  })
})
