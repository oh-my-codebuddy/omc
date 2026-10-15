/**
 * statusline-layout.ts — 状态栏渲染引擎（statusline 阶段 P2）：纯函数，无类状态。
 *
 * - 最多两行，每行左右两组 segment（超越 omp 单行限制）
 * - ANSI-aware 宽度：右对齐 padding 与截断按**可视宽度**算（ctx 段含着色码，
 *   旧 clipPlain 按 string.length 会在溢出时切断转义序列，本引擎修正该隐患）
 * - 默认布局（无配置）必须产出与重构前逐字节一致的单行输出（回归约束）
 */
import type { SegmentId, StatuslineConfig, StatuslineSeparator } from '../config';
// pi-tui 主入口导出（UAX#11 宽度表 + ANSI 剥离）：emoji/CJK 双宽的正确可视宽度（P3.7）
import { visibleWidth } from '@oh-my-pi/pi-tui';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const FG_RESET = '\x1b[39m';
/** 分隔符灰（omp statusLineSep=244，dark.json；segments 分段着色模式下使用，P3.6） */
const SEPARATOR_GRAY = '\x1b[38;5;244m';

/** 仅匹配 SGR（本项目状态栏只用 SGR 着色） */
const SGR_RE = /^\x1b\[[0-9;]*m/;

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 可视宽度（UAX#11：emoji/CJK 双宽算 2 格；转义序列不计，P3.7 起走 pi-tui visibleWidth） */
export function visualWidth(s: string): number {
  return visibleWidth(s);
}

/**
 * ANSI-aware 截断：按可视宽度截到 max，超出补 `…`（占 1 格）。
 * 转义序列原样保留不计宽；不会在转义序列中间下刀；emoji 按码点迭代不切半。
 */
export function clipVisual(s: string, max: number): string {
  if (visualWidth(s) <= max) return s;
  const limit = Math.max(0, max - 1);
  let out = '';
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < limit) {
    const m = SGR_RE.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    // 码点迭代（for..of 处理代理对），emoji 不切半；放不下整字符即停
    const cp = String.fromCodePoint(s.codePointAt(i) ?? 0);
    const w = visibleWidth(cp);
    if (vis + w > limit) break;
    out += cp;
    i += cp.length;
    vis += w;
  }
  return `${out}…`;
}

/** 分隔符字符（无背景色块的简化实现；powerline 仅字形，不仿 omp 的 bg 端盖） */
export const SEPARATOR_CHARS: Record<StatuslineSeparator, string> = {
  pipe: ' | ',
  slash: ' / ',
  dot: ' · ', // omp sep.dot 同款（U+00B7 中点，零字体依赖）
  powerline: ' \u{e0b0} ',
  'powerline-thin': ' \u{e0b1} ',
  block: ' █ ',
  none: ' ',
  ascii: ' > ',
};

export interface LayoutRow {
  /** 段 id：内置段（SEGMENT_IDS）或插件段（`plugin:<id>`） */
  left: string[];
  right: string[];
}

export interface ResolvedLayout {
  rows: LayoutRow[];
  separator: string;
  /** 整行 DIM（默认 true，现状观感；segments:true 时忽略） */
  dim: boolean;
  /** 语义着色（默认 true；渲染层传给 ctx 段决定是否上黄/红） */
  semantic: boolean;
  /** 分段着色（默认 false；true = 每段独立色 + 分隔符灰，omp dark 色板，P3.6） */
  segments: boolean;
  /** 段前图标（默认 false；omp unicode preset 字形，P3.7） */
  icons: boolean;
}

/** 默认布局 = 重构前现状单行（顺序/分隔符/DIM 逐字节一致） */
const DEFAULT_ROWS: LayoutRow[] = [
  { left: ['vim', 'model', 'mode', 'tokens', 'ctx', 'cwd', 'git'], right: [] },
];

export function resolveLayout(config?: StatuslineConfig): ResolvedLayout {
  const rows: LayoutRow[] = config?.rows?.length
    ? config.rows.map((r) => ({ left: r.left ?? [], right: r.right ?? [] }))
    : DEFAULT_ROWS;
  return {
    rows,
    separator: SEPARATOR_CHARS[config?.separator ?? 'pipe'],
    dim: config?.colors?.dim ?? true,
    semantic: config?.colors?.semantic ?? true,
    segments: config?.colors?.segments ?? false,
    icons: config?.icons ?? false,
  };
}

/** segment 渲染回调：null = 该段当前隐藏（如无 vim、非 git 目录；未知 id 也返回 null） */
export type SegmentRender = (id: string) => string | null;

/** 渲染某组段（已渲染、已过滤空/null） */
function partsOf(row: LayoutRow, render: SegmentRender, group: 'left' | 'right'): string[] {
  return row[group].map(render).filter((s): s is string => s !== null && s !== '');
}

/** 分隔符（分段着色模式下上 omp statusLineSep 灰 244，段自带颜色） */
function separatorOf(layout: ResolvedLayout): string {
  return layout.segments ? `${SEPARATOR_GRAY}${layout.separator}${FG_RESET}` : layout.separator;
}

/**
 * 把一行内的左右两组拼成单行：right 非空时右对齐（padding = max-1-左宽-右宽），
 * 宽度不足退化「左 + sep + 右」再截断；两组全空返回 null（整行跳过）。
 */
function styleBody(
  layout: ResolvedLayout,
  leftParts: readonly string[],
  rightParts: readonly string[],
  width: number,
): string | null {
  if (leftParts.length === 0 && rightParts.length === 0) return null;

  const max = Math.max(0, width - 1); // 与现状一致：右侧预留 1 列
  const sep = separatorOf(layout);
  const left = leftParts.join(sep);
  const right = rightParts.join(sep);

  let body: string;
  if (!right) {
    body = clipVisual(` ${left}`, max);
  } else {
    const padding = max - 1 - visualWidth(left) - visualWidth(right);
    if (padding >= 1) {
      body = ` ${left}${' '.repeat(padding)}${right}`;
    } else {
      // 宽度不够左右并存：退化为左 + 分隔 + 右再截断
      body = clipVisual(` ${left}${sep}${right}`, max);
    }
  }
  return layout.dim && !layout.segments ? `${DIM}${body}${RESET}` : body;
}

function renderLine(
  layout: ResolvedLayout,
  render: SegmentRender,
  row: LayoutRow,
  width: number,
): string | null {
  return styleBody(layout, partsOf(row, render, 'left'), partsOf(row, render, 'right'), width);
}

/**
 * 渲染全部行，`\n` 连接（pi-tui Text 组件原生支持多行）。
 * 全部行都为空时返回空串（与原 render 在无内容时的观感一致——原实现恒有 model/mode，不会走到）。
 */
export function renderRows(layout: ResolvedLayout, render: SegmentRender, width: number): string {
  const lines = layout.rows
    .map((row) => renderLine(layout, render, row, width))
    .filter((line): line is string => line !== null);
  return lines.join('\n');
}

/** 只渲染第 i 行（composer-shape 阶段：顶 chrome 注入 / 编辑器下方块按行取；越界 null） */
export function renderRowAt(
  layout: ResolvedLayout,
  render: SegmentRender,
  width: number,
  i: number,
): string | null {
  const row = layout.rows[i];
  if (!row) return null;
  return renderLine(layout, render, row, width);
}

/**
 * 只渲染第 i 行的某一组（composer-shape 阶段：claude/rule 的 chip = row0 右组）。
 * 紧凑输出（不加前导空格/不做右对齐——chip 会再经 rule 的 topFill 计算）；越界/该组全空 null。
 */
export function renderGroupAt(
  layout: ResolvedLayout,
  render: SegmentRender,
  width: number,
  i: number,
  group: 'left' | 'right',
): string | null {
  const row = layout.rows[i];
  if (!row) return null;
  const parts = partsOf(row, render, group);
  if (parts.length === 0) return null;
  const body = clipVisual(parts.join(separatorOf(layout)), Math.max(0, width - 1));
  return layout.dim && !layout.segments ? `${DIM}${body}${RESET}` : body;
}
