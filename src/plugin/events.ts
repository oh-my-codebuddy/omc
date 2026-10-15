/**
 * events.ts — 轻量 typed 事件总线（plugin 阶段 P4.6，对齐 Cordis typed events 模式）。
 *
 * 宿主派发点：
 *   - `session/before-create`：newSession() 前（model/resume 可见）
 *   - `session/error`：UIEvent error 到达时（kind/message）
 *   - `session/identity` / `turn/start` / `turn/end` / `permission/pending` /
 *     `permission/resolved` / `host/shutdown`：herdr P1 追加（见 plugin/host-reports.ts）
 *
 * 订阅经 `ctx.events.on()` 登记，返回 disposer 并入插件卸载链（可逆）。
 * 单个订阅者抛错只吞掉，不影响其余订阅者与宿主主流程。
 */
import type { Disposer, HostEvents, PluginEventsCapability } from './types';

type AnyHandler = (payload: unknown) => void;

export class PluginEventBus implements PluginEventsCapability {
  readonly #handlers = new Map<string, Set<AnyHandler>>();

  on<K extends keyof HostEvents>(type: K, handler: (payload: HostEvents[K]) => void): Disposer {
    const key = type as string;
    let set = this.#handlers.get(key);
    if (!set) {
      set = new Set();
      this.#handlers.set(key, set);
    }
    const h = handler as AnyHandler;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  /** 派发；无订阅者即空操作。订阅者异常被吞（隔离）。 */
  emit<K extends keyof HostEvents>(type: K, payload: HostEvents[K]): void {
    const set = this.#handlers.get(type as string);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(payload);
      } catch {
        // 单个订阅者抛错不影响派发链
      }
    }
  }

  /** 测试可观测性：某事件的订阅者数 */
  listenerCount(type: keyof HostEvents): number {
    return this.#handlers.get(type as string)?.size ?? 0;
  }
}
