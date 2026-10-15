/**
 * 任务面板键盘导航状态机（subagent-visibility P2.2）。
 *
 * 复刻 codebuddy 的「成员焦点导航」：空输入框 `↓` 进入 → `↑`/`↓` 环绕移动 →
 * `Enter` 聚焦（切视图）→ `Esc` 退出。`index` 是**面板可见任务数组**
 * （`visibleTasks`）的下标；可见集变化时用 {@link syncSwitcher} 收敛。
 *
 * 纯逻辑（无 UI / 无 pi-tui 依赖），便于单测。原地修改（渲染侧持有同一对象，
 * 避免每键重建）。
 */
export interface SwitcherState {
  /** 是否处于导航选择模式 */
  active: boolean;
  /** 选中项在可见任务数组中的下标 */
  index: number;
}

export function createSwitcher(): SwitcherState {
  return { active: false, index: 0 };
}

/**
 * 收敛到当前可见数（每次渲染前调用）：
 * - 无可见任务 → 退出导航（选中的行消失了）
 * - 下标越界 → 夹紧到末尾
 */
export function syncSwitcher(st: SwitcherState, count: number): void {
  if (count === 0) {
    st.active = false;
    st.index = 0;
    return;
  }
  if (st.index >= count) st.index = count - 1;
}

/** 环绕移动（`delta` 可正可负）；无可见任务时退出导航 */
export function moveSwitcher(st: SwitcherState, delta: number, count: number): void {
  if (count === 0) {
    st.active = false;
    st.index = 0;
    return;
  }
  st.index = (((st.index + delta) % count) + count) % count;
}

/** 进入导航模式（无可见任务则不入）；成功返回 true */
export function enterSwitcher(st: SwitcherState, count: number): boolean {
  if (count === 0) return false;
  st.active = true;
  st.index = 0;
  return true;
}
