/**
 * PlanApprovalInline（plan-approval P2.2）：ExitPlanMode 审批的**内联三选项选择器**，
 * 复刻 codebuddy 转录区正文流形态：
 *
 *   Would you like to proceed?
 *   > 1. Yes
 *     2. No, keep planning (escape)
 *     3. Exit plan mode
 *
 * 内联可交互的三个前提（调研实证）：
 * - 声明 `focused` 字段 → pi-tui `isFocusable` 判定成立（`tui.ts:355`），`setFocus` 后可收键；
 * - `isTranscriptBlockFinalized()` 未决返回 false → **pin 住转录区退休**（否则超一屏块被
 *   退休进原生 scrollback，退休行不重绘 → 交互死 + 画面冻结，项目 × 摘要卡同类教训）；
 * - 决定后由宿主手动 `tui.setFocus(editor)` 还焦（内联无 overlay 的焦点栈自动恢复）。
 *
 * 键盘：↑/↓（+j/k）移动、Enter/return 确认、`1`/`2`/`3` 数字直选、Escape = 选项 2。
 * （不复用 `SelectList`：它把可打印字符当搜索过滤，数字键会被吞。）
 */
import { theme } from '@oh-my-pi/pi-tui';
import { matchesKey } from '@oh-my-pi/pi-tui/keys.js';
import { truncateToWidth } from '@oh-my-pi/pi-tui/utils.js';
import type { Component } from '@oh-my-pi/pi-tui';
import type { PlanChoice } from '../permission/bridge';

/**
 * 用户选择（与 codebuddy 三选项一一对应）。
 * 取自 `bridge.PlanChoice` 的三个**用户**选项（排除 `abort` —— 那是中断/换会话的收口，不是选项）。
 */
export type PlanApprovalChoice = Exclude<PlanChoice, 'abort'>;

const PROMPT = 'Would you like to proceed?';

/** 选项文案照抄 codebuddy（顺序 = 数字键 1/2/3） */
const OPTIONS: ReadonlyArray<{ label: string; choice: PlanApprovalChoice }> = [
  { label: '1. Yes', choice: 'yes' },
  { label: '2. No, keep planning (escape)', choice: 'keep' },
  { label: '3. Exit plan mode', choice: 'exit' },
];

export class PlanApprovalInline implements Component {
  /** pi-tui 焦点契约：存在 `focused` 字段才可被 setFocus（值由 TUI 维护） */
  focused = false;
  #index = 0;
  #decided = false;
  #cache: { width: number; lines: readonly string[] } | undefined;

  constructor(private onPick: (choice: PlanApprovalChoice) => void) {}

  invalidate(): void {
    this.#cache = undefined;
  }

  render(width: number): readonly string[] {
    const w = Math.max(1, width);
    if (this.#cache?.width === w) return this.#cache.lines;
    const lines: string[] = [theme.fg('muted', truncateToWidth(PROMPT, w))];
    OPTIONS.forEach((opt, i) => {
      const selected = i === this.#index;
      const text = `${selected ? '> ' : '  '}${opt.label}`;
      lines.push(selected ? theme.fg('accent', truncateToWidth(text, w)) : truncateToWidth(text, w));
    });
    this.#cache = { width: w, lines };
    return lines;
  }

  handleInput(data: string): void {
    if (this.#decided) return;
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) this.#move(1);
    else if (matchesKey(data, 'up') || matchesKey(data, 'k')) this.#move(-1);
    else if (matchesKey(data, 'enter') || matchesKey(data, 'return')) this.#pick(this.#index);
    else if (matchesKey(data, 'escape')) this.#pick(1);
    else if (matchesKey(data, '1')) this.#pick(0);
    else if (matchesKey(data, '2')) this.#pick(1);
    else if (matchesKey(data, '3')) this.#pick(2);
  }

  /** 未决 false → pin 住退休；已决 true → 正常退休 */
  isTranscriptBlockFinalized(): boolean {
    return this.#decided;
  }

  markTranscriptBlockFinalized(): void {
    this.#decided = true;
    this.invalidate();
  }

  #move(delta: number): void {
    this.#index = (this.#index + delta + OPTIONS.length) % OPTIONS.length;
    this.invalidate();
  }

  #pick(index: number): void {
    if (this.#decided) return;
    const opt = OPTIONS[index];
    if (!opt) return;
    this.markTranscriptBlockFinalized();
    this.onPick(opt.choice);
  }
}
