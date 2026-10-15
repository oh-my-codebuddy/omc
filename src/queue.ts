/**
 * 生成中预输入队列（ux-port P1.1）：main.ts 散点 queue 收口。
 * 串行单队列（SDK 无 steering API，omp 双队列语义降级，见 docs/plan/ux-port/p1-queue.md）。
 *
 * 回显时机：入项可携带 echo，omp 式——排队期间只在 band 显示，
 * 出队交付（deliver）时才回显进 transcript + 落盘，避免双重显示。
 */
import type { UserMessage } from '@tencent-ai/agent-sdk';
import type { SkillPromptDetails } from '@oh-my-pi/pi-tui/chat/messages.js';
import type { CustomCommandDetails } from './app/command-invoke';
import { appendFileSync } from 'node:fs';

/** 测试可观测性：OMC_DEBUG_QUEUE=<path> 时追加 PUSH/SHIFT/POP/CLEAR/DELIVER 事件行
 * （OMC_DEBUG_PERM 同款，scripts/smoke-queue-pty.sh 断言用；DELIVER 由 main deliver() 发） */
const debugPath = process.env.OMC_DEBUG_QUEUE;

export function queueDebug(line: string): void {
  if (!debugPath) return;
  try {
    appendFileSync(debugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/** 交付时回显内容（skill-invoke P4.1 判别联合；undefined = 提交时已回显，如 /compact 经 sendToAgent） */
export type QueuedEcho =
  | {
      /** 缺省 = 现有用户气泡行为（向后兼容） */
      kind?: 'user';
      text: string;
      imageLinks?: readonly (string | undefined)[];
    }
  | {
      /** skill 卡片（omp SkillMessageComponent）；发送内容在 msg（展开文本），此处只带卡片数据 */
      kind: 'skill';
      details: SkillPromptDetails;
      imageLinks?: readonly (string | undefined)[];
    }
  | {
      /** 自定义命令卡片（custom-commands P3）：发送内容在 msg（渲染后正文），此处只带卡片数据 */
      kind: 'command';
      details: CustomCommandDetails;
      imageLinks?: readonly (string | undefined)[];
    };

/** 回显摘要文本（band 标签 / 调试日志 / dequeue 草稿恢复共用口径） */
export function echoText(echo: QueuedEcho): string {
  if (echo.kind === 'skill') return echo.details.prompt ?? `/skill:${echo.details.name}`;
  if (echo.kind === 'command') {
    const { name, args } = echo.details;
    return echo.details.prompt ?? `/${name}${args ? ` ${args}` : ''}`;
  }
  return echo.text;
}

function labelOf(item: QueuedInput): string {
  const t = item.echo ? echoText(item.echo) : typeof item.msg === 'string' ? item.msg : '[图片]';
  return t.replace(/\s+/g, ' ').slice(0, 40);
}

export interface QueuedInput {
  /** 交付给 agent 的消息（纯文本或含图 UserMessage，双型保持；skill = 展开后的 prompt 全文） */
  msg: string | UserMessage;
  /** 交付时回显内容；undefined = 提交时已回显（如 /compact 经 sendToAgent，无需二次回显/落盘） */
  echo?: QueuedEcho;
}

export class QueueController {
  #items: QueuedInput[] = [];
  /** 队列变更回调（P1.2 band 刷新挂这里） */
  #onChange: (() => void) | null = null;

  setOnChange(cb: (() => void) | null): void {
    this.#onChange = cb;
  }

  #changed(): void {
    this.#onChange?.();
  }

  push(item: QueuedInput): void {
    this.#items.push(item);
    queueDebug(`PUSH ${labelOf(item)} size=${this.#items.length}`);
    this.#changed();
  }

  /** 队首交付（生成结束自动续发） */
  shift(): QueuedInput | undefined {
    const it = this.#items.shift();
    if (it !== undefined) {
      queueDebug(`SHIFT ${labelOf(it)} size=${this.#items.length}`);
      this.#changed();
    }
    return it;
  }

  /** 队尾取回（P1.3 Alt+↑ dequeue 回编辑器） */
  pop(): QueuedInput | undefined {
    const it = this.#items.pop();
    if (it !== undefined) {
      queueDebug(`POP ${labelOf(it)} size=${this.#items.length}`);
      this.#changed();
    }
    return it;
  }

  /** 清空（P1.4 Esc 中断丢弃），返回丢弃条数供提示 */
  clear(): number {
    const n = this.#items.length;
    if (n > 0) {
      this.#items.length = 0;
      queueDebug(`CLEAR n=${n}`);
      this.#changed();
    }
    return n;
  }

  get size(): number {
    return this.#items.length;
  }

  /** band 渲染快照（只读） */
  list(): readonly QueuedInput[] {
    return this.#items;
  }
}
