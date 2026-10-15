/**
 * status-source.ts — composer-shape 阶段：把 omc 的 Statusline 适配成
 * composer shape 所需的两处状态来源：
 *
 * 实况与预览共用：{@link composerTopBorder}（顶 chrome 单行）+ {@link composerBottomLines}
 * （编辑器下方块多行）。app.ts 用于实况接线；composer-preview.ts 用于自绘预览。
 *
 * 行 → 槽位映射（两行设计保留）：
 *   band/box            → 顶 chrome: row0，下方: row1..（无第二行则空）
 *   claude/rule         → 顶 chrome: row0 右组，下方: row0 左组 + row1..
 *   pi/borderless/field/rail → 顶 chrome: 无，下方: 全部行
 */
import type { ComposerStyle } from '@oh-my-pi/pi-tui';
import type { Statusline } from '../app/statusline';

/** 影响状态栏落位的 style 字段子集 */
export type ComposerStatusStyle = Pick<ComposerStyle, 'statusAttachment' | 'bottomBar' | 'bottomBarGap'>;

/** 顶 chrome 单行内容（band/box 取整行 row0；claude/rule 取 row0 右组；none 无） */
export function composerTopBorder(
  statusline: Statusline,
  style: ComposerStatusStyle,
  width: number,
): { content: string; width: number } | undefined {
  if (style.statusAttachment === 'none') return undefined;
  if (style.statusAttachment === 'top-rule-chip') {
    return { content: statusline.renderRowGroup(width, 0, 'right') ?? '', width };
  }
  return { content: statusline.renderRow(width, 0) ?? '', width };
}

/**
 * 编辑器下方块（多行，含 bottomBarGap 空行）。
 * bottomBar `full` → 全部行；`left` → row0 左组 + row1..；`none` → row1..（band/box 的加法扩展）。
 */
export function composerBottomLines(
  statusline: Statusline,
  style: ComposerStatusStyle,
  width: number,
): string[] {
  const lines: string[] = [];
  if (style.bottomBar === 'left') {
    const left = statusline.renderRowGroup(width, 0, 'left');
    if (left !== null) lines.push(left);
  }
  const from = style.bottomBar === 'full' ? 0 : 1;
  for (let i = from; i < statusline.rowCount; i++) {
    const line = statusline.renderRow(width, i);
    if (line !== null) lines.push(line);
  }
  if (style.bottomBarGap && lines.length > 0) lines.unshift('');
  return lines;
}

