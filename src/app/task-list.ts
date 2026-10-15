/**
 * task-list（tool-render P2）：待办 / 任务列表的状态机与结果文本解析（纯逻辑，零依赖）。
 *
 * 数据源为 SDK 的 `Task*` 工具族 —— **P2.0 探针实证（2026-10-06，scripts/probe-task-tools.ts）**：
 *
 * | 调用 | 入参 | result 文本 |
 * |---|---|---|
 * | `TaskCreate` | `{subject, description, activeForm?}`（**无 id**） | `Task #1 created successfully: 探针任务甲` |
 * | `TaskUpdate` | `{taskId, status, subject?}`（id 在入参里） | `Updated task #1 status` / `Task 2 deleted successfully` |
 * | `TaskList`   | `{}`                                 | `#1 [pending] 探针任务甲` 多行 + `Summary: …`（权威全量） |
 *
 * 由此产生两条硬约束：
 * 1. **`TaskCreate` 的 id 只能从 result 文本解析** → 状态机必须把 start 期入参与
 *    result 按 `toolUseId` 配对；配对由 bridge 负责（`normalize` 是逐消息纯函数，
 *    无跨消息状态），本模块只管「给入参与结果、算出新快照」。
 * 2. **`TaskList` 是权威全量快照**（已删项不再出现）→ 直接替换本地表，自愈
 *    「漏掉的 TaskCreate / 跨会话遗留任务」等偏差。
 *
 * `TodoWrite`（遗留）**不实现**：P2.0 实测它不在工具面（`has TodoWrite = false`），
 * 模型调不到；命中即天然回落原生工具卡。
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** 列表里展示的任务（`deleted` 不会留在快照中，仅作入参/解析中间态） */
export interface TaskItem {
  /** TaskCreate result 里的 `#N`（字符串数字，保持原样） */
  id: string;
  /** TaskCreate 入参的 subject；TaskList 解析时取自列表行 */
  subject: string;
  /**
   * 进行时文案（TaskCreate 入参才有；TaskList 不返回）。
   * 因此本字段一旦由 create 写入，后续 TaskList 替换时按 id 继承（见 `TaskStore.applyList`）。
   */
  activeForm?: string;
  status: Exclude<TaskStatus, 'deleted'>;
}

/** 列表状态机关心的工具（小写）。`TaskGet`/`TaskStop`/`TaskOutput`/`A2A*` 不参与 —— 见头注 */
export const TASK_LIST_TOOLS = ['taskcreate', 'taskupdate', 'tasklist'] as const;

/** 工具名是否进列表状态机（P1.1 同款：工具名大小写不定，一律先 toLowerCase） */
export function isTaskListTool(toolName: string): boolean {
  return (TASK_LIST_TOOLS as readonly string[]).includes(toolName.toLowerCase());
}

/** `Task #3 created successfully: xxx` → `'3'` */
export function parseCreatedId(text: string): string | undefined {
  return /Task #(\d+) created successfully/.exec(text)?.[1];
}

/** `Updated task #3 status` → `'3'` */
export function parseUpdatedId(text: string): string | undefined {
  return /^Updated task #(\d+) status/m.exec(text)?.[1];
}

/** `Task 3 deleted successfully` → `'3'` */
export function parseDeletedId(text: string): string | undefined {
  return /^Task (\d+) deleted successfully/m.exec(text)?.[1];
}

const LIST_LINE = /^#(\d+) \[(\w+)\] (.*)$/gm;

/** TaskList 认识的三个状态（`deleted` 不出现在列表里，只作 TaskUpdate 入参） */
const KNOWN_STATUS = new Set(['pending', 'in_progress', 'completed']);

/** `TaskUpdate` 入参解析结果（bridge 用它判定「形态合法 → 落列表卡 / 非法 → 回落原生卡」） */
export interface TaskUpdateArgs {
  id: string;
  /** `deleted` 表示移除 */
  status: TaskItem['status'] | 'deleted';
  subject?: string;
}

/**
 * 解析 `TaskUpdate` 入参。P2.0 实证形态 `{taskId: "1", status: "in_progress"}`；
 * `subject` 字段可选（schema 有，探针未见）。id 允许数字/字符串（统一 String 化）。
 * 缺 id、缺 status 或 status 不在白名单 → undefined（调用方回落原生工具卡）。
 */
export function parseUpdateArgs(input: Record<string, unknown>): TaskUpdateArgs | undefined {
  const raw = input.taskId;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const id = String(raw);
  const status = str(input.status);
  if (status !== 'deleted' && !KNOWN_STATUS.has(status)) return undefined;
  return { id, status: status as TaskUpdateArgs['status'], subject: str(input.subject) || undefined };
}


/**
 * 解析 `TaskList` result 文本为任务数组（权威全量）。
 * 行格式 `#<id> [<status>] <subject>`；`Summary: …` 等非匹配行忽略，
 * 未知 status 的行也忽略（防御未来新增状态渲染成错图标）。
 */
export function parseTaskListResult(text: string): TaskItem[] {
  const out: TaskItem[] = [];
  LIST_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIST_LINE.exec(text)) !== null) {
    const status = m[2]!;
    if (!KNOWN_STATUS.has(status)) continue;
    out.push({
      id: m[1]!,
      subject: m[3]!.trim(),
      status: status as TaskItem['status'],
    });
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 快照等价比较（用于「无变化则不必落卡」） */
function sameItems(a: TaskItem[], b: TaskItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.subject !== y.subject || x.status !== y.status || x.activeForm !== y.activeForm) {
      return false;
    }
  }
  return true;
}

/**
 * 任务列表状态机。Map 的插入序即展示序（`applyList` 按列表行序重建）。
 * 所有 `apply*` 返回「快照是否变化」——bridge 据此决定是否落卡（避免同态刷屏）。
 */
export class TaskStore {
  #items = new Map<string, TaskItem>();

  /**
   * `TaskCreate`：id 取自 result 文本，subject/activeForm 取自入参
   * （P2.0 实证 result 不含这两个字段）。
   * result 未回传 `#N`（异常/错误）→ 不改状态、不落卡。
   */
  applyCreate(input: Record<string, unknown>, resultText: string): boolean {
    const id = parseCreatedId(resultText);
    if (!id) return false;
    const before = this.snapshot();
    const prev = this.#items.get(id);
    this.#items.set(id, {
      id,
      subject: str(input.subject) || prev?.subject || `#${id}`,
      activeForm: str(input.activeForm) || prev?.activeForm || undefined,
      // 新建即 pending；同一 id 复现（理论上不会）也重置为 pending
      status: 'pending',
    });
    return !sameItems(before, this.snapshot());
  }

  /**
   * `TaskUpdate`：入参自带 taskId + status（无需 result）。
   * - `deleted` → 移除；未知 id 删除为无变化。
   * - 未知 id 的普通更新 → 建立占位条目（`#id` 兜底 subject），下次 `TaskList` 自愈补全。
   */
  applyUpdate(input: Record<string, unknown>): boolean {
    const args = parseUpdateArgs(input);
    if (!args) return false;
    const { id, status } = args;

    if (status === 'deleted') {
      return this.#items.delete(id);
    }

    const before = this.snapshot();
    const prev = this.#items.get(id);
    this.#items.set(id, {
      id,
      subject: args.subject || prev?.subject || `#${id}`,
      activeForm: prev?.activeForm,
      status,
    });
    return !sameItems(before, this.snapshot());
  }

  /**
   * `TaskList`：全量替换（权威）。按列表行序重建插入序；
   * `activeForm` 不在列表里 → 按 id 从旧表继承（避免「进行时文案」在 List 后丢失）。
   */
  applyList(resultText: string): boolean {
    const parsed = parseTaskListResult(resultText);
    const before = this.snapshot();
    const next = new Map<string, TaskItem>();
    for (const item of parsed) {
      const prev = this.#items.get(item.id);
      next.set(item.id, { ...item, activeForm: prev?.activeForm });
    }
    this.#items = next;
    return !sameItems(before, this.snapshot());
  }

  /** 当前快照（展示序） */
  snapshot(): TaskItem[] {
    return [...this.#items.values()].map((t) => ({ ...t }));
  }

  get size(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }
}
