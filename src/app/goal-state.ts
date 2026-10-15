/**
 * goal-state.ts — `/goal` 会话级停止条件的纯状态（goal P1）。
 *
 * 机制（见 docs/plan/goal/）：会话级 Stop hook 在每次代理想停时做判定，未达标则拦停续跑、
 * 达标则放行并清除。本文件只管**纯状态与子命令解析**（可单测）；hook 接线（P1.2）、
 * 裁判（P1.3）、安全阀（P1.5）在别处。
 *
 * 语义对齐 codebuddy `/goal`：
 * - `/goal <condition>` 设条件（多词 join）
 * - `/goal` 无参显示当前条件 + 统计
 * - `/goal clear|stop|off|reset|none|cancel` 清除
 * - `/goal pause` / `/goal resume` 暂停 / 恢复
 * - 条件上限 4000 字符（超限报错、不设）
 *
 * 保留字优先：单字 `clear` 等一律当子命令，不当条件（与 codebuddy 一致）。
 * 无 ANSI 颜色：本模块全部导出为**纯文本**，着色由命令层负责（便于单测断言）。
 */

/** 条件长度上限（对齐 codebuddy；超出报错不设） */
export const GOAL_MAX_CONDITION_CHARS = 4000;

/** 清除子命令别名（对齐 codebuddy 的 6 别名） */
export const GOAL_CLEAR_ALIASES = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'] as const;

/** 达标自动退出开关（goal P2）：`/goal --exit <条件>` */
export const GOAL_EXIT_FLAG = '--exit';

/**
 * 熔断：最大续跑轮数。**无限循环保护必须自建**（P0 实证：CLI `stop_hook_active` 恒 true 时
 * 既不自动放行也不设上限）。
 */
export const GOAL_MAX_TURNS = 50;

/**
 * 熔断：goal 存活时长上限（ms）。兜底「无轮数增长」场景（如裁判持续解析失败，
 * `turnCount` 不计增 → 轮数熔断永不触发）。
 */
export const GOAL_MAX_DURATION_MS = 60 * 60 * 1000;

/**
 * 会话级 goal 状态（omc 侧内存）。
 * 不含 token 预算 —— 对齐 codebuddy 而非 omp（omc 无预算会计）。
 */
export interface GoalState {
  /** 停止条件（自然语言） */
  condition: string;
  /** 判定锚点：裁判只评估此时间之后的对话（对齐 codebuddy "AFTER this timestamp"） */
  createdAt: number;
  /** 暂停 = 标志关闭（不反注册 hook —— hook 恒注册，见 P0 硬约束 1） */
  paused: boolean;
  /** block 触发次数（续跑轮数） */
  turnCount: number;
  /** 最近一次裁判理由 */
  lastReason?: string;
  /** 达标后自动退出进程（`/goal --exit`；等价 `/exit`，用于无人值守，goal P2） */
  exitOnMet: boolean;
}

/** 解析后的子命令 */
export type GoalCommand =
  | { kind: 'set'; condition: string; exitOnMet?: boolean }
  | { kind: 'show' }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'error'; message: string };

/**
 * 裁判判定结果（P1.3 裁判会话产出；纯数据，不含 SDK 类型）。
 * `impossible` = 条件被判定为不可能满足（对齐 codebuddy `treatImpossibleAsAllow`，消费方 P1.5）。
 */
export interface GoalVerdict {
  ok: boolean;
  reason: string;
  impossible?: boolean;
  /** 裁判输出无法解析（视为未达标但**不计入熔断**，避免裁判偶发格式抖动误熔断） */
  parseError?: boolean;
}

/** Stop hook 决策产物：decision + 迁移后的状态（纯函数返回，便于单测） */
export interface StopHookOutcome {
  decision: 'approve' | 'block';
  /** 迁移后的 goal 状态（达标清除时为 null） */
  state: GoalState | null;
  /** block 时回给 CLI 的理由（注入为合成 user 消息） */
  reason?: string;
  /** 安全阀告警（UI 回执；熔断 / 条件不可能满足） */
  notice?: { kind: 'limit' | 'impossible'; message: string };
}

/** 熔断阈值（可注入，便于单测） */
export interface StopHookLimits {
  now?: number;
  maxTurns?: number;
  maxDurationMs?: number;
}

/** 解析 `/goal` 之后的参数文本 → 子命令（纯函数） */
export function parseGoalCommand(args: string): GoalCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: 'show' };
  // `--exit <条件>`（goal P2）：达标后自动退出。仅作用于 set。
  if (trimmed === GOAL_EXIT_FLAG || trimmed.startsWith(`${GOAL_EXIT_FLAG} `)) {
    const rest = trimmed.slice(GOAL_EXIT_FLAG.length).trim();
    if (!rest) {
      return { kind: 'error', message: `--exit 需要跟停止条件（用法：/goal ${GOAL_EXIT_FLAG} <条件>）` };
    }
    if (rest.length > GOAL_MAX_CONDITION_CHARS) {
      return { kind: 'error', message: `条件过长（${rest.length} 字符 > 上限 ${GOAL_MAX_CONDITION_CHARS}）` };
    }
    return { kind: 'set', condition: rest, exitOnMet: true };
  }
  const lower = trimmed.toLowerCase();
  if ((GOAL_CLEAR_ALIASES as readonly string[]).includes(lower)) return { kind: 'clear' };
  if (lower === 'pause') return { kind: 'pause' };
  if (lower === 'resume') return { kind: 'resume' };
  if (trimmed.length > GOAL_MAX_CONDITION_CHARS) {
    return {
      kind: 'error',
      message: `条件过长（${trimmed.length} 字符 > 上限 ${GOAL_MAX_CONDITION_CHARS}）`,
    };
  }
  return { kind: 'set', condition: trimmed };
}

/**
 * 状态迁移（纯函数）：按子命令算出新状态；返回 `null` 表示「无 goal」。
 * `now` 由调用方注入（可测）。`error` 不改状态（由命令层打印报错）。
 */
export function applyGoalCommand(
  state: GoalState | null,
  cmd: GoalCommand,
  now: number,
): GoalState | null {
  switch (cmd.kind) {
    case 'set':
      // 重新设条件 = 重置锚点与统计（对齐 codebuddy：新条件从此刻起判）
      return {
        condition: cmd.condition,
        createdAt: now,
        paused: false,
        turnCount: 0,
        exitOnMet: cmd.exitOnMet === true,
      };
    case 'clear':
      return null;
    case 'pause':
      return state ? { ...state, paused: true } : null;
    case 'resume':
      return state ? { ...state, paused: false } : null;
    case 'show':
    case 'error':
      return state;
  }
}

/**
 * 记录一次 block（续跑）：`turnCount+1` 并更新 `lastReason`（纯函数）。
 * 供 P1.2 的 Stop hook 回调在返回 `{decision:'block'}` 时调用。
 */
export function recordGoalBlock(state: GoalState, reason: string): GoalState {
  return { ...state, turnCount: state.turnCount + 1, lastReason: reason };
}

/**
 * Stop hook 决策（纯函数，P1.2）：按当前状态与裁判结果算出「放行/拦停 + 新状态」。
 *
 * - 未激活 / 已暂停 → approve（不判定；开销 ≈0）
 * - 无裁判结果（未注入裁判 / 裁判异常）→ approve（**安全默认**：宁可放行不误锁）
 * - `verdict.ok` → approve + **清除状态**（达标自动清除，对齐 codebuddy）
 * - `verdict.impossible` → approve + 清除 + 告警（对齐 codebuddy `treatImpossibleAsAllow`）
 * - 达熔断阈值（轮数 / 时长）→ approve + 清除 + 告警（**不静默死循环**）
 * - 否则 → block + `turnCount+1` + 更新 `lastReason`
 *
 * 消费方：`AgentSession.onStopHook`（把 decision 翻译成 SDK `HookJSONOutput`）。
 */
export function reduceStopHook(
  state: GoalState | null,
  verdict: GoalVerdict | null,
  limits: StopHookLimits = {},
): StopHookOutcome {
  if (!state || state.paused || !verdict) {
    return { decision: 'approve', state };
  }
  if (verdict.ok) {
    return { decision: 'approve', state: null };
  }
  if (verdict.impossible) {
    return {
      decision: 'approve',
      state: null,
      notice: { kind: 'impossible', message: `裁判判定条件不可能满足，已放行：${verdict.reason}` },
    };
  }
  const maxTurns = limits.maxTurns ?? GOAL_MAX_TURNS;
  const maxDurationMs = limits.maxDurationMs ?? GOAL_MAX_DURATION_MS;
  const now = limits.now ?? Date.now();
  if (state.turnCount >= maxTurns) {
    return {
      decision: 'approve',
      state: null,
      notice: { kind: 'limit', message: `已达最大续跑轮数 ${maxTurns}，已放行并清除 goal` },
    };
  }
  if (now - state.createdAt >= maxDurationMs) {
    return {
      decision: 'approve',
      state: null,
      notice: {
        kind: 'limit',
        message: `已超 goal 时长上限 ${Math.round(maxDurationMs / 60_000)} 分钟，已放行并清除 goal`,
      },
    };
  }
  if (verdict.parseError) {
    // 解析失败：仍拦停（不确定达标），但**不计入熔断**（只更新理由）
    return {
      decision: 'block',
      state: { ...state, lastReason: verdict.reason },
      reason: verdict.reason,
    };
  }
  return {
    decision: 'block',
    state: recordGoalBlock(state, verdict.reason),
    reason: verdict.reason,
  };
}

/** `/goal` 无参：当前条件 + 统计（纯文本行，供 `ctx.print`） */
export function formatGoalStatus(state: GoalState | null): string[] {
  if (!state) {
    return ['  当前无 goal —— 用 /goal <条件> 设置会话级停止条件'];
  }
  const lines = [
    `  goal     ${state.condition}`,
    `  状态     ${state.paused ? '已暂停（/goal resume 恢复）' : '活跃'}`,
    `  续跑     ${state.turnCount} 次`,
    `  退出     ${state.exitOnMet ? '达标后自动退出' : '关闭'}`,
  ];
  if (state.lastReason) lines.push(`  最近理由 ${state.lastReason}`);
  return lines;
}

/**
 * `/goal` 事件的 UI 文本（goal P1.4，bridge 渲染用；纯文本行，不含前缀/着色）。
 * - block：`["goal 续跑 #N — reason"]`（bridge 用 `#addStatus` 覆盖显示 → 进度可见）
 * - satisfied：`["✓ 条件已满足（续跑 N 次）：cond", "裁判理由：reason"]`；
 *   `exitOnMet` 时追加一行明确的退出提示（goal P2.3）
 * - halted：`["⚠ 已放行并清除 goal：message"]`（安全阀）
 */
export function formatGoalUpdate(ev: {
  kind: 'block' | 'satisfied' | 'halted';
  condition: string;
  turnCount: number;
  reason: string;
  exitOnMet?: boolean;
}): string[] {
  if (ev.kind === 'block') {
    return [`goal 续跑 #${ev.turnCount}${ev.reason ? ` — ${ev.reason}` : ''}`];
  }
  if (ev.kind === 'halted') {
    return [`⚠ 已放行并清除 goal：${ev.reason}`];
  }
  const lines = [`✓ 条件已满足（续跑 ${ev.turnCount} 次）：${ev.condition}`];
  if (ev.reason) lines.push(`裁判理由：${ev.reason}`);
  if (ev.exitOnMet) {
    lines.push('--exit 已触发：目标达成，omc 即将退出（可用 omc -c 或 --resume 恢复）');
  }
  return lines;
}