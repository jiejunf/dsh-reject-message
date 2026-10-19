/**
 * 宿主拒绝沙箱提权时那句 "拒绝即终结" 的改写.
 *
 * 宿主原文由 dsh-sandbox 的 approveEscalation 拼出:
 * `the user rejected escalating this <主体> to "<档位>"; it stays denied, so stop and explain instead of working around it`.
 * 尾句把这次拒绝说成不可翻案的终局, 与本项目给模型的规则不符, 这里换掉尾句,
 * 前段的拒绝事实与目标档位原样保留.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * 宿主终结尾句的整句匹配. 前段与主体词被捕获, 尾句逐字一致才认领,
 * 所以宿主改了措辞就不动它; 开头不锚定, 文本块自带的 `Error: ` 一类前缀不受影响.
 */
const HOST_FINAL_REJECTION = /(the user rejected escalating this (\S+) to "[^"]+"); it stays denied, so stop and explain instead of working around it$/

/** 尾句替换后的续写, 主体词随工具家族 (command / operation) 变化. */
function retryGuidance(subject: string): string {
  return `if this ${subject} is still necessary, `
    + 're-request it with a clearer justification, though a repeat ask may be rejected again'
}

/**
 * 把一段含宿主终结尾句的文本改写成可重新发起的表述.
 * @param text - 工具结果里的一段文本.
 * @returns 改写后的文本, 不是这句宿主文案时返回 undefined.
 */
export function rewriteEscalationTail(text: string): string | undefined {
  const match = HOST_FINAL_REJECTION.exec(text)
  if (match === null) return undefined
  const head = match[1]
  const subject = match[2]
  if (head === undefined || subject === undefined) return undefined
  return `${text.slice(0, match.index)}${head}; ${retryGuidance(subject)}`
}

/**
 * 就地改写 content blocks 里的宿主终结尾句, 其余块 (例如追加的拒绝描述) 原样保留.
 * @param content - 进入决策的 content blocks.
 * @returns 改写后的 blocks, 没有可改的块时返回 undefined.
 */
export function rewriteEscalationTailBlocks(content: readonly ContentBlock[]): ContentBlock[] | undefined {
  let changed = false
  const blocks = content.map((block) => {
    if (block.type !== 'text') return block
    const text = rewriteEscalationTail(block.text)
    if (text === undefined) return block
    changed = true
    return { type: 'text' as const, text }
  })
  return changed ? blocks : undefined
}
