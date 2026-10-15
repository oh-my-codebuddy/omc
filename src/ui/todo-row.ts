/**
 * todo-row.ts（todo-hud P1.1）：待办的**贴底常驻行**渲染（纯函数）。
 *
 * 形态对标 codebuddy CLI 的 dock 待办行（编辑器正上方，不落转录区）：
 *   生成中 · 展开   `⠋ ⟳ 正在探针乙  ( 1/3 · 12s · Bash · ↑25 · ctrl+t 收起待办 )`
 *   空闲   · 折叠   `⟳ 正在探针乙  ( 1/3 · ctrl+t 展开待办 )` + `Next: 探针任务丙`
 *
 * 为什么自绘而不复用 pi-tui `Loader`（D9）：`Loader` 的 messageColorFn 对**整段**上色，
 * 多行展开时状态图标无法逐行着色；故只借它的 spinner 常量（`SPINNER_ADVANCE_MS`，app 侧用）。
 *
 * 纯函数（注入 `fg`、不读主题单例，同 `task-panel.ts` 范式）→ 可在非 TUI 环境单测；
 * 宽度一律 `visibleWidth` / `truncateToWidth`（CJK 双宽），**不用** `Bun.stringWidth`。
 */
import { visibleWidth } from '@oh-my-pi/pi-tui';
import { replaceTabs, truncateToWidth } from '@oh-my-pi/pi-tui/utils.js';
import type { TaskItem } from '../app/task-list';
import { formatDuration, formatTokens, type Fg } from './task-panel';

/** 展开态行数上限（D10）：dock 子件非法变高会压缩转录视口 → 必须限高 */
export const TODO_MAX_ROWS = 8;

/** 段分隔符（同 task-panel） */
const SEP = ' · ';
/** 首行 `正文` 与 `( meta )` 之间的间隔 */
const GAP = '  ';

/** 状态图标（迁自 task-list-card.ts：☐ pending / ⟳ in_progress / ☑ completed），逐项着色 */
export function statusMark(status: TaskItem['status'], fg: Fg): string {
  if (status === 'completed') return fg('success', '☑');
  if (status === 'in_progress') return fg('accent', '⟳');
  return fg('dim', '☐');
}

/** 行文案：in_progress 优先 activeForm（进行时），其余用 subject（同现状口径） */
export function taskLabel(task: TaskItem): string {
  return task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
}

/**
 * 是否应显示待办行（D2：**有任务就常驻**，任务清空或**全部完成**后消失）。
 * app 侧据此决定 workingRow 挂/不挂；纯函数同时服务单测。
 */
export function hasActiveTodos(items: readonly TaskItem[]): boolean {
  return items.some((t) => t.status !== 'completed');
}

export interface TodoHeaderOptions {
  fg: Fg;
  /** 终端列数（超宽截断，优先保 meta 段） */
  columns: number;
  /** 生成中：前置 spinner 帧 + 附 meta（耗时 / 工具 / tokens） */
  working: boolean;
  /** 当前 spinner 帧（`working` 时由 app 按 80ms 推进；缺省不显示） */
  spinnerFrame?: string;
  /** 本轮已耗时（ms；仅生成中展示，空闲是冻结值无意义） */
  elapsedMs?: number;
  /** 当前执行的工具名（生成中且已采到才展示） */
  tool?: string;
  /** 本轮累计 output tokens（生成中且已采到才展示） */
  turnTokens?: number;
  /** 展开态（决定 `ctrl+t` 提示文案） */
  expanded: boolean;
}

/**
 * 首行（恒单行）：`<spinner|mark> <要点>  ( <计数> [· 耗时 · 工具 · ↑tokens] · ctrl+t … )`。
 * 无数据段自动省略（不留空分隔符）；超宽时先截要点、meta 尽量保住。
 */
export function renderTodoHeader(items: readonly TaskItem[], opts: TodoHeaderOptions): string {
  const { fg, columns, working } = opts;
  const current = items.find((t) => t.status === 'in_progress');
  const pending = items.find((t) => t.status === 'pending');

  // 要点：进行中 → activeForm（accent）；无进行中 → 预告下一条；全完成 → 收尾文案
  const label = current
    ? fg('accent', taskLabel(current))
    : pending
      ? `${fg('dim', 'Next:')} ${fg('text', pending.subject)}`
      : fg('dim', '全部完成');
  const mark = current
    ? statusMark('in_progress', fg)
    : pending
      ? statusMark('pending', fg)
      : statusMark('completed', fg);
  // 生成中把状态图标换成 spinner（spinner 本身就是「在跑」的指示，避免 `⠋ ⟳` 双图标）
  const lead = working ? `${fg('accent', opts.spinnerFrame ?? '⠋')} ${label}` : `${mark} ${label}`;

  const done = items.filter((t) => t.status === 'completed').length;
  const segments: string[] = items.length > 0 ? [`${done}/${items.length}`] : [];
  if (working) {
    if (opts.elapsedMs !== undefined) segments.push(formatDuration(opts.elapsedMs));
    if (opts.tool) segments.push(opts.tool);
    if (opts.turnTokens !== undefined) segments.push(`↑${formatTokens(opts.turnTokens)}`);
  }
  segments.push(opts.expanded ? 'ctrl+t 收起待办' : 'ctrl+t 展开待办');
  const meta = fg('dim', `( ${segments.join(SEP)} )`);

  const full = replaceTabs(`${lead}${GAP}${meta}`);
  const metaW = visibleWidth(meta);
  // meta 自身都放不下：整体截断（保证不越界）
  if (metaW + visibleWidth(GAP) >= columns) return truncateToWidth(full, columns);
  const budget = Math.max(0, columns - metaW - visibleWidth(GAP));
  return `${truncateToWidth(lead, budget)}${GAP}${meta}`;
}

export interface TodoBodyOptions {
  fg: Fg;
  columns: number;
  expanded: boolean;
  /** 展开行数上限（缺省 TODO_MAX_ROWS） */
  maxRows?: number;
}

/**
 * 正文（0~N 行）：
 * - 折叠：`Next: <下一条>`（**首行已预告 Next 时返回空**，避免同一信息打两遍；无下一条也返回空）
 * - 展开：全表 `  <mark> #<id> <label>` + 限高尾巴
 */
export function renderTodoBody(items: readonly TaskItem[], opts: TodoBodyOptions): string[] {
  const { fg, columns, expanded } = opts;
  if (items.length === 0) return [];

  if (!expanded) {
    // 首行（无 in_progress 分支）已经显示 `Next: <首个 pending>` → 正文不再重复
    if (!items.some((t) => t.status === 'in_progress')) return [];
    const next = items.find((t) => t.status === 'pending');
    if (!next) return [];
    return [truncateToWidth(`${fg('dim', 'Next:')} ${fg('text', next.subject)}`, columns)];
  }

  const rows = items.map((t) =>
    replaceTabs(`  ${statusMark(t.status, fg)} ${fg('muted', `#${t.id}`)} ${taskLabel(t)}`),
  );
  const cap = Math.max(1, opts.maxRows ?? TODO_MAX_ROWS);
  const shown = rows.slice(0, cap);
  if (rows.length > cap) shown.push(fg('dim', `  … 还有 ${rows.length - cap} 项未显示`));
  return shown.map((r) => truncateToWidth(r, columns));
}
