import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { rewriteEscalationTail, rewriteEscalationTailBlocks } from '../src/escalation-tail.ts'

/** 宿主的固定尾句, 由 dsh-sandbox 的 approveEscalation 给出. */
const TAIL = 'it stays denied, so stop and explain instead of working around it'

/** bash 家族的改写结果 (主体词 command). */
const RETRY_COMMAND = 'if this command is still necessary, '
  + 're-request it with a clearer justification, though a repeat ask may be rejected again'

/** 文件家族 (fs) 的改写结果 (主体词 operation). */
const RETRY_OPERATION = 'if this operation is still necessary, '
  + 're-request it with a clearer justification, though a repeat ask may be rejected again'

describe('rewriteEscalationTail', () => {
  it('keeps the rejection head and swaps the tail', () => {
    assert.equal(
      rewriteEscalationTail(`the user rejected escalating this command to "danger-full-access"; ${TAIL}`),
      `the user rejected escalating this command to "danger-full-access"; ${RETRY_COMMAND}`,
    )
  })

  it('keeps an Error: prefix and follows the subject word', () => {
    assert.equal(
      rewriteEscalationTail(`Error: the user rejected escalating this operation to "workspace-write"; ${TAIL}`),
      `Error: the user rejected escalating this operation to "workspace-write"; ${RETRY_OPERATION}`,
    )
  })

  it('leaves other texts alone', () => {
    assert.equal(rewriteEscalationTail('the user rejected tool "bash"'), undefined)
    assert.equal(
      rewriteEscalationTail('the user rejected escalating this command to "danger-full-access"; it stays denied'),
      undefined,
    )
    assert.equal(
      rewriteEscalationTail(`the user rejected escalating this command to "danger-full-access"; ${TAIL}\nmore text`),
      undefined,
    )
    assert.equal(rewriteEscalationTail('tool call aborted'), undefined)
  })
})

describe('rewriteEscalationTailBlocks', () => {
  it('rewrites the matching block and keeps the others', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: `Error: the user rejected escalating this command to "danger-full-access"; ${TAIL}` },
      { type: 'text', text: 'unrelated block' },
    ]
    const next = rewriteEscalationTailBlocks(blocks)
    assert.deepEqual(next, [
      { type: 'text', text: `Error: the user rejected escalating this command to "danger-full-access"; ${RETRY_COMMAND}` },
      { type: 'text', text: 'unrelated block' },
    ])
  })

  it('returns undefined when no block matches', () => {
    assert.equal(rewriteEscalationTailBlocks([{ type: 'text', text: 'ok' }]), undefined)
    assert.equal(rewriteEscalationTailBlocks([]), undefined)
  })
})
