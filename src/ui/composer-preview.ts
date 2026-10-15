/**
 * composer-preview.ts（composer-shape 阶段）：自绘输入区预览，**忠实实况**。
 *
 * 为什么不用 pi-tui 的 `renderComposerShapePreview`：它硬编码 `borderAccent`（青）画边框、
 * 并把 gutter 预着色成 `accent`（橙）——与实况不一致（实况边框 = editor.borderColor =
 * borderAccent 青；gutter 交给 style 自己上色：band=borderColor，claude/rule=原始不上色）。
 * omp 自身也存在此预览≠实况偏差。
 *
 * 本模块走与真实编辑器**同一套主题色 + 同一着色路径**（style.renderTop/renderRow/renderBottom
 * + 同源状态内容），保证每种样式的每个元素（边框 / 提示符 / 文本 / fill / 状态栏）都与实况一致；
 * 并额外渲染「编辑器下方块」多行，使 band/box 的第二行也能在预览中看到。
 *
 * 几何与 pi-tui 预览一致：paddingX = style.defaultPaddingX(undefined)（实况 EditorTheme 未设
 * editorPaddingX）、chromeWidth = style.sideChromeWidth(paddingX)、topFill/content 扣两侧 chrome。
 */
import {
  getComposerStyle,
  isFilledComposerStyle,
  padding,
  theme,
  truncateToWidth,
  visibleWidth,
} from '@oh-my-pi/pi-tui';
import type { Statusline } from '../app/statusline';
import { composerBottomLines, composerTopBorder } from './status-source';

/**
 * 实况编辑器边框色 = 主题 `borderAccent`（青）——用户 2026-10-04 拍板：默认边框由橙(accent)改青。
 * app.ts 与预览共用同一函数（单一真源）；注意 `editor.setTheme`（setPreferences 内部）会
 * 把 editor.borderColor 重置回主题默认，故每次切形状后需重设。
 */
export const editorBorderColor = (str: string): string => theme.fg('borderAccent', str);

const SAMPLE_TEXT = 'Ask anything, edit files, run tools';

/** 生成某 shape 的预览行（与实况同色同路径） */
export function renderComposerPreview(
  shape: string,
  width: number,
  statusline?: Statusline,
): readonly string[] {
  const style = getComposerStyle(shape);
  const previewWidth = Math.max(24, width);
  const paddingX = style.defaultPaddingX(undefined);
  const chromeWidth = style.sideChromeWidth(paddingX);

  const topBorder =
    statusline && style.statusAttachment !== 'none'
      ? composerTopBorder(statusline, style, Math.max(1, previewWidth - chromeWidth * 2))
      : undefined;

  const chromeCtx = {
    width: previewWidth,
    paddingX,
    borderColor: editorBorderColor,
    accentColor: (s: string) => theme.fg('accent', s),
    surfaceColor: (s: string) =>
      theme.bgFill('userMessageBg', theme.fgOnBg('userMessageText', 'userMessageBg', s)),
    box: theme.boxRound,
    topBorder,
  };

  const gutter = style.defaultPromptGutter ?? '';
  const contentWidth = Math.max(1, previewWidth - chromeWidth * 2 - visibleWidth(gutter));
  const promptText = truncateToWidth(SAMPLE_TEXT, Math.max(1, contentWidth - 1));
  const promptRow = `${promptText}${theme.inverse(' ')}`;
  const text = isFilledComposerStyle(style) ? promptRow : theme.fgResolved('text', promptRow);
  const pad = padding(Math.max(0, contentWidth - visibleWidth(promptText) - 1));

  const lines: string[] = [];
  const top = style.renderTop(chromeCtx);
  if (top !== undefined) lines.push(top);
  lines.push(
    ...style.renderRow({
      ...chromeCtx,
      text,
      pad,
      // 原始 gutter（未预着色）——交由 style 上色，与实况完全一致
      gutter,
      isLastRow: true,
      cursorOverflow: 0,
      imeSafeCursorTail: false,
      scrollbarThumb: false,
    }),
  );
  const bottom = style.renderBottom(chromeCtx);
  if (bottom !== undefined) lines.push(bottom);

  // 编辑器下方块（多行）——与实况 app.ts.composerBottomLines 同源
  if (statusline) {
    const block = composerBottomLines(statusline, style, previewWidth);
    if (block.length > 0) lines.push(...block);
  }
  return lines;
}
