/**
 * TaskRegistry —— 后台任务 / 子代理的状态机（subagent-visibility P1.5）。
 *
 * 数据源：SDK 的 `task_*` 四类消息（经 normalize 成 UIEvent）。实测要点（2026-10-06/07 探针）：
 * - 到达顺序不保证：`task_updated(pending)` 可早于 `task_started`（子代理场景）→ 一律 upsert
 * - `task_progress` 只有子代理（Agent）任务发，携带累计 `usage{totalTokens,toolUses,durationMs}`
 * - 终端态来自 `task_updated` 的 status 或 `task_notification`（两者都要清活跃表）
 * - 子代理展示名 `@<subagent_type>-<n>`（如 general-purpose-1）需要与父级 `Agent` 工具入参
 *   配对：入参里有 subagent_type/description，而 task_started 里没有 → 由 main 层登记入参
 *
 * 纯逻辑（无 UI / 无 pi-tui 依赖），便于单测。
 */
import type { UIEvent, WorkflowTimelineItem } from '../agent/types';

export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'killed';

const TERMINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'stopped', 'killed'];

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

const STATE_ALIASES: Record<string, TaskState> = {
  pending: 'pending',
  running: 'running',
  paused: 'running', // 非终端，展示为运行中（与 SDk 文档的 paused 对齐）
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'killed',
};

/** Agent 工具入参（配对用） */
export interface AgentToolInput {
  /** 父级 `Agent` 工具的 `tool_use_id`（P2.3：与子代理事件流的 `parentToolUseId` 配对） */
  toolUseId?: string;
  subagentType?: string;
  description?: string;
}

export interface TaskEntry {
  id: string;
  /** 任务类型：`Agent` / `Bash` / `local_workflow` / `task`（未知） */
  type: string;
  /** 展示名：Agent 为 `<subagent_type>-<n>`；其余为 `<type小写>-<id短号>` */
  name: string;
  description: string;
  state: TaskState;
  /**
   * 父级 `Agent` 工具 id（P2.3）：Agent 任务由 `tool_start` 入参顺序配对得到（`task_started`
   * 对 Agent 实测不带 `tool_use_id`）；Bash 任务直接取 `task_started.tool_use_id`。
   * 与子代理事件流的 `parentToolUseId` 同名 → 焦点导航据此定位该子代理的事件桶。
   */
  toolUseId?: string;
  /** 首次见到该任务的时间（用于耗时） */
  startedAt: number;
  endedAt?: number;
  /** 累计 tokens（task_progress / task_notification 的 usage.totalTokens） */
  tokens: number;
  toolUses: number;
  /**
   * 任务**自报**耗时（`usage.duration_ms`，累计快照，取最大）。
   * 2026-10-07 实证：Agent 子代理任务在这个 CLI 版本**不发终态事件**（180s 窗口只有
   * pending→progress→started→running），墙钟会无限增长 → 展示优先用自报值（冻结）。
   */
  reportedMs?: number;
  /**
   * Bash 后台任务的完整输出落盘路径（P2.5；`task_notification.output_file`，终态才到达）。
   * 供焦点导航「查看产出」读全文（对标 P1 只透传路径、无查看入口的缺口）。
   */
  outputFile?: string;
  /** 最近一次收到该任务事件的时间（陈旧判定用） */
  lastEventAt: number;
  /**
   * 仅 workflow 任务（`local_workflow`）：workflow 名（`task_started.workflow_name`）。
   * 取值口径（T1 A2）：`name` 参数起 = 该 name；`scriptPath` 起 = `path:<basename>`。
   */
  workflowName?: string;
  /**
   * 仅 workflow 任务：阶段 / 子代理时间线快照（`task_progress.workflow_progress`）。
   * **覆盖式**（协议 §5.2 权威快照）：后到的整体替换，不累积 diff。
   */
  workflowProgress?: WorkflowTimelineItem[];
  /**
   * 时间线数据来源标记（P2 修订）：`'journal'` 表示已由磁盘 journal（**真实进度**）填充 →
   * 此后**忽略 stdio 的 `task_progress` 快照**。为什么需要：workflow 完成瞬间 CLI 会补发一条
   * **陈旧初始快照**（agent 停在 `start`），会把 journal 的完整进度覆盖掉（2026-10-10 实测）。
   */
  workflowProgressSource?: 'journal';
  /**
   * 名字/类型是 upsert 兜底占位（`task_updated(pending)` 先到时的临时名）→
   * `task_started` 到达后允许覆盖。内部字段，UI 不必读。
   */
  placeholder?: boolean;
}

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskEntry>();
  /** 已登记但尚未与 task_started 配对的 Agent 工具入参（FIFO） */
  private readonly pendingAgentInputs: AgentToolInput[] = [];
  /** 子代理命名计数（每种 subagent_type 独立编号，对齐 codebuddy 的 general-purpose-1） */
  private readonly nameCounters = new Map<string, number>();

  /**
   * 登记父级 `Agent` 工具入参（main 层从 tool_start.detail 解析后调用）。
   * 必须早于对应的 `task_started` 到达（同一条 assistant 消息先出 tool_use，CLI 随后发 task_started）。
   */
  noteAgentToolInput(input: AgentToolInput): void {
    this.pendingAgentInputs.push(input);
  }

  /** 应用一个 task_* 事件；返回是否产生了可见变化 */
  apply(ev: UIEvent): boolean {
    switch (ev.type) {
      case 'task_started': {
        const agentInput = ev.taskType === 'Agent' ? this.pendingAgentInputs.shift() : undefined;
        const existing = this.tasks.get(ev.taskId);
        const type = ev.taskType ?? existing?.type ?? 'task';
        // P2.3：父级工具 id（Bash 由 task_started 自带；Agent 靠 tool_start 入参配对兜底）
        const toolUseId = ev.toolUseId ?? agentInput?.toolUseId ?? existing?.toolUseId;
        const entry: TaskEntry = {
          id: ev.taskId,
          type,
          name:
            existing && !existing.placeholder
              ? existing.name
              : this.makeName(type, agentInput, ev.taskId),
          description: ev.description || existing?.description || agentInput?.description || '',
          ...(toolUseId ? { toolUseId } : {}),
          state: existing?.state ?? 'running',
          startedAt: existing?.startedAt ?? ev.timestamp,
          tokens: existing?.tokens ?? 0,
          toolUses: existing?.toolUses ?? 0,
          ...(existing?.reportedMs !== undefined ? { reportedMs: existing.reportedMs } : {}),
          // workflow 名（T1 A1：task_started.workflow_name == description，但独立存字段更明确）
          ...(ev.workflowName ?? existing?.workflowName
            ? { workflowName: ev.workflowName ?? existing?.workflowName }
            : {}),
          ...(existing?.workflowProgress ? { workflowProgress: existing.workflowProgress } : {}),
          ...(existing?.workflowProgressSource ? { workflowProgressSource: existing.workflowProgressSource } : {}),
          lastEventAt: ev.timestamp,
        };
        this.tasks.set(ev.taskId, entry);
        return true;
      }
      case 'task_progress': {
        const entry = this.ensure(ev.taskId, ev.timestamp);
        entry.lastEventAt = ev.timestamp;
        if (ev.usage) {
          entry.tokens = Math.max(entry.tokens, ev.usage.totalTokens);
          entry.toolUses = Math.max(entry.toolUses, ev.usage.toolUses);
          if (Number.isFinite(ev.usage.durationMs)) {
            entry.reportedMs = Math.max(entry.reportedMs ?? 0, ev.usage.durationMs);
          }
        }
        if (entry.state === 'pending') entry.state = 'running';
        // workflow 时间线：**覆盖式**快照（协议 §5.2）。但若已由 journal（真实进度）填充，
        // 忽略 stdio 快照 —— 完成瞬间 CLI 会补发一条陈旧初始快照（2026-10-10 实测）
        if (ev.workflowProgress && entry.workflowProgressSource !== 'journal') {
          entry.workflowProgress = ev.workflowProgress;
        }
        return true;
      }
      case 'task_updated': {
        const entry = this.ensure(ev.taskId, ev.timestamp);
        entry.lastEventAt = ev.timestamp;
        const next = ev.status ? STATE_ALIASES[ev.status] : undefined;
        if (next) {
          entry.state = next;
          if (isTerminalTaskState(next)) {
            entry.endedAt = endTimeOf(ev.patch) ?? ev.timestamp;
          }
        }
        return true;
      }
      case 'task_notification': {
        const entry = this.ensure(ev.taskId, ev.timestamp);
        entry.lastEventAt = ev.timestamp;
        const next = STATE_ALIASES[ev.status] ?? 'completed';
        entry.state = next;
        if (isTerminalTaskState(next)) entry.endedAt = ev.timestamp;
        if (ev.outputFile) entry.outputFile = ev.outputFile; // P2.5：产出全文路径
        if (ev.usage) {
          entry.tokens = Math.max(entry.tokens, ev.usage.totalTokens);
          if (Number.isFinite(ev.usage.durationMs)) {
            entry.reportedMs = Math.max(entry.reportedMs ?? 0, ev.usage.durationMs);
          }
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * 外部源（workflow journal，P2 修订）同步时间线 + tokens：内容有变才写入并刷新 `lastEventAt`
   * （`lastEventAt` 变化是进度视图 / 面板的重绘信号）。返回是否变化。
   * 一旦写入即标记 `workflowProgressSource='journal'` → 此后忽略 stdio 的陈旧快照。
   * 为什么需要：stdio 通道上 CLI 只发最初两三条 `task_progress` 快照（且完成瞬间还会补一条
   * **陈旧初始快照**把进度打回去），运行中的细粒度进度只在 `journal.jsonl` 里（见 workflow-journal.ts）。
   */
  setWorkflowProgress(id: string, items: readonly WorkflowTimelineItem[], at: number, tokens?: number): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    const next = [...items];
    if (t.workflowProgress !== undefined && JSON.stringify(t.workflowProgress) === JSON.stringify(next)) {
      // 内容未变：仅补 tokens（journal 的 tokens 会随后续 agent 完成增长）
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > t.tokens) {
        t.tokens = tokens;
        return true;
      }
      return false;
    }
    t.workflowProgress = next;
    t.workflowProgressSource = 'journal';
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > t.tokens) t.tokens = tokens;
    t.lastEventAt = at;
    return true;
  }

  /** 活跃任务（非终端态），按开始时间排序 */
  active(): TaskEntry[] {    return [...this.tasks.values()].filter((t) => !isTerminalTaskState(t.state)).sort((a, b) => a.startedAt - b.startedAt);
  }

  all(): TaskEntry[] {
    return [...this.tasks.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  clear(): void {
    this.tasks.clear();
    this.pendingAgentInputs.length = 0;
    this.nameCounters.clear();
  }

  /**
   * 外部活跃信号（P2.7）：CLI 记录仍在更新（`subagentStatus().mtimeMs` 新鲜）→ 刷新
   * `lastEventAt`，避免「子代理在跑但 omc 收不到事件」被 `STALE_MS` 误判移除。
   * 已是终态 / 不存在返回 false。
   */
  touch(id: string, at: number): boolean {
    const t = this.tasks.get(id);
    if (!t || isTerminalTaskState(t.state)) return false;
    t.lastEventAt = at;
    return true;
  }

  /**
   * 外部判定完成（P2.7）：Agent 子代理不发终态事件，改由 main 侧读 CLI 记录判定
   * （`isSubagentDone`）→ 置终端态 + `endedAt`（供 `✓` 展示与 TTL 消失）。
   * 已是终态 / 不存在返回 false。
   */
  markCompleted(id: string, endedAt: number): boolean {
    const t = this.tasks.get(id);
    if (!t || isTerminalTaskState(t.state)) return false;
    t.state = 'completed';
    t.endedAt = endedAt;
    return true;
  }

  /**
   * 外部判定失败（2026-10-07 僵尸子代理）：`function_call` 悬空且记录静止过久
   * （`isSubagentZombie`）→ 置 `failed`（面板 `✗` + TTL 消失）+ 主转录区告警卡。
   * 已是终态 / 不存在返回 false。
   */
  markFailed(id: string, endedAt: number): boolean {
    const t = this.tasks.get(id);
    if (!t || isTerminalTaskState(t.state)) return false;
    t.state = 'failed';
    t.endedAt = endedAt;
    return true;
  }

  /**
   * 清理早于 `before`（epoch ms）结束的终态任务（P2.1）。
   * 面板完成态 TTL 到期后由 main 调用 —— 终态条目否则永不释放（长时间会话内存累积）。
   * 活跃任务与 `endedAt` 缺失的条目不动。返回是否删除了条目。
   */
  pruneTerminal(before: number): boolean {
    let removed = false;
    for (const [id, t] of this.tasks) {
      if (isTerminalTaskState(t.state) && t.endedAt !== undefined && t.endedAt < before) {
        this.tasks.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  private ensure(id: string, at: number): TaskEntry {
    let entry = this.tasks.get(id);
    if (!entry) {
      // task_updated(pending) 可能先到（子代理实测）→ 先建条目，类型/名字等 started 补齐
      entry = {
        id,
        type: 'task',
        name: `task-${id.slice(-4)}`,
        description: '',
        state: 'pending',
        startedAt: at,
        tokens: 0,
        toolUses: 0,
        lastEventAt: at,
        placeholder: true, // 等 task_started 补齐类型/名字
      };
      this.tasks.set(id, entry);
    }
    return entry;
  }

  private makeName(type: string, agentInput: AgentToolInput | undefined, id: string): string {
    if (type === 'Agent') {
      const base = agentInput?.subagentType ?? 'agent';
      const n = (this.nameCounters.get(base) ?? 0) + 1;
      this.nameCounters.set(base, n);
      return `${base}-${n}`;
    }
    return `${type.toLowerCase()}-${id.slice(-4)}`;
  }
}

/** 终端态 patch 的 end_time（epoch ms，实测形态） */
function endTimeOf(patch: Record<string, unknown>): number | undefined {
  const v = patch.end_time;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
