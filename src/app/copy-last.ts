/**
 * copy-last.ts — 「复制最近一条助手回复」（input-interactions P4）。
 *
 * `/copy` 命令（`src/commands/local-commands.ts`）与 `Ctrl+Y` 快捷键（`src/main.ts`）
 * **共用**同一段逻辑：读最近一条 assistant 定稿 → 写系统剪贴板 → 生成回执文案。
 * 本文件只做纯决策 + 文案（颜色由调用方按 `kind` 决定），不 import ui/pi-tui。
 */

/** 复制结果 */
export type CopyLastOutcome =
  | { kind: 'empty' }
  | { kind: 'ok'; chars: number }
  | { kind: 'fail' };

/**
 * 执行「复制上轮回复」：`text` 为空 → `empty`；写剪贴板成功 → `ok{chars}`；失败 → `fail`。
 * `copy` 为注入的系统写剪贴板实现（main 侧 `writeClipboardText`）。
 */
export function copyLastReply(text: string, copy: (text: string) => boolean): CopyLastOutcome {
  if (!text.trim()) return { kind: 'empty' };
  return copy(text) ? { kind: 'ok', chars: text.length } : { kind: 'fail' };
}

/** 回执文案（无颜色；`/copy` 与 `Ctrl+Y` 共用，颜色由调用方按 `kind` 决定） */
export function copyLastOutcomeText(outcome: CopyLastOutcome): string {
  switch (outcome.kind) {
    case 'empty':
      return '[copy] 当前会话尚无助手回复可复制';
    case 'ok':
      return `[copy] 已复制 ${outcome.chars} 字符到剪贴板`;
    case 'fail':
      return '[copy] 写入剪贴板失败（非 macOS 或无 pbcopy）';
  }
}
