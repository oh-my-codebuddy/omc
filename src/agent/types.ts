/**
 * UIEvent：agent 层向 UI 层输出的内部事件模型。
 * UI 层只认 UIEvent，不认 SDK Message。
 */
import type { DiffLine } from '../app/line-diff';

export interface UIEventBase {
  id: string;
  timestamp: number;
}

/** 流式文本增量 */
export interface TextDelta extends UIEventBase {
  type: 'text_delta';
  text: string;
}

/** 流式思考增量 */
export interface ThinkingDelta extends UIEventBase {
  type: 'thinking_delta';
  text: string;
}

/** 一条 assistant 回复定稿（完整文本） */
export interface TextFinal extends UIEventBase {
  type: 'text_final';
  text: string;
  /**
   * ux-port-v2 P4.4：定稿时的完整 thinking（omp message_end 整体落盘范式——
   * thinking 是 assistant 消息 content 的普通 block，定稿随消息一次落盘）。
   * live 由 thinking_delta 累积、此字段恒 undefined；仅 main 落盘合成时填，
   * resume 重放灌回组件：定稿态静态全文（无脉冲/计时），按当前显隐位渲染。
   * 只存文本不存签名——omp 持久化签名是 resume 回传 API 所需，我们的上下文
   * 恢复由 SDK 黑盒 transcript 负责，本地 jsonl 仅供 UI 重建。
   */
  thinking?: string;
  /**
   * ux-port-v2 P3 修订：该文本是 compact 压缩摘要（normalize 以前缀
   * `<conversation_history_summary>` 识别——2026-10-02 探针实证 SDK 0.3.267
   * manual /compact 轮**不发** compact_boundary，summary 只能靠文本前缀识别）。
   * trigger/preTokens 由 main 层填（inCompactTurn / statusline 压缩前 context），
   * 或随 compact_boundary 事件由 bridge 窗口提供；resume 重放时随 jsonl 还原。
   */
  compactSummary?: boolean;
  trigger?: 'manual' | 'auto';
  /** 压缩前上下文 tokens（估算：statusline 压缩前 used；boundary 到达时为精确值） */
  preTokens?: number;
}

/**
 * 工具特化渲染载荷：编辑类工具的 diff（tool-render P1 / D1 seam）。
 * lines 由 `src/app/line-diff` **本地计算**——P1.1 探针实证 SDK 侧 tool_result
 * 只有单行成功文本、`UserMessage.tool_use_result` 恒不填充，没有任何结构化 patch。
 */
export interface ToolDiff {
  filePath: string;
  lines: DiffLine[];
  /**
   * 旧内容不可得 → UI 按「新文件 / 全新增行」标注（不显示 − 行）。
   * 目前仅 write 走此分支（P1.1 实证：覆盖既有文件前 SDK 要求先 Read，
   * 旧文从不随 write 入参或结果到达）。
   */
  isNewFile?: boolean;
}

/** 工具调用开始 */
export interface ToolStart extends UIEventBase {
  type: 'tool_start';
  toolUseId: string;
  toolName: string;
  /** input 的简短摘要（单行） */
  summary: string;
  /** input 完整 JSON（截 2000 字符；verbose 模式用，P6.5） */
  detail?: string;
  /** 编辑类工具的结构化 diff（不存在则 UI 回落原 summary/detail 路径） */
  diff?: ToolDiff;
}

/** 工具结果携带的图片（base64） */
export interface ToolResultImage {
  data: string;
  mimeType: string;
}

/** 工具调用结果 */
export interface ToolResult extends UIEventBase {
  type: 'tool_result';
  toolUseId: string;
  /** 结果内容摘要（单行） */
  summary: string;
  /** 结果完整文本（截 2000 字符；verbose 模式用，P6.5） */
  detail?: string;
  isError: boolean;
  /** 结果中的 base64 图片块（M4.1：喂工具卡内联渲染） */
  images?: ToolResultImage[];
}

/** 状态消息（compacting 等） */
export interface StatusMessage extends UIEventBase {
  type: 'status';
  status: string;
}

/**
 * 上下文压缩边界（ux-port-v2 P3.1）。
 * SDK system/compact_boundary 消息升级为一等事件：bridge 消费渲染分隔线 +
 * 「下一条 text_final = 压缩摘要」标志；summary 消息本身不带 isCompacted 标记
 * （P4 二轮验收实证），只能靠时序识别。
 * compact_boundary 不落盘（与 status 同口径），resume 重放无摘要卡片。
 */
export interface CompactBoundaryEvent extends UIEventBase {
  type: 'compact_boundary';
  trigger: 'manual' | 'auto';
  /** 压缩前上下文 tokens（SDK compact_metadata.pre_tokens，精确值） */
  preTokens: number;
}

/**
 * 单次 API 调用的上下文用量（ux-port P4.2 修订版）。
 * 来源：assistant 消息的 message.usage（每次 API 调用一条）。
 * 为什么不用 result.usage：此 CLI 的 result.usage 是会话累计值
 * （2026-10-01 真机实证：三轮 input 83357→112434→117084 单调递增），
 * 直接算 context 会轮轮翻倍、/compact 后也不降。
 */
export interface ContextUsageEvent extends UIEventBase {
  type: 'context_usage';
  inputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** 该次调用的 output（P4.2 三修：manual compact 轮 = summary 长度，供压缩后 context 估算） */
  outputTokens?: number;
}

/**
 * 后台任务（subagent-visibility P1）：SDK `system/task_*` 四类消息的结构化载荷。
 * 时序实证（2026-10-06 探针 `scripts/probe-task-messages.ts`，SDK 0.3.267 / CLI 2.159.0）：
 * - `task_started` 可能**晚于** `task_updated(pending)` 到达（子代理场景实测），
 *   且 `tool_use_id` 对子代理任务为 undefined（Bash 任务才有）→ 状态机按 `taskId` upsert
 * - `task_progress` **仅子代理（Agent）任务发**，Bash 后台任务不发（与 SDK 文档一致）
 * - 终端态 `task_updated.patch` 形如 `{status:'completed', end_time:<epoch ms>}`
 * - `task_notification` 的 `usage` 对 Bash 任务为 undefined（子代理才有）
 */
export interface TaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** 后台任务启动 */
export interface TaskStartedEvent extends UIEventBase {
  type: 'task_started';
  taskId: string;
  /** 发起该任务的 tool_use id（子代理任务实测为 undefined） */
  toolUseId?: string;
  description: string;
  /** 来源工具名：`Bash` / `Agent` / `local_workflow`（实测值） */
  taskType?: string;
  /** 仅 workflow 任务：workflow 声明的 meta.name */
  workflowName?: string;
}

/** 后台任务进度（事件驱动，非定时；仅子代理任务有） */
export interface TaskProgressEvent extends UIEventBase {
  type: 'task_progress';
  taskId: string;
  usage?: TaskUsage;
  lastToolName?: string;
  /** 仅 workflow 任务：阶段 / 子代理时间线快照（**覆盖式**，非增量 —— 协议 §5.2 权威快照） */
  workflowProgress?: WorkflowTimelineItem[];
}

/**
 * workflow 进度时间线条目（`task_progress.workflow_progress[]`）。
 * 来源：CLI stdio 协议文档 `cn/cli/workflow-stdio-protocol.md` §5.2 +
 * `scripts/probe-workflow.ts` runtime 实测（2026-10-09，T1 A3）。
 * 该协议是**加性演进**的：可能新增 `type` 值 → 消费方必须忽略未知 type。
 */
export interface WorkflowPhaseItem {
  type: 'workflow_phase';
  index: number;
  title: string;
}

export interface WorkflowAgentItem {
  type: 'workflow_agent';
  index: number;
  /** 内容寻址 key `v<schema>:<sha256>`（跨重跑稳定） */
  agentId: string;
  state: 'start' | 'done' | 'error' | 'cached';
  startedAt?: number;
  endedAt?: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  tokens?: number;
  /** 短预览（**不可信**，协议 §9） */
  resultPreview?: string;
}

export type WorkflowTimelineItem = WorkflowPhaseItem | WorkflowAgentItem;

/** 后台任务状态变化（patch 携带变更字段，终端态另有 end_time） */
export interface TaskUpdatedEvent extends UIEventBase {
  type: 'task_updated';
  taskId: string;
  status?: string;
  patch: Record<string, unknown>;
}

/** 后台任务完成 / 失败 / 被停止 */
export interface TaskNotificationEvent extends UIEventBase {
  type: 'task_notification';
  taskId: string;
  status: string;
  summary: string;
  /** 完整输出的落盘路径（用 TaskOutput 工具或直接读文件取全文） */
  outputFile?: string;
  outputStderrFile?: string;
  usage?: TaskUsage;
}

/** 会话初始化 */
export interface SystemInit extends UIEventBase {
  type: 'system_init';
  sessionId: string;
  model: string;
  permissionMode: string;
  tools: string[];
  /**
   * MCP server 名单（custom-commands P5 T5）：SDK `SystemInit.mcp_servers`
   * （`{name, status}`）。CLI 原本就发，omc 早期版本丢弃；`/mcp` 命令的数据源。
   */
  mcpServers: Array<{ name: string; status: string }>;
}

/**
 * plan 模式状态变化（plan-approval P1.2）。
 *
 * 来源：**流里 `system/init.permissionMode` 的跳变** + 计划文件捕获（`Write`/`Edit` 到
 * `~/.codebuddy/plans/`）—— 替代 SDK 的 `onPlanModeEnter/Exit`（2026-10-08 P1.1 探针
 * 实证其为死选项，0 次触发）。UI 侧据此做 plan 态提示 / `/plan` 打开计划。
 *
 * ⚠️ 判据用本事件（源自流），**不要**用 `session.getPermissionMode()`：后者对 CLI
 * 内部驱动的模式切换不同步（探针实测 allow 退出 plan 后仍报 'plan'）。
 */
export interface PlanUpdateEvent extends UIEventBase {
  type: 'plan_update';
  /** 当前权限模式（流里 system/init.permissionMode） */
  permissionMode: string;
  /** 是否处于 plan 模式（permissionMode === 'plan'） */
  active: boolean;
  /** 本次会话认领的计划文件路径（从 plan 目录的 Write/Edit 捕获；可能缺省） */
  planFilePath?: string;
}

/**
 * `/goal` 状态事件（goal P1.4）：由 `AgentSession` 的 Stop hook 回调产出。
 *
 * 续跑发生在**同一轮内**（P0 定论：block 不产生新 `result`）→ 不能靠 result 计数展示进度，
 * 故由本事件驱动 UI：`block` 每次覆盖显示「续跑 #N」，`satisfied` 打印完成回执。
 */
export interface GoalUpdateEvent extends UIEventBase {
  type: 'goal_update';
  /** block = 未达标拦停续跑；satisfied = 达标放行并自动清除；halted = 安全阀放行 */
  kind: 'block' | 'satisfied' | 'halted';
  /** 停止条件（satisfied 回执展示） */
  condition: string;
  /** 续跑轮数（block = 本次 block 后的次数；satisfied = 清除前的总次数） */
  turnCount: number;
  /** 裁判理由 */
  reason: string;
  /** 是否达标后自动退出（`/goal --exit`；goal P2；仅 satisfied 有意义） */
  exitOnMet?: boolean;
}

/**
 * 文件检查点锚点（rewind P1.0）：SDK `file-history-snapshot` 消息升级为一等事件。
 *
 * 语义（2026-10-08 P0 探针实证）：
 * - 该消息在**有文件改动**的轮次内出现（Edit/Write/MultiEdit 落盘时，一轮内可多条）；
 * - 同轮多条 snapshot 的 `snapshot.messageId` **相同** = 该轮 user item id；
 * - 该 id 可直接作 CLI `rewind` 控制请求的 `user_message_id`（回退到该轮**之前**）。
 *
 * UI **不渲染**本事件；仅供 `/rewind` 候选列表（无文件改动的轮次不会有锚点 → 不可回退）。
 */
export interface CheckpointEvent extends UIEventBase {
  type: 'checkpoint';
  /** 该轮 user item id（`snapshot.messageId`），即回退锚点 */
  messageId: string;
  /** 该轮被跟踪的文件（工作区内为相对路径，跨目录为绝对路径） */
  files: string[];
  /** 同一轮内的增量快照更新（`isSnapshotUpdate`） */
  isUpdate: boolean;
  /**
   * 该轮各文件的备份记录（rewind 本地恢复兜底用；快照增量更新会重发全量 map，
   * 调用方以**最后一条**为准覆盖）。`existedAtTrack` SDK 类型未声明（CLI 实发有），
   * 缺省按 true 处理。
   */
  backups?: Record<string, CheckpointBackupEntry>;
}

/** 单文件备份记录（CLI file-history 快照条目；备份全文在 ~/.codebuddy/file-history/<sid>/） */
export interface CheckpointBackupEntry {
  /** 备份文件名（`~/.codebuddy/file-history/<sid>/<backupFileName>`）；version 0 新建文件可缺省 */
  backupFileName?: string;
  version: number;
  /** 跟踪那一刻文件是否已存在；false → 回退语义 = 删除该文件 */
  existedAtTrack?: boolean;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  /** 末轮 cache 读/写 tokens（ux-port P4.1；SDK 可缺省或 null，normalize 归一为 undefined） */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
}

/** 一轮对话完成 */
export interface ResultEvent extends UIEventBase {
  type: 'result';
  success: boolean;
  /** success 时的最终文本 */
  result?: string;
  /** 失败时的错误列表 */
  errors?: string[];
  usage?: UsageInfo;
  /** 被用户中断（不算错误也不算成功） */
  interrupted?: boolean;
}

/**
 * 错误分类。
 * `permission_denied`（permission-surface P2.4）不是真错误：它是用户**拒绝工具调用**时
 * CLI 合成的回执（`Permission denied for tool(s): X`）。单独分类，让 UI 渲染成中文拒绝行，
 * 而不是 `[error:execution]` 红字。
 */
export type ErrorKind = 'execution' | 'abort' | 'startup' | 'auth' | 'unknown' | 'permission_denied';

/** 错误事件 */
export interface ErrorEvent extends UIEventBase {
  type: 'error';
  kind: ErrorKind;
  message: string;
  /** 附加上下文（如 stderr、errors 列表） */
  detail?: string;
}

export type UIEvent =
  | TextDelta
  | ThinkingDelta
  | TextFinal
  | ToolStart
  | ToolResult
  | StatusMessage
  | CompactBoundaryEvent
  | ContextUsageEvent
  | SystemInit
  | PlanUpdateEvent
  | GoalUpdateEvent
  | CheckpointEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskUpdatedEvent
  | TaskNotificationEvent
  | ResultEvent
  | ErrorEvent;

/**
 * 子代理事件（subagent-visibility P2.3）：子代理（`Agent` 工具派生）在**自己的会话**里
 * 产生、经 `normalize` 后附加父级 `Agent` 工具 id（= SDK 消息的 `parent_tool_use_id`，
 * 2026-10-07 实测）的事件。由 `AgentSession.subagentEvents()` 走**独立通道**投递 ——
 * 不进主 `turnSink`/`idleSink`，故不会串主 delta 缓冲（P1.5 重复文本 bug）也不会被误判为
 * CLI 自发轮（P1.5 问题 3）。UI 侧按 `parentToolUseId` 分桶，供「焦点导航」切换视图时重放。
 */
export type SubagentEvent = UIEvent & { parentToolUseId: string };

let seq = 0;

export function makeEventId(): string {
  seq += 1;
  return `ev-${Date.now().toString(36)}-${seq}`;
}
