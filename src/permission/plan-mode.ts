/**
 * plan-mode.ts（plan-mode P1.1）：**进/出 plan 的模式语义**（纯函数，无副作用）。
 *
 * 背景（P0 实证，见 docs/plan/plan-mode/p0-probe.md）：CLI 的 `EnterPlanMode` 把会话模式设成
 * `plan`，但每次内部请求都会跑 `updatePermissionMode`，其优先级是 **override > 启动的
 * `--permission-mode` > 当前非默认值** —— omc 启动时传的 `bypassPermissions` 会把模型刚进入的
 * plan **冲掉**，于是 `ExitPlanMode` 时 CLI 自认不在 plan、且 bypass 自动放行分支命中 → 永不询问。
 *
 * 修法（P0 约束 1/2）：
 * - **进 plan 即钉**：omc 感知到「进 plan」（模型 `EnterPlanMode` / `/mode plan` / Shift+Tab）时，
 *   记下 `prePlanMode` 并用 `setPermissionMode('plan')` 建 **override**（优先级最高 → 冲不掉）。
 * - **每个出口都要解钉**：批准（选项 1）/ 退出（选项 3）后 CLI 只恢复自身 subject、override 仍残留
 *   'plan' → 会话被**钉死在 plan** ⇒ omc 必须显式 `setPermissionMode(prePlanMode)`。选项 2
 *   （留在 plan 继续规划）**不解钉**。
 *
 * 本模块只算状态流转（可单测）；真正的控制请求（`session.setPermissionMode`）与 UI 刷新
 * 由 `main.ts` 的收口函数发起。
 */

/** omc 侧的 plan 模式状态（`currentMode` 的伴随信息） */
export interface PlanModeState {
  /** 当前权限模式（omc `currentMode` 的等价物） */
  mode: string;
  /** 进 plan 那一刻的模式；不在 plan 时为 `null` */
  prePlanMode: string | null;
}

/**
 * 进 plan：把「当前模式」记为 `prePlanMode`（已是 plan 时保持不变，缺失则回落 `fallback`）。
 *
 * `fallback` 用在「会话本就从 plan 起手」的场景 —— 此时 `currentMode === 'plan'` 且没有
 * 「进之前」的信息，退出时回落到它（`main.ts` 传启动模式 `initialMode`）。
 */
export function enterPlanMode(s: PlanModeState, fallback = 'default'): PlanModeState {
  if (s.mode === 'plan') return { mode: 'plan', prePlanMode: s.prePlanMode ?? fallback };
  return { mode: 'plan', prePlanMode: s.mode };
}

/**
 * 出 plan：恢复 `target ?? prePlanMode ?? fallback` 并**清空** `prePlanMode`（= 解钉）。
 *
 * 三个出口都走这里：选项 1（批准）/ 选项 3（退出 plan 模式）显式传 `prePlanMode`；
 * 用户手切（`/mode default`、`/plan off`、Shift+Tab 转出）经 `applyPermissionMode` 等价生效。
 */
export function exitPlanMode(s: PlanModeState, target?: string, fallback = 'default'): PlanModeState {
  return { mode: target ?? s.prePlanMode ?? fallback, prePlanMode: null };
}

/**
 * 用户**主动**切模式（`/mode <id>`、`/plan`、Shift+Tab 循环）的收口：
 * - 切到 plan → 记 `prePlanMode`（等价 `enterPlanMode`）
 * - 切到别的 → 清 `prePlanMode`（= 已离开 plan，不留陈旧值）
 */
export function applyPermissionMode(s: PlanModeState, mode: string, fallback = 'default'): PlanModeState {
  if (mode === 'plan') return enterPlanMode(s, fallback);
  return { mode, prePlanMode: null };
}

/** 状态行后缀（D5）：`⏸ plan + bypassPermissions (shift+Tab to cycle)`；无 prePlanMode 时回落现有文案 */
export function planModeLabel(prePlanMode: string | null | undefined): string {
  return prePlanMode ? `plan + ${prePlanMode}` : 'plan mode';
}
