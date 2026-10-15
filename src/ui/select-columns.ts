/**
 * select-columns.ts — SelectOverlay 结构化列模式（select-columns 阶段 P1）。
 *
 * 纯函数：列宽一次算好（构造期）+ 表头/数据行共用拼装；渲染接线在 select-overlay.ts。
 * 宽度一律 pi-tui `visibleWidth` 口径（ANSI/宽字符安全），截断 `truncateToWidth`。
 * 宿主通用能力：本文件不得出现任何业务词。
 */
import { padding, truncateToWidth, visibleWidth } from '@oh-my-pi/pi-tui/utils.js';

/** 光标列宽（`> ` / 两个空格）与 `✓` 标记列宽 */
export const CURSOR_COL_WIDTH = 2;
export const MARK_COL_WIDTH = 2;
/** 列间间隔 */
export const COLUMN_GAP = 2;

export interface ColumnsLayout {
  /** 名称列宽（label ↔ columns[0]） */
  nameWidth: number;
  /** 字段列宽（columns[1..] ↔ fields[0..]），长度 = columns.length - 1 */
  fieldWidths: number[];
}

export interface ColumnSourceItem {
  label: string;
  fields?: readonly string[];
}

/**
 * 列宽计算（D3/D7）：名称列 clamp(最宽 label 与列头, 6, maxNameWidth)；
 * 字段列 = max(列头, 各行 field) 可见宽。fields 长度不齐容错：少了按空串、多了不参与。
 * 各列宽度和 > contentWidth → 返回 null（D6 窄宽退回：调用方走现有双列路径）。
 */
export function computeColumnWidths(
  items: readonly ColumnSourceItem[],
  columns: readonly string[],
  maxNameWidth: number,
  contentWidth: number,
): ColumnsLayout | null {
  if (columns.length === 0) return null;
  const fieldCount = columns.length - 1;
  let nameWidth = visibleWidth(columns[0]!);
  for (const it of items) nameWidth = Math.max(nameWidth, visibleWidth(it.label));
  nameWidth = Math.min(Math.max(nameWidth, 6), Math.max(1, maxNameWidth));
  const fieldWidths: number[] = [];
  for (let c = 0; c < fieldCount; c++) {
    let w = visibleWidth(columns[c + 1]!);
    for (const it of items) w = Math.max(w, visibleWidth(it.fields?.[c] ?? ''));
    fieldWidths.push(Math.max(1, w));
  }
  const total =
    CURSOR_COL_WIDTH +
    MARK_COL_WIDTH +
    nameWidth +
    fieldWidths.reduce((sum, w) => sum + w, 0) +
    COLUMN_GAP * fieldCount;
  if (total > contentWidth) return null;
  return { nameWidth, fieldWidths };
}

/** 单元格：截断到列宽 + 右侧补空格对齐 */
export function padCell(text: string, width: number): string {
  const cell = truncateToWidth(text, width);
  return cell + padding(Math.max(0, width - visibleWidth(cell)));
}

/**
 * 拼装一行（表头与数据行共用列宽）。
 * `cursor` 传光标符（如 `>`）即画光标列，缺省空白；`mark` 画 `✓` 标记列。
 * fields 少了补空、多了按 fieldWidths 截断。
 */
export function buildColumnsRow(
  layout: ColumnsLayout,
  label: string,
  fields: readonly string[],
  opts: { cursor?: string; mark?: boolean } = {},
): string {
  const prefix = opts.cursor ? `${opts.cursor} ` : padding(CURSOR_COL_WIDTH);
  const mark = opts.mark ? '✓ ' : padding(MARK_COL_WIDTH);
  const cells = [padCell(label, layout.nameWidth)];
  for (let i = 0; i < layout.fieldWidths.length; i++) {
    cells.push(padCell(fields[i] ?? '', layout.fieldWidths[i]!));
  }
  return (prefix + mark + cells.join(padding(COLUMN_GAP))).trimEnd();
}
