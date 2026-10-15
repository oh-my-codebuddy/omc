/**
 * error-dedup.ts（rate-limit P1 T3 / 决策 D4）：宿主**通用** UI 行为（无业务知识）。
 *
 * 背景：某些错误（实测 429）CLI 会先把文案作为 assistant 正文输出，随后同一条文案
 * 又经 `ExecutionError` 变成 `error` 事件 → 转录区把同一句话渲染两遍。
 *
 * 判据 = **纯文本判等**：error 文本与「最近一条已渲染的 assistant 定稿文本（text_final）」
 * 完全相同时，视为同一条信息的重复呈现 → 跳过渲染。**不掺**任何限流 / 错误码语义，
 * 不做子串或模糊匹配（避免误伤语义相近但不同的内容）。事件派发不受影响（插件照收）。
 */

/**
 * 是否把该 error 文本视为重复（→ 跳过转录区渲染）。
 *
 * @param errorText     `ErrorEvent.message`
 * @param lastFinalText 最近一条 `text_final` 的文本（无则空串）
 */
export function isDuplicateErrorText(errorText: string, lastFinalText: string): boolean {
  // 空串不算重复（空 error 不该被吞掉；空 lastFinalText 无可比对象）
  return lastFinalText.length > 0 && errorText === lastFinalText;
}
