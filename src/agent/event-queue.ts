/**
 * EventQueue：pump → 消费侧的单消费者事件队列（subagent-visibility P1.3）。
 *
 * 为什么需要它：SDK transport 的 messageStream 是**单消费者队列**且 `send()` 每轮
 * `reset()` 清队列（`lib/utils/stream.js` / `lib/session.js`），所以 omc 内部只能有
 * **一个**常驻循环读 SDK 流；读到的 UIEvent 经本队列分派给不同消费侧
 * （用户轮 sink / 非用户轮 idle sink）。
 *
 * 语义：
 * - `push` 可早于消费（先入队）
 * - `end()` 让迭代器在排空队列后正常结束；`end()` 后再 `push` 无效（丢弃）
 * - 迭代是**单消费者**：第二个消费者拿不到已投递的事件（不广播）
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];
  private finished = false;

  push(item: T): void {
    if (this.finished) return;
    this.items.push(item);
    this.wake();
  }

  /** 关闭队列：排空后迭代器结束；后续 push 被丢弃（含 pump 在轮结束后迟到的事件） */
  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.wake();
  }

  get isFinished(): boolean {
    return this.finished;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift()!;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

/**
 * 唤醒信号（可重复触发）：pump 在等待 SDK 消息时要能被「有待发消息」/「关闭」
 * 打断并让位（原因见 session.ts 的 pump 注释）。`fire` 在无等待者时缓存，
 * 下一次 `wait()` 立即兑现。
 */
export class WakeSignal<K extends string> {
  private resolver: ((kind: K) => void) | null = null;
  private queued: K | null = null;

  wait(): Promise<K> {
    if (this.queued !== null) {
      const k = this.queued;
      this.queued = null;
      return Promise.resolve(k);
    }
    return new Promise<K>((resolve) => {
      this.resolver = resolve;
    });
  }

  fire(kind: K): void {
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r(kind);
    } else {
      this.queued = kind;
    }
  }
}
