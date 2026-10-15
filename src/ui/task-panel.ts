/**
 * task-panel.ts —— 子代理 / 后台任务面板渲染（subagent-visibility P1.5）。
 *
 * 对标 codebuddy 交互式的 agent 面板（2026-10-07 从其 bundle 提取的口径）：
 * - 状态图标（codebuddy `agentStatus`）：`●` 运行中 / `✓` 完成 / `✗` 失败 / `⊘` 停止·缓存
 * - 计数行：`<n> <type> agent running · <耗时> · ↓<tokens>`
 * - 明细行：`● <type> @<name> <描述>` …… 右对齐 `<耗时>  ↑<tokens>`
 * - 分隔符 `·`；耗时 `formatDuration`（9s / 1m 23s / 1h 5m）；tokens `formatTokens`（48.9k）
 * - 主代理行 `● main`（组头，codebuddy 同款）
 *
 * 纯函数（注入 fg 着色与 now），便于单测；宽度按 pi-tui visibleWidth（CJK/emoji 双宽）。
 */
import { visibleWidth } from '@oh-my-pi/pi-tui';
import { truncateToWidth } from '@oh-my-pi/pi-tui/utils.js';
import { isTerminalTaskState, type TaskEntry, type TaskState } from '../app/task-registry';
import { formatWorkflowProgress, summarizeWorkflowProgress } from '../app/workflow-progress';

export type Fg = (token: string, s: string) => string;

/**
 * 陈旧阈值（P1.6）：Agent 子代理任务在这个 CLI 版本**不发终态事件**（2026-10-07 探针实证：
 * 180s 窗口内只有 pending→progress→started→running）。
 * 取 20s：活跃子代理的 progress 实测每几秒一条（toolUses 步进），20s 无消息即视为不再上报。
 *
 * 陈旧后的处置（用户 2026-10-07 12:15 定稿）：**直接从面板移除该行**——「获取不到状态就别显示」。
 * 行消失而非显示 `idle … ?`；任务若恢复上报（新 progress）会重新出现。
 * **Bash 任务不适用**：它本就不发 progress，但终态通知实测会到（约 result 后 5~9s），
 * 若也判陈旧会误伤 `sleep 300` 这类长命令。
 */
export const STALE_MS = 20_000;

/**
 * 完成态行停留时长（P2.1，用户 2026-10-07 定稿「固定时长后消失」）。
 * 任务终态到达 → 行显示 `✓`/`✗` 并定格耗时，`COMPLETED_TTL_MS` 后从面板移除。
 * 只对**有终态事件**的任务生效（Bash 后台任务实测会到）；Agent 子代理不发终态 → 走陈旧移除。
 */
export const COMPLETED_TTL_MS = 10_000;

/** 完成态行是否仍在 TTL 停留窗口内（终态 + endedAt 未过期） */
export function isRecentCompleted(t: TaskEntry, now: number): boolean {
  if (!isTerminalTaskState(t.state) || t.endedAt === undefined) return false;
  return now - t.endedAt < COMPLETED_TTL_MS;
}

/** 状态图标 + 着色 token（照抄 codebuddy agentStatus 的 glyph/语义） */
export function taskStateGlyph(state: TaskState): { glyph: string; token: string } {
  if (state === 'failed') return { glyph: '✗', token: 'error' };
  if (state === 'stopped' || state === 'killed') return { glyph: '⊘', token: 'warning' };
  if (state === 'completed') return { glyph: '✓', token: 'success' };
  return { glyph: '●', token: 'accent' }; // pending / running
}

/** 状态英文词（对齐 codebuddy 计数行；pending 也显示 running 语义） */
export function taskStateWord(state: TaskState): string {
  if (state === 'failed') return 'failed';
  if (state === 'stopped' || state === 'killed') return 'stopped';
  if (state === 'completed') return 'completed';
  return 'running';
}

/** 是否陈旧（Agent 任务长时间无事件）：终态任务永不算陈旧 */
export function isStaleTask(t: TaskEntry, now: number): boolean {
  if (isTerminalTaskState(t.state)) return false;
  if (t.type !== 'Agent') return false; // Bash 不发 progress，但终态会到 → 不按此判
  return now - t.lastEventAt > STALE_MS;
}

/**
 * 面板可见任务（P2.1）：
 * - 活跃任务：排除陈旧（Agent 状态未知则移除——用户定稿「获取不到状态就别显示」）
 * - 终态任务：仅在 `COMPLETED_TTL_MS` 窗口内可见（完成后 `✓` 停留片刻再消失）
 */
export function visibleTasks(entries: readonly TaskEntry[], now: number): TaskEntry[] {
  return entries.filter((t) =>
    isTerminalTaskState(t.state) ? isRecentCompleted(t, now) : !isStaleTask(t, now),
  );
}

/**
 * 耗时口径（P1.6）：**活跃期墙钟走字**，与任务自报 `usage.duration_ms` 取大（自报值是任务侧
 * 权威累计值，防墙钟因排队/等待而虚高）；**终态 → `endedAt − startedAt` 定格**。
 * （陈旧行不渲染，故无需冻结口径；`STALE_MS` 后该行直接消失。）
 */
export function taskElapsedMs(t: TaskEntry, now: number): number {
  if (t.endedAt !== undefined) return Math.max(0, t.endedAt - t.startedAt);
  const floor = t.reportedMs ?? 0;
  return Math.max(floor, Math.max(0, now - t.startedAt));
}

/** codebuddy formatDuration：9s / 1m 23s / 1h 5m */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** codebuddy formatTokens：48.9k / 1.0M（面板不带单位后缀，靠 ↑/↓ 图标表意） */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface TaskPanelOptions {
  now: number;
  columns: number;
  fg: Fg;
  /** 最多渲染几条明细（超出折叠为 `… +N`） */
  maxRows?: number;
  /**
   * 键盘导航选中态（P2.2）：可见任务数组的下标。命中的明细行首列由空格换成 `❯`
   * （宽度不变；照 codebuddy `AgentRow` 的 `selected` 形态）。
   */
  selectedIndex?: number;
}

const SEP = ' · ';

/** 组行文本（codebuddy 计数行）：`1 general-purpose agent running · 9s · ↓48.9k` */
export function summaryLineText(active: readonly TaskEntry[], now: number): string {
  const types = [...new Set(active.map((t) => t.type))];
  const agentish = types.length === 1 && types[0] === 'Agent';
  const typeLabel = agentish
    ? agentNameOf(active[0]!)
    : types.length === 1
      ? types[0] === 'local_workflow'
        ? 'workflow'
        : types[0]!.toLowerCase()
      : 'task';
  const n = active.length;
  const noun = agentish ? `agent${n === 1 ? '' : 's'}` : `task${n === 1 ? '' : 's'}`;
  const state = active.every((t) => taskStateWord(t.state) === 'running') ? 'running' : 'active';
  const dur = formatDuration(Math.max(...active.map((t) => taskElapsedMs(t, now))));
  const tokens = active.reduce((sum, t) => sum + t.tokens, 0);
  return `${n} ${typeLabel} ${noun} ${state}${SEP}${dur}${SEP}↓${formatTokens(tokens)}`;
}

/** 子代理名里的类型前缀（general-purpose-1 → general-purpose；Bash-xxxx → 退化为类型） */
function agentNameOf(t: TaskEntry): string {
  const base = t.name.replace(/-\d+$/, '');
  return base.length > 0 ? base : t.type.toLowerCase();
}

/**
 * 是否还需要 1s ticker（P1.6 / P2.1）：
 * - 活跃任务：耗时仍随墙钟变化（含自报耗时可能被墙钟超过的情况）→ 需要
 * - 终态任务：`COMPLETED_TTL_MS` 窗口内需要（到期要重绘移除该行）；过期后不需要
 * 全部可见任务都已终态过期 / 陈旧即停表。
 */
export function needsTicking(entries: readonly TaskEntry[], now: number): boolean {
  return entries.some((t) =>
    isTerminalTaskState(t.state)
      ? isRecentCompleted(t, now)
      : !isStaleTask(t, now) && t.endedAt === undefined,
  );
}

/**
 * 渲染面板行（无可见任务返回空数组 = 面板隐藏）。
 * 行序：`● main` → 计数行（仅当有仍在跑的任务）→ 各任务明细（含完成 TTL 内的 `✓` 行）。
 * 陈旧（状态未知）与过期完成行不渲染——见 STALE_MS / COMPLETED_TTL_MS 注释。
 */
export function renderTaskPanel(entries: readonly TaskEntry[], opts: TaskPanelOptions): string[] {
  const visible = visibleTasks(entries, opts.now);
  if (visible.length === 0) return [];

  const { now, columns, fg } = opts;
  const maxRows = opts.maxRows ?? 6;
  const lines: string[] = [];

  // 组头（codebuddy 的 `● main`：主管道在跑）
  lines.push(` ${fg('success', '●')} ${fg('muted', 'main')}`);

  // 计数行只统计「仍在跑」的任务：完成态行不应计入（否则出现「1 task completed · running」矛盾）
  const running = visible.filter((t) => !isTerminalTaskState(t.state));
  if (running.length > 0) {
    lines.push(` ${fg('muted', summaryLineText(running, now))}`);
  }

  const shown = visible.slice(0, maxRows);
  shown.forEach((t, i) => {
    const { glyph, token } = taskStateGlyph(t.state);
    // P2 T5：workflow 任务显示 workflow 名 + 进度聚合（阶段 + agent 计数）；
    // 「⚙」前缀对齐 CLI 的 workflow 图标语义
    let head: string;
    if (t.type === 'local_workflow') {
      const wfName = t.workflowName ?? t.description ?? t.name;
      const prog = formatWorkflowProgress(summarizeWorkflowProgress(t.workflowProgress));
      head = `${fg(token, glyph)} ${fg('muted', '⚙')} ${fg('accent', wfName)}${prog ? ` ${fg('muted', prog)}` : ''}`;
    } else {
      head = `${fg(token, glyph)} ${fg('muted', t.type)} ${t.type === 'Agent' ? `${fg('accent', `@${t.name}`)} ` : ''}${fg('text', t.description || t.name)}`;
    }
    const right = `${formatDuration(taskElapsedMs(t, now))}  ↑${formatTokens(t.tokens)}`;
    // 左边内容超出「列宽 − 右侧 − 1 空格」时截断（宽字符按 visibleWidth 口径）
    const leftBudget = columns - visibleWidth(right) - 2;
    const headText = truncateToWidth(head, Math.max(0, leftBudget));
    // 选中态：首列空格换 `❯`（宽度不变，见 TaskPanelOptions.selectedIndex）
    const lead = opts.selectedIndex === i ? fg('accent', '❯') : ' ';
    const left = `${lead}${headText}`;
    const pad = Math.max(0, columns - visibleWidth(left) - visibleWidth(right) - 1);
    lines.push(`${left}${' '.repeat(pad)}${fg('muted', right)}`);
  });
  if (visible.length > shown.length) {
    lines.push(` ${fg('muted', `… +${visible.length - shown.length}`)}`);
  }
  return lines;
}
