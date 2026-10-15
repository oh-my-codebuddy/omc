/**
 * statusline-segments.ts — segment 注册表（statusline 阶段 P3）。
 *
 * 每段一个纯函数：SegmentCtx 快照 → 显示文本；null = 当前隐藏。
 * 数据源全部来自 Statusline 既有簿记（costUsd/turns/tokens 等），无新 IO。
 * 排除段（本项目无数据源，明确不做）：pr/subagents/collab/stream/cache 系/usage quota。
 *
 * 插件段（P6 追加）：`plugin:<插件自报 id>`（如 `plugin:codebuddy:account`）由插件经
 * `ctx.statusline.register()` 注册（见文件末尾）；仍须**同步廉价**（每帧渲染）。
 */
import { homedir as osHomedir, hostname as osHostname } from 'node:os';
import type { SegmentId } from '../config';
import { fmtTokens } from './statusline';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const FG_RESET = '\x1b[39m';

/** 24-bit 前景色 */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}
/** 256 色前景色 */
function c256(n: number): string {
  return `\x1b[38;5;${n}m`;
}

/**
 * omp dark 主题分段色板（statusline 阶段 P3.6 照抄 oh-my-pi tui/src/theme/dark.json）。
 * 仅在 colors.segments:true 时启用（默认整行 DIM 单色零回归）。
 */
export const SEGMENT_COLORS = {
  model: rgb('#d787af'), // statusLineModel
  path: rgb('#00afaf'), // statusLinePath
  gitClean: rgb('#5faf5f'), // statusLineGitClean（omp 另有 dirty #d7af5f——本项目只有 branch 无脏标记，恒 clean）
  context: rgb('#8787af'), // statusLineContext（ctx 低用量基色；≥70/≥90 仍走语义黄红）
  spend: rgb('#5fafaf'), // statusLineSpend（token_in）
  output: c256(205), // statusLineOutput（token_out）
  cost: c256(205), // statusLineCost
  accent: rgb('#febc38'), // accent（session_name / vim normal）
  success: rgb('#89d281'), // success（vim insert）
  warning: rgb('#e4c00f'), // warning（vim visual）
  error: rgb('#fc3a4b'), // error（ctx ≥90%，分段模式下替代标准 RED）
} as const;

/** 分段着色包装（segments 模式开启时；段内自带颜色，结束恢复默认前景） */
function paint(ctx: SegmentCtx, color: string, text: string): string {
  return ctx.segmentColors ? `${color}${text}${FG_RESET}` : text;
}

/** Statusline 私有状态快照（render 时构造一次，14 段共享） */
export interface SegmentCtx {
  vim?: { mode: string; pending: string };
  model: string;
  mode: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  costUsd: number;
  contextTokens?: number;
  contextWindow?: number;
  cwd: string;
  branch: string | null;
  sessionId?: string;
  /** 会话标题（/rename sidecar 优先 → 首条 user 消息回落；无 = 隐藏，见 Statusline.resolveSessionName） */
  sessionName?: string;
  /** semantic 关时 ctx 段不上黄/红（config.statusline.colors.semantic） */
  semantic: boolean;
  /** 分段着色（config.statusline.colors.segments；true = omp dark 色板每段独立色） */
  segmentColors: boolean;
  /** 段前图标（config.statusline.icons，P3.7；omp unicode preset 字形） */
  icons: boolean;
  now: Date;
}

/**
 * 段图标（statusline 阶段 P3.7）：omp unicode preset 字形照抄
 * （oh-my-pi tui/src/theme/symbols.ts :459-513，零 Nerd Font 依赖）。
 * vim/mode 无图标：omp vim 图标是 display=icon 可选项（默认文本标签），mode 无常态段。
 */
export const SEGMENT_ICONS: Partial<Record<SegmentId, string>> = {
  model: '⬢', // icon.model
  tokens: '🪙', // icon.tokens（合并段）
  token_in: '⤵', // icon.input
  token_out: '⤴', // icon.output
  ctx: '◫', // icon.context
  cwd: '📁', // icon.folder
  git: '⑂', // icon.branch
  cost: '💲', // icon.cost
  turns: '↻', // icon.loop（轮数语义复用）
  time: '⏱', // icon.time
  hostname: '🖥', // icon.host
  session: '🆔', // icon.session
  session_name: '✎', // omp session_name 无图标；取 icon.extensionPrompt（rename 语义）
};

/** 段前图标（icons 开启时；随段一起着色——omp withIcon 同款：图标在颜色内部） */
function withIcon(ctx: SegmentCtx, id: SegmentId, text: string): string {
  const icon = ctx.icons ? SEGMENT_ICONS[id] : undefined;
  return icon ? `${icon} ${text}` : text;
}

/** cwd 段显示路径长度上限；超过则缩写中段（对齐 omp clampPathLength 默认 40） */
const MAX_CWD_LENGTH = 40;

/**
 * cwd 段显示路径：home 前缀换 `~`；超长时保留**首段 + 末两段**，中间各缩成首字母
 * （`/Users/you/Projects/github/very-long-project-name` → `/Users/y/P/github/very-long-project-name`）。
 * 段数不足 4（无可缩中段）或缩写后仍超长时，左侧 `…` 截断保留尾部兜底。
 */
export function formatCwd(cwd: string, home = osHomedir()): string {
  let display = cwd;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    display = `~${cwd.slice(home.length)}`;
  }
  if (display.length <= MAX_CWD_LENGTH) return display;

  const isAbs = display.startsWith('/');
  const parts = display.split('/').filter(Boolean);
  if (parts.length > 3) {
    const head = parts[0]!;
    const mid = parts.slice(1, -2).map((s) => s.slice(0, 1));
    const tail = parts.slice(-2);
    display = `${isAbs ? '/' : ''}${[head, ...mid, ...tail].join('/')}`;
  }
  if (display.length <= MAX_CWD_LENGTH) return display;
  const ellipsis = '…';
  return `${ellipsis}${display.slice(-(MAX_CWD_LENGTH - ellipsis.length))}`;
}

export type SegmentFn = (ctx: SegmentCtx) => string | null;

/** ux-port P4.2：context 段（百分比 + 10 格文本条 + 用量/窗口；≥70% 黄 ≥90% 红） */
function renderContext(ctx: SegmentCtx): string {
  const used = fmtTokens(ctx.contextTokens ?? 0);
  if (!ctx.contextWindow) return paint(ctx, SEGMENT_COLORS.context, withIcon(ctx, 'ctx', `ctx ${used}`));
  const pct = (ctx.contextTokens ?? 0) / ctx.contextWindow;
  const cells = 10;
  const filled = Math.min(cells, Math.max(0, Math.round(pct * cells)));
  const bar = '█'.repeat(filled) + '░'.repeat(cells - filled);
  const text = withIcon(
    ctx,
    'ctx',
    `ctx ${Math.round(pct * 100)}% ${bar} ${used}/${fmtTokens(ctx.contextWindow)}`,
  );
  if (ctx.segmentColors) {
    // omp 分段模式：基色 statusLineContext，超阈值上主题 warning/error（自恢复默认前景）
    if (!ctx.semantic) return `${SEGMENT_COLORS.context}${text}${FG_RESET}`;
    const color =
      pct >= 0.9 ? SEGMENT_COLORS.error : pct >= 0.7 ? SEGMENT_COLORS.warning : SEGMENT_COLORS.context;
    return `${color}${text}${FG_RESET}`;
  }
  // 整行 DIM 模式（现状）：着色后须切回 DIM
  if (!ctx.semantic) return text;
  const color = pct >= 0.9 ? RED : pct >= 0.7 ? YELLOW : '';
  return color ? `${color}${text}${DIM}` : text;
}

export const SEGMENTS: Record<SegmentId, SegmentFn> = {
  vim: (ctx) => {
    if (!ctx.vim) return null;
    const label = `${ctx.vim.mode.toUpperCase()}${ctx.vim.pending}`;
    if (!ctx.segmentColors) return label;
    // omp VIM_MODE_COLORS：insert=success / normal=accent / visual 系=warning
    const color = ctx.vim.mode.startsWith('visual')
      ? SEGMENT_COLORS.warning
      : ctx.vim.mode === 'insert'
        ? SEGMENT_COLORS.success
        : SEGMENT_COLORS.accent;
    return `${color}${label}${FG_RESET}`;
  },
  model: (ctx) => paint(ctx, SEGMENT_COLORS.model, withIcon(ctx, 'model', ctx.model)),
  mode: (ctx) => ctx.mode, // omp 无对应常态段，保持默认前景（无图标）
  tokens: (ctx) => {
    const icon = ctx.icons ? `${SEGMENT_ICONS.tokens} ` : '';
    return ctx.segmentColors
      ? `${SEGMENT_COLORS.spend}${icon}in ${fmtTokens(ctx.inputTokens)}${FG_RESET} ` +
          `${SEGMENT_COLORS.output}out ${fmtTokens(ctx.outputTokens)}${FG_RESET}`
      : `${icon}in ${fmtTokens(ctx.inputTokens)} out ${fmtTokens(ctx.outputTokens)}`;
  },
  token_in: (ctx) =>
    ctx.inputTokens > 0
      ? paint(ctx, SEGMENT_COLORS.spend, withIcon(ctx, 'token_in', `in ${fmtTokens(ctx.inputTokens)}`))
      : null,
  token_out: (ctx) =>
    ctx.outputTokens > 0
      ? paint(
          ctx,
          SEGMENT_COLORS.output,
          withIcon(ctx, 'token_out', `out ${fmtTokens(ctx.outputTokens)}`),
        )
      : null,
  ctx: (ctx) => (ctx.contextTokens !== undefined ? renderContext(ctx) : null),
  cwd: (ctx) => paint(ctx, SEGMENT_COLORS.path, withIcon(ctx, 'cwd', formatCwd(ctx.cwd))),
  git: (ctx) =>
    ctx.branch ? paint(ctx, SEGMENT_COLORS.gitClean, withIcon(ctx, 'git', ctx.branch)) : null,
  cost: (ctx) =>
    ctx.costUsd > 0
      ? paint(ctx, SEGMENT_COLORS.cost, withIcon(ctx, 'cost', `$${ctx.costUsd.toFixed(2)}`))
      : null,
  turns: (ctx) =>
    ctx.turns > 0 ? withIcon(ctx, 'turns', `${ctx.turns} turns`) : null,
  time: (ctx) => {
    const p = (n: number): string => String(n).padStart(2, '0');
    return withIcon(ctx, 'time', `${p(ctx.now.getHours())}:${p(ctx.now.getMinutes())}`);
  },
  hostname: (ctx) => {
    const h = osHostname().split('.')[0];
    return h ? withIcon(ctx, 'hostname', h) : null;
  },
  // experimental：UUID 截前 8 位，无人类可读名，价值有限
  session: (ctx) => {
    const id = ctx.sessionId?.slice(0, 8);
    return id ? withIcon(ctx, 'session', id) : null;
  },
  // 人类可读标题（/rename 或首条 user 消息）；超 24 字符截断（CJK 宽度不精算，预算保守）
  session_name: (ctx) => {
    const name = ctx.sessionName;
    if (!name) return null;
    const text = name.length > 24 ? `${name.slice(0, 23)}…` : name;
    return paint(ctx, SEGMENT_COLORS.accent, withIcon(ctx, 'session_name', text));
  },
};

// ---------------------------------------------------------------- 插件段

/**
 * 插件段前缀：配置里写 `plugin:<插件自报 id>`（如 `plugin:codebuddy:account`）。
 * 与内置 15 段天然不冲突；插件自报 id 不含此前缀（宿主统一补，禁止插件伪造内置段）。
 */
export const PLUGIN_SEGMENT_PREFIX = 'plugin:';

/** 插件注册的段（key = 去前缀 id，如 `codebuddy:account`） */
const pluginSegments = new Map<string, SegmentFn>();

/** 注册插件段（宿主接线；id 不含 `plugin:` 前缀） */
export function registerPluginSegment(id: string, fn: SegmentFn): void {
  pluginSegments.set(id, fn);
}

/** 注销插件段（卸载链）；返回是否确实存在 */
export function unregisterPluginSegment(id: string): boolean {
  return pluginSegments.delete(id);
}

/** 段是否可渲染（内置 或 已注册插件段）——供未知段告警用 */
export function isKnownSegment(id: string): boolean {
  if (Object.hasOwn(SEGMENTS, id)) return true;
  return id.startsWith(PLUGIN_SEGMENT_PREFIX) && pluginSegments.has(id.slice(PLUGIN_SEGMENT_PREFIX.length));
}

/**
 * 渲染一个段：内置优先 → 插件段（`plugin:` 前缀）→ 未知返回 null。
 * 插件段 `render` 抛错 → 当帧隐藏（失败隔离，不拖垮状态栏）。
 */
export function renderSegment(id: string, ctx: SegmentCtx): string | null {
  const builtin = (SEGMENTS as Record<string, SegmentFn | undefined>)[id];
  if (builtin) return builtin(ctx);
  if (!id.startsWith(PLUGIN_SEGMENT_PREFIX)) return null;
  const fn = pluginSegments.get(id.slice(PLUGIN_SEGMENT_PREFIX.length));
  if (!fn) return null;
  try {
    return fn(ctx);
  } catch {
    return null;
  }
}
