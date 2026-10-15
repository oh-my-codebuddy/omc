/**
 * bash-execution.ts（input-interactions P1）——`!` / `!!` bash 命令的 transcript 回显组件。
 *
 * **直接复用 pi-tui 自带的 `BashExecutionComponent`**（就是 omp 用的那个，
 * `node_modules/@oh-my-pi/pi-tui/src/chat/bash-execution.ts`）：它内含 headless xterm
 * （`@oh-my-pi/pi-utils/vterm`）回放 → `appendPtyChunk(原始字节)` 即可**保留颜色**渲染
 * 游标移动/重绘，附带 loader（运行中）、尾部窗口折叠、`ctrl+o` 展开、退出码页脚。
 * 这比自绘卡片更忠实，也省掉一整套 ANSI 排版。
 *
 * `OmcBashExecution` 只加一层壳：`!!`（本地执行、不进上下文）时在卡片下方补一行显式提示
 * —— omp 靠输入区 shell 模式 chip 变色提示，omc 尚无该 chip（P1.6 未做），靠 dim 边框不够醒目。
 */
import { theme } from '@oh-my-pi/pi-tui';
import { BashExecutionComponent } from '@oh-my-pi/pi-tui/chat/bash-execution';
import { Container } from '@oh-my-pi/pi-tui/tui';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import type { BashCardDetails } from '../app/bash-mode';

export { BashExecutionComponent };

/** pi-tui 组件所需的宿主 UI（`tui`；组件需要 `terminal` / `imageBudget` / `requestComponentRender`） */
export type BashExecutionHost = ConstructorParameters<typeof BashExecutionComponent>[1];

/** `!!` 未进上下文的显式提示行 */
export const BASH_EXCLUDED_HINT = '（!! 本地执行 · 未进入模型上下文）';

function excludedHint(): Text {
  return new Text(theme.fg('warning', BASH_EXCLUDED_HINT), 1, 0);
}

/**
 * `!` / `!!` 卡片。运行中先构造（loader 起转），输出经 `exec.appendPtyChunk(raw)` 流式进，
 * 结束时 `exec.setComplete(exitCode, cancelled, { output })` 定型。
 */
export class OmcBashExecution extends Container {
  /** 内层 pi-tui 组件（main 直接调用其流式 API） */
  readonly exec: BashExecutionComponent;

  constructor(host: BashExecutionHost, command: string, excluded: boolean) {
    super();
    this.exec = new BashExecutionComponent(command, host, excluded);
    this.addChild(this.exec);
    if (excluded) this.addChild(excludedHint());
  }

  /** ctrl+o 批量翻转经 duckCallBool 命中（鸭子类型，与工具卡/摘要卡同口径） */
  setExpanded(expanded: boolean): void {
    this.exec.setExpanded(expanded);
  }
}

/** 运行中的卡片（live 路径：main 流式喂原始字节） */
export function beginBashExecution(
  host: BashExecutionHost,
  command: string,
  excluded: boolean,
): OmcBashExecution {
  return new OmcBashExecution(host, command, excluded);
}

/**
 * 已定型的卡片（`/resume` 重放 / 切视图重放）。喂**净化后**的纯文本 —— 颜色无从复原
 * （落盘的是净化文本，同 omp `bashExecutionToText` 口径），故按非 PTY 路径渲染（muted 单色）。
 */
export function bashExecutionFromDetails(
  host: BashExecutionHost,
  d: BashCardDetails,
): OmcBashExecution {
  const comp = new OmcBashExecution(host, d.command, d.excluded);
  comp.exec.setComplete(d.exitCode ?? undefined, d.timedOut || d.cancelled, { output: d.output });
  return comp;
}
