/**
 * 视图事件日志（subagent-visibility P2.3/P2.4）。
 *
 * 记录「主视图」与「各子代理视图」的事件序列，供焦点导航**切换视图时重放**
 * （P2.4 的 `switchView` 清空 transcript + 清 scrollback 后逐条重放）。
 *
 * - **不落盘**：仅当前会话内存；`/resume` 后子代理视图为空（可接受）。
 * - 主视图含 user 消息（重放要回显用户气泡），故记录项是一元组而非纯 `UIEvent`。
 * - key = {@link MAIN_VIEW} 或子代理的父级 `Agent` 工具 id（= `SubagentEvent.parentToolUseId`）。
 *
 * 纯数据结构（无 UI 依赖），便于单测与跨层复用（main 写、app 读）。
 */
import type { UIEvent } from '../agent/types';
import type { BashCardDetails } from './bash-mode';

export type ViewRecord =
  | { kind: 'user'; text: string }
  | { kind: 'event'; ev: UIEvent }
  /** 命令输出 / 提示 / welcome 等信息行（`bridge.addInfoLines`，内容可自带 ANSI） */
  | { kind: 'info'; lines: string[] }
  /** 信息卡（子代理完成卡等）：纯文本 head/tail 行 + **Markdown 渲染**的正文（`bridge.addInfoCard`） */
  | { kind: 'info_md'; lines: string[]; markdown: string; tail?: string[] }
  /** `!` / `!!` bash 命令回显卡（`bridge.addTranscriptComponent` + `ui/bash-execution.ts`，input-interactions P1） */
  | { kind: 'bash'; details: BashCardDetails };

/** 主视图的 key（其余 key 均为子代理的父级工具 id） */
export const MAIN_VIEW = 'main';

export class ViewLog {
  readonly #map = new Map<string, ViewRecord[]>();

  append(key: string, rec: ViewRecord): void {
    let arr = this.#map.get(key);
    if (!arr) {
      arr = [];
      this.#map.set(key, arr);
    }
    arr.push(rec);
  }

  get(key: string): readonly ViewRecord[] {
    return this.#map.get(key) ?? [];
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  clear(): void {
    this.#map.clear();
  }

  keys(): string[] {
    return [...this.#map.keys()];
  }
}
