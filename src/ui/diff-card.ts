/**
 * DiffCard（tool-render P1.4）：编辑类工具卡的特化 diff 渲染。
 *
 * 为什么自研而不复用 ToolExecutionComponent：后者把入参渲染成 JSON 详情，
 * 而 diff 需要行级着色 + 行号 gutter + 变更统计（P1 目标）。
 *
 * 治本约束（D3，见项目 memory）：
 * - **单组件多行**：render() 一次返回整块行数组，不逐行 addChild——否则
 *   TranscriptContainer 会在块间插空行，把卡片「断线」。
 * - **展开限高**：展开态截断到视口预算内（默认 maxDetailRows），超高部分
 *   整块退休进原生 scrollback 后 ctrl+o 折不动（退休冻结）。
 *
 * 与工具卡同鸭子面（ToolExecutionHandle 子集）：bridge 对有 diff 的卡与本卡
 * 走同一套调用（setArgsComplete / setExecutionStarted / setExpanded /
 * updateResult / seal），ctrl+o 的 duckCallBool 也认 setExpanded。
 *
 * 配色全部取主题语义键（toolDiffAdded/Removed/Context、toolTitle、muted、dim），
 * 不硬编码终端色。
 */
import { theme } from '@oh-my-pi/pi-tui';
import {
  Ellipsis,
  expandKeyHint,
  replaceTabs,
  truncateMiddleToWidth,
  truncateToWidth,
} from '@oh-my-pi/pi-tui/render/render-utils.js';
import { diffStats } from '../app/line-diff';
import type { ToolDiff } from '../agent/types';

/** 可见宽度（ANSI 不计；render-utils 未 re-export visibleWidth，用 Bun 原生，
 *  与 CompactSummaryCard 的分隔条同口径） */
function visibleWidth(s: string): number {
  return Bun.stringWidth(s, { countAnsiEscapeCodes: false });
}

/** 展开详情行数上限：固定值或按视口动态求值（render 时求值，跟随 resize） */
export type DiffRowCap = number | (() => number);

/** 默认展开行数上限（无视口回调时的兜底；远小于一屏，防退休冻结后折不动） */
export const DIFF_CARD_MAX_ROWS = 24;

export interface DiffCardOptions {
  toolName: string;
  diff: ToolDiff;
  /** 展开详情行数上限（缺省 DIFF_CARD_MAX_ROWS） */
  maxDetailRows?: DiffRowCap;
  /** 初始展开（缺省 true：diff 就是这张卡的正文，折叠态只留摘要行） */
  expanded?: boolean;
  /** 会话 cwd（路径显示为相对路径） */
  cwd?: string;
}

type DiffStatus = 'running' | 'ok' | 'error';

export class DiffCard {
  #toolName: string;
  #diff: ToolDiff;
  #cap: DiffRowCap;
  #cwd: string | undefined;
  #expanded: boolean;
  #status: DiffStatus = 'running';
  #cache: { key: string; rows: readonly string[] } | undefined;

  constructor(options: DiffCardOptions) {
    this.#toolName = options.toolName;
    this.#diff = options.diff;
    this.#cap = options.maxDetailRows ?? DIFF_CARD_MAX_ROWS;
    this.#cwd = options.cwd;
    this.#expanded = options.expanded ?? true;
  }

  // ---------- 工具卡鸭子面（bridge 统一调用） ----------

  /** 结果到达：只记状态（错误时 header 追 ✗），diff 正文不变。
   *  参数签名照抄 pi-tui `ToolExecutionHandle.updateResult`，保证 bridge 里
   *  与本组件可同类型调用（联合类型方法的参数取交集）。 */
  updateResult(
    result: {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details?: unknown;
      isError?: boolean;
    },
    _isPartial?: boolean,
    _toolCallId?: string,
  ): void {
    this.#status = result.isError ? 'error' : 'ok';
    this.invalidate();
  }

  setArgsComplete(_toolCallId?: string): void {
    // 无需处理：diff 在构造时已由 normalize 算好
  }

  setExecutionStarted(_toolCallId?: string): void {
    // 无需处理：diff 卡无执行动画
  }

  setExpanded(expanded: boolean): void {
    if (this.#expanded === expanded) return;
    this.#expanded = expanded;
    this.invalidate();
  }

  /** 定稿（result 兜底 seal）：止住 running 态 */
  seal(): void {
    if (this.#status === 'running') this.#status = 'ok';
    this.invalidate();
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  // ---------- 渲染 ----------

  render(width: number): readonly string[] {
    const w = Math.max(1, width);
    const key = `${w}|${this.#expanded}|${this.#status}`;
    if (this.#cache?.key === key) return this.#cache.rows;

    const rows: string[] = [this.#headerRow(w)];
    if (this.#expanded) {
      const cap = Math.max(1, typeof this.#cap === 'function' ? this.#cap() : this.#cap);
      const body = this.#bodyRows(w);
      if (body.length > cap) {
        rows.push(...body.slice(0, cap));
        rows.push(theme.fg('dim', `… 还有 ${body.length - cap} 行未显示`));
      } else {
        rows.push(...body);
      }
    }

    this.#cache = { key, rows };
    return rows;
  }

  /** 单行摘要：`✎ Edit  path +N −M   ⌃O`（路径按剩余宽度截断） */
  #headerRow(width: number): string {
    const { added, removed } = diffStats(this.#diff.lines);
    const isWrite = this.#toolName.toLowerCase() === 'write';
    const icon = theme.fg('toolTitle', isWrite ? theme.icon.file : theme.cmd.pencil);
    const title = `${icon} ${theme.fg('toolTitle', this.#toolName)}`;
    const stats =
      theme.fg('toolDiffAdded', `+${added}`) +
      (this.#diff.isNewFile ? '' : ` ${theme.fg('toolDiffRemoved', `-${removed}`)}`);
    const mark = this.#status === 'error' ? ` ${theme.fg('error', theme.status.error)}` : '';
    const hint = ` ${theme.fg('dim', expandKeyHint())}`;

    const prefix = `${title} `;
    const suffix = ` ${stats}${mark}${hint}`;
    const pathBudget = width - visibleWidth(prefix) - visibleWidth(suffix);
    const path =
      pathBudget >= 8 ? theme.fg('muted', truncateMiddleToWidth(this.#shortPath(), pathBudget)) : '';
    return truncateToWidth(`${prefix}${path}${suffix}`, width, Ellipsis.Omit);
  }

  /** diff 正文行：`{+|-| }行号 文本`，按类型着色，超宽截断 */
  #bodyRows(width: number): string[] {
    const lines = this.#diff.lines;
    if (lines.length === 0) return [theme.fg('dim', '（无内容变更）')];

    const gutter = Math.max(3, String(lines.length).length);
    const out: string[] = [];
    let oldNo = 1;
    let newNo = 1;
    for (const line of lines) {
      let num: number;
      let marker: string;
      let color: 'toolDiffAdded' | 'toolDiffRemoved' | 'toolDiffContext';
      if (line.type === 'del') {
        num = oldNo++;
        marker = '-';
        color = 'toolDiffRemoved';
      } else if (line.type === 'add') {
        num = newNo++;
        marker = '+';
        color = 'toolDiffAdded';
      } else {
        num = newNo;
        oldNo++;
        newNo++;
        marker = ' ';
        color = 'toolDiffContext';
      }
      const text = `${marker}${String(num).padStart(gutter)} ${replaceTabs(line.text)}`;
      out.push(theme.fg(color, truncateToWidth(text, width, Ellipsis.Omit)));
    }
    return out;
  }

  /** 相对 cwd 的路径（cwd 内才缩） */
  #shortPath(): string {
    const p = this.#diff.filePath;
    const cwd = this.#cwd;
    if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
    return p;
  }
}
