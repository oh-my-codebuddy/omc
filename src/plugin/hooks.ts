/**
 * hooks.ts — 插件生命周期钩子总线（plugin 阶段 P6 追加）。
 *
 * 与 `events`（纯通知、无返回值）的区别：`hooks` **可介入** ——
 * `session/before-create` 的处理器可返回 patch（目前仅 `env`），宿主合并后用于创建会话。
 * 由此插件能在**首会话创建时**就注入 env（如按所选账户注入 `CODEBUDDY_API_KEY`），
 * 无需 `switchAccount` 重建一次会话。
 *
 * 规则：
 * - **同步**（宿主 `newSession` 保持同步）；
 * - 按注册（插件加载）序执行；`before-create` 的 patch **后者覆盖前者**；
 * - 单个钩子抛错 → 跳过该钩子，不阻塞创建。
 */
import type {
  Disposer,
  HostHooks,
  PluginHooksCapability,
  SessionAfterCreateInfo,
  SessionBeforeCreateInfo,
  SessionBeforeCreatePatch,
} from './types';

type AnyHandler = (info: unknown) => unknown;

export class PluginHooks implements PluginHooksCapability {
  /** 保序数组（Set 会丢序语义不明确；注册量极小） */
  readonly #before: AnyHandler[] = [];
  readonly #after: AnyHandler[] = [];

  on<K extends keyof HostHooks>(
    type: K,
    handler: (info: HostHooks[K]['info']) => HostHooks[K]['result'],
  ): Disposer {
    const list = this.#list(type);
    const h = handler as AnyHandler;
    list.push(h);
    return () => {
      const i = list.indexOf(h);
      if (i >= 0) list.splice(i, 1);
    };
  }

  #list(type: keyof HostHooks | string): AnyHandler[] {
    return type === 'session/after-create' ? this.#after : this.#before;
  }

  /** 派发 before-create：按注册序合并 patch（`env` 浅合并，后者覆盖） */
  emitBeforeCreate(info: SessionBeforeCreateInfo): SessionBeforeCreatePatch {
    const env: Record<string, string | undefined> = {};
    for (const h of [...this.#before]) {
      try {
        const patch = h(info) as SessionBeforeCreatePatch | undefined;
        if (patch?.env) Object.assign(env, patch.env);
      } catch {
        // 单个钩子抛错 → 跳过
      }
    }
    return { env };
  }

  /** 派发 after-create（通知；无返回值） */
  emitAfterCreate(info: SessionAfterCreateInfo): void {
    for (const h of [...this.#after]) {
      try {
        h(info);
      } catch {
        // 单个钩子抛错 → 跳过
      }
    }
  }

  /** 测试可观测性：某位点的钩子数 */
  hookCount(type: keyof HostHooks): number {
    return this.#list(type).length;
  }
}
