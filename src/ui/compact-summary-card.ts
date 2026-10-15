/**
 * CompactSummaryCard（ux-port-v2 P3 三轮）：compaction 摘要折叠卡，omp
 * CompactionSummaryMessageComponent 同款观感（分隔条 + ⌃O 展开 markdown），
 * 但**展开高度限高**——pi-tui 原版展开不限高，摘要常态超一屏，展开帧整批退休进
 * 原生 scrollback（退休行不重绘），ctrl+o 折叠只作用于视口内活体，视觉上
 * 「折不动」并连累同屏其他卡（2026-10-02 用户 Kitty 实测 + FOLD 日志实锤：
 * 状态机正确、画面冻结）。
 *
 * 结构照抄 pi-tui SummaryMessageComponent（chat/compaction-summary-message.ts），
 * 用其导出件自组：DividerSummary（抄）+ Disclosure + Box + Markdown，
 * 唯一差异是详情体经 CappedMarkdown 限高（默认 24 行，超出截断 + 提示行）。
 * 全文出口：/export 会话导出（摘要原文在 jsonl 落盘里）。
 */
import { getMarkdownTheme, theme } from '@oh-my-pi/pi-tui';
import { Disclosure } from '@oh-my-pi/pi-tui/components/disclosure';
import { Box } from '@oh-my-pi/pi-tui/components/box';
import { Markdown } from '@oh-my-pi/pi-tui/components/markdown';
import { expandKeyHint } from '@oh-my-pi/pi-tui/render/render-utils.js';
import { COMPACT_SUMMARY_MARKER } from '../agent/normalize';

/** 剥 summary 外层 XML 包装（<conversation_history_summary>/<summary>），只留正文（卡片与浮层共用） */
export function stripCompactSummaryWrapper(text: string): string {
  let t = text.trim();
  if (t.startsWith(COMPACT_SUMMARY_MARKER)) t = t.slice(COMPACT_SUMMARY_MARKER.length);
  const close = `</${COMPACT_SUMMARY_MARKER.slice(1)}`;
  if (t.endsWith(close)) t = t.slice(0, -close.length);
  return t.replaceAll('<summary>', '').replaceAll('</summary>', '').trim();
}

/** 展开详情行数上限（不含提示行）：保证整卡永远远小于一屏，展开/折叠可视 */
export const COMPACT_CARD_MAX_DETAIL_ROWS = 24;

/** 分隔条（抄 pi-tui DividerSummary：宽感知的 `─ label · ⌃O ─` 行，上下各一空行） */
class DividerSummary {
  #label: () => string;
  #cache: { width: number; lines: readonly string[] } | undefined;

  constructor(label: () => string) {
    this.#label = label;
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  render(width: number): readonly string[] {
    width = Math.max(1, width);
    if (this.#cache?.width === width) return this.#cache.lines;
    const lines = ['', this.#divider(width), ''];
    this.#cache = { width, lines };
    return lines;
  }

  #divider(width: number): string {
    const rule = theme.tree.horizontal;
    const label = this.#label();
    // sep.dot 自带前后空格（" · "），trim 后与 hint 单空格相接
    const hint = `${theme.sep.dot.trim()} ${expandKeyHint()}`;
    const plainWidth = Bun.stringWidth(`${label} ${hint}`, { countAnsiEscapeCodes: false });
    const remaining = width - plainWidth - 2;
    if (remaining < 4) return theme.fg('muted', label);
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return (
      theme.fg('dim', rule.repeat(left)) +
      ` ${theme.fg('muted', label)} ${theme.fg('dim', hint)} ` +
      theme.fg('dim', rule.repeat(right))
    );
  }
}

/** 详情行数上限：固定值或按视口动态计算（render 时求值，跟随 resize） */
export type DetailRowCap = number | (() => number);

/**
 * 限高 Markdown：超上限截断并补 dim 提示行。渲染后**真计数**截断（非估算），
 * 保证整卡远小于一屏。导出以复用（P2 计划卡同款限高；`overflowHint` 可自定义提示行文案）。
 */
export class CappedMarkdown {
  #md: Markdown;
  #cap: DetailRowCap;
  #hint: (hidden: number) => string;

  constructor(text: string, cap: DetailRowCap, overflowHint?: (hidden: number) => string) {
    this.#md = new Markdown(text, 0, 0, getMarkdownTheme(), {
      color: (t: string) => theme.fg('customMessageText', t),
    });
    this.#cap = cap;
    this.#hint = overflowHint ?? ((hidden) => `… 摘要还有 ${hidden} 行，/summary 查看全文`);
  }

  setIgnoreTight(ignore: boolean): void {
    this.#md.setIgnoreTight?.(ignore);
  }

  invalidate(): void {
    this.#md.invalidate?.();
  }

  render(width: number): readonly string[] {
    const rows = this.#md.render(width);
    const maxRows = Math.max(4, typeof this.#cap === 'function' ? this.#cap() : this.#cap);
    if (rows.length <= maxRows) return rows;
    const hidden = rows.length - maxRows;
    return [...rows.slice(0, maxRows), theme.fg('dim', this.#hint(hidden))];
  }
}

export interface CompactSummaryCardOptions {
  /** 已剥 XML 包装的摘要正文 */
  summary: string;
  /** 压缩前 tokens（>0 时详情首行显示 "Compacted from N tokens"；估算口径） */
  tokensBefore?: number;
  /** 详情行数上限（固定值或视口函数；缺省 COMPACT_CARD_MAX_DETAIL_ROWS） */
  maxDetailRows?: DetailRowCap;
}

export class CompactSummaryCard {
  #disclosure: Disclosure;

  constructor(options: CompactSummaryCardOptions) {
    const tokenLine =
      options.tokensBefore !== undefined && options.tokensBefore > 0
        ? `Compacted from ${options.tokensBefore.toLocaleString()} tokens`
        : 'Compacted context';
    const detailMarkdown = `**${tokenLine}**\n\n${options.summary}`;
    const label = `${theme.icon.camera} compacted`;
    const maxRows = options.maxDetailRows ?? COMPACT_CARD_MAX_DETAIL_ROWS;
    this.#disclosure = new Disclosure({
      summary: new DividerSummary(() => label),
      body: () => {
        const box = new Box(1, 1, (t: string) => theme.bg('customMessageBg', t));
        box.setIgnoreTight(true);
        box.addChild(new CappedMarkdown(detailMarkdown, maxRows));
        return box;
      },
      expanded: false,
    });
  }

  /** ctrl+o 批量翻转经 duckCallBool 命中（鸭子类型，与工具卡同口径） */
  setExpanded(expanded: boolean): void {
    this.#disclosure.setExpanded(expanded);
  }

  setIgnoreTight(ignore: boolean): this {
    this.#disclosure.setIgnoreTight(ignore);
    return this;
  }

  invalidate(): void {
    this.#disclosure.invalidate();
  }

  render(width: number): readonly string[] {
    return this.#disclosure.render(width);
  }
}
