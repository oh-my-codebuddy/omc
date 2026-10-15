/**
 * account.ts — 切换账户原语（plugin 阶段 P4.5）。
 *
 * 链路（已定论）：SDK 在建 session 时把 env 交给 CLI spawn，运行期**没有** setApiKey。
 * 因此「切账户」= 关闭当前 CLI 会话 → `resume(sessionId)` 重建并注入
 * `CODEBUDDY_API_KEY`（+ 可选 `CODEBUDDY_USER`）。上下文靠 resume 续上，代价是
 * CLI 进程重启一次（当前这一轮无感换 key 不可行，UI 须提示）。
 *
 * 本模块只做「编排 + env 组装」，不含宿主实现 → 纯函数可单测；main.ts 提供
 * `SwitchAccountHost`（真实 session 生命周期 + UI 重放）。
 */

/** 切换目标账户 */
export interface AccountTarget {
  /** 必填：注入子进程的 CODEBUDDY_API_KEY */
  apiKey: string;
  /** 可选：注入 CODEBUDDY_USER（多账户区分/展示用，SDK 侧不校验） */
  user?: string;
}

/** 账户 → CLI 子进程 env 覆盖（叠加在 sanitizeHostEnv 之后，覆盖同名键） */
export function accountEnv(target: AccountTarget): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { CODEBUDDY_API_KEY: target.apiKey };
  if (target.user) env.CODEBUDDY_USER = target.user;
  return env;
}

/**
 * 宿主侧重建钩子（main.ts 实现）：
 * - `currentSessionId()`：resume 需要当前 sessionId；新会话（未初始化）→ null
 * - `isRunning()`：生成中禁止切账户（rebuild 会关掉正在跑的 CLI）
 * - `rebuild(resumeId, env)`：关旧会话 + 按 env 重建 + UI 重放（可同步可异步）
 */
export interface SwitchAccountHost {
  /**
   * resume 需要当前 sessionId；**无内容 / 未初始化 → null**（此时切账户直接开新会话，
   * 避免 resume 一个 CLI 侧从未落盘的会话 → `No conversation found`）。
   */
  currentSessionId(): string | null;
  isRunning(): boolean;
  rebuild(resumeId: string | null, env: Record<string, string | undefined>): void | Promise<void>;
}

/**
 * 切账户：校验 → 组装 env → 交宿主 rebuild（resume 当前会话）。
 * 抛错场景（调用方给用户人话提示）：空 apiKey、生成中。
 */
export async function switchAccount(host: SwitchAccountHost, target: AccountTarget): Promise<void> {
  if (!target.apiKey || !target.apiKey.trim()) {
    throw new Error('切换账户缺少 API Key');
  }
  if (host.isRunning()) {
    throw new Error('生成中无法切换账户，请先中断当前轮（Esc）');
  }
  await host.rebuild(host.currentSessionId(), accountEnv(target));
}

/**
 * resume 目标在 CLI 侧不存在的错误特征（P6 追加）。
 * 典型场景：切账户后 resume 一个从未落盘的会话（新建后一句话未发），
 * 新账户的 CLI 查不到该 conversation → 报此错。宿主据此**自愈**（去掉 resume 开新会话）。
 */
export function isResumeNotFound(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

/**
 * 切账户时的 resume 目标（P6）：**仅当会话有内容**且 sessionId 有效才返回它，
 * 否则 null（宿主开新会话）——避免 resume 一个 CLI 侧从未落盘的会话。
 */
export function resumeTargetForSwitch(hasContent: boolean, sessionId: string | null): string | null {
  return hasContent && sessionId ? sessionId : null;
}
