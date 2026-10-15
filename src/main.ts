/**
 * 入口（pi-tui M1；print-mode P1 起改为两分支）
 * - 一次性（`omc -p "prompt"` / 有位置参数 / 非 TTY）：不启动 pi-tui，`PrintRenderer`
 *   只把**最终答案**打到 stdout（P1.2/P1.3）；无 prompt 时读一次 stdin；退出码按成败
 * - TTY REPL：pi-tui 装配（src/ui/app.ts），UIEvent 经 EventBridge 驱动 chat 组件
 *
 * M1 临时约束：权限全分支自动放行（M3 弹窗）；slash 走 onSubmit 纯文本解析
 * （无补全）；/resume 浮层、历史、Ctrl-V 图片分别属 M3/M2。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AgentSession, buildChildEnv, variantEnvFromSettings, type RewindResult } from './agent/session';
import { makeEventId, type ToolStart, type UIEvent } from './agent/types';
import { computeToolDiff } from './agent/normalize';
import type {
  UserMessage,
  ImageContentBlock,
  ImageMediaType,
  RawLanguageModel,
} from '@tencent-ai/agent-sdk';
import {
  PERMISSION_MODES,
  isLaunchPermissionMode,
  launchPermissionModeList,
  nextPermissionMode,
  type LaunchPermissionMode,
  type SwitchablePermissionMode,
} from './permission/modes';
import { Statusline } from './app/statusline';
import { appendUsageDaily } from './app/usage-daily';
import { getCommandUsage, recordCommandUsage } from './app/command-usage';
import {
  PRINT_OUTPUT_FORMATS,
  PrintRenderer,
  isPrintOutputFormat,
  writePrintEmission,
  type PrintOutputFormat,
} from './app/print-mode';
import { TaskRegistry, isTerminalTaskState, type TaskEntry } from './app/task-registry';
import { collectSavedWorkflows, type WorkflowEntry } from './app/workflow-data';
import {
  journalToTimeline,
  readWorkflowJournal,
  readWorkflowReport,
  workflowJournalSignature,
} from './app/workflow-journal';
import { MAIN_VIEW, ViewLog, type ViewRecord } from './app/view-log';
import {
  isSubagentDone,
  isSubagentZombie,
  mainSessionLogPath,
  readMainSessionTeammateReports,
  readPendingCall,
  readSubagentOutcome,
  readSubagentRecords,
  subagentStatus,
  ZOMBIE_MS,
  type TeammateReport,
} from './app/subagent-log';
import { buildContextReport, estimateSkillBudget } from './app/context-report';
import {
  collectMemoryFileCandidates,
  collectMemoryFiles,
  collectSkillEntries,
  collectSkillsWithStats,
} from './app/context-data';
import { buildAllSlashCommands, refillCustomCommandMap, refillSkillMap, refillWorkflowCommandMap } from './app/skill-slash';
import { resumeHintLines } from './app/resume-hint';
import type { SlashCommand as PiSlashCommand } from '@oh-my-pi/pi-tui/autocomplete.js';
import { buildSkillPromptMessage, capSkillPromptDisplay, parseSkillInvocation } from './app/skill-invoke';
import { renderCustomCommand } from './app/command-invoke';
import { buildWorkflowInvocation } from './app/workflow-invoke';
import { writeClipboardText } from './app/clipboard';
import { copyLastOutcomeText, copyLastReply } from './app/copy-last';
import { isDuplicateErrorText } from './app/error-dedup';
import {
  parseBashInput,
  runBashCommand,
  formatBashContext,
  toBashOutcome,
  toBashCardDetails,
  bashDebug,
  type BashCardDetails,
  type ParsedBashInput,
} from './app/bash-mode';
import { appendMemory, memoryDebug, parseMemoryInput } from './app/memory-append';
import { bashExecutionFromDetails, beginBashExecution, type BashExecutionHost } from './ui/bash-execution';
import { bashPtyViewport } from '@oh-my-pi/pi-tui/chat/bash-execution';
import type { SkillEntry } from './app/context-data';
import type { CustomCommandEntry } from './app/command-data';
import { PermissionBridge, pendingLabel } from './permission/bridge';
import {
  applyPermissionMode,
  enterPlanMode,
  exitPlanMode as exitPlanState,
} from './permission/plan-mode';
import { SessionLog, isSessionNamed, writeAutoTitle, type CheckpointRecord, type LogRecord } from './session-store/jsonl';
import { anchorToRecord, CheckpointLog, type CheckpointAnchor } from './app/rewind-checkpoints';
import { truncateCliSessionAt } from './app/cli-session-rewind';
import {
  DEFAULT_REWIND_SCOPE,
  FILE_SKIP_INACTIVE_LINE,
  fileStepSkippable,
  formatAnchorList,
  formatLocalRestoreOutcome,
  formatLocalRestorePreview,
  formatRewindPreview,
  formatRewindResult,
  INACTIVE_SESSION_NOTE,
  isInactiveSessionError,
  isNoCheckpointError,
  parseRewindScope,
  planLocalRestore,
  REWIND_SCOPE_OPTIONS,
  scopeIncludesConversation,
  scopeIncludesFiles,
  type LocalRestoreOutcome,
  type RewindScope,
} from './app/rewind';
import {
  INHERIT_SENTINEL,
  VARIANT_IDS,
  cliUserSettingsPath,
  needsVariantRestart,
  readVariantMap,
  resolveVariant,
  writeVariant,
} from './app/model-variants';
import { readMcpServers, type McpConfigResult } from './app/mcp-config';
import { buildMemorySystemPrompt, createMemoryServer, MEMORY_SERVER_NAME } from './app/memory-tool';
import { buildVariantListLines, sourceNote, toVariantEntry } from './commands/variant-commands';
import { GoalJudgeSession, readTranscriptTail } from './app/goal-judge';
import {
  SuggestionService,
  detectLanguage,
  suggestionKey,
  type SuggestionInput,
} from './app/prompt-suggestion';
import { TitleService, isLowSignalTitleInput } from './app/title-service';
import {
  loadConfig,
  readPluginConfig,
  readUserMcpDisabled,
  saveUserComposerShape,
  saveUserMcpDisabled,
  saveUserModel,
  saveUserSuggestEnabled,
  saveUserVimMode,
  writePluginConfig,
} from './config';
import { historyFile } from './config/paths';
import { CommandRegistry, parseSlash, routeSlashCommand } from './commands/registry';
import { registerBuiltinCommands } from './commands/builtin';
import type { CommandContext } from './commands/types';
import { PluginCapabilities } from './plugin/capabilities';
import { PluginEventBus } from './plugin/events';
import { PluginHost } from './plugin/host';
import { PluginHooks } from './plugin/hooks';
import { identityReport, pendingReport } from './plugin/host-reports';
import type { HostPendingKind } from './plugin/types';
import {
  PLUGIN_SEGMENT_PREFIX,
  isKnownSegment,
  registerPluginSegment,
  unregisterPluginSegment,
} from './app/statusline-segments';
import { PLUGIN_HELP, runPluginCli } from './plugin/cli';
import { formatPluginTable, pluginStatuses } from './plugin/manage';
import { readRegistry } from './plugin/registry';
import { SubcommandRegistry, isHelpArg, subcommandHelpLines, subcommandUsageLine } from './plugin/subcommands';
import { disable as disablePlugin, enable as enablePlugin } from './plugin/installer';
import { isResumeNotFound, resumeTargetForSwitch, switchAccount as switchAccountPrimitive } from './agent/account';
import { createPiTuiApp, type PiTuiApp } from './ui/app';
import { suggestDebug } from './ui/bridge';
import { showResumeOverlay } from './ui/resume-overlay';
import { showModelOverlay } from './ui/model-overlay';
import { showUsageOverlay } from './ui/usage-overlay';
import { showSummaryOverlay } from './ui/summary-overlay';
import { showDetailOverlay } from './ui/detail-overlay';
import { renderSessionMarkdown } from './app/export-markdown';
import { showShapeOverlay } from './ui/shape-overlay';
import { showModeOverlay } from './ui/mode-overlay';
import { showPluginOverlay } from './ui/plugin-overlay';
import { showSelectOverlay } from './ui/select-overlay';
import { HIDDEN_MARK, buildSkillsOverlayItems, showSkillsOverlay } from './ui/skills-overlay';
import { COMPLETED_TTL_MS, formatDuration } from './ui/task-panel';
import { buildWorkflowViewLines } from './ui/workflow-view';
import { renderWelcome } from './ui/welcome';
import { isBuiltinComposerStyle } from '@oh-my-pi/pi-tui';
import { COMPOSER_SHAPE_VALUES, getComposerShapeOptions } from '@oh-my-pi/pi-tui/overlays/composer-shape-registry';
import { formatModelsTable } from './app/models-table';
import pkg from '../package.json';
import { parseArgv } from './cli-args';
import { QueueController, echoText, queueDebug, type QueuedInput } from './queue';
import { shiftImageMarkers } from '@oh-my-pi/pi-tui/prompt/composer-attachments.js';
import { SKILL_PROMPT_MESSAGE_TYPE } from '@oh-my-pi/pi-tui/chat/messages.js';
import type { ImageContent } from '@oh-my-pi/pi-ai';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const isTTY = process.stdout.isTTY === true;

/** 测试可观测性（skill-invoke P5.1）：OMC_DEBUG_SKILL=<path> 时 skill 分支命中追加
 * INVOKE 行（OMC_DEBUG_QUEUE 同款，scripts/smoke-skill-pty.sh 断言用） */
const skillDebugPath = process.env.OMC_DEBUG_SKILL;
function skillDebug(line: string): void {
  if (!skillDebugPath) return;
  try {
    appendFileSync(skillDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/**
 * 后台任务调试通道（subagent-visibility P1.3）：`OMC_DEBUG_TASKS=<path>` 追加
 * `TASK ...` 行（值为 `1` 时写 stderr）。P1 的 task_* 可见性口径 = 日志 + 单测，
 * 卡片/面板留 P2；smoke-task-messages-pty.sh 靠这个文件做断言。
 */
const tasksDebugTarget = process.env.OMC_DEBUG_TASKS;
function taskDebug(line: string): void {
  if (!tasksDebugTarget) return;
  try {
    if (tasksDebugTarget === '1' || tasksDebugTarget === '-') process.stderr.write(line + '\n');
    else appendFileSync(tasksDebugTarget, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/**
 * print-mode 调试通道（P1.3）：`OMC_DEBUG_PRINT=<path>` 追加事件轨迹
 * （值 `1`/`-` 写 stderr）。用来排查「quiet 渲染漏了哪个事件 / system_init 有没有 sessionId」
 * 这类从 stdout 看不出的事（stdout 本就只该有最终答案）。
 */
const printDebugTarget = process.env.OMC_DEBUG_PRINT;
function printDebug(line: string): void {
  if (!printDebugTarget) return;
  try {
    if (printDebugTarget === '1' || printDebugTarget === '-') process.stderr.write(line + '\n');
    else appendFileSync(printDebugTarget, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/**
 * 自动标题调试通道（session-title P1.4）：`OMC_DEBUG_TITLE=<path>` 追加 gate/触发/写盘行
 * （值 `1`/`-` 写 stderr）。`scripts/smoke-title-pty.sh` 靠这个文件做断言。
 * 注：`TitleService` 内部也认同名变量，此处只记**门禁**层（service 内的创建/耗时由它自己记）。
 */
const titleDebugTarget = process.env.OMC_DEBUG_TITLE;
function titleDebug(line: string): void {
  if (!titleDebugTarget) return;
  try {
    if (titleDebugTarget === '1' || titleDebugTarget === '-') process.stderr.write(line + '\n');
    else appendFileSync(titleDebugTarget, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/** task_* 事件 → 单行调试日志（P1：只记日志，不落盘、不进转录） */
function taskDebugLine(ev: UIEvent): string | undefined {
  switch (ev.type) {
    case 'task_started':
      return `TASK started id=${ev.taskId} type=${ev.taskType ?? '?'} desc=${ev.description}`;
    case 'task_progress':
      return `TASK progress id=${ev.taskId} lastTool=${ev.lastToolName ?? '-'} tokens=${ev.usage?.totalTokens ?? '-'} toolUses=${ev.usage?.toolUses ?? '-'} ms=${ev.usage?.durationMs ?? '-'}`;
    case 'task_updated':
      return `TASK updated id=${ev.taskId} status=${ev.status ?? String(ev.patch.status ?? '?')}`;
    case 'task_notification':
      return `TASK notification id=${ev.taskId} status=${ev.status} summary=${ev.summary}`;
    default:
      return undefined;
  }
}

/**
 * subagent-visibility P1.5：后台任务/子代理状态表（面板数据源）。
 * 由 task_* 事件驱动；Agent 工具的入参（subagent_type/description）在 tool_start 时登记，
 * 供状态表给子代理命名 `@general-purpose-1`（对齐 codebuddy 面板）。
 */
const taskRegistry = new TaskRegistry();

/**
 * 视图事件日志（subagent-visibility P2.3）：主视图 + 各子代理视图的事件序列，
 * 供 P2.4 焦点导航**切换视图时重放**（不落盘 —— 仅当前会话内存；`/resume` 后子代理视图为空）。
 * key = `MAIN_VIEW`（主对话）或子代理的父级 `Agent` 工具 id（= `SubagentEvent.parentToolUseId`）。
 * 主视图含 user 消息（重放要回显出用户气泡），故记录项是一元组而非纯 UIEvent。
 */
const viewLog = new ViewLog();
/**
 * 当前聚焦的视图 key（P2.4）：`MAIN_VIEW` 或子代理父级工具 id。渲染入口据此分流 ——
 * 非当前视图的事件只记日志不渲染（切回时重放）。
 */
let currentView: string = MAIN_VIEW;
/** Agent Hub（CLI 记录视图）已渲染到的 jsonl mtime（taskId → mtime）：轮询据此判定要不要重读重绘 */
const agentViewMtimes = new Map<string, number>();
/** Workflow Hub（workflow 进度视图）已渲染到的 lastEventAt（taskId → ts）：轮询据此判定要不要重绘 */
const workflowViewPulses = new Map<string, number>();
/** workflow journal 签名（runId → `mtime:size`）：仅变化才重读重解析（stdio 通道不发运行中进度） */
const workflowJournalSigs = new Map<string, string>();
/** 主会话 jsonl 的 teammate 注入缓存（完成判定主信号）：mtime 变了才重读 */
let mainLogMtime = 0;
let mainLogReports: Map<string, TeammateReport> = new Map();

function logViewEvent(key: string, rec: ViewRecord): void {
  viewLog.append(key, rec);
}

/**
 * 信息行出口（P2.4）：命令输出 / 提示 / welcome 等信息行统一经此 —— 记入主视图日志
 * （切视图重放要保留，否则切一次视图 welcome 与命令输出就没了）+ 仅当前在主视图时渲染。
 */
function infoLines(lines: string[]): void {
  logViewEvent(MAIN_VIEW, { kind: 'info', lines });
  if (currentView === MAIN_VIEW) app?.bridge.addInfoLines(lines);
}

/**
 * 信息卡出口（子代理完成卡）：head/tail 纯文本行 + **Markdown 渲染**正文 ——
 * 记入主视图日志（`info_md` 记录，切视图/重放形态一致）+ 仅当前在主视图时渲染。
 * 报告必须 markdown 渲染（2026-10-07 用户反馈：`##`/`**` 原样外露不可接受）。
 */
function infoCard(head: string[], markdown: string, tail: string[] = []): void {
  logViewEvent(MAIN_VIEW, { kind: 'info_md', lines: head, markdown, tail });
  if (currentView === MAIN_VIEW) app?.bridge.addInfoCard(head, markdown, tail);
}

/**
 * 面板推送（app 内 tasksText.setText 自带「内容未变不重绘」判定）。
 * P2.1：推送 `all()`（含完成 TTL 内的终态行），可见性由 task-panel 的 `visibleTasks` 决定；
 * 顺带清理过期终态条目（终态否则永不释放）。
 */
function refreshTaskPanel(): void {
  const now = Date.now();
  taskRegistry.pruneTerminal(now - COMPLETED_TTL_MS);
  app?.setTaskPanel(taskRegistry.all());
}

/** Agent 工具入参 → 登记给状态表（命名/描述配对） */
function noteAgentToolInput(ev: Extract<UIEvent, { type: 'tool_start' }>): void {
  if (ev.toolName.toLowerCase() !== 'agent') return;
  let subagentType: string | undefined;
  let description: string | undefined;
  if (ev.detail) {
    try {
      const parsed = JSON.parse(ev.detail) as { subagent_type?: unknown; description?: unknown };
      if (typeof parsed.subagent_type === 'string') subagentType = parsed.subagent_type;
      if (typeof parsed.description === 'string') description = parsed.description;
    } catch {
      // detail 非法 JSON（截断等）→ 退化为无名子代理
    }
  }
  // P2.3：带上父级 tool_use_id（与子代理事件流的 parentToolUseId 配对，供视图切换定位）
  taskRegistry.noteAgentToolInput({ toolUseId: ev.toolUseId, subagentType, description });
}

/** 状态表接线：Agent 入参登记 + task_* 事件应用 + 面板刷新 */
function applyTaskEvent(ev: UIEvent): void {
  if (ev.type === 'tool_start') {
    noteAgentToolInput(ev);
    return;
  }
  if (!taskRegistry.apply(ev)) return;
  refreshTaskPanel();
}

/**
 * subagent-visibility P2.4：聚焦某个任务 → 切换 transcript 为该任务的视图
 * （焦点导航的「真·视图切换」，omp `session-focus-controller` 同范式）。
 *
 * 任务 → 子代理事件桶的映射靠 `TaskEntry.toolUseId`（与 `SubagentEvent.parentToolUseId` 同名）。
 * Bash 后台任务不产出子代理事件 → 无过程记录时给提示（产出查看留 P2.5）。
 */
function focusTaskView(taskId: string): void {
  const entry = taskRegistry.all().find((t) => t.id === taskId);
  if (!entry) return;
  // P2.7：**优先**读 CLI 落盘记录（`~/.codebuddy/projects/…/subagents/<taskId>.jsonl`）——
  // SDK 流不推送 teammate 的 inbox 注入与 lead 自动续话，故这里的记录才是「子代理真正做了什么
  // + 最终产出」的权威来源（见 src/app/subagent-log.ts 头注 / AGENTS.md「与 CLI 的耦合点」）。
  // model-variants-and-workflows P2（2026-10-09 用户验收修订）：workflow 任务的过程记录 =
  // 进度时间线（`task_progress.workflow_progress`），**不是**子代理事件 —— 它派出的子代理在
  // CLI 侧独立会话、事件不与 workflow task 配对（`tool_use_id` 有值但无 parentToolUseId 桶）。
  // 故渲染专属进度视图，避免落到「暂无过程记录可查看（子代理事件未配对…）」的误报。
  if (entry.type === 'local_workflow') {
    currentView = `task:${entry.id}`;
    workflowViewPulses.set(entry.id, entry.lastEventAt);
    switchWorkflowView(entry);
    return;
  }
  if (entry.type === 'Agent') {
    const records = readSubagentRecords(process.cwd(), session.sessionId, entry.id);
    if (records && records.length > 0) {
      currentView = entry.id;
      // 记下当前渲染到的 mtime，轮询只在有新行时重绘（见 3s 轮询的 Agent Hub 刷新）
      agentViewMtimes.set(entry.id, subagentStatus(process.cwd(), session.sessionId, entry.id).mtimeMs);
      // 已交付（teammate 注入存在）→ 报告全文前置（Markdown 渲染），后接执行过程。
      // 同名陈旧报告须按 timestamp >= startedAt 过滤（同轮询的 ①，CLI 重用子代理名）
      const repForView = readMainSessionTeammateReports(process.cwd(), session.sessionId).get(entry.name);
      const report = repForView && repForView.timestamp >= entry.startedAt ? repForView.text : undefined;
      const view = report
        ? [
            {
              kind: 'info_md' as const,
              lines: [`${GREEN}✓${RESET} ${DIM}交付报告全文${RESET} ${CYAN}@${entry.name}${RESET}`],
              markdown: report,
              tail: [`${DIM}──── 以下为执行过程记录 ────${RESET}`],
            },
            ...records,
          ]
        : records;
      app?.switchView(view, `Agent Hub · @${entry.name}（CLI 记录 · Esc 返回主视图）`);
      return;
    }
  }
  // 回退：内存事件桶（实时流；CLI 记录尚未落盘时）
  const key = entry.toolUseId;
  if (key && viewLog.has(key)) {
    currentView = key;
    const label = entry.type === 'Agent' ? `@${entry.name}` : entry.name;
    app?.switchView(viewLog.get(key), `Agent Hub · ${label}（Esc 返回主视图）`);
    return;
  }
  // P2.5：Bash 后台任务无子代理事件流 → 读 output_file 全文展示（补齐「查看结果」缺口）
  const out = readTaskOutput(entry.outputFile);
  if (out) {
    currentView = `task:${entry.id}`;
    const head = `${entry.type} ${entry.name} · ${entry.description}`;
    app?.switchView([{ kind: 'info', lines: [head, '', ...out] }], `Task · ${entry.name}（Esc 返回主视图）`);
    return;
  }
  infoLines([
    `${DIM}[tasks] ${entry.name}：暂无过程记录可查看（子代理事件未配对，或 Bash 任务尚未产出）${RESET}`,
  ]);
}

/**
 * 渲染 / 刷新 Workflow Hub 视图（P2 修订）：把 `workflowProgress` 时间线快照转成
 * 阶段分组视图；聚焦期间由 3s 轮询按 `lastEventAt` 变化重绘（见下）。
 */
function switchWorkflowView(entry: TaskEntry): void {
  const name = entry.workflowName ?? entry.description ?? entry.name;
  app?.switchView(
    [{ kind: 'info', lines: buildWorkflowViewLines(entry, Date.now()) }],
    `Workflow Hub · ⚙ ${name}（Esc 返回主视图；/workflows 看清单）`,
  );
}

/**
 * P2 修订：活跃 workflow 任务 → 读 CLI journal（逐条追加的**实时**进度）合成时间线写回 registry。
 * 为什么必须走磁盘：stdio 通道上 CLI 只在最初发两三条 `task_progress` 快照，运行中的 agent 完成 /
 * 阶段推进**不再发**（`scripts/probe-workflow.ts runtime multi` 实证）；journal 才有逐条记录
 * （见 `src/app/workflow-journal.ts` 头注）。签名（`mtime:size`）不变则跳过，避免每 3s 重读。
 */
function syncWorkflowJournals(): void {
  const sid = session.sessionId;
  if (!sid) return;
  const cwd = process.cwd();
  let changed = false;
  // 含**终态**任务：完成瞬间 CLI 会补发一条陈旧 stdio 快照把进度打回去（2026-10-10 实测），
  // 故完成后再用 journal（此刻已完整）覆盖一次。见 task-registry.workflowProgressSource。
  for (const t of taskRegistry.all().filter((x) => x.type === 'local_workflow')) {
    const sig = workflowJournalSignature(cwd, sid, t.id);
    if (!sig || workflowJournalSigs.get(t.id) === sig) continue;
    workflowJournalSigs.set(t.id, sig);
    const j = readWorkflowJournal(cwd, sid, t.id);
    if (!j) continue;
    const timeline = journalToTimeline(j);
    // 空时间线（仅 run_started / no-op workflow）不覆盖 stdio 快照（那可能已带 phase）
    if (timeline.length === 0) continue;
    if (taskRegistry.setWorkflowProgress(t.id, timeline, Date.now(), j.tokens)) changed = true;
  }
  if (changed) refreshTaskPanel();
}

/** 已宣布报告的 runId（一次性；record 在完成时才写，故靠轮询重试） */
const announcedWorkflows = new Set<string>();

/**
 * workflow 完成 → 把**报告全文**回流到主对话（P2 修订 2026-10-10）。
 *
 * 为什么需要：CLI 完成时只往主会话注入 `<task-notification>`（摘要 + output-file 路径），
 * 报告正文**不进对话** → 模型只能看到摘要，会答非所问（用户实测：模型回了句「完整报告含
 * 每条主张的证据与来源链接，已写入上方输出」的幻觉，正文其实没有任何内容）。
 * 报告全文在 run record 的 `result`（Markdown，含来源链接）→ omc 补一张完成卡
 * （同 `announceSubagentDone` 范式：完整打印、不折叠、Markdown 渲染）。
 */
function announceWorkflowDone(entry: TaskEntry): void {
  if (announcedWorkflows.has(entry.id)) return;
  const report = readWorkflowReport(process.cwd(), session.sessionId, entry.id);
  if (!report) return; // record 尚未写完 / 无结果 → 下次 tick 再试
  announcedWorkflows.add(entry.id);
  const name = entry.workflowName ?? entry.description ?? entry.name;
  const head = [`${GREEN}✓${RESET} ${DIM}工作流交付报告${RESET} ${CYAN}⚙ ${name}${RESET}`];
  const tail = [`${DIM}──── 报告全文（run ${entry.id.slice(0, 8)}…；也可 /workflows 查看）────${RESET}`];
  infoCard(head, report, tail);
}

/** P2.5：读 Bash 后台任务的 output_file 全文（截断到 `maxLines`），失败返回 null */
function readTaskOutput(file: string | undefined, maxLines = 200): string[] | null {
  if (!file) return null;
  try {
    const text = readFileSync(file, 'utf8').replace(/\n$/, '');
    const lines = text.split('\n');
    if (lines.length > maxLines) {
      return [...lines.slice(0, maxLines), `${DIM}…（共 ${lines.length} 行，已截断）${RESET}`];
    }
    return lines.length > 0 ? lines : [`${DIM}(无输出)${RESET}`];
  } catch {
    return null; // 文件不存在 / 不可读 → 调用方给提示
  }
}

/**
 * P2.7：子代理完成 → **主转录区追加「完成卡」**（把「子进程结果」带回主对话）。
 *
 * 为什么要 omc 补这一手：CLI **不把** teammate 的 inbox 注入与 lead 自动续话推给 SDK 宿主
 * （`scripts/probe-teammate-sdk.ts` 实证）→ 子代理结果在主对话里永远看不到。既然 omc 能
 * 判定完成（CLI 记录），就把子代理的**最终产出**呈现到主视图，并明确标注「子代理」
 * （不冒充主 agent 的回复）。走 `infoLines` → 进主视图日志，切视图重放可见。
 * ⚠️ 多行必须 join 成**单个**字符串（TranscriptContainer 块间插空行，逐行 addChild 会断卡）。
 */
function announceSubagentDone(t: TaskEntry, now: number, fullReport?: string): void {
  // teammate 交付注入（主信号）带正文时优先用；否则回退子代理记录的末尾产出。
  // 报告**完整打印、不折叠**（2026-10-07 用户定稿）：它是子代理的交付物本身，
  // 是用户最关心的信息，不是工具类的额外元数据；且按 **Markdown 渲染**（同轮反馈）。
  const outcome = fullReport
    ? fullReport.replace(/\n+$/, '').split('\n')
    : readSubagentOutcome(process.cwd(), session.sessionId, t.id, 200) ?? [];
  // 落盘（P2.7 追溯）：此前只渲染不落盘 → 事后无法确认这张卡是否出现过（见 jsonl.ts 注释）
  appendLog({
    type: 'subagent_done',
    id: makeEventId(),
    timestamp: now,
    name: t.name,
    taskId: t.id,
    description: t.description,
    elapsedMs: now - t.startedAt,
    outcome,
    ...(fullReport ? { report: fullReport } : {}),
  });
  const head = subagentDoneHead({ name: t.name, description: t.description, elapsedMs: now - t.startedAt });
  const markdown = fullReport ?? (outcome.length > 0 ? outcome.join('\n') : '（无结论文本）');
  infoCard([head], markdown, ['', SUBAGENT_DONE_HINT]); // 空行隔开正文与引导（2026-10-07 用户反馈）
}

/** 完成卡头行（实时与 `resume` 重放共用） */
function subagentDoneHead(rec: { name: string; description: string; elapsedMs: number }): string {
  return `${GREEN}✓${RESET} ${DIM}子代理${RESET} ${CYAN}@${rec.name}${RESET} ${DIM}${rec.description || rec.name} · ${formatDuration(rec.elapsedMs)}${RESET}`;
}

/** 完成卡尾行引导（Enter 只能在完成行 TTL 消失前用 → 主引导给随时可用的追问） */
const SUBAGENT_DONE_HINT = `${DIM}（追问「子代理结果」可让主 agent 汇总；↓ 选中任务 · Enter 看执行过程）${RESET}`;

/** 僵尸告警卡行（`announceSubagentZombie` 与 `resume` 重放共用） */
function subagentFailedCardLines(rec: {
  name: string;
  description: string;
  elapsedMs: number;
  stuckTool?: string;
}): string[] {
  const head = `${YELLOW}✗${RESET} ${DIM}子代理${RESET} ${CYAN}@${rec.name}${RESET} ${DIM}${rec.description || rec.name} · 疑似中断（${formatDuration(rec.elapsedMs)}）${RESET}`;
  const body = rec.stuckTool
    ? `  最后的工具调用 ${formatDuration(ZOMBIE_MS)} 无结果：${rec.stuckTool}`
    : `  记录 ${formatDuration(ZOMBIE_MS)} 无更新且无最终产出`;
  const hint = `  ${DIM}（子代理进程可能已挂死/被杀，可重新派发）${RESET}`;
  return [head, body, hint];
}

/**
 * 僵尸子代理告警卡（2026-10-07 会话 01a1168e）：工具调用悬空 > `ZOMBIE_MS` →
 * 主转录区明确告知「疑似中断 + 卡在哪个工具」，取代旧行为「面板行无声消失、无任何下文」。
 */
function announceSubagentZombie(t: TaskEntry, now: number): void {
  const pending = readPendingCall(process.cwd(), session.sessionId, t.id);
  const stuckTool = pending ? `${pending.name}: ${pending.summary}` : undefined;
  appendLog({
    type: 'subagent_done',
    id: makeEventId(),
    timestamp: now,
    name: t.name,
    taskId: t.id,
    description: t.description,
    elapsedMs: now - t.startedAt,
    outcome: [],
    status: 'failed',
    ...(stuckTool ? { stuckTool } : {}),
  });
  infoLines([
    subagentFailedCardLines({
      name: t.name,
      description: t.description,
      elapsedMs: now - t.startedAt,
      ...(stuckTool ? { stuckTool } : {}),
    }).join('\n'),
  ]);
}

/** P2.4：返回主视图（重放主视图事件日志） */
function returnToMainView(): void {
  if (currentView === MAIN_VIEW) return;
  currentView = MAIN_VIEW;
  app?.switchView(viewLog.get(MAIN_VIEW));
}

// ---------- argv：--continue / --resume <id> / --model <id> / --help / --version，剩余为 prompt ----------
// 解析见 src/cli-args.ts（纯函数，可单测）
const argv = parseArgv(process.argv.slice(2));

// --version：在会话创建前短路（下方顶层即 newSession，晚了会白起 CLI 子进程）
if (argv.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
// --permission-mode 非法值：会话创建前报错退出（对齐 CLI 惯例，避免静默回退）
if (argv.permissionMode && !isLaunchPermissionMode(argv.permissionMode)) {
  process.stderr.write(`未知权限模式：${argv.permissionMode}（可选：${launchPermissionModeList()}）\n`);
  process.exit(1);
}
// print-mode P1.2：--output-format 非法值 / 缺值 → 会话创建前报错退出（同 --permission-mode 惯例）
if (!isPrintOutputFormat(argv.outputFormat)) {
  process.stderr.write(
    `未知输出格式：${argv.outputFormat || '(缺值)'}（可选：${PRINT_OUTPUT_FORMATS.join(' | ')}）\n`,
  );
  process.exit(1);
}
/** print-mode：已校验的输出格式（上面的检查保证这里是 'text' | 'json'） */
const outputFormat: PrintOutputFormat = isPrintOutputFormat(argv.outputFormat)
  ? argv.outputFormat
  : 'text';
/** 恢复的 sessionId：--resume 优先；--continue 取当前 cwd 最近会话 */
let resumeId: string | null = argv.resumeId;
if (argv.cont && !resumeId) resumeId = SessionLog.latest(process.cwd());

// ---------- 权限 + 命令 ----------
const permBridge = new PermissionBridge();
const registry = new CommandRegistry();
registerBuiltinCommands(registry);

// ---------- 插件宿主（plugin P2/P4）：注册表读 ~/.omc/plugins.json，启动期加载 ----------
/** 插件事件总线（宿主派发点 session/before-create、session/error，P4.6） */
const hostEvents = new PluginEventBus();
/** 插件生命周期钩子总线（P6：`session/before-create` 可注入 env 等） */
const pluginHooks = new PluginHooks();
/** CLI 子命令注册表（内置 models + 插件子命令，P4.3；内置优先） */
const subcommands = new SubcommandRegistry();
/**
 * TTY 分支装配后非空（一次性/非 TTY 始终为 null → 朴素输出）。
 * **声明必须在插件加载之前**：`ctx.log` / `ctx.ui` 在 apply 期读它（此时为 null → 走
 * stderr/stdout），否则会 TDZ（`Cannot access 'app' before initialization`）。
 */
let app: PiTuiApp | null = null;
/**
 * print-mode P1.3：`-p/--print` 期间的 quiet 渲染器（非空时 `handleEvent` 改走它，
 * stdout 只放最终答案）；一次性执行结束即置回 null。TTY 交互/非 print 路径恒为 null。
 */
let printRenderer: PrintRenderer | null = null;
/** 是否正在生成（切账户拒绝并发；同 app 需在插件加载前声明） */
let running = false;
/**
 * goal P2：`/goal --exit` 达标后待退出。**禁止在 Stop hook 回调/result 前退出**
 * （P0 定论：回调内 close/exit 会丢本轮 result）→ 回调只置此标志，本轮 `result`
 * 处理后由 `runTurn` 触发 `cleanup(0)`。
 */
let pendingGoalExit = false;
/**
 * 退出时打印「如何恢复本会话」（cleanup → printResumeHint）。
 * 只有 TTY 交互路径置 true：子命令（omc models / omc plugin …）与非 TTY 降级的
 * stdout 是机器可读/管道输出，不该混进恢复提示。
 */
let resumeHintOnExit = false;

/**
 * 插件能力上下文（P4 完整面）。
 * - ui/sessions 经闭包读 app/session（激活期 app 未装配 → 调用期才求值）
 * - config 读走 loadConfig（每次现读，插件写后立即可见）
 */
const pluginCaps = new PluginCapabilities({
  registry,
  subcommands,
  events: hostEvents,
  hooks: pluginHooks,
  // statusline 段：插件自报 id（不含 `plugin:` 前缀）→ 宿主补前缀写入段注册表
  statusline: {
    // id 由插件自报（短名，如 `codebuddy:account`）；宿主只补 `plugin:` 前缀，避免伪造内置段
    register: (_pluginName, seg) => {
      if (!seg.id || /\s/.test(seg.id) || seg.id.startsWith(PLUGIN_SEGMENT_PREFIX)) {
        throw new Error(`statusline 段 id 非法：${seg.id}（不能为空 / 含空白 / 带 plugin: 前缀）`);
      }
      const full = `${PLUGIN_SEGMENT_PREFIX}${seg.id}`;
      if (isKnownSegment(full)) throw new Error(`statusline 段 id 已被占用：${full}`);
      registerPluginSegment(seg.id, () => seg.render());
      return () => {
        unregisterPluginSegment(seg.id);
      };
    },
    // 插件主动刷新：其段 render 读的状态变更后调用（命令路径另有宿主兜底，见 onSubmit）
    refresh: () => app?.refreshStatusline(),
  },
  config: {
    read: () => loadConfig(process.cwd()),
    get: (pluginName, key) => readPluginConfig(pluginName)[key],
    set: (pluginName, key, value) => writePluginConfig(pluginName, key, value),
  },
  ui: {
    select: (opts) =>
      new Promise<string | null>((resolve) => {
        if (!app) {
          resolve(null);
          return;
        }
        showSelectOverlay(app.tui, opts, {
          onPick: (value) => resolve(value),
          onCancel: () => resolve(null),
        });
      }),
    print: (lines) => {
      if (app) infoLines(lines);
      else for (const l of lines) process.stdout.write(`${l}\n`);
    },
  },
  sessions: {
    switchAccount: (target) =>
      switchAccountPrimitive(
        {
          // 无内容的会话不 resume（切账户直接开新会话）——避免 resume 一个 CLI 侧从未
          // 落盘的会话（新建后一句话未发 / 刚被关掉）→ `No conversation found`（P6 修）
          currentSessionId: () => resumeTargetForSwitch(sessionHasContent(), session.sessionId),
          isRunning: () => running,
          rebuild: (resumeId, env) => rebuildSession(resumeId, env),
        },
        target,
      ),
    // 通用查询：当前生效模型（闭包惰性读 `currentModel`；会话极早期可能为 initialModel）
    currentModel: () => currentModel,
  },
  log: (name, message) => {
    const line = `[plugin:${name}] ${message}`;
    if (app) infoLines([`${DIM}${line}${RESET}`]);
    else process.stderr.write(`${line}\n`);
  },
});
const pluginHost = new PluginHost({ capabilities: pluginCaps });

// ---------- 宿主事件派发：权限挂起（herdr P1.3） ----------
// 权限桥 pending 变化 → permission/pending（→ blocked）/ permission/resolved。
// 与 UI 弹窗（permission-overlay 的 addChangeListener）并存，互不覆盖。
/** 上一次挂起类型（边缘触发判定用；null = 当前无挂起） */
let permPendingKind: HostPendingKind | null = null;
permBridge.addChangeListener(() => {
  const pending = permBridge.pending;
  const view = pending ? { kind: pending.kind, label: pendingLabel(pending) } : null;
  const report = pendingReport(permPendingKind, view);
  permPendingKind = view?.kind ?? null;
  if (!report) return;
  if (report.type === 'permission/pending') hostEvents.emit('permission/pending', report.payload);
  else hostEvents.emit('permission/resolved', report.payload);
});

// ---------- 宿主事件派发：会话身份（herdr P1.5） ----------
/** 已上报的 sessionId（去重：仅变化时派发 session/identity） */
let lastReportedSessionId: string | null = null;
/** 会话 id 落位 → 派发 session/identity（新会话在 system_init 前 id 未定 → 不派发） */
function reportSessionIdentity(sessionId: string | undefined | null, resumed: string | null): void {
  const payload = identityReport(lastReportedSessionId, sessionId, resumed);
  if (!payload) return;
  lastReportedSessionId = payload.sessionId;
  hostEvents.emit('session/identity', payload);
}

// ---------- 内置子命令注册（P4.3 models / P5 plugin）----------
// 上移到此处（原在 main() 前）：`omc --help` 需在打印前把内置 + 插件子命令统一列出。
// 分发逻辑不变（main() 仍按 argv 首位置参数 `subcommands.get()`；内置优先，插件不得同名）。
subcommands.registerBuiltin({
  name: 'models',
  description: '列出可用模型（ID/上下文/最大输出/thinking/能力/积分）',
  run: async (sctx) => {
    let raw: RawLanguageModel[];
    try {
      raw = await fetchModelsSettled();
    } catch (e) {
      throw new Error(`查询失败：${e instanceof Error ? e.message : String(e)}（确认 codebuddy CLI 已安装并登录）`);
    }
    sctx.print([formatModelsTable(raw, currentModel)]);
  },
});

subcommands.registerBuiltin({
  name: 'plugin',
  description: '插件管理（list / add / remove / enable / disable / reload）',
  usage: '<子命令>',
  help: PLUGIN_HELP,
  run: async (sctx, args) => {
    const lines = await runPluginCli(args, {
      host: {
        loadedNames: () => pluginHost.loadedNames(),
        unload: (name) => pluginHost.unload(name),
        reload: (name) => pluginHost.reload(name),
      },
    });
    sctx.print(lines);
  },
});

// ---------- --help：打印帮助并短路（须在 newSession 之前，避免白起 CLI 子进程） ----------
// 插件子命令由插件 apply(ctx) 运行期注册 → 先 loadAll 收集（副作用同 `omc models`：
// 会执行插件 activate，可能读写配置）。子命令列表 = 内置 + 插件（统一分节，插件标 [插件]）。
if (argv.help) {
  await pluginHost.loadAll();
  // `omc <子命令> --help` / `-h` → 该子命令的详细帮助（而非全局帮助）
  const [helpTarget] = argv.positional;
  const helpSub = helpTarget ? subcommands.get(helpTarget) : undefined;
  if (helpSub) {
    process.stdout.write(`${subcommandHelpLines(helpSub).join('\n')}\n`);
    process.exit(0);
  }
  const pluginSubs = subcommands.pluginSubcommands();
  const lines = [
    `oh-my-codebuddy (omc) v${pkg.version} — 基于 @tencent-ai/agent-sdk 的终端编码代理`,
    '',
    '用法：',
    '  omc [选项] [prompt]',
    '  omc -p [选项] [prompt]  非交互一次性执行（结果打到 stdout；无 prompt 时读 stdin）',
    '  echo "<prompt>" | omc -p',
    '  omc <子命令> ...',
    '',
    '选项：',
    '  -h, --help        显示本帮助',
    '  -v, --version     显示版本号',
    '  -c, --continue    恢复当前目录最近会话',
    '  -r, --resume <id> 恢复指定会话',
    '  -m, --model <id>  指定模型（覆盖配置与 env；见 omc models）',
    '  -p, --print       非交互一次性执行：跑一轮、把最终答案打到 stdout 后退出，不启动 TUI',
    '      --output-format <text|json>',
    `                    输出格式（默认 text；json 为单行 JSON，可 jq 解析）`,
    '  -y, --dangerously-skip-permissions',
    '                    跳过权限弹窗（非交互模式本就自动放行；AskUserQuestion 问答仍弹）',
    '      --permission-mode <mode>',
    `                    本进程默认权限模式，不写配置（${launchPermissionModeList()}）`,
    '',
    '子命令：',
    ...subcommands.builtinSubcommands().map((s) => `  ${subcommandUsageLine(s)}  —  ${s.description}`),
    '',
    '插件子命令：',
    ...(pluginSubs.length > 0
      ? pluginSubs.map((s) => `  ${subcommandUsageLine(s)}  —  ${s.description}`)
      : ['  （暂无；omc plugin add <来源> 安装插件）']),
    '',
    '示例：',
    '  omc                  进入 REPL',
    '  omc "帮我重构 xxx"    一次性模式（仅打印最终答案）',
    '  omc -p "帮我重构 xxx" 同上一行（-p 为显式开关）',
    '  git diff | omc -p "总结这次改动"   管道输入',
    '  omc -p "..." --output-format json | jq -r .result',
    '  omc --continue       恢复最近会话',
    '  omc -m hy3           以指定模型启动',
    '  omc -y               跳过权限确认（谨慎）',
    '  omc --permission-mode plan   以计划模式启动',
    '  omc <子命令> help     查看某子命令的详细帮助',
    '',
    'REPL 内输入 /help 查看斜杠命令与键位。',
    '',
  ];
  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

// ---------- 配置（P6.5：用户级 ← 项目级 ← env） ----------
const config = loadConfig(process.cwd());
/** 生效模型：CLI --model > 配置（env > 项目级 > 用户级）> 内置默认 */
const initialModel = argv.model ?? config.model ?? 'hy3';
/**
 * 生效权限模式：-y > --permission-mode > 配置（env > 项目级 > 用户级）> default。
 * -y 覆盖 --permission-mode 取 bypassPermissions，并由 session 额外透传 CLI
 * `--dangerously-skip-permissions`（见 AgentSessionOptions.skipPermissions）。
 */
const skipPermissions = argv.dangerouslySkipPermissions;
const initialMode: LaunchPermissionMode = skipPermissions
  ? 'bypassPermissions'
  : ((argv.permissionMode as LaunchPermissionMode | null) ?? config.permissionMode ?? 'default');

/**
 * mcp-console P1：**本会话构造时**读取的 MCP 配置（user + project 合并结果）。
 * 在 `newSession` 里赋值（会话重建天然重算）；`/mcp` 读它展示来源与状态。
 * ⚠ 声明必须早于顶层 `newSession(resumeId)` 调用（否则 TDZ，见 AGENTS.md 插件加载约束）。
 */
let currentMcpConfig: McpConfigResult | null = null;

/**
 * goal P1.3：`/goal` 裁判会话（常驻轻量 SDK 会话，通道①）。
 * 随主会话重建而重建（旧实例 `close` 防子进程泄漏）；`cleanup` 时关闭。
 */
let goalJudgeSession: GoalJudgeSession | null = null;

/**
 * 裁判模型：优先 lite 变体（settings#variantModels.lite 显式设置时）；
 * 未设置/继承 → 返回 undefined（让 CLI 用默认模型）——P1.3 简化，lite 降本为可选优化。
 */
function goalJudgeModel(): string | undefined {
  const st = resolveVariant('lite', { variantMap: readVariantMap(), mainModelId: initialModel });
  return st.source === 'settings' ? st.modelId : undefined;
}

/**
 * prompt-suggestion 阶段：建议生成服务（常驻轻量 SDK 会话；对齐 CLI `agents.promptSuggestion.models=['lite']`）。
 * 随主会话重建而重建（旧实例 `close` 防子进程泄漏）；`cleanup` 时关闭。仅产出建议文本，UI 展示见 ui/app.ts。
 */
let suggestionService: SuggestionService | null = null;

/**
 * session-title P1.4：自动标题服务（**用完即关**，自身无会话句柄；随主会话重建而重建以刷新模型/env）。
 * 门禁与失败计数在下方 `maybeStartTitle`；落盘/展示见 `src/session-store/jsonl.ts` 读链。
 */
let titleService: TitleService | null = null;
/** 累计生成失败计数（sid → 次数；D6 达 3 次放弃）。内存即可：`/clear` 换 sid 自然清零 */
const titleFailures = new Map<string, number>();
/** 在飞 sid（防连发消息起两个标题会话） */
const titleInFlight = new Set<string>();
/** 累计失败上限（D6） */
const TITLE_MAX_FAILURES = 3;

/** lite 变体模型（settings 显式设置时用其 id，否则让 CLI 用默认 = 继承主模型）。建议/标题两服务共用 */
function liteVariantModel(): string | undefined {
  const st = resolveVariant('lite', { variantMap: readVariantMap(), mainModelId: initialModel });
  return st.source === 'settings' ? st.modelId : undefined;
}

// executable: 'node' —— bun build --compile 产物中 spawn 'bun' 会挂起（见 sdk-reference.md 风险节）
// 权限（M3.1 接回）：TTY 走 permBridge 弹窗；一次性/非 TTY 无交互界面自动放行（MVP P5 语义）
// env（P4.5 切账户）：叠加在宿主清理之后，注入 CODEBUDDY_API_KEY 等
function newSession(
  resume: string | null,
  env?: Record<string, string | undefined>,
  /**
   * 运行期 override（clear 阶段 P1.1）：`/clear` 重建会话时继承**当前**模型/权限，
   * 对齐 codebuddy `inheritClearedSessionOverrides`（否则会退回启动时的 `initialModel`/`initialMode`）。
   */
  override?: { model?: string; permissionMode?: LaunchPermissionMode },
): AgentSession {
  const model = override?.model ?? initialModel;
  const permissionMode = override?.permissionMode ?? initialMode;
  hostEvents.emit('session/before-create', { model, resume });
  // P6 钩子：插件可在创建前注入 env（如按所选账户注入 CODEBUDDY_API_KEY）。
  // 优先级：调用方显式 env（如切账户）> 钩子 patch —— 显式注入不会被钩子盖掉。
  const hookEnv = pluginHooks.emitBeforeCreate({ model, resume }).env ?? {};
  const mergedEnv = { ...hookEnv, ...env };
  // mcp-console P1：omc 自读 `.mcp.json`（user + project 合并）→ 显式注入 `mcpServers`。
  // 必须显式注入：`settingSources: []` 令 CLI 不加载 `.mcp.json`（探针实证）。配置在
  // 此处（= spawn CLI 时）读定 → 改配置需重启会话生效。P3：注入面剔除 omc 自管禁用集。
  const mcp = readMcpServers(process.cwd(), { extraDisabled: readUserMcpDisabled() });
  currentMcpConfig = mcp;
  // active-memory P1.3/P1.4：进程内记忆 MCP server（`save_memory`）+ 索引注入。
  // 都在此处（= 每次 spawn CLI 时）算定 → /clear、/resume、对话回退、watchdog 各重建路径
  // 天然重算（P0 待办：注入内容必须在所有 rebuild 路径重算）。
  const memoryServer = createMemoryServer(process.cwd());
  const memoryAppend = buildMemorySystemPrompt(process.cwd());
  const created = AgentSession.create({
    model,
    permissionMode,
    skipPermissions,
    canUseTool: (toolName, input, options) =>
      app ? permBridge.canUseTool(toolName, input, options) : Promise.resolve({ behavior: 'allow' as const }),
    resume: resume ?? undefined,
    env: mergedEnv,
    // 记忆 server 恒在（同名用户配置被覆盖，保证 save_memory 不被挤掉）
    mcpServers: { ...mcp.servers, [MEMORY_SERVER_NAME]: memoryServer },
    extra: {
      executable: 'node',
      ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
      // 索引注入（P0 定论 3）：只用 `{append}` 形式（字符串形式会整体替换系统提示词）
      ...(memoryAppend ? { systemPrompt: { append: memoryAppend } } : {}),
    },
  });
  pluginHooks.emitAfterCreate({ sessionId: created.sessionId, resumed: resume });
  // goal P1.3：重建裁判会话（常驻轻量，不挂 hook）+ 给主会话注入裁判回调
  // （回调按 Stop 入参 transcript_path + goal 锚点 createdAt 裁出对话，交裁判判定）
  goalJudgeSession?.close();
  goalJudgeSession = new GoalJudgeSession({
    cwd: process.cwd(),
    model: goalJudgeModel(),
    // ⚠ 必须经 buildChildEnv 清理宿主污染（SERVER__PORT 等会致 CLI 子进程挂起）；
    // 与主会话一致的口径，否则裁判会话 send 永不返回（冒烟实证：hook 触发但无 decision）。
    env: buildChildEnv(mergedEnv),
  });
  const judge = goalJudgeSession;
  created.setGoalJudge((input, state) =>
    judge.judge(
      state.condition,
      readTranscriptTail(input.transcript_path, { createdAt: state.createdAt }),
    ),
  );
  // prompt-suggestion：重建建议生成会话（常驻轻量；env 口径同主会话 + 变体 env，
  // 确保 lite 变体在 `settingSources: []` 隔离下仍生效，见 variantEnvFromSettings 注释）
  suggestionService?.close();
  suggestionService = new SuggestionService({
    cwd: process.cwd(),
    model: liteVariantModel(),
    env: buildChildEnv({ ...variantEnvFromSettings(), ...mergedEnv }),
    debug: suggestDebug,
  });
  // session-title P1.4：重建标题服务（env 口径同上；用完即关，此处只是刷新模型/env 快照）
  titleService?.close();
  titleService = new TitleService({
    cwd: process.cwd(),
    model: liteVariantModel(),
    env: buildChildEnv({ ...variantEnvFromSettings(), ...mergedEnv }),
    debug: titleDebug,
  });
  // herdr P1.5：resume 情结构造即有 id → 立即上报；新会话留待 system_init
  reportSessionIdentity(created.sessionId, resume);
  return created;
}
// ---------- 插件加载（P6）：必须在**首会话创建之前** ----------
// 否则 `session/before-create` 钩子来不及挂上，插件无法影响首会话（如按所选账户注入 KEY）。
// 代价：插件 `apply` 里若访问 `ctx.sessions`（session 尚未创建）会抛错 → 被 host 兜成
// 「加载失败」；插件应只做注册（命令/子命令/钩子），运行期再用 sessions。
await pluginHost.loadAll();

let session = newSession(resumeId);
// plan-approval P1.3：计划内容提供者（ExitPlanMode 入参不含内容，探针实证 input 恒 `{}`）。
// 闭包读当前 `session` 绑定，会话重建后自动指向新会话。
permBridge.setPlanProvider(() => session.planSnapshot());
permBridge.onPlanDecided = (choice) => {
  // plan-mode P1.3（D2）：三选项语义 —— 1 批准 / 2 留在 plan / 3 退出。
  // cancel-stops-turn D3：非批准的 deny 已一律带 `interrupt:true`（bridge 内 settlePlan）→ **立即停轮**，
  // 不再有 omc 主动续轮，也无需 R1 手动收尾（CLI 在 interrupt 通路下自行产出 result）。
  if (choice === 'yes') {
    // 选项 1：**先解钉**回 prePlanMode（P0 约束 2 —— CLI 只恢复自身 subject，override 残留
    // 'plan' 会把会话钉死在 plan），随后 CLI 执行计划、本轮自然收尾（不发 result 干预）。
    exitPlanMode();
  }
};
// P2.3 选项 3「Exit plan mode」：切回非 plan 模式（cancel-stops-turn 后差异只在「解钉」这个状态处理，
// 回执文案由 omc 自绘 —— interrupt 通路下 CLI 的 `exited` 模板不再送达模型）。
permBridge.onPlanExitMode = () => {
  exitPlanMode();
};

// ---------- plan 模式进/出收口（plan-mode P1.1）----------

/**
 * 出 plan 的兜底模式（= 「没有『进 plan 前模式』可恢复」时用它）。
 *
 * 正常情况 `prePlanMode` 有值（进 plan 那一刻的模式）；只有**启动就是 plan**
 * （`--permission-mode plan`，P2 冒烟与老 `smoke-plan-pty.sh` 都这么起）时没有 —— 此时把
 * `initialMode`（= plan）当兜底会让「批准后」仍停在 plan（只读）→ 计划批准了却执行不了，
 * 故回落 `default`（与旧 `onPlanExitMode` 的硬编码值一致）。
 */
const PLAN_EXIT_FALLBACK = initialMode === 'plan' ? 'default' : initialMode;

/** 模式状态变更后同步 UI（提示行 `⏸ plan + <prePlanMode>` + 状态栏） */
function syncPermissionMode(): void {
  app?.setPermissionMode(currentMode, prePlanMode);
  app?.refreshStatusline();
}

/**
 * 进 plan 收口（plan-mode P1.1，D3/D7；三入口共用）：记 `prePlanMode` + 用 `setPermissionMode('plan')`
 * 的 **override 钉住**（P0 约束 1 —— CLI 每次内部请求都会用启动时的 bypass 覆盖掉 plan）。
 *
 * 入口：① 事件流观察到模型调 `EnterPlanMode`；② `/mode plan` / `/plan`；③ Shift+Tab 循环到 plan
 * （②③ 的命令侧已自行 `setPermissionMode`，此处只补状态与幂等兜底）。
 *
 * `force=true`（观察到 `ExitPlanMode` 时）**重发一次**控制请求，挤掉「观察到 EnterPlanMode ↔
 * 下一次内部请求」的竞态（P0 实测：幂等，日志 `Set permission mode … from plan to plan`）。
 */
function pinPlanMode(force = false): void {
  const already = currentMode === 'plan' && prePlanMode !== null;
  const next = enterPlanMode({ mode: currentMode, prePlanMode }, PLAN_EXIT_FALLBACK);
  prePlanMode = next.prePlanMode;
  currentMode = next.mode;
  syncPermissionMode();
  if (already && !force) return;
  void session.setPermissionMode('plan').catch((e: unknown) => {
    infoLines([`${YELLOW}[plan] 钉住 plan 模式失败：${e instanceof Error ? e.message : String(e)}${RESET}`]);
  });
}

/**
 * 出 plan 收口（plan-mode P1.1，P0 约束 2）：恢复 `prePlanMode`（缺省回落启动模式）+ **清 override**。
 * 批准（选项 1）、退出（选项 3）、用户手切离开 plan 都走这里；选项 2（留在 plan）**不走**。
 */
function exitPlanMode(target?: string): void {
  const next = exitPlanState({ mode: currentMode, prePlanMode }, target, PLAN_EXIT_FALLBACK);
  prePlanMode = next.prePlanMode;
  currentMode = next.mode;
  syncPermissionMode();
  void session.setPermissionMode(next.mode as SwitchablePermissionMode).catch((e: unknown) => {
    infoLines([`${YELLOW}[mode] 切换失败：${e instanceof Error ? e.message : String(e)}${RESET}`]);
  });
}

/**
 * 用户**主动**切权限模式的状态收口（`/mode <id>`、`/plan`、Shift+Tab 循环共用）：
 * 切到 plan → 记 `prePlanMode`；切到别的 → 清 `prePlanMode`（已离开 plan，不留陈旧后缀）。
 * 控制请求由调用方发（命令侧原本就会调 `session.setPermissionMode`）。
 */
function applyUserPermissionMode(mode: string): void {
  const next = applyPermissionMode({ mode: currentMode, prePlanMode }, mode, PLAN_EXIT_FALLBACK);
  prePlanMode = next.prePlanMode;
  currentMode = next.mode;
  syncPermissionMode();
}
/**
 * 会话代次（subagent-visibility P1.3）：每次**替换** `session` 自增，
 * 常驻的非用户轮消费者（pumpIdleEvents）据此重新绑定到新会话的 idle 流。
 */
let sessionEpoch = 0;
/** 当前模型/权限模式（system_init 事件与 /model /mode 命令更新；初值取 CLI/config P6.5） */
let currentModel = initialModel;
let currentMode: string = initialMode;
/**
 * plan-mode P1.1（D4）：进 plan 那一刻的模式（`null` = 不在 omc 感知的 plan 中）。
 *
 * 用途有二：① 退出 plan（批准 / 选项 3 / 用户手切）时**恢复**它（P0 约束 2：CLI 只恢复自身
 * subject、override 残留 'plan' → 会话被钉死）；② 提示行后缀 `⏸ plan + <prePlanMode>`（D5）。
 * 三个入口（模型 `EnterPlanMode` / `/mode plan` / Shift+Tab）与出口统一经 `pinPlanMode()` /
 * `exitPlanMode()` / `applyUserPermissionMode()` 维护。
 */
let prePlanMode: string | null = null;
/** ux-port-v2 P5.3：system_init 的工具名簿记（/tools 用；rebuildSession 清零防串会话） */
let currentTools: string[] = [];
/** custom-commands P5 T5：system_init 的 MCP server 名单（/mcp 用；rebuildSession 清零防串会话） */
let currentMcpServers: Array<{ name: string; status: string }> = [];
/**
 * model-variants-and-workflows P1：最近一次取到的 raw 模型表（变体解析的 `relatedModels` 数据源）。
 * 由 `refreshContextWindow` 顺带刷新（system_init / 切模型后触发，首轮即热）；`/status` 同步读它。
 */
let lastRawModels: RawLanguageModel[] = [];
/** custom-commands P5 T5：最近一条 assistant 定稿文本（/copy 用；换会话清零） */
let lastAssistantText = '';
/**
 * rate-limit P1 T3（D4）：最近一条**已渲染**的 assistant 定稿文本（text_final）。
 * 供「error 文本完全相同 → 重复呈现」判等（`isDuplicateErrorText`）；换会话清零。
 * 与 `lastAssistantText` 语义不同（后者是 /copy 数据源，只在有内容时更新）。
 */
let lastFinalTextForDedup = '';
/** prompt-suggestion 阶段：最近一条用户输入文本（建议生成上下文；换会话清零） */
let lastUserText = '';
/** prompt-suggestion 阶段：建议生成去重键（同一轮 user+assistant 只生成一次） */
let lastSuggestKey = '';
/**
 * input-interactions P1：`!` bash 命令的**待注入上下文**缓冲。
 *
 * 语义对齐 omp：`!cmd` 的「命令+输出」进入**下一轮请求**（不触发本轮回复）。omc 的
 * SDK 没有「只加历史、不起轮」的 API（`send()` 必起一轮），故攒到这里，在 `deliver()`
 * 时拼进下一条发给模型的用户消息；`!!cmd`（excluded）不入缓冲。换会话清零（防串会话）。
 */
let pendingBashContexts: string[] = [];
/** subagent-visibility P1.5：init 去重键（sessionId|model）——init 每轮重发，避免重复查窗口 */
let lastInitKey = '';
let verbose = config.verbose ?? false;
/** ux-port P3.4：vim 编辑模式（/vim 热切换 + 用户级配置持久化；默认关） */
let vimMode = config.vimMode ?? false;
/** prompt-suggestion 阶段：输入框浅色「提问建议」开关（/suggest 热切换 + 用户级配置持久化；默认开） */
let suggestEnabled = config.suggestEnabled ?? true;
/** composer-shape 阶段：输入区形状（/shape 热切换 + 用户级配置持久化；默认 band） */
let composerShape = config.composerShape ?? 'band';
/** ux-port P2.1：ctrl+o 全局工具卡展开位（会话内运行期状态，与 verbose 的关系见 bridge.ts #onToolStart 注释）。
 *  tool-render P1 改 tri-state：undefined = 用户尚未操作（新卡用自身默认——原生工具卡折叠、
 *  DiffCard 展开看 diff）；boolean = 用户已显式选择（存量与新卡一律跟随）。 */
let toolsExpanded: boolean | undefined = undefined;
/** ux-port P2.3：ctrl+shift+o 工具活动区显隐位（true = 隐藏） */
let toolActivityHidden = false;
/** ux-port-v2 P4：ctrl+t thinking 显示位（「看一眼」场景，会话运行期不持久——
 * 参照 verbose 是配置项、toolsExpanded 是运行期的语义划分） */
let thinkingVisible = false;

// ---------- 会话持久化（P6.1） ----------
/** 懒建：sessionId 需等 SDK 生成（--resume 时构造即有） */
let sessionLog: SessionLog | null = null;
function appendLog(record: LogRecord): void {
  if (!sessionLog) {
    const sid = session.sessionId;
    if (!sid) return;
    sessionLog = new SessionLog(process.cwd(), sid);
  }
  sessionLog.append(record);
}

/**
 * `/rewind` 候选锚点（rewind P1.0/P1.3）：live 由 `checkpoint` 事件喂、`/resume` 由落盘记录重建。
 * 见 `src/app/rewind-checkpoints.ts`。
 */
let checkpointLog = new CheckpointLog();

/**
 * tool-render P1：落盘剥离 diff。
 * diff 完全由工具入参本地算出（normalize.computeToolDiff），而 detail 本身已含
 * old_string/new_string；落全量会让 write 大文件的 content 进 jsonl 两遍
 * （detail 截断版 + diff 全量版）。resume 重放用同一分派从 detail 重算（见下）。
 */
function stripDiffForLog(ev: ToolStart): ToolStart {
  return ev.diff ? { ...ev, diff: undefined } : ev;
}

/**
 * resume 重放补回 diff（落盘时被剥离）：detail 可解析时用 normalize 同一分派
 * 重算；detail 被 2000 字符截断导致 JSON 非法时维持无 diff（回落原生工具卡）。
 */
type ReplayableRecord = Exclude<
  LogRecord,
  { type: 'user' } | { type: 'subagent_done' } | { type: 'checkpoint' } | { type: 'bash' }
>;

function withReplayedDiff(rec: ReplayableRecord): ReplayableRecord {
  if (rec.type !== 'tool_start' || rec.diff || !rec.detail) return rec;
  try {
    const input = JSON.parse(rec.detail) as Record<string, unknown>;
    const diff = computeToolDiff(rec.toolName, input);
    return diff ? { ...rec, diff } : rec;
  } catch {
    return rec;
  }
}

// ---------- 渲染层 ----------
const statusline = new Statusline(
  process.cwd(),
  () => currentModel,
  () => currentMode,
  config.statusline,
);
/**
 * skill-invoke P2：skill 注册表（name → SkillEntry）。
 * TTY 分支启动时填充；P3 提交解析 / P4 注入复用。P6 热更新原地重填本 Map
 * （editor.skillFilePath 闭包持引用，见 app.ts）。
 */
const skillMap = new Map<string, SkillEntry>();
/**
 * custom-commands P2：自定义命令注册表（name → CustomCommandEntry）。
 * 与 skillMap 同构：TTY 启动时填充、热更新原地重填（`refillCustomCommandMap`）。
 * P3 起承担 `/xxx` 渲染执行的查表来源（当前仅 `/` 补全列表用）。
 */
const customCommandMap = new Map<string, CustomCommandEntry>();
/**
 * model-variants-and-workflows P2 T3：saved workflow 命令注册表（name → WorkflowEntry）。
 * 与 customCommandMap 同构（TTY 启动填充 / 热更新原地重填），**只收 saved**（project/user），
 * builtin 由 `/deep-research` 专门命令承载。触发走转发型（让模型调 `Workflow({name,args})`）。
 */
const workflowCommandMap = new Map<string, WorkflowEntry>();
/** 生成中预输入队列（ux-port P1.1 收口：串行单队列，回显延迟到交付） */
const queue = new QueueController();
/**
 * P4.3 日落盘差分基线：result.usage 是 CLI 会话累计值（2026-10-01 实证），
 * 单轮增量 = 本轮累计 - 上轮累计。resume 重放只推进基线；rebuildSession 清零。
 */
let lastCum = { input: 0, output: 0, cost: 0 };

// ---------- skill 热更新（skill-invoke P6） ----------
/** 当前完整 slash 命令数组（内置命令 + skill: 命名空间条目 + 自定义命令 + saved workflow 命令） */
function currentSlashCommands(): PiSlashCommand[] {
  return buildAllSlashCommands(
    registry.list(),
    [...skillMap.values()],
    [...customCommandMap.values()],
    [...workflowCommandMap.values()],
  );
}

let lastSkillRefresh = 0;
/**
 * 统一热刷新：原地清空+重填同一 skillMap 实例（editor.skillFilePath 闭包
 * 持引用不漂移，无需重设钩子）→ 重建命令数组 → 整体替换 autocomplete
 * provider 内层。纯同步 fs 扫描（惰性钩子在同步接口里调用，见 app.ts）。
 *
 * custom-commands P2：**同一个函数连带刷新自定义命令表**（`customCommandMap`）——
 * 两条来源共用「频道订阅 + 打开 / 惰性重扫」两个触发点，无需第二套机制。
 * 名字保留 `refreshSkills`（既有多处引用），语义为「刷新全部 `/` 命令来源」。
 */
function refreshSkills(): void {
  if (!app) return;
  lastSkillRefresh = Date.now();
  refillSkillMap(process.cwd(), skillMap); // 原地清空+重填，Map 引用不变
  refillCustomCommandMap(process.cwd(), customCommandMap);
  refillWorkflowCommandMap(process.cwd(), homedir(), workflowCommandMap);
  app.setSkillSlashCommands(currentSlashCommands());
}

/** 触发 2：打开 / 惰性重扫（兜底；1500ms 节流，须同步完成） */
function refreshSkillsIfStale(): void {
  if (Date.now() - lastSkillRefresh < 1500) return;
  refreshSkills();
}

/**
 * 触发 1：SDK commands 频道订阅（权威，与 CLI 一致）。订阅即 spawn/connect
 * CLI 并立即推一次（=> 启动即全量对齐一次）。标注 experimental，老 CLI 拒绝
 * 时降级为「打开 / 惰性重扫」。会话重建（/resume、watchdog）后须重新订阅。
 */
function subscribeCommandsChannel(): void {
  if (!app) return; // 一次性/非 TTY 路径不为订阅常驻 CLI
  session.subscribeCommands(() => refreshSkills()).catch(() => {
    infoLines([
      `${YELLOW}[skills] 变更订阅不可用（CLI 版本不支持），热更新降级为打开 / 时重扫${RESET}`,
    ]);
  });
}

// ---------- 事件处理 ----------
/**
 * ux-port P4.2：查询当前模型 contextWindow 写入状态条（best-effort）。
 * system_init 与 /model 切换后调用；不缓存列表（低频操作，切到列表外模型也能查到）。
 * 失败（CLI 不支持 raw 等）时 window 缺省，状态条 context 段退化为只显示用量。
 *
 * model-variants P1：顺带把 raw 模型表存到 `lastRawModels`（变体解析的 `relatedModels` 数据源，
 * 供 `/status` 与 `variantStates()` 同步读取）。
 */
async function refreshContextWindow(): Promise<void> {
  try {
    const models = await session.getAvailableModels();
    const w = models.find((m) => m.modelId === currentModel)?.contextWindow;
    statusline.setContextWindow(w);
    app?.refreshStatusline();
  } catch {
    // best-effort：window 未知不影响主流程
  }
  try {
    lastRawModels = await session.getAvailableModelsRaw();
  } catch {
    // best-effort：变体展示退化为 inherit
  }
}

/**
 * P4.2 修订：manual /compact 轮标志。compact 指令走服务端有状态会话的增量请求，
 * 其 assistant usage（实测 ~13.8k）只是指令调用自身的小 prompt，**不是对话上下文**——
 * 若刷新 ctx 段会制造「compact 后占用骤降」的假象（2026-10-01 真机：35%→7%→31% 困惑）。
 * 该轮的 context_usage 不直接刷新，而是累加 output（= summary 长度）；
 * 轮末 result 到达时用「system 基线 + summary」估算压缩后 context 立即刷新
 * （2026-10-01 三修：用户反馈 compact 完成时百分比不动、说话时突降，时序违和）。
 * auto compact 发生在正常轮内不受影响。
 */
let inCompactTurn = false;
let compactOutputTokens = 0;
/**
 * todo-hud P1（D5）：贴底待办行 meta 的两个数据源 ——
 * - `currentToolName`：当前正在执行的工具名（`tool_start` 置位，`tool_result`/`result` 清空）
 * - `turnTokens`：**本轮增量** output tokens（轮内累加 `context_usage.outputTokens`，开轮归零）
 * 二者都不属 UI 层，故在此采集后经 `PiTuiAppDeps` 注入（app 侧只做展示）。
 */
let currentToolName: string | undefined;
let turnTokens = 0;
/** ux-port-v2 P3：最近一次压缩摘要全文（/summary 浮层数据源；resume 重放还原） */
let lastCompactSummary: { text: string; trigger?: 'manual' | 'auto'; preTokens?: number } | null = null;

/** 分支无关的簿记（model/mode/usage），TTY 追加 bridge 路由；
 *  replay=true 时跳过日落盘（resume 重放的历史 result 不重复记账，P4.3） */
function handleEvent(ev: UIEvent, opts?: { replay?: boolean }): void {
  // rate-limit P1 T3（D4）：error 文本与最近一条 assistant 定稿文本完全相同 → 同一信息
  // 重复呈现 → 跳过**渲染**（视图日志也不记，避免切视图重放时再度出现）；事件照发。
  const dupError = ev.type === 'error' && isDuplicateErrorText(ev.message, lastFinalTextForDedup);
  // P2.3：主视图事件进视图日志（切视图重放用）。replay 时跳过（防重放把自己再记一遍）。
  if (!opts?.replay && !dupError) logViewEvent(MAIN_VIEW, { kind: 'event', ev });
  // goal P2：`/goal --exit` 达标 → 置待退出（实际退出在 runTurn 的 result 之后，见 pendingGoalExit）
  if (!opts?.replay && ev.type === 'goal_update' && ev.kind === 'satisfied' && ev.exitOnMet) {
    pendingGoalExit = true;
  }
  // rewind P1.0：检查点锚点采集（replay 的锚点由 replayLog 从记录重建）。
  // 落盘时机：新建锚点 + **增量快照带来备份数据时**——轮首快照常是空标记
  // （trackedFileBackups={}），真实数据在同轮增量快照里；replay 由 fromRecords 按
  // messageId 归并多条记录（files/backups 取最后非空），故重复落盘无副作用
  if (ev.type === 'checkpoint' && !opts?.replay) {
    const isNewAnchor = checkpointLog.observe(ev.messageId, ev.files, ev.timestamp, ev.backups);
    const hasBackupData = ev.backups !== undefined && Object.keys(ev.backups).length > 0;
    if (isNewAnchor || hasBackupData) {
      const anchor = checkpointLog.find(ev.messageId);
      if (anchor) appendLog(anchorToRecord(anchor, makeEventId(), Date.now()));
    }
  }
  // subagent-visibility P1.3：task_* 事件统一在此落调试日志（用户轮 / CLI 自发轮 /
  // 非 TTY 降级三条路径都经过 handleEvent）
  const taskLine = taskDebugLine(ev);
  if (taskLine) taskDebug(taskLine);
  // P1.5：状态表接线（面板数据源）。replay 重放的是本地 jsonl（无 task_*，不进面板）
  if (!opts?.replay) applyTaskEvent(ev);
  // P4.6：宿主事件派发（replay 的历史 error 不重放给插件）
  if (ev.type === 'error' && !opts?.replay) {
    hostEvents.emit('session/error', { message: ev.message, kind: ev.kind, model: currentModel });
  }
  // P6 自愈：resume 目标在 CLI 侧不存在（如切账户后旧会话未落盘）→ 去掉 resume 开新会话
  if (ev.type === 'error' && !opts?.replay && resumeId && isResumeNotFound(ev.message)) {
    setTimeout(healResumeNotFound, 0);
  }
  if (ev.type === 'system_init') {
    currentModel = ev.model;
    currentMode = ev.permissionMode;
    // plan-mode P1.4：带上 `prePlanMode` —— init 每轮重发，若此时 omc 已钉住 plan（override 生效
    // 时 CLI 也报 plan），后缀不该丢。
    app?.setPermissionMode(ev.permissionMode, prePlanMode); // 权限模式提示行同步（switch/resume 后）
    currentTools = ev.tools; // P5.3：/tools 数据源
    currentMcpServers = ev.mcpServers; // P5 T5：/mcp 数据源
    statusline.setSessionId(ev.sessionId); // statusline 阶段 P3：session 段
    app?.refreshStatusline();
    // P1.5：init 会**每轮重发**（CLI 的 drain-wait 轮询实测每 ~3.5s 一次）→ 只有
    // session/model 真变化才重查模型窗口，否则同一模型被反复查询（控制请求 + 状态栏抖动）
    const initKey = `${ev.sessionId}|${ev.model}`;
    if (initKey !== lastInitKey) {
      lastInitKey = initKey;
      void refreshContextWindow(); // P4.2：模型确定后查窗口
    }
    reportSessionIdentity(ev.sessionId, resumeId); // herdr P1.5：新会话 id 此刻落位
  }
  // ux-port P4.2：context 段由末次 API 调用用量驱动（result.usage 是累计值不可用）
  if (ev.type === 'context_usage') {
    turnTokens += ev.outputTokens ?? 0; // todo-hud P1（D5）：本轮增量（贴底待办行 meta）
    if (inCompactTurn) {
      compactOutputTokens += ev.outputTokens ?? 0; // compact 轮 output = summary 长度
    } else {
      statusline.setContextUsage(ev);
      app?.refreshStatusline();
    }
  }
  // 状态栏 token 簿记（result.usage 是 CLI 会话累计值，statusline 内部覆盖语义）
  if (ev.type === 'result' && ev.usage) {
    statusline.addUsage(ev.usage);
    // P4.3 日落盘：累计值差分出单轮增量；resume 重放只更新基线不记账
    const u = ev.usage;
    const cost = u.totalCostUsd ?? lastCum.cost;
    if (!opts?.replay) {
      appendUsageDaily({
        inputTokens: Math.max(0, u.inputTokens - lastCum.input),
        outputTokens: Math.max(0, u.outputTokens - lastCum.output),
        totalCostUsd: Math.max(0, cost - lastCum.cost),
      });
    }
    lastCum = { input: u.inputTokens, output: u.outputTokens, cost };
    app?.refreshStatusline();
  }
  // P4.2 三修：compact 轮收口 → 用「system 基线 + summary」估算压缩后 context 立即刷新
  if (ev.type === 'result' && inCompactTurn) {
    statusline.estimatePostCompact(compactOutputTokens);
    app?.refreshStatusline();
  }
  // ux-port-v2 P3：compact 摘要卡片元数据（SDK 0.3.267 不发 compact_boundary，
  // normalize 以 `<conversation_history_summary>` 前缀打标；trigger 由 /compact 轮判定，
  // preTokens 取 statusline 压缩前 context——该轮 context_usage 被 inCompactTurn 门控
  // 未刷新，used 仍是压缩前末次值；resume 重放时字段随 jsonl 已存在，??= 不覆盖）
  if (ev.type === 'text_final' && ev.compactSummary) {
    ev.trigger ??= inCompactTurn ? 'manual' : 'auto';
    ev.preTokens ??= statusline.contextUsage().used;
    // /summary 浮层全文出口（卡片限高的全文备份；resume 重放同路径还原）
    lastCompactSummary = { text: ev.text, trigger: ev.trigger, preTokens: ev.preTokens };
  }
  // rate-limit P1 T3（D4）：记录最近一条定稿文本（error 重复判等的基准；含重放路径）
  if (ev.type === 'text_final') lastFinalTextForDedup = ev.text;
  // todo-hud P1：当前执行中的工具名（贴底待办行 meta；result 收尾即清空，避免显示陈旧工具）
  if (ev.type === 'tool_start') currentToolName = ev.toolName;
  else if (ev.type === 'tool_result' || ev.type === 'result') currentToolName = undefined;
  // plan-mode P1.1（D3）：模型自己进/出 plan 的**感知源** = 事件流里的工具调用（P0 A2 实证：
  // `EnterPlanMode` 不在 deferred 列表，模型直调 → `tool_start` 顶层名即它）。
  // 观察到即钉住（幂等）；ExitPlanMode 时再钉一次挤掉竞态（P0 约束 1）。重放不触发
  // （resume 重放历史工具卡不该改当前模式）。
  if (!opts?.replay && ev.type === 'tool_start' && (ev.toolName === 'EnterPlanMode' || ev.toolName === 'ExitPlanMode')) {
    pinPlanMode(ev.toolName === 'ExitPlanMode');
  }
  if (app) {
    // P2.4：只在主视图聚焦时渲染；聚焦子代理视图期间主视图事件仅记录（切回时重放）
    if (currentView === MAIN_VIEW) {
      // D4：重复 error 跳过渲染（事件已派发；视图日志也未记 → 重放同样不再现）
      if (!dupError) app.bridge.handleEvent(ev);
      // CLI 启动失败友好提示（P6.7）
      if (ev.type === 'error' && ev.kind === 'startup') {
        infoLines([
          `${YELLOW}[hint] codebuddy CLI 启动失败：确认已全局安装（npm i -g @tencent-ai/codebuddy-code）且 codebuddy 可执行${RESET}`,
        ]);
      }
    }
  } else if (printRenderer) {
    // print-mode P1.3：quiet 渲染（stdout 只在 result 时出最终答案；过程事件静默）
    const em = printRenderer.handle(ev);
    printDebug(
      ev.type === 'system_init'
        ? `EV system_init sessionId=${ev.sessionId}`
        : `EV ${ev.type}${em?.stdout ? ` stdout=${em.stdout.length}B` : ''}`,
    );
    writePrintEmission(em);
  } else if (!dupError) {
    renderEventPlain(ev);
  }
}

/** 非 TTY / 一次性降级：P1 朴素直写 */
function renderEventPlain(ev: UIEvent): void {
  switch (ev.type) {
    case 'text_delta':
      process.stdout.write(ev.text);
      break;
    case 'thinking_delta':
      process.stdout.write(`${DIM}${ev.text}${RESET}`);
      break;
    case 'text_final':
      process.stdout.write('\n');
      break;
    case 'tool_start':
      process.stdout.write(`\n[tool] ${ev.toolName}: ${ev.summary}\n`);
      break;
    case 'tool_result':
      process.stdout.write(`[tool:${ev.isError ? 'error' : 'ok'}] ${ev.summary}\n`);
      break;
    case 'status':
      process.stdout.write(`[status] ${ev.status}\n`);
      break;
    case 'compact_boundary':
      process.stdout.write(`[compact] ${ev.trigger} pre_tokens=${ev.preTokens}\n`);
      break;
    case 'system_init':
      process.stdout.write(`[init] model=${ev.model} mode=${ev.permissionMode} tools=${ev.tools.length}\n`);
      break;
    case 'result': {
      const tag = ev.interrupted ? 'interrupted' : ev.success ? 'done' : 'failed';
      const usage = ev.usage
        ? ` in=${ev.usage.inputTokens} out=${ev.usage.outputTokens} $${ev.usage.totalCostUsd?.toFixed(4) ?? '?'}`
        : '';
      process.stdout.write(`[result:${tag}]${usage}\n`);
      if (ev.errors) process.stdout.write(`  errors: ${ev.errors.join('; ')}\n`);
      break;
    }
    case 'error':
      process.stdout.write(`[error:${ev.kind}] ${ev.message}${ev.detail ? ` (${ev.detail})` : ''}\n`);
      if (ev.kind === 'startup') {
        process.stdout.write('[hint] codebuddy CLI 启动失败：确认已全局安装（npm i -g @tencent-ai/codebuddy-code）且 codebuddy 可执行\n');
      }
      break;
  }
}

/**
 * 交付一条输入（直发或出队续发）：omp 式回显时机——出队交付时才
 * 回显进 transcript + 落盘（P6.3：只记发给 agent 的消息，含图只记文本部分），
 * 排队期间由 band 展示（P1.2），避免同一条消息双重显示。
 */
function deliver(item: QueuedInput): void {
  queueDebug(`DELIVER ${item.echo ? echoText(item.echo) : typeof item.msg === 'string' ? item.msg : '[图片]'}`);
  if (item.echo?.kind === 'skill') {
    // skill-invoke P4.3：回显 omp skill 卡片（草稿 chip），模型收展开全文；
    // 落盘只记草稿（/skill:name），与 omp 标题生成口径一致（不落 SKILL.md 正文）。
    // 展示 content 经限高（capSkillPromptDisplay）：展开超一屏会整卡退休冻结
    // （ctrl+o 收不回，2026-10-05 用户验收发现）；模型收的 msg 不截断
    const details = item.echo.details;
    app?.bridge.addSkillMessage(
      {
        role: 'custom',
        customType: SKILL_PROMPT_MESSAGE_TYPE,
        content:
          typeof item.msg === 'string'
            ? capSkillPromptDisplay(item.msg, {
                columns: process.stdout.columns ?? 80,
                rows: process.stdout.rows ?? 24,
              })
            : '',
        display: true,
        details,
        attribution: 'user',
        timestamp: Date.now(),
      },
      item.echo.imageLinks,
    );
    logUserMessage(echoText(item.echo));
  } else if (item.echo?.kind === 'command') {
    // custom-commands P3 T5：自定义命令卡（CommandMessageCard，展开限高防退休冻结）。
    // 落盘只记草稿（/name args），与 skill 口径一致（不落渲染后正文）。
    app?.bridge.addCommandMessage(item.echo.details);
    logUserMessage(echoText(item.echo));
  } else if (item.echo) {
    app?.bridge.addUserMessage(item.echo.text, { imageLinks: item.echo.imageLinks });
    logUserMessage(item.echo.text);
  }
  // input-interactions P1：把 `!` bash 的待注入上下文拼进本轮发给模型的消息
  // （omp/codebuddy「下一轮请求携带」；`!!` 不入缓冲）。回显/落盘仍是用户原话。
  void runTurn(applyPendingBashContext(item.msg));
}

/**
 * 一轮渲染 / 落盘状态（runTurn 与 CLI 自发轮共用，subagent-visibility P1.3）。
 * 落盘只记定稿事件（P6.1）。但 CLI 有时只发 delta 不发完整 assistant 消息
 * （2026-09-30 实测一次性模式无 text_final），故镜像定稿点（tool_start/result 提交
 * textBuf），用累计 delta 合成 text_final 落盘。
 * ux-port-v2 P4.4：thinking 同口径——deltaThinking 随定稿点写入 text_final.thinking，
 * resume 重放才有 thinking 可显（omp message_end 整体落盘范式，只存文本不存签名）。
 */
interface TurnRenderState {
  deltaText: string;
  deltaThinking: string;
  /** 本回合是否被用户中断（result.interrupted；herdr turn/end 载荷） */
  interrupted: boolean;
}

function newTurnState(): TurnRenderState {
  return { deltaText: '', deltaThinking: '', interrupted: false };
}

function flushTurnDelta(st: TurnRenderState): void {
  if (st.deltaText.trim() || st.deltaThinking.trim()) {
    appendLog({
      type: 'text_final',
      id: makeEventId(),
      timestamp: Date.now(),
      text: st.deltaText,
      ...(st.deltaThinking.trim() ? { thinking: st.deltaThinking } : {}),
    });
  }
  st.deltaText = '';
  st.deltaThinking = '';
}

/** 单条轮内事件：落盘 + 渲染（用户轮与 CLI 自发轮共用） */
function renderTurnEvent(ev: UIEvent, st: TurnRenderState): void {
  switch (ev.type) {
    case 'text_delta':
      st.deltaText += ev.text;
      break;
    case 'thinking_delta':
      st.deltaThinking += ev.text;
      break;
    case 'text_final':
      // compact 摘要轮：thinking 先单列一条 thinking-only 记录（镜像 live 的
      // byPrefix 窗口行为——先定稿 thinking-only 块、再出摘要卡，P3 bridge.ts）
      if (ev.compactSummary && st.deltaThinking.trim()) flushTurnDelta(st);
      st.deltaText = ''; // 完整 assistant 消息到达，delta 已由它覆盖
      if (ev.text.trim()) lastAssistantText = ev.text; // P5 T5：/copy 数据源
      appendLog(st.deltaThinking.trim() ? { ...ev, thinking: st.deltaThinking } : ev);
      st.deltaThinking = '';
      break;
    case 'tool_start':
    case 'result':
      flushTurnDelta(st);
      // tool-render P1：diff 不落盘（stripDiffForLog），resume 时从 detail 重算
      appendLog(ev.type === 'tool_start' ? stripDiffForLog(ev) : ev);
      break;
    case 'tool_result':
      appendLog(ev);
      break;
    // status/error/system_init/task_* 不落盘；text_delta/thinking_delta 经累积随定稿点落盘
  }
  handleEvent(ev);
  if (ev.type === 'result') st.interrupted = ev.interrupted === true;
}

/** 轮收尾（用户轮与 CLI 自发轮共用）：working 态、宿主事件、预输入队列续发 */
function finishTurn(interrupted: boolean): void {
  running = false;
  inCompactTurn = false;
  compactOutputTokens = 0;
  if (abandonTimer) {
    clearTimeout(abandonTimer);
    abandonTimer = null;
  }
  app?.setWorking(false);
  permBridge.denyPending(); // 兜底：轮结束不应有悬挂的权限请求
  hostEvents.emit('turn/end', { interrupted }); // herdr P1.4：→ idle
  // 预输入队列：当前生成结束后自动续发（交付时回显 + 落盘）
  const next = queue.shift();
  if (next !== undefined) deliver(next);
  // prompt-suggestion：无中断 + 无预输入续发时，异步生成「下一步建议」（不阻塞/不打扰）
  if (!interrupted && next === undefined) void maybeGenerateSuggestion();
}

/**
 * prompt-suggestion 阶段：一轮结束后异步生成「下一步建议」（对齐 CLI promptSuggestion）。
 *
 * 门槛：开关开 / 服务就绪 / 空闲 / 有助手上下文 / 同一轮不重复（`suggestionKey`）。
 * 结果只写 `app.setSuggestion`（UI 展示），任何失败都静默为「无建议」。
 */
async function maybeGenerateSuggestion(): Promise<void> {
  if (!suggestEnabled || !suggestionService || running || !session.sessionId) {
    suggestDebug(
      `gate-skip enabled=${suggestEnabled} svc=${!!suggestionService} running=${running} sid=${!!session.sessionId}`,
    );
    return;
  }
  const input: SuggestionInput = {
    lastUserText,
    lastAssistantText,
    language: detectLanguage(`${lastUserText}\n${lastAssistantText}`),
  };
  const key = suggestionKey(lastUserText, lastAssistantText);
  if (key === lastSuggestKey) {
    suggestDebug('gate-skip dup-key');
    return;
  }
  lastSuggestKey = key;
  suggestDebug(`trigger user=${JSON.stringify(lastUserText.slice(0, 40))} asst=${lastAssistantText.length}字`);
  const text = await suggestionService.request(input);
  // 生成期间又开跑（新一轮/续发）→ 丢弃，避免打扰
  if (!text || running) {
    suggestDebug(`drop text=${text === null ? 'null' : 'empty'} running=${running}`);
    return;
  }
  app?.setSuggestion(text);
}

/** 会「开启一轮」的事件：CLI 自动续话轮的内容类事件（task_* 与 status/init 不算） */
function startsAutoTurn(ev: UIEvent): boolean {
  switch (ev.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'text_final':
    case 'tool_start':
    case 'tool_result':
    case 'error':
      return true;
    default:
      return false;
  }
}

async function runTurn(text: string | UserMessage): Promise<void> {
  running = true;
  // prompt-suggestion：新一轮作废旧建议生成 + 清掉展示中的建议（避免带上一轮建议发送）
  suggestionService?.cancel();
  app?.setSuggestion(null);
  // P4.2 修订：manual /compact 轮的 context_usage 不刷新状态栏（见 inCompactTurn 注释）
  inCompactTurn = text === '/compact';
  turnTokens = 0; // todo-hud P1：本轮 tokens 从零起算（贴底待办行 meta）
  app?.setWorking(true);
  hostEvents.emit('turn/start', {}); // herdr P1.4：→ working
  const st = newTurnState();
  try {
    for await (const ev of session.send(text)) {
      renderTurnEvent(ev, st);
      // goal P2：`/goal --exit` 达标 → 本轮 result 渲染完后干净退出（P0 硬约束：不在回调内退）
      if (ev.type === 'result' && pendingGoalExit) {
        pendingGoalExit = false;
        setTimeout(() => cleanup(0), 0);
        return;
      }
    }
  } finally {
    finishTurn(st.interrupted);
  }
}

/**
 * 常驻消费「非用户轮」事件（subagent-visibility P1.3）。
 *
 * 探针实证（2026-10-06，`scripts/probe-task-messages.ts`）：后台任务/bash/子代理完成时
 * CLI 会**自动续话** —— 在用户轮的 result 之后 ~9s 再推 `task_notification` + 一段新的
 * assistant 文本 + 第二个 result。旧实现「首个 result 即 return」把整段续话丢了，
 * 新实现把它当**新一轮**渲染（宁可多一轮，也不丢内容）；task_* 状态 P1 只记调试日志
 * （卡片/面板留 P2）。
 */
async function pumpIdleEvents(): Promise<void> {
  // 会话可被替换（/resume、切账户、watchdog 重建）→ 用代次判断是否要重新绑定新会话
  for (;;) {
    const epoch = sessionEpoch;
    await consumeIdleEvents(session);
    if (sessionEpoch === epoch) return; // 未替换：会话被 close（退出流程）→ 常驻循环结束
  }
}

/** 消费单个会话的非用户轮事件，直到该会话关闭 */
async function consumeIdleEvents(src: AgentSession): Promise<void> {
  /** 非空 = CLI 自发轮进行中（懒启动：见 startsAutoTurn） */
  let st: TurnRenderState | null = null;
  /**
   * 自发轮兜底（P1.5）：CLI 自发轮**可能永远等不到 result**（隔离前的子代理内部事件
   * 曾造成 running 永久为 true → 用户输入只能排队）。异常来源已由 session 层过滤，
   * 这里再上一道保险：超过 IDLE_TURN_TIMEOUT_MS 无事件即强制收尾。
   */
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const ARM_IDLE_TURN_TIMEOUT_MS = 5 * 60_000;

  for await (const ev of src.idleEvents()) {
    if (ev.type === 'result') {
      handleEvent(ev); // usage 簿记 / 日落盘
      if (st) {
        finishTurn(st.interrupted);
        st = null;
        clearIdleTimer();
        taskDebug('AUTOTURN end'); // P1.4 冒烟断言用
      }
      continue;
    }
    if (!startsAutoTurn(ev)) {
      handleEvent(ev); // task_*/status 等：只记账 / 落日志（bridge 对未知类型是空操作）
      continue;
    }
    if (!st) {
      st = newTurnState();
      running = true;
      turnTokens = 0; // todo-hud P1：自发轮同样从零起算本轮 tokens
      app?.setWorking(true);
      hostEvents.emit('turn/start', {});
      taskDebug('AUTOTURN start'); // P1.4 冒烟断言用：CLI 自发轮（自动续话）成轮
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        infoLines([`${DIM}[tasks] 自发轮超时未收尾，已强制结束（可继续对话）${RESET}`]);
        taskDebug('AUTOTURN timeout');
        finishTurn(false);
        st = null;
      }, ARM_IDLE_TURN_TIMEOUT_MS);
    }
    renderTurnEvent(ev, st);
  }
  clearIdleTimer();
}

/**
 * 常驻消费「子代理事件」（subagent-visibility P2.3）。
 *
 * 子代理消息由 session 层走独立通道（`subagentEvents()`）投递，带父级 `Agent` 工具 id，
 * 与主对话流物理隔离 → **不渲染进主转录区**，只按 `parentToolUseId` 存进视图日志，
 * 供 P2.4 焦点导航切换视图时重放。会话可被替换（/resume、切账户）→ 代次重绑定，
 * 与 `pumpIdleEvents` 同构。
 */
async function pumpSubagentEvents(): Promise<void> {
  for (;;) {
    const epoch = sessionEpoch;
    await consumeSubagentEvents(session);
    if (sessionEpoch === epoch) return;
  }
}

async function consumeSubagentEvents(src: AgentSession): Promise<void> {
  for await (const ev of src.subagentEvents()) {
    const { parentToolUseId, ...rest } = ev;
    logViewEvent(parentToolUseId, { kind: 'event', ev: rest as UIEvent });
    // P2.6 冒烟断言用：确证子代理事件被旁路保留（旧 P1.5 此处是 DROP）
    taskDebug(`SUBAGENT view=${parentToolUseId} type=${rest.type}`);
    // P2.4：正聚焦该子代理视图 → 实时渲染。走 bridge 纯渲染（不触发 main 的簿记副作用，
    // 故子代理的 system_init / context_usage 不会污染主会话状态栏）。
    if (currentView === parentToolUseId) {
      app?.bridge.handleEvent(rest as UIEvent);
    }
  }
}

function cleanup(code: number): void {
  app?.stop();
  session.close();
  goalJudgeSession?.close();
  suggestionService?.close();
  titleService?.close();
  // herdr P1.6：退出释放口 —— 先通知插件（同步），再触发卸载链但**不等待**
  // （await 会拖慢/卡退出；真正可靠的 release 由插件侧 process.on('exit') + spawnSync 做）
  hostEvents.emit('host/shutdown', {});
  void pluginHost.unloadAll();
  printResumeHint();
  process.exit(code);
}

/**
 * 退出提示：已生成 session 时打印恢复方式（终端恢复后打，普通 stdout 输出）。
 * 仅 TTY 交互路径（resumeHintOnExit）——子命令 / 非 TTY 降级不打，免得污染管道输出。
 */
function printResumeHint(): void {
  if (!resumeHintOnExit) return;
  const lines = resumeHintLines(session.sessionId);
  if (lines.length === 0) return;
  process.stdout.write(`\n${lines.join('\n')}\n`);
}

/** 用户消息落盘（P6.1）；P2.3 同时进视图日志（切视图重放要回显用户气泡） */
function logUserMessage(text: string): void {
  lastUserText = text; // prompt-suggestion：建议上下文（斜杠命令由 buildSuggestionInput 过滤）
  const id = makeEventId();
  appendLog({ type: 'user', id, timestamp: Date.now(), text });
  // rewind P1.0：记下本轮标签与归属（其后到达的 checkpoint 锚点据此命名/归属）
  checkpointLog.noteUserInput(text, id);
  logViewEvent(MAIN_VIEW, { kind: 'user', text });
  // session-title P1.4：异步生成会话标题（不阻塞本轮回合；门禁见 maybeStartTitle）
  maybeStartTitle(text);
}

/**
 * session-title P1.4：用户消息提交后异步生成会话标题（不阻塞/不打扰）。
 *
 * 门禁（**全满足**才起请求）：
 * 1. `OMC_TITLE_DISABLE=1` 未关；
 * 2. 有 sessionId；
 * 3. 非本地命令文本（`/` 开头：command/skill/内置命令路径都落此形态）且非空白；
 * 4. 会话仍未命名 —— 判据 = `.title`(手改) 与 `.autotitle`(auto) **都不存在**（`isSessionNamed`；
 *    **不能**用 `sessionTitle()`：它总回落首句，永不空。先 `/rename` 过也不再生成，免白跑一次）；
 * 5. 非低信号（`isLowSignalTitleInput`）；
 * 6. 失败计数 `< TITLE_MAX_FAILURES`（D6）；
 * 7. 该 sid 无在飞请求。
 *
 * 成功后：`writeAutoTitle()` + `statusline.refreshSessionName()` + `app.refreshStatusline()`。
 */
function maybeStartTitle(text: string): void {
  if (process.env.OMC_TITLE_DISABLE === '1') {
    titleDebug('gate-skip disabled');
    return;
  }
  const sid = session.sessionId;
  if (!sid) {
    titleDebug('gate-skip no-sid');
    return;
  }
  const trimmed = (text ?? '').trim();
  if (!trimmed) return;
  if (trimmed.startsWith('/')) {
    titleDebug('gate-skip slash-command');
    return;
  }
  if (isSessionNamed(process.cwd(), sid)) {
    titleDebug('gate-skip already-titled');
    return;
  }
  if (isLowSignalTitleInput(trimmed)) {
    titleDebug('gate-skip low-signal');
    return;
  }
  if ((titleFailures.get(sid) ?? 0) >= TITLE_MAX_FAILURES) {
    titleDebug('gate-skip max-failures');
    return;
  }
  if (titleInFlight.has(sid) || !titleService) {
    titleDebug(`gate-skip in-flight=${titleInFlight.has(sid)} svc=${!!titleService}`);
    return;
  }
  titleInFlight.add(sid);
  titleDebug(`trigger sid=${sid} text=${JSON.stringify(trimmed.slice(0, 40))}`);
  void titleService
    .generate(trimmed)
    .then((title) => {
      if (!title) {
        const n = (titleFailures.get(sid) ?? 0) + 1;
        titleFailures.set(sid, n);
        titleDebug(`null failures=${n}`);
        return;
      }
      // 生成期间会话可能已换（/clear、resume）→ 丢弃，避免把标题写进别的会话
      if (session.sessionId !== sid) {
        titleDebug('drop: session-changed');
        return;
      }
      if (!writeAutoTitle(process.cwd(), sid, title)) {
        titleDebug('write-failed');
        return;
      }
      titleDebug(`write ${JSON.stringify(title)}`);
      // 展示链：statusline 缓存制 → 必须显式 re-resolve + 重绘
      statusline.refreshSessionName();
      app?.refreshStatusline();
    })
    .catch((e) => {
      // 兜底：标题是锦上添花，任何意外都静默（不打扰主对话）
      titleDebug(`error: ${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => {
      titleInFlight.delete(sid);
    });
}

/**
 * 重放 JSONL 重建 UI（P6.2）：定稿事件经 bridge 重渲染。
 * 本地无记录不阻塞——CLI 侧有自己的 transcript，SDK resume 仍可恢复上下文。
 */
function replayLog(): void {
  if (!resumeId) return;
  const records = SessionLog.load(process.cwd(), resumeId);
  const note = `[resume] 恢复会话 ${resumeId}（${records.length} 条本地记录）`;
  if (app) infoLines([`${DIM}${note}${RESET}`]);
  else process.stdout.write(`${note}\n`);
  /** rewind P1.0：重放期间收集检查点记录，循环后一次性重建候选（不逐条 observe） */
  const replayedCheckpoints: CheckpointRecord[] = [];
  for (const rec of records) {
    if (rec.type === 'user') {
      if (app) app.bridge.addUserMessage(rec.text);
      else process.stdout.write(`> ${rec.text}\n`);
    } else if (rec.type === 'checkpoint') {
      // rewind P1.0：锚点重建（不渲染；悬浮层候选的数据源）
      replayedCheckpoints.push(rec);
    } else if (rec.type === 'subagent_done') {
      // P2.7：完成卡重放（**不是** UIEvent，不能走 handleEvent）；
      // 完成卡正文走 Markdown 渲染（与实时形态一致），僵尸卡维持纯文本行
      if (rec.status === 'failed') {
        const card = subagentFailedCardLines(rec).join('\n');
        if (app) infoLines([card]);
        else process.stdout.write(`${card}\n`);
      } else {
        const head = subagentDoneHead(rec);
        const markdown = rec.report ?? (rec.outcome.length > 0 ? rec.outcome.join('\n') : '（无结论文本）');
        if (app) infoCard([head], markdown, ['', SUBAGENT_DONE_HINT]);
        else process.stdout.write(`${[head, markdown, SUBAGENT_DONE_HINT].join('\n')}\n`);
      }
    } else if (rec.type === 'bash') {
      // input-interactions P1：`!` / `!!` bash 回显卡重放（**不是** UIEvent，不能走
      // handleEvent）。喂**净化文本** → 无颜色（落盘不含 ANSI，同 omp resume 口径）。
      // 不重新入待注入缓冲 —— CLI 会话历史里本就带着它。
      const details: BashCardDetails = {
        command: rec.command,
        output: rec.output,
        exitCode: rec.exitCode,
        truncated: rec.truncated,
        droppedChars: rec.droppedChars,
        totalChars: rec.totalChars,
        timedOut: rec.timedOut,
        cancelled: rec.cancelled,
        excluded: rec.excluded,
      };
      if (app) {
        app.bridge.addTranscriptComponent(
          bashExecutionFromDetails(app.tui as unknown as BashExecutionHost, details),
        );
      } else {
        process.stdout.write(`${bashCardPlainText(details)}\n`);
      }
    } else if (app) {
      // 走簿记 + bridge（result usage 计入状态栏，不重复日落盘）；
      // tool_start 的 diff 落盘时被剥离，此处从 detail 重算补回
      handleEvent(withReplayedDiff(rec), { replay: true });
    } else if (rec.type === 'text_final') {
      // 非 TTY 重放没有 delta 流，text_final 须直接打全文（live 时它只打换行）
      process.stdout.write(`${rec.text}\n`);
    } else {
      renderEventPlain(rec);
    }
  }
  // rewind P1.0：重建 /rewind 候选（无记录 → 清空，防串会话）
  checkpointLog = CheckpointLog.fromRecords(replayedCheckpoints);
}

// ---------- 命令上下文 ----------
/**
 * 换会话 / 重建（M3.3，MVP P6.3 搬移；P4.5 泛化）：关旧 SDK 会话 → 按 env 新建
 * （resume 续上下文 + 可注入 CODEBUDDY_API_KEY 切账户）→ 清 transcript → 重放 →
 * 后续落盘进同一文件。
 */
function rebuildSession(sid: string | null, env?: Record<string, string | undefined>): void {
  session.close();
  // clear P1.1：重建时继承**当前**模型/权限（对齐 codebuddy `inheritClearedSessionOverrides`）
  session = newSession(sid, env, {
    model: currentModel,
    permissionMode: currentMode as LaunchPermissionMode,
  });
  sessionEpoch += 1; // P1.3：非用户轮消费者重新绑定新会话
  subscribeCommandsChannel(); // P6：旧订阅随旧会话消亡，重新挂上
  sessionLog = null; // appendLog 懒建会用新 sessionId
  resumeId = sid;
  taskRegistry.clear(); // P1.5：换会话不带走旧任务（面板随之清空）
  agentViewMtimes.clear(); // 视图刷新基线随会话失效
  workflowViewPulses.clear(); // workflow 视图刷新基线同上
  workflowJournalSigs.clear(); // journal 签名缓存同上
  announcedWorkflows.clear(); // 报告回流去重表同上
  mainLogMtime = 0; // teammate 注入缓存换会话失效（文件名随 sid 变）
  mainLogReports = new Map();
  viewLog.clear(); // P2.3：换会话丢弃旧视图日志（子代理桶随之作废）
  refreshTaskPanel();
  lastInitKey = ''; // P1.5：新会话重新查一次模型窗口
  lastCum = { input: 0, output: 0, cost: 0 }; // P4.3：换会话差分基线清零（replay 会重建）
  currentTools = []; // P5.3：防串会话（新会话 system_init 到达前 /tools 报未初始化）
  currentMcpServers = []; // P5 T5：同上（/mcp）
  lastAssistantText = ''; // P5 T5：同上（/copy 不会跨会话复制到旧会话内容）
  lastFinalTextForDedup = ''; // rate-limit P1 T3：同上（error 去重基准不跨会话）
  lastUserText = ''; // prompt-suggestion：同上（建议上下文不跨会话）
  lastSuggestKey = ''; // prompt-suggestion：去重键清零，新会话首轮可再生成
  pendingBashContexts = []; // input-interactions P1：待注入 bash 上下文不跨会话
  checkpointLog = new CheckpointLog(); // rewind P1.0：防串会话（replayLog 会按记录重建）
  // resume-state P1.3：会话级累计清零 —— 否则不在旧会话上叠加（turns 会累加、ctx 留旧值）。
  // 重放（replayLog → handleEvent(replay) → addUsage）随后按**被恢复会话**的记录重建 in/out/cost/turns。
  // 已知限制：ctx 段无落盘来源（context_usage 不入 jsonl）→ 恢复后空白，下一轮真实 usage 到达时恢复。
  statusline.reset();
  // resume-state P1.2：建议会话一换即清（对齐 CLI `PromptSuggestionService` 的 clearSuggestion）
  suggestionService?.cancel();
  if (app) {
    app.transcript.clear();
    app.bridge.reset();
    app.editor.setText('');
    app.setSuggestion(null); // P1.2：清掉展示中的**旧会话**建议（否则会被 Tab/Enter 误当输入发送）
    app.tui.requestRender(true, { clearScrollback: true });
    // 会话重建后无条件还焦输入框（rewind 浮层锁死修复，2026-10-09）：浮层链路/replay
    // 之后焦点可能落在已出栈的浮层组件上（pi-tui preFocus 还原不校验组件是否还在栈里），
    // 编辑器因此收不到键 —— 对齐 plan 内联卡的 restoreFocus: () => tui.setFocus(editor)
    app.tui.setFocus(app.editor);
  }
  // resume-state P1.1：状态栏跟随**被恢复会话** —— 此前 statusline 只从 `system_init` 拿 sessionId，
  // 而 resume 路径不发 system_init → 标题残留旧会话（中途 /resume）或空白（--resume 启动）。
  // resume 情结构造即有 id（同 `reportSessionIdentity(created.sessionId, resume)` 口径）；
  // 新会话为 undefined → 清空，交由后续 system_init 填。
  statusline.setSessionId(session.sessionId);
  replayLog();
}

// ---------- /rewind（rewind P1.3）----------
/**
 * 回退候选（1-based 序号 = 数组下标 + 1）。
 * 只有**产生过文件改动**的轮次才有锚点（无文件改动的轮不可回退，与 codebuddy 一致）。
 */
function rewindAnchors(): readonly CheckpointAnchor[] {
  return checkpointLog.list();
}

function rewindListLines(): string[] {
  return formatAnchorList(rewindAnchors());
}

/**
 * 对话回退（rewind P1.4 / R2 修复）：截断两侧记录 + 普通 resume 重启。
 *
 * 机制（2026-10-08 实证，见 `src/app/cli-session-rewind.ts` 头注释）：
 * ① omc 自己的记录截到该轮 `UserRecord` 之前（否则 `/resume` 重放会把撤销的轮又画出来）；
 * ② **CLI 自己的会话 jsonl 截到该轮 user item 之前** —— 这一步替代了 CLI flag
 *    `--resume-session-at`（后者会让会话带 `conversationReverted` 状态，导致**回退之后新产生的
 *    轮次不在有效分支里**、新锚点回退必失败）；
 * ③ 普通 `--resume` 重启 → 清 transcript + 重放被截断的本地记录
 *    （重放顺带重建 `checkpointLog`，目标及其之后的候选自然消失）。
 *
 * @returns 失败原因；undefined = 成功
 */
function applyConversationRewind(anchor: CheckpointAnchor): string | undefined {
  const sid = session.sessionId;
  if (!sid || !anchor.userRecordId) return '该检查点缺少轮次归属信息';
  // ① 本地记录截断。**找不到归属轮 = 锚点不属于当前本地记录（陈旧/串会话）→ 整体中止**：
  //    绝不能跳过本地截断还去截 CLI 侧 —— 两侧截断不同步会让「已被 CLI 删掉的轮」的锚点
  //    经重启重放灌回候选列表，下一次文件回退必报 `No checkpoint associated`
  //    （2026-10-09 真机缺陷，见 docs/plan/rewind/bug-handoff-rewind-lockup.md 症状 B）
  const records = SessionLog.load(process.cwd(), sid);
  const idx = records.findIndex((r) => r.id === anchor.userRecordId);
  if (idx < 0) return '该检查点的轮次归属不在本地会话记录中（可能属旧会话），无法回退对话';
  SessionLog.rewrite(process.cwd(), sid, records.slice(0, idx));
  // ② CLI 会话记录截断（失败则**不重启**，避免留下坏的会话状态）
  const outcome = truncateCliSessionAt(process.cwd(), sid, anchor.messageId);
  if (outcome !== 'truncated' && outcome !== 'truncated-empty') {
    return outcome === 'not-found'
      ? '该检查点不在 CLI 会话记录中（可能属旧会话记录），无法回退对话'
      : outcome === 'no-log'
        ? '找不到 CLI 会话记录文件，无法回退对话'
        : 'CLI 会话记录写入失败（权限/磁盘），无法回退对话';
  }
  // ③ 重启：截断为空（= 回退到第一轮之前）时**不能复用同 id** —— 实测空 history 载入后
  //    lastMessageId 建立不起来，之后新轮的锚点全部不可回退（probe-rewind-truncate-empty）
  //    → 改用新会话，语义即「对话清零」
  rebuildSession(outcome === 'truncated-empty' ? null : sid);
  return undefined;
}

// ---------- 本地恢复兜底（CLI teammate-message 内容嗅探 bug，2026-10-09）----------
/**
 * 背景见 `src/app/rewind.ts` 头注：CLI 把含 `<teammate-message` 的项目指令注入首轮用户消息
 * 的运行时文本 → 内容嗅探误判 → 首轮锚点 `rewind`/`rewind_files` 必报
 * `No checkpoint associated`。此处分两级闸门后走 omc 自恢复（与 CLI revert 语义对齐）。
 */

/** 闸门①：锚点确实存在于**当前** CLI 会话记录（区分「内容嗅探误判」与「锚点真陈旧」） */
function cliSessionHasMessage(sid: string, messageId: string): boolean {
  try {
    const p = mainSessionLogPath(process.cwd(), sid);
    if (!existsSync(p)) return false;
    return readFileSync(p, 'utf8').includes(`"id":"${messageId}"`);
  } catch {
    return false;
  }
}

/** 闸门②：有可用备份数据 → 出恢复计划（数据不足/锚点陈旧 → null，按原错误如实报） */
function localRestorePlanFor(anchor: CheckpointAnchor): ReturnType<typeof planLocalRestore> {
  const plan = planLocalRestore(rewindAnchors(), anchor.messageId);
  if (!plan) return null;
  const sid = session.sessionId;
  if (!sid || !cliSessionHasMessage(sid, anchor.messageId)) return null;
  return plan;
}

/**
 * 执行本地恢复计划（**破坏性**；调用方负责已 dry-run/确认）。
 * 恢复 = 写回 `~/.codebuddy/file-history/<sid>/<backupFileName>` 全文；
 * 删除 = existedAtTrack=false 的文件（ENOENT 视为已达目标态）。
 */
function applyLocalFileRestore(plan: NonNullable<ReturnType<typeof planLocalRestore>>, sid: string): LocalRestoreOutcome {
  const outcome: LocalRestoreOutcome = { restored: [], removed: [], failed: [] };
  const dir = join(homedir(), '.codebuddy', 'file-history', sid);
  for (const r of plan.restore) {
    try {
      const content = readFileSync(join(dir, r.backupFileName), 'utf8');
      const target = isAbsolute(r.path) ? r.path : resolve(process.cwd(), r.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      outcome.restored.push(r.path);
    } catch (e) {
      outcome.failed.push({ path: r.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const p of plan.remove) {
    try {
      unlinkSync(isAbsolute(p) ? p : resolve(process.cwd(), p));
      outcome.removed.push(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') outcome.removed.push(p);
      else outcome.failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcome;
}

/**
 * 执行一次回退（**破坏性**）。返回可打印的结果/错误行。
 * 顺序：先回文件（用当前活会话的控制通道），再回对话（重启会话）。
 *
 * 修复（2026-10-08，用户复现）：**文件步失败不再中止整体**。CLI 的运行时回退要求
 * 「会话已激活」（= 跑过至少一轮），刚启动/刚被对话回退重启的会话会回
 * `No active session` —— 此时若范围含对话，仍继续做对话回退并如实分步反馈
 * （对齐 CLI 自身「文件失败不阻塞历史」的语义）。
 *
 * 修复（2026-10-09）：文件步报 `No checkpoint associated`（CLI 内容嗅探误判首轮锚点）
 * 且通过两级闸门时，改走**本地备份恢复**（`applyLocalFileRestore`），结果单独成行。
 */
async function performRewind(anchor: CheckpointAnchor, scope: RewindScope): Promise<string[]> {
  if (running) return [`${YELLOW}[rewind] 生成中，稍后再试${RESET}`];
  const wantsFiles = scopeIncludesFiles(scope);
  const wantsConversation = scopeIncludesConversation(scope);
  let fileResp: RewindResult | null = null;
  let localOutcome: LocalRestoreOutcome | null = null;
  if (wantsFiles) {
    try {
      fileResp = await session.rewindFiles(anchor.messageId, false);
    } catch (e) {
      fileResp = { canRewind: false, error: e instanceof Error ? e.message : String(e) };
    }
    // CLI 内容嗅探 bug 兜底：首轮锚点被误判时走本地备份恢复
    if (isNoCheckpointError(fileResp)) {
      const plan = localRestorePlanFor(anchor);
      if (plan) localOutcome = applyLocalFileRestore(plan, session.sessionId ?? '');
    }
    // 仅文件范围 + 文件步失败（且未走兜底）→ 无后续动作可做，直接返回
    if (!localOutcome && fileStepSkippable(fileResp) && !wantsConversation) {
      return formatRewindResult(scope, fileResp, false);
    }
  }
  let conversationDone = false;
  if (wantsConversation) {
    const failure = applyConversationRewind(anchor);
    if (failure) {
      return [
        `${YELLOW}[rewind] 对话回退不可用（${failure}）${RESET}`,
        ...(localOutcome ? formatLocalRestoreOutcome(localOutcome) : formatRewindResult('files', fileResp, false)),
      ];
    }
    conversationDone = true;
  }
  if (localOutcome) {
    const lines = [...formatLocalRestoreOutcome(localOutcome)];
    if (scopeIncludesConversation(scope)) {
      lines.push(conversationDone ? '对话：已回退到该轮之前' : '对话：未回退');
    }
    if (conversationDone) lines.push(`${DIM}[rewind] ${INACTIVE_SESSION_NOTE}${RESET}`);
    return lines;
  }
  const lines = formatRewindResult(scope, fileResp, conversationDone);
  // 重启后文件回退暂不可用 → 一次说清，免得用户下次再撞。
  // 但仅当「仅对话范围（未跑文件步）」或「文件步正是因会话未激活被跳过」时才追加 ——
  // 文件步因其他原因失败（如 No checkpoint associated）时追加会暗示错误归因，误导用户
  // （2026-10-09 真机反馈，见 bug-handoff-rewind-lockup.md §3.5）
  if (conversationDone && (!fileResp || isInactiveSessionError(fileResp))) {
    lines.push(`${DIM}[rewind] ${INACTIVE_SESSION_NOTE}${RESET}`);
  }
  return lines;
}

/** 打印结果（TTY 走 infoLines，非 TTY 直写） */
function printRewind(lines: string[]): void {
  if (app) infoLines(lines);
  else for (const l of lines) process.stdout.write(`${l}\n`);
}

/** 交互流第 2 步：选范围 → 预览 → 确认 → 执行 */
function pickRewindScope(messageId: string): void {
  if (!app) return;
  showSelectOverlay(
    app.tui,
    {
      title: '回退范围',
      current: DEFAULT_REWIND_SCOPE,
      items: REWIND_SCOPE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description })),
      hint: 'Enter 确认 · Esc 取消',
    },
    {
      onPick: (scope) => {
        if (scope === 'files' || scope === 'conversation' || scope === 'both') {
          void startInteractiveRewind(messageId, scope);
        }
      },
      onCancel: () => {},
    },
  );
}

/** 交互流第 3 步：dry-run 预览（文件）+ 二次确认 */
async function startInteractiveRewind(messageId: string, scope: RewindScope): Promise<void> {
  const anchor = checkpointLog.find(messageId);
  if (!anchor) {
    printRewind([`${YELLOW}[rewind] 检查点已失效${RESET}`]);
    return;
  }
  if (running) {
    printRewind([`${YELLOW}[rewind] 生成中，稍后再试${RESET}`]);
    return;
  }
  if (scopeIncludesFiles(scope)) {
    let dry: RewindResult;
    try {
      dry = await session.rewindFiles(messageId, true);
    } catch (e) {
      dry = { canRewind: false, error: e instanceof Error ? e.message : String(e) };
    }
    // CLI 内容嗅探 bug 兜底预览：误判时能出本地恢复计划 → 照常走确认（执行时走兜底）
    const localPlan = isNoCheckpointError(dry) ? localRestorePlanFor(anchor) : null;
    if (localPlan) {
      printRewind(formatLocalRestorePreview(anchor, localPlan));
    } else if (fileStepSkippable(dry)) {
      if (!scopeIncludesConversation(scope)) {
        // 仅文件范围：无法预览 → 无可执行动作，直接说明并退出
        printRewind(formatRewindResult(scope, dry, false));
        return;
      }
      // 含对话：文件不可用但对话仍可回退 → 说明后继续走确认。
      // 「跳过」特指会话未激活；其他错误（如锚点真陈旧）如实报因，不套未激活文案
      if (isInactiveSessionError(dry)) {
        printRewind([`${YELLOW}${FILE_SKIP_INACTIVE_LINE}${RESET}`, `${DIM}对话回退不受影响${RESET}`]);
      } else {
        printRewind([
          `${YELLOW}文件：回退不可用（${dry.error ?? '未知原因'}）${RESET}`,
          `${DIM}对话回退不受影响${RESET}`,
        ]);
      }
    } else {
      printRewind(formatRewindPreview(anchor, dry));
    }
  }
  if (scopeIncludesConversation(scope)) {
    printRewind([`${YELLOW}对话将回退到该轮之前（之后的对话不可恢复）${RESET}`]);
  }
  if (!app) return;
  const scopeLabel = REWIND_SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;
  showSelectOverlay(
    app.tui,
    {
      title: `确认回退（${scopeLabel}）`,
      items: [
        { value: 'yes', label: '确认回退', description: `${anchor.label} 之前` },
        { value: 'no', label: '取消', description: '不做任何改动' },
      ],
      hint: 'Enter 确认 · Esc 取消',
    },
    {
      onPick: (v) => {
        if (v === 'yes') void performRewind(anchor, scope).then(printRewind);
      },
      onCancel: () => {},
    },
  );
}

/** 交互流第 1 步：选检查点 */
function openRewind(): void {
  const anchors = rewindAnchors();
  if (anchors.length === 0) {
    printRewind([`${DIM}[rewind] 没有可回退的检查点（只有产生过文件改动的轮次才有）${RESET}`]);
    return;
  }
  if (!app) {
    printRewind(rewindListLines());
    return;
  }
  if (running) {
    printRewind([`${YELLOW}[rewind] 生成中，稍后再试${RESET}`]);
    return;
  }
  showSelectOverlay(
    app.tui,
    {
      title: '回退到（将撤销该轮及其之后的改动）',
      items: anchors.map((a, i) => ({
        value: a.messageId,
        label: `#${i + 1}`,
        description: `${a.label} · ${a.files.length > 0 ? `${a.files.length} 文件` : '无文件'}`,
      })),
      hint: 'Enter 选择 · Esc 取消',
    },
    {
      onPick: (messageId) => pickRewindScope(messageId),
      onCancel: () => {},
    },
  );
}

/** `/rewind <编号> [scope]`：非交互直接执行 */
async function rewindTo(n: number, scopeRaw?: string): Promise<string[]> {
  const anchors = rewindAnchors();
  const anchor = anchors[n - 1];
  if (!anchor) {
    return [`${YELLOW}[rewind] 编号 ${n} 不存在（当前共 ${anchors.length} 个检查点）${RESET}`];
  }
  let scope: RewindScope = DEFAULT_REWIND_SCOPE;
  if (scopeRaw !== undefined && scopeRaw !== '') {
    const parsed = parseRewindScope(scopeRaw);
    if (!parsed) return [`${YELLOW}[rewind] 范围只能是 files | conversation | both${RESET}`];
    scope = parsed;
  }
  return performRewind(anchor, scope);
}

/**
 * 当前会话是否有内容（P6 切账户决策）：无内容则不 resume（开新会话）。
 * - 本进程内已落过盘（sessionLog 非空）→ 有；
 * - 否则读该 sessionId 的本地记录（`--resume` 恢复的会话可能有既有记录）。
 * 无内容意味着 CLI 侧很可能没有 conversation 文件，resume 必失败。
 */
function sessionHasContent(): boolean {
  const sid = session.sessionId;
  if (!sid) return false;
  if (sessionLog) return true;
  return SessionLog.load(process.cwd(), sid).length > 0;
}

/** 自愈防重入（丢弃失效 resumeId 只做一次） */
let healingResume = false;
/** resume 目标不存在 → 丢弃 resumeId 重开新会话，并提示重发（P6） */
function healResumeNotFound(): void {
  if (healingResume || !resumeId) return;
  healingResume = true;
  try {
    rebuildSession(null);
    const line =
      '[resume] 原会话在 CLI 侧不存在（可能属旧账户或未落盘），已开启新会话；请重发刚才的消息';
    if (app) infoLines([`${YELLOW}${line}${RESET}`]);
    else process.stdout.write(`${line}\n`);
  } finally {
    healingResume = false;
  }
}

const cmdCtx: CommandContext = {
  get session() {
    return session; // /resume 换会话后命令须拿到新实例（P6.3）
  },
  registry,
  print: (lines) => {
    if (app) infoLines(lines);
    else for (const l of lines) process.stdout.write(`${l}\n`);
  },
  clearScreen: () => {
    app?.transcript.clear();
    app?.bridge.reset();
    // clearScrollback：终端 scrollback 一并清（M3 计划语义），否则旧内容上翻可见
    app?.tui.requestRender(true, { clearScrollback: true });
  },
  clearConversation: () => {
    // clear P1.1：`/clear` 与 codebuddy 对齐 = **开始新对话**（清空模型上下文）。
    // 运行中拒绝：`rebuildSession` 会 close 当前会话、丢本轮 result（omc 安全取舍）。
    if (running) {
      infoLines([`${YELLOW}[clear] 生成中，无法开始新对话（先 Esc 中断）${RESET}`]);
      return;
    }
    rebuildSession(null); // 新 sessionId、不 resume；清转录 + replayLog（新会话空屏）
    // 清空会话级用量显示（否则新会话仍显示旧轮数/token/ctx，用户以为没清）
    statusline.reset();
    app?.refreshStatusline();
    infoLines([`${DIM}[clear] 已开始新对话（旧对话可用 /resume 恢复）${RESET}`]);
  },
  clearAlways: () => permBridge.clearAlways(),
  openResume: () => {
    if (!app) {
      cmdCtx.print([`${DIM}[resume] 非交互模式可用 --continue / --resume <id> 启动参数${RESET}`]);
      return;
    }
    if (running) {
      infoLines([`${YELLOW}[resume] 生成中，无法切换会话${RESET}`]);
      return;
    }
    const list = SessionLog.list(process.cwd());
    if (list.length === 0) {
      infoLines([`${DIM}[resume] 当前目录无历史会话${RESET}`]);
      return;
    }
    showResumeOverlay(app.tui, list, {
      onPick: (sid) => {
        if (!app) return;
        if (sid === session.sessionId) {
          infoLines([`${DIM}[resume] 已是当前会话${RESET}`]);
          return;
        }
        rebuildSession(sid);
      },
      onCancel: () => {},
    });
  },
  openRewind: () => openRewind(),
  rewindList: () => rewindListLines(),
  rewindTo: (n, scope) => rewindTo(n, scope),
  openModel: () => {
    if (!app) {
      // 非 TTY 回退：纯文本列表（交互浮层无从附着）
      void session
        .getAvailableModels()
        .then((models) => {
          const cur = currentModel;
          cmdCtx.print([
            '可用模型：',
            ...models.map(
              (m) =>
                `  ${m.modelId === cur ? `${YELLOW}*${RESET}` : ' '} ${CYAN}${m.modelId}${RESET} ${m.name}${m.description ? `${DIM} — ${m.description}${RESET}` : ''}`,
            ),
            `${DIM}/model <id> 直接切换${RESET}`,
          ]);
        })
        .catch((e: unknown) => {
          cmdCtx.print([`${YELLOW}[model] 查询失败：${e instanceof Error ? e.message : String(e)}${RESET}`]);
        });
      return;
    }
    void (async () => {
      try {
        // raw 才带 credits（浮层字段对齐 codebuddy：名称/[id]/(xN.NN credits)）；
        // REPL 长会话云目录早已落位，无需 fetchModelsSettled
        const raw = await session.getAvailableModelsRaw();
        const entries = raw.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          credits: m.credits?.replace(/\s*credits\s*$/, ''),
        }));
        if (!app) return;
        showModelOverlay(app.tui, entries, currentModel, {
          onPick: (id, scope) => {
            void (async () => {
              await session.setModel(id);
              cmdCtx.setCurrentModel(id);
              if (scope === 'global') {
                saveUserModel(id);
                infoLines([`${DIM}[model] 已切换 → ${id}（全局，已写入用户配置，下一轮生效）${RESET}`]);
              } else {
                infoLines([`${DIM}[model] 已切换 → ${id}（本会话，下一轮生效）${RESET}`]);
              }
            })().catch((e: unknown) => {
              infoLines([
                `${YELLOW}[model] 切换失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
              ]);
            });
          },
          onCancel: () => {},
        });
      } catch (e) {
        infoLines([
          `${YELLOW}[model] 查询失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
        ]);
      }
    })();
  },
  openVariant: (variantId) => {
    void (async () => {
      let raw: RawLanguageModel[];
      try {
        raw = await session.getAvailableModelsRaw();
      } catch (e) {
        cmdCtx.print([
          `${YELLOW}[model:${variantId}] 查询模型列表失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
        ]);
        return;
      }
      const models = raw.map((m) => toVariantEntry(m));
      const variantMap = readVariantMap();
      // 非 TTY：文本列表回退（与 `/model:lite list` 同一组装函数，零漂移）
      if (!app) {
        cmdCtx.print(
          buildVariantListLines(variantId, {
            models,
            mainModelId: currentModel,
            variantMap,
            pendingRestart: needsVariantRestart(variantId, variantMap, session.variantEnvAtSpawn),
          }),
        );
        return;
      }
      const state = {
        ...resolveVariant(variantId, {
          variantMap,
          mainModelId: currentModel,
          relatedModels: models.find((m) => m.id === currentModel)?.relatedModels,
        }),
        pendingRestart: needsVariantRestart(variantId, variantMap, session.variantEnvAtSpawn),
      };
      showModelOverlay(
        app.tui,
        models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          credits: (raw.find((r) => r.id === m.id)?.credits ?? '').replace(/\s*credits\s*$/, '') || undefined,
        })),
        // 变体模式：✓ 与预选落在「当前生效值」上（可能是 INHERIT_SENTINEL 那一行）
        state.source === 'inherit' ? INHERIT_SENTINEL : state.modelId,
        {
          onPick: (value) => {
            const r = writeVariant(cliUserSettingsPath(), variantId, value);
            cmdCtx.print(
              r.ok
                ? [
                    value === INHERIT_SENTINEL
                      ? `${GREEN}✓${RESET} ${variantId} variant reset to default resolution (global)`
                      : `${GREEN}✓${RESET} ${variantId} variant set to ${value} (global)`,
                    `${DIM}（变体在 omc 会话启动时注入，改值后需重启会话生效；真 CLI 会话立即生效）${RESET}`,
                  ]
                : [`${YELLOW}[model:${variantId}] 写入失败：${r.error}${RESET}`],
            );
          },
          onCancel: () => {},
        },
        {
          title: `Select ${variantId} model`,
          variant: { hint: sourceNote(state) },
        },
      );
    })();
  },
  openUsage: () => {
    if (!app) {
      cmdCtx.print([`${DIM}[usage] 非交互模式请用 /cost 查看单行统计${RESET}`]);
      return;
    }
    showUsageOverlay(app.tui, statusline); // P4.4：dashboard overlay
  },
  openSummary: () => {
    if (!app) return;
    if (!lastCompactSummary) {
      infoLines([`${DIM}[summary] 本 session 尚无压缩摘要（/compact 后可查看）${RESET}`]);
      return;
    }
    showSummaryOverlay(app.tui, lastCompactSummary);
  },
  // detail-view P1.3：/detail（或 F2）→ 全屏可滚动**会话详情**（含 thinking 全文 + 工具 input/output）
  openDetail: () => {
    if (!app) {
      cmdCtx.print([
        `${DIM}[detail] 非交互模式无法打开全屏视图 —— 可用 /export 导出为 markdown 文件${RESET}`,
      ]);
      return;
    }
    const sid = session.sessionId;
    const records = sid ? SessionLog.load(process.cwd(), sid) : [];
    if (records.length === 0) {
      infoLines([`${DIM}[detail] 当前会话无落盘记录——先进行一轮对话再查看${RESET}`]);
      return;
    }
    showDetailOverlay(app.tui, {
      markdown: renderSessionMarkdown(
        records,
        { sessionId: sid, exportedAt: new Date(), model: currentModel },
        { includeThinking: true, title: '会话详情（thinking 全文 + 工具输出）' },
      ),
      title: '会话详情（thinking 全文 + 工具输出）',
    });
  },
  // plugin P5.4：/plugin 插件管理浮层（列表 + Enter 启停 + r 重载；非 TTY 回退文本表）
  openPlugins: () => {
    const entries = () => pluginStatuses(readRegistry(), pluginHost.loadedNames());
    if (!app) {
      cmdCtx.print(formatPluginTable(entries()));
      return;
    }
    showPluginOverlay(app.tui, {
      entries,
      toggle: async (name) => {
        const entry = readRegistry().plugins[name];
        if (!entry) return `${YELLOW}[plugin] 插件不存在：${name}${RESET}`;
        if (entry.enabled !== false) {
          disablePlugin(name);
          await pluginHost.unload(name);
          return `${DIM}[plugin] 已停用 ${name}${RESET}`;
        }
        enablePlugin(name);
        const ok = await pluginHost.reload(name);
        return ok
          ? `${DIM}[plugin] 已启用 ${name}（已加载）${RESET}`
          : `${YELLOW}[plugin] 已启用 ${name}（加载失败，见上方警告）${RESET}`;
      },
      reload: async (name) => {
        const entry = readRegistry().plugins[name];
        if (!entry) return `${YELLOW}[plugin] 插件不存在：${name}${RESET}`;
        if (entry.enabled === false) {
          return `${YELLOW}[plugin] ${name} 已停用，先启用再重载${RESET}`;
        }
        const ok = await pluginHost.reload(name);
        return ok
          ? `${DIM}[plugin] 已重载 ${name}${RESET}`
          : `${YELLOW}[plugin] ${name} 重载失败（见上方警告）${RESET}`;
      },
    });
  },
  sendToAgent: (text) => {
    logUserMessage(text);
    if (running) {
      queue.push({ msg: text }); // 提交时已回显（onSubmit 斜杠路径），不带 echo
      return;
    }
    void runTurn(text);
  },
  stats: () => statusline.stats(),
  toggleVerbose: () => {
    verbose = !verbose;
    return verbose;
  },
  toggleVim: () => {
    vimMode = !vimMode;
    saveUserVimMode(vimMode);
    app?.setVimMode(vimMode);
    return vimMode;
  },
  // prompt-suggestion 阶段：/suggest 开关（热切换 + 用户级持久化；关闭即清展示中的建议）
  suggestEnabled: () => suggestEnabled,
  setSuggestEnabled: (enabled: boolean) => {
    suggestEnabled = enabled;
    saveUserSuggestEnabled(enabled);
    if (!enabled) {
      suggestionService?.cancel();
      app?.setSuggestion(null);
    }
  },
  // composer-shape 阶段：/shape 无参弹浮层（非 TTY 回退文本列表，对齐 /model）
  openShape: () => {
    if (!app) {
      cmdCtx.print([
        '可用输入区形状：',
        ...getComposerShapeOptions().map(
          (o) =>
            `  ${o.value === composerShape ? `${YELLOW}*${RESET}` : ' '} ${CYAN}${o.value}${RESET}${DIM} — ${o.label}${RESET}`,
        ),
        `${DIM}/shape <id> 直接切换${RESET}`,
      ]);
      return;
    }
    showShapeOverlay(
      app.tui,
      composerShape,
      {
        onPick: (shape) => {
          composerShape = shape;
          saveUserComposerShape(shape);
          app?.setComposerShape(shape);
          infoLines([`${DIM}[shape] 已切换 → ${shape}（已写入用户配置）${RESET}`]);
        },
        onCancel: () => {},
      },
      statusline,
    );
  },
  // /mode 无参弹浮层（非 TTY 回退文本列表，对齐 /model）
  openMode: () => {
    if (!app) {
      const cur = currentMode;
      cmdCtx.print([
        '权限模式：',
        ...PERMISSION_MODES.map(
          (m) => `  ${m.id === cur ? `${YELLOW}*${RESET}` : ' '} ${CYAN}${m.id}${RESET}${DIM} — ${m.description}${RESET}`,
        ),
        `${DIM}/mode <id> 直接切换（清空 always 白名单）${RESET}`,
      ]);
      return;
    }
    showModeOverlay(app.tui, currentMode, {
      onPick: (mode) => {
        void (async () => {
          await session.setPermissionMode(mode as SwitchablePermissionMode);
          cmdCtx.clearAlways();
          cmdCtx.setCurrentMode(mode);
          infoLines([`${DIM}[mode] 已切换 → ${mode}，always 白名单已清空${RESET}`]);
        })().catch((e: unknown) => {
          infoLines([
            `${YELLOW}[mode] 切换失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
          ]);
        });
      },
      onCancel: () => {},
    });
  },
  // composer-shape 阶段：/shape <id> 直接切换（校验 + 持久化 + 应用，仿 /model）
  setComposerShape: (shape) => {
    if (!isBuiltinComposerStyle(shape)) {
      cmdCtx.print([
        `${YELLOW}[shape] 未知形状：${shape}（可选：${COMPOSER_SHAPE_VALUES.join(' / ')}）${RESET}`,
      ]);
      return;
    }
    composerShape = shape;
    saveUserComposerShape(shape);
    app?.setComposerShape(shape);
    cmdCtx.print([`${DIM}[shape] 已切换 → ${shape}（已写入用户配置）${RESET}`]);
  },
  // ux-port-v2 P1.3：/context 报告组装（skills/memory 每次重扫，~5ms 不缓存）
  contextReport: (expand) => {
    const { used, window } = statusline.contextUsage();
    const { skills, shadowed, entries } = collectSkillsWithStats(process.cwd());
    return buildContextReport({
      used,
      window,
      baseline: statusline.contextBaselineValue(),
      model: currentModel,
      memoryFiles: collectMemoryFiles(process.cwd()),
      skills,
      skillsShadowed: shadowed,
      skillBudget: estimateSkillBudget(entries),
      width: process.stdout.columns ?? 80,
      expand,
    });
  },
  // skill-system P4.3：/skills 只读列表（omc 自读磁盘全量，含隐藏项；TTY → 分组浮层）
  openSkills: () => {
    const entries = collectSkillEntries(process.cwd());
    if (!app) {
      const lines: string[] = [];
      for (const it of buildSkillsOverlayItems(entries)) {
        lines.push(
          it.kind === 'group'
            ? `▍${it.label}`
            : `  ${it.label}${it.hidden ? HIDDEN_MARK : ''}${it.description ? ` — ${it.description}` : ''}`,
        );
      }
      cmdCtx.print(lines.length > 0 ? lines : ['（未发现 skill）']);
      return;
    }
    showSkillsOverlay(app.tui, entries);
  },
  // statusline 阶段：/rename 后 session_name 段即时生效
  refreshSessionName: () => {
    statusline.refreshSessionName();
    app?.refreshStatusline();
  },
  currentModel: () => currentModel,
  // model-variants-and-workflows P1：场景变体（/model:lite /model:reasoning）
  availableModelsRaw: () => session.getAvailableModelsRaw(),
  variantStates: () => {
    const variantMap = readVariantMap();
    const spawned = session.variantEnvAtSpawn;
    return VARIANT_IDS.map((id) => ({
      ...resolveVariant(id, {
        variantMap,
        mainModelId: currentModel,
        relatedModels: lastRawModels.find((m) => m.id === currentModel)?.relatedModels as
          | Record<string, string>
          | undefined,
      }),
      pendingRestart: needsVariantRestart(id, variantMap, spawned),
    }));
  },
  writeVariantModel: (variantId, value) => writeVariant(cliUserSettingsPath(), variantId, value),
  currentTools: () => currentTools,
  // custom-commands P5 T4：/todos（待办快照）与 /tasks（任务列表）
  taskSnapshot: () => app?.bridge.taskSnapshot() ?? [],
  tasks: () => taskRegistry.all(),
  // model-variants-and-workflows P2：/workflows 可用清单（三源自读磁盘，每次刷新）
  workflows: () => collectSavedWorkflows(),
  // custom-commands P5 T5：/mcp 与 /copy
  mcpServers: () => currentMcpServers,
  // mcp-console P1/P2：/mcp 展示配置来源（本会话构造时读定的 `.mcp.json` 合并结果）
  mcpConfig: () => currentMcpConfig,
  // mcp-console P3：/mcp enable|disable 读写 omc 自管禁用集（实时读，反映最新写入）
  mcpDisabled: () => readUserMcpDisabled(),
  setMcpDisabled: (names) => saveUserMcpDisabled(names),
  lastAssistantText: () => lastAssistantText,
  copyToClipboard: (text) => writeClipboardText(text),
  // custom-commands P5 T6：prompt 型内置命令 → 渲染成用户消息 + 命令卡回显
  // （与自定义命令同一条提交路径；模板见 commands/prompt-templates.ts）
  runPromptCommand: (def, args) => {
    const entry: CustomCommandEntry = {
      name: def.name,
      description: def.description,
      scope: 'builtin',
      filePath: `(builtin:${def.cliPromptName})`,
      body: def.template,
      allowedTools: [],
      disableModelInvocation: false,
    };
    const trimmed = args.trim();
    submitRenderedCommand(entry, args, {
      rawText: trimmed ? `/${def.name} ${trimmed}` : `/${def.name}`,
    });
  },
  // model-variants-and-workflows P2 T3/T4：转发执行 workflow（saved 查表，未命中回退内置常量）
  runWorkflow: (name, args) => {
    const entry =
      workflowCommandMap.get(name) ??
      collectSavedWorkflows().find((e) => e.name === name && e.scope === 'builtin');
    if (!entry) {
      infoLines([`${YELLOW}[workflow] 未知工作流：${name}（/workflows 查看可用清单）${RESET}`]);
      return;
    }
    const trimmed = args.trim();
    submitWorkflowCommand(entry, args, { rawText: trimmed ? `/${name} ${trimmed}` : `/${name}` });
  },
  setCurrentModel: (m) => {
    currentModel = m;
    app?.refreshStatusline();
    void refreshContextWindow(); // P4.2：切模型后 window 按新模型重算
  },
  currentMode: () => currentMode,
  setCurrentMode: (m) => {
    // plan-mode P1.1（入口 2/3）：/mode、/plan、浮层选项的统一状态收口 —— 进 plan 记
    // prePlanMode、离开 plan 清它（控制请求由上层的命令侧发出，此处只维护状态与提示行）。
    applyUserPermissionMode(m);
  },
  exit: () => cleanup(0),
};

// ---------- TTY 提交与中断 ----------

/**
 * 渲染型命令的提交路径（custom-commands P3 引入，P5 T6 起自定义命令与 prompt 型
 * 内置命令共用）：渲染（四步管道）→ 命令卡回显（`echo.kind='command'`，含内联 shell
 * 审计）→ `QueuedInput → deliver`（排队 / Alt+↑ / 落盘 / 中断语义全白拿）。
 * 渲染失败：回显用户气泡 + 提示（不静默丢提交）。
 */
function submitRenderedCommand(
  entry: CustomCommandEntry,
  args: string,
  opts: {
    /** 提交原文（`$ARGUMENTS` 卡片回显与草稿恢复用） */
    rawText: string;
    /** 用户气泡文本（默认 = rawText；带图片提交时是压缩后的文本） */
    userText?: string;
    imageLinks?: readonly (string | undefined)[];
  },
): void {
  if (!app) return;
  let built: ReturnType<typeof renderCustomCommand>;
  try {
    built = renderCustomCommand(entry, args, { cwd: process.cwd(), prompt: opts.rawText });
  } catch (e) {
    const userText = opts.userText ?? opts.rawText;
    app.bridge.addUserMessage(userText, { imageLinks: opts.imageLinks });
    logViewEvent(MAIN_VIEW, { kind: 'user', text: userText });
    infoLines([
      `${YELLOW}[/${entry.name}] 渲染失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
    ]);
    return;
  }
  const item: QueuedInput = {
    msg: built.message,
    echo: { kind: 'command', details: built.details },
  };
  if (running) {
    queue.push(item);
    return;
  }
  deliver(item);
}

/**
 * model-variants-and-workflows P2 T3：saved workflow 命令转发 —— 生成「调用 Workflow 工具」
 * 指令，走既有 QueuedInput 通路（排队 / Alt+↑ / 落盘 / 中断）+ 命令卡回显
 * （复用 `CustomCommandDetails`）。纯构造（`buildWorkflowInvocation` 不抛，无内联 shell），
 * 故无需 renderCustomCommand 那套 try/catch。
 */
function submitWorkflowCommand(
  entry: WorkflowEntry,
  args: string,
  opts: {
    rawText: string;
    userText?: string;
    imageLinks?: readonly (string | undefined)[];
  },
): void {
  if (!app) return;
  const built = buildWorkflowInvocation(entry, args, { prompt: opts.rawText });
  const item: QueuedInput = {
    msg: built.message,
    echo: { kind: 'command', details: built.details },
  };
  if (running) {
    queue.push(item);
    return;
  }
  deliver(item);
}

/** 非 TTY / 无卡片的 bash 纯文本形态（打日志用） */
function bashCardPlainText(d: BashCardDetails): string {
  const sigil = d.excluded ? '!!' : '!';
  const status = d.timedOut
    ? '⏱ 超时'
    : d.cancelled
      ? '✗ 已取消'
      : d.exitCode === 0
        ? '✓'
        : `✗ code ${d.exitCode ?? '?'}`;
  const head = `❯ ${sigil} ${d.command}  ${status}${d.excluded ? ' （本地执行，未进入上下文）' : ''}`;
  return [head, d.output || '(无输出)'].join('\n');
}

/**
 * input-interactions P1：`!` / `!!` bash 模式 —— 在**原生 PTY + 用户自己的 shell** 上执行
 * （别名/函数可用、输出带颜色），**不触发模型轮**。
 *
 * 语义对齐 omp（`!` 进下一轮上下文 / `!!` 不进；见 `src/app/bash-mode.ts`）。omc 的 SDK
 * 无「只加历史、不起轮」API，故「进上下文」= 入 `pendingBashContexts`，等 `deliver()`
 * 时拼进下一条发给模型的消息（`!!` 不入缓冲）。
 *
 * 展示复用 pi-tui `BashExecutionComponent`（omp 同款）：原始字节流式喂 vterm 彩色回放；
 * 落盘/重放用净化后的纯文本（颜色不复原，同 omp resume 口径）。
 */
async function runBashMode(parsed: ParsedBashInput): Promise<void> {
  const card = app
    ? beginBashExecution(app.tui as unknown as BashExecutionHost, parsed.command, parsed.excluded)
    : undefined;
  if (card) app?.bridge.addTranscriptComponent(card);
  const viewport = app
    ? bashPtyViewport(app.tui as unknown as Parameters<typeof bashPtyViewport>[0])
    : { cols: 100, rows: 30 };

  const result = await runBashCommand(parsed.command, {
    cwd: process.cwd(),
    cols: viewport.cols,
    rows: viewport.rows,
    onChunk: (chunk) => card?.exec.appendPtyChunk(chunk),
  });

  const outcome = toBashOutcome(result);
  const details = toBashCardDetails(parsed.command, outcome, parsed.excluded);
  if (card) {
    card.exec.setComplete(
      outcome.exitCode ?? undefined,
      outcome.timedOut || outcome.cancelled,
      { output: outcome.output },
    );
  } else {
    process.stdout.write(`${bashCardPlainText(details)}\n`);
  }
  appendLog({ type: 'bash', id: makeEventId(), timestamp: Date.now(), ...details });
  logViewEvent(MAIN_VIEW, { kind: 'bash', details });
  if (!parsed.excluded) pendingBashContexts.push(formatBashContext(parsed.command, outcome));
  bashDebug(
    `RUN excluded=${parsed.excluded ? 1 : 0} exit=${outcome.exitCode ?? 'null'} timedOut=${outcome.timedOut ? 1 : 0} cancelled=${outcome.cancelled ? 1 : 0} out=${outcome.output.length} cmd=${parsed.command}`,
  );
}

/**
 * 把待注入的 bash 上下文拼进一条即将发给模型的消息（input-interactions P1）。
 * 非空即消费（清空缓冲）；纯文本直接前置，含图 UserMessage 前置一个 text block。
 */
function applyPendingBashContext(msg: string | UserMessage): string | UserMessage {
  if (pendingBashContexts.length === 0) return msg;
  const prefix = pendingBashContexts.join('\n\n');
  const n = pendingBashContexts.length;
  pendingBashContexts = [];
  bashDebug(`INJECT n=${n} chars=${prefix.length}`);
  if (typeof msg === 'string') return `${prefix}\n\n${msg}`;
  const content = msg.message.content;
  if (typeof content === 'string') {
    return { ...msg, message: { ...msg.message, content: `${prefix}\n\n${content}` } };
  }
  return {
    ...msg,
    message: { ...msg.message, content: [{ type: 'text', text: `${prefix}\n\n` }, ...content] },
  };
}

/**
 * input-interactions P2：`#` 记忆快捷 —— 把内容追加到用户选定的 memory 文件。
 *
 * 语义对齐 codebuddy（`#` = 记忆快捷方式，bundle 前缀表 `{"#": MEMORY}`），但**不经模型**：
 * codebuddy 构建 `<user-memory-input>` 用户消息交给模型调 `SaveMemory`；omc 直接本地写盘
 * （更快更确定）。格式 = `- <内容>` bullet + `## CodeBuddy Added Memories` section（P2.1 实证，
 * 见 `src/app/memory-append.ts`）。
 *
 * 文件候选 = `collectMemoryFileCandidates(cwd)`：**含未生效项并显式标注**（防写进被遮蔽的
 * AGENTS.md）。写盘**只 append**、以候选集做白名单校验（防任意写）。
 */
function openMemoryShortcut(content: string): void {
  const candidates = collectMemoryFileCandidates(process.cwd());
  const allowed = candidates.map((c) => c.path);
  /**
   * 路径展示（**先判是否在 cwd 下**，再判 home）：
   *   · 项目文件（cwd 子树）→ `./CODEBUDDY.md`（**不露绝对路径**，即便 cwd 在 home 内）
   *   · 全局文件（不在 cwd）→ `~/.codebuddy/CODEBUDDY.md`
   */
  const shortPath = (p: string): string => {
    const rel = relative(process.cwd(), p);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return `./${rel}`;
    const home = homedir();
    if (p === home || p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
    return p;
  };
  const write = (path: string): void => {
    const r = appendMemory(path, content, { allowedPaths: allowed });
    if (!r.ok) {
      infoLines([`${YELLOW}# 写入失败：${r.error}${RESET}`]);
      return;
    }
    if (r.duplicate) {
      infoLines([`${DIM}# 该条目已存在于 ${path}（未重复写入）${RESET}`]);
      return;
    }
    memoryDebug(`WRITE path=${path} created=${r.created ? 1 : 0} chars=${r.appended.length}`);
    infoLines([
      `${GREEN}✓${RESET} 已追加到 ${shortPath(path)}${r.created ? '（新建文件）' : ''} ${DIM}+${r.appended.length} 字符${RESET}`,
      `${DIM}记忆在 CLI 会话启动时加载 → 新会话（/clear 或退出重开）后生效${RESET}`,
    ]);
  };

  if (!app) {
    // 非 TTY：不弹浮层、不写盘，仅列出候选供人工处理
    for (const c of candidates) {
      process.stdout.write(`  ${c.label} ${shortPath(c.path)}${c.active ? '' : '（未生效）'}\n`);
    }
    return;
  }
  showSelectOverlay(
    app.tui,
    {
      title: '# 追加记忆到…',
      // label 较长（`CODEBUDDY.local.md（项目）`）→ 放宽名称列，避免「项目」被截断
      maxPrimaryColumnWidth: 32,
      items: candidates.map((c) => ({
        value: c.path,
        label: c.active ? c.label : `${c.label}（未生效）`,
        description: c.active ? shortPath(c.path) : `${shortPath(c.path)} — 被 ${c.shadowedBy} 遮蔽`,
      })),
      hint: 'Enter 写入 · Esc 取消',
    },
    {
      onPick: (path) => write(path),
      onCancel: () => {},
    },
  );
}

function onSubmit(text: string): void {
  if (!app) return;
  // P2.4：聚焦子代理视图时提交消息 → 先回主视图（视图只读，新消息属于主会话；
  // 对齐 codebuddy「聚焦成员后输入框切换为向该成员发消息」——omc 的 SDK 不支持向子代理
  // 发消息，故降级为「自动返回主会话」）
  returnToMainView();
  // 先收集图片（clearDraft 前 pendingImages/pendingImageLinks 有效），
  // 回显用压缩后的文本 + imageLinks（chip 可点击，M4.1）
  const collected = app.paste.collectSubmission(text);

  // input-interactions P1：`!` / `!!` bash 模式（先于 skill/slash 解析）。命令在本机执行、
  // **不触发模型轮**；`!` 的「命令+输出」攒进待注入缓冲，由下一条发给模型的消息携带
  // （`!!` 不进）。不接受附件（与 omp 同口径），故不看图片。
  const bash = parseBashInput(text);
  bashDebug(`SUBMIT raw=${JSON.stringify(text).slice(0, 80)} bash=${bash ? 1 : 0}`);
  if (bash) {
    if (!bash.command) {
      infoLines([
        `${DIM}用法：! <命令> 本机执行并加入上下文；!! <命令> 仅本机执行（不进上下文）${RESET}`,
      ]);
      return;
    }
    void runBashMode(bash);
    return;
  }

  // input-interactions P2：`#` 记忆快捷（前缀表 `{"#": MEMORY}`，对齐 codebuddy）——先于
  // skill/slash 解析；本地直接写盘、**不触发模型轮**。内容为空（只敲 `#`）→ 给用法提示。
  const mem = parseMemoryInput(text);
  memoryDebug(`SUBMIT raw=${JSON.stringify(text).slice(0, 80)} mem=${mem ? 1 : 0}`);
  if (mem) {
    if (!mem.content) {
      infoLines([`${DIM}用法：# <内容> 追加到记忆文件（项目 / 全局 CODEBUDDY.md 等）${RESET}`]);
      return;
    }
    app.bridge.addUserMessage(collected.text, { imageLinks: collected.imageLinks });
    logViewEvent(MAIN_VIEW, { kind: 'user', text: collected.text });
    openMemoryShortcut(mem.content);
    return;
  }

  // skill-invoke P4.3：skill 调用拦截——必须在 parseSlash 之前（对齐 omp 先判
  // isKnownSkillCommand）。custom-commands P2 放宽命令名支持 `:` 分段后，
  // `skill:` 作为 omc 保留命名空间由 parseSlash 主动排除（registry.ts
  // RESERVED_NAMESPACE_PREFIX），故顺序仍需如此：已知 skill 在此拦下，
  // 未知 skill 返回 undefined → 落回 parseSlash（返回 null）→ 保持字面发给模型
  const skillInv = parseSkillInvocation(text, skillMap);
  if (skillInv) {
    // command-usage P1.3：命中 skill 即计数（键 = 补全条目 name 口径 `skill:<裸名>`）
    recordCommandUsage(`skill:${skillInv.name}`);
    const entry = skillMap.get(skillInv.name)!;
    let built: ReturnType<typeof buildSkillPromptMessage>;
    try {
      built = buildSkillPromptMessage(entry, { args: skillInv.args, prompt: skillInv.prompt });
    } catch (e) {
      infoLines([
        `${YELLOW}[skill:${skillInv.name}] SKILL.md 读取失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
      ]);
      return;
    }
    // 纯文本注入（pending 图片不随附——skill 场景罕见，已知限制）；
    // 走 QueuedInput 通路自动获得排队/Alt+↑/落盘语义
    skillDebug(
      `INVOKE name=${skillInv.name} args=${skillInv.args.replace(/\s+/g, ' ')} lines=${built.details.lineCount} body0=${built.message.split('\n')[2] ?? ''}`,
    );
    const item: QueuedInput = {
      msg: built.message,
      echo: { kind: 'skill', details: built.details, imageLinks: collected.imageLinks },
    };
    if (running) {
      queue.push(item);
      return;
    }
    deliver(item);
    return;
  }

  // 斜杠命令：命中注册表则本地执行，不发给 agent；未命中提示
  // （维持现状：slash 立即回显不排队，生成中也立即本地执行）
  const slash = parseSlash(text);
  if (slash) {
    // custom-commands P3 T3 / P4 T2：registry 未命中 → 查本地自定义命令（`~/.codebuddy/commands/**.md`）。
    // 顺序约束：parseSkillInvocation → parseSlash → registry → customCommandMap
    // （`skill:` 已被 parseSlash 排除，不会串到自定义命令）。
    // 覆盖语义（P4 定案）：**内置优先**（`routeSlashCommand`），对齐 CLI 执行层实证
    // （`executeSlashCommand` 先 `tryExecuteBuiltinCommand` 命中即返回）——内置 21 命令
    // 不可被同名自定义命令劫持。
    const route = routeSlashCommand(
      registry.get(slash.name),
      customCommandMap.get(slash.name),
      workflowCommandMap.get(slash.name),
    );
    // command-usage P1.3：命中注册表 / 自定义 / workflow 才计数（未知命令 route=null 不计）
    if (route) recordCommandUsage(slash.name);
    if (route === 'custom') {
      // custom-commands P3 T3 / P4 T2：自定义命令渲染 → 命令卡 + 投递
      submitRenderedCommand(customCommandMap.get(slash.name)!, slash.args, {
        rawText: text.trim(),
        userText: collected.text,
        imageLinks: collected.imageLinks,
      });
      return;
    }
    if (route === 'workflow') {
      // model-variants-and-workflows P2 T3：saved workflow 命令 → 转发「调用 Workflow 工具」
      submitWorkflowCommand(workflowCommandMap.get(slash.name)!, slash.args, {
        rawText: text.trim(),
        userText: collected.text,
        imageLinks: collected.imageLinks,
      });
      return;
    }
    if (route === 'builtin') {
      const cmd = registry.get(slash.name)!;
      app.bridge.addUserMessage(collected.text, { imageLinks: collected.imageLinks });
      // P2.4：命令回显也进主视图日志（切视图重放时保留用户气泡）
      logViewEvent(MAIN_VIEW, { kind: 'user', text: collected.text });
      // 命令收口补刷状态栏：本地命令（含插件命令如 /user 切账户）可能改动状态栏数据
      // （模型/模式/账户/会话…），但其处理不发起对话轮 → 无 system_init/result 事件兜底，
      // 底栏（缓存式 Text）会停在旧值。故命令返回后（成功/失败均）无条件刷一次。
      void Promise.resolve(cmd.run(cmdCtx, slash.args))
        .catch((e: unknown) => {
          infoLines([
            `${YELLOW}[/${slash.name}] 执行失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
          ]);
        })
        .finally(() => app?.refreshStatusline());
      return;
    }
    app.bridge.addUserMessage(collected.text, { imageLinks: collected.imageLinks });
    logViewEvent(MAIN_VIEW, { kind: 'user', text: collected.text });
    infoLines([`${YELLOW}未知命令：/${slash.name}（/help 查看可用命令）${RESET}`]);
    return;
  }

  // 图片：按提交文本中仍存在的占位符收集，组装 image blocks（图在前文在后）
  let msg: string | UserMessage = collected.text;
  if (collected.images.length > 0) {
    const blocks: UserMessage['message']['content'] = [
      ...collected.images.map(
        (img): ImageContentBlock => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType as ImageMediaType,
            data: img.data,
          },
        }),
      ),
      { type: 'text', text: collected.text },
    ];
    msg = { type: 'user', session_id: '', message: { role: 'user', content: blocks }, parent_tool_use_id: null };
  }
  // omp 式回显时机：生成中入队（回显/落盘延迟到交付）；空闲直发即交付
  const item: QueuedInput = { msg, echo: { text: collected.text, imageLinks: collected.imageLinks } };
  if (running) {
    queue.push(item); // 预输入排队（决策：排队而非禁止）
    return;
  }
  deliver(item);
}

/** 从排队消息提取图片块 → pi-tui ImageContent（P1.3 dequeue 恢复用） */
function extractQueuedImages(msg: string | UserMessage): ImageContent[] {
  if (typeof msg === 'string') return [];
  const content = msg.message.content;
  if (typeof content === 'string') return [];
  const out: ImageContent[] = [];
  for (const block of content) {
    if (block.type === 'image' && block.source.type === 'base64') {
      out.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
    }
  }
  return out;
}

/**
 * P1.3：Alt+↑ 取回队尾进 editor（omp input-controller.ts:1786 #restoreEntriesToEditor
 * 范式，单条版）：图片回 pendingImages（标记按草稿已有图片数移位防串号），
 * 取回文本前置于当前草稿，setCollapsedText 把 [Image #N] 标记折回 chip。
 */
function dequeueToEditor(): void {
  const item = queue.pop();
  if (!item || !app) return;
  const { editor } = app;
  // skill echo 恢复草稿（details.prompt 原位 token），普通 echo 恢复原文
  const text = item.echo ? echoText(item.echo) : typeof item.msg === 'string' ? item.msg : '';
  const images = extractQueuedImages(item.msg);
  let restored = text;
  if (images.length > 0) {
    const offset = editor.pendingImages.length;
    editor.pendingImages.push(...images);
    editor.pendingImageLinks.push(...images.map(() => undefined));
    editor.imageLinks = editor.pendingImageLinks;
    restored = shiftImageMarkers(text, offset);
  }
  const current = editor.getText();
  const combined = [restored, current].filter((t) => t.trim()).join('\n\n');
  editor.setCollapsedText(combined);
}

/**
 * P1.4：中断时丢弃排队消息（2026-10-01 用户拍板：中断意图是「停」，
 * 排队消息自动续发违背预期；omp 的 drainBlocked 门控机制太重不抄）。
 * 同步清空安全：runTurn finally 的续发只在事件循环后续到达，必读到空队列。
 */
function discardQueueOnInterrupt(): void {
  const n = queue.clear();
  if (n > 0) infoLines([`${DIM}[queue] 已丢弃 ${n} 条排队消息${RESET}`]);
}

/** Esc：子代理视图=返回主视图；生成中=中断（挂起权限统一 deny 防悬挂）+ watchdog；空闲无操作（不退出） */
function onEscape(): void {
  // P2.4：聚焦子代理视图时 Esc 优先返回主视图（对齐 codebuddy「空输入框 Esc 返回主会话」）
  if (currentView !== MAIN_VIEW) {
    returnToMainView();
    return;
  }
  if (running) {
    discardQueueOnInterrupt();
    permBridge.denyPending();
    void session.interrupt();
    armAbandonWatchdog();
  }
}

/**
 * 僵尸轮兜底（M4.6）：AskUserQuestion 等场景下 CLI 可能中断后仍不发 result
 * （2026-09-30 真机事故：acquireAnswers 阻塞，interrupt 只标 interrupted 不收口），
 * running 永远 true → Esc/Ctrl-C 全变空操作、/resume 被拒、loader 永转。
 * interrupt 后 10s 仍 running → 关闭旧会话（卡死的 runTurn 随流断开自然收尾）、
 * 按原 sessionId 重建（保上下文），用户可继续对话或直接退出。
 */
let abandonTimer: ReturnType<typeof setTimeout> | null = null;
function armAbandonWatchdog(): void {
  if (abandonTimer) clearTimeout(abandonTimer);
  abandonTimer = setTimeout(() => {
    abandonTimer = null;
    if (!running) return;
    const sid = session.sessionId;
    infoLines([`${YELLOW}[watchdog] 本轮无响应，已强制结束并重建会话（可继续对话或正常退出）${RESET}`]);
    session.close();
    session = newSession(sid);
    sessionEpoch += 1; // P1.3：非用户轮消费者重新绑定新会话
    subscribeCommandsChannel(); // P6：watchdog 重建后重新订阅
  }, 10_000);
}

/**
 * Ctrl-C（P6.7 双击退出 + 首按清空草稿）。
 * - 空闲：有草稿 → **整段清空**（对齐 omp `input-controller.ts` handleCtrlC → clearEditor
 *   → `clearDraft()`；含图片/文本附件 chip），不中断；空输入框不动。
 * - running：中断生成（僵尸轮自救），不碰草稿（中断意图是「停」，非「清输入」）。
 * - 双击退出：以上两种情况都照常武装 —— 1.5s 内再按一次直接退出（对齐 omp 500ms 窗口，
 *   omc 沿用 1.5s）。running 时也生效（M4.6 前 running 分支会先 return 永远到不了双击）。
 */
let lastCtrlC = 0;
/** 测试可观测性：OMC_DEBUG_CTRLC=<path> 时追加 CLEAR/EXIT 行（scripts/smoke-ctrlc-pty.sh 断言用） */
const ctrlcDebugPath = process.env.OMC_DEBUG_CTRLC;
function ctrlcDebug(line: string): void {
  if (!ctrlcDebugPath) return;
  try {
    appendFileSync(ctrlcDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}
function onCtrlC(): void {
  const now = Date.now();
  const double = now - lastCtrlC < 1500;
  lastCtrlC = now;
  if (double) {
    ctrlcDebug('EXIT double-press');
    cleanup(0);
  }
  if (running) {
    discardQueueOnInterrupt();
    permBridge.denyPending();
    void session.interrupt();
    armAbandonWatchdog();
    infoLines([`${DIM}中断中…（再按一次 Ctrl-C 直接退出）${RESET}`]);
    return;
  }
  // 首按清空草稿（对齐 omp）：整段清空，有草稿才清（空输入框行为不变）
  if (app && app.editor.getText().length > 0) {
    app.editor.clearDraft();
    app.tui.requestRender();
    ctrlcDebug('CLEAR draft');
  }
  infoLines([`${DIM}再按一次 Ctrl-C 退出${RESET}`]);
}

// ---------- 崩溃兜底（P6.7）：先恢复终端，再打错误页退出 ----------
function fatal(e: unknown): void {
  try {
    app?.stop();
  } catch {
    // 恢复终端失败也要继续打错误页
  }
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  process.stderr.write(`\n\x1b[31m[oh-my-codebuddy 崩溃]\x1b[0m\n${msg}\n`);
  try {
    session.close();
  } catch {
    // 忽略
  }
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

/** print-mode：无输入时的用法提示（写 stderr，stdout 保持纯净） */
const PRINT_USAGE =
  '用法：omc -p "<问题>" 或 echo "<问题>" | omc -p [--output-format text|json]\n';
/**
 * print-mode P1.2：解析一次性执行的输入。
 *
 * - 位置参数 prompt 优先；
 * - 无 prompt 且 stdin 非 TTY → **姿势 B**（P0 定论 6）`readFileSync(0,'utf8')` 一次读尽
 *   （同步读完后 fd 0 关闭，不留常驻监听 —— 旧「stdin 会挂住事件循环」的真凶是 readline
 *   而非 stdin 本身，P0 定论 6 已推翻旧警告）；
 * - 无 prompt 且 stdin 是 TTY（交互式敲 `omc -p` 却没给输入）→ null（调用方给用法提示）。
 */
function resolvePrintInput(prompt: string): string | null {
  if (prompt) return prompt;
  if (process.stdin.isTTY) return null;
  let text = '';
  try {
    text = readFileSync(0, 'utf8');
  } catch {
    return null; // 无 stdin 可读（如 fd 0 已关闭）
  }
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

// ---------- 主流程 ----------
/**
 * models 子命令专用：等云目录同步落位后再取列表。
 * CLI 首答是捆绑 product.json 的静态目录（SDK 包内那份是国际版 22 模型），
 * 云端目录（env=internal → 国内版端点，域名见 AGENTS.md）由 CloudPreProductProvider
 * 后台同步，实测 ~0.5-2s 落位（2026-10-04 日志：直连 codebuddy 同账号同端点
 * 拿到国内 32 模型，omc 70ms 抢答拿到国际 24）。omc models 答完即退，
 * 不等等就永远吃静态目录。策略：首答触发 connect/同步 → 至少等 1.5s →
 * 轮询至连续两次一致（上限 5s 兜底，防云同步挂起阻塞子命令）。
 */
async function fetchModelsSettled(): Promise<RawLanguageModel[]> {
  let prev = await session.getAvailableModelsRaw();
  const deadline = Date.now() + 5000;
  const minWait = Date.now() + 1500;
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const cur = await session.getAvailableModelsRaw();
    const same = cur.length === prev.length && cur.every((m, i) => m.id === prev[i]?.id);
    if (same && Date.now() >= minWait) return cur;
    if (Date.now() > deadline) return cur;
    prev = cur;
  }
}

// 注：内置子命令（models / plugin）的注册已上移到插件宿主装配处（`const pluginHost` 下方），
// 以便 `omc --help` 在加载插件后统一列出全部子命令（内置 + 插件）。分发逻辑不变。

async function main(): Promise<void> {
  // 插件已在首会话创建前加载（见上方 `await pluginHost.loadAll()`）。

  // P4.3：CLI 子命令分发（在 prompt/一次性处理之前；内置优先，命中即执行并退出）
  const [firstToken, ...subArgs] = argv.positional;
  if (firstToken) {
    const sub = subcommands.get(firstToken);
    if (sub) {
      try {
        // `omc <子命令> help` / `--help` / `-h` → 宿主统一打印详细帮助（不下发 run）
        if (isHelpArg(subArgs[0])) {
          for (const l of subcommandHelpLines(sub)) process.stdout.write(`${l}\n`);
          cleanup(0);
          return;
        }
        await sub.run(
          {
            cwd: process.cwd(),
            print: (ls) => {
              for (const l of ls) process.stdout.write(`${l}\n`);
            },
          },
          subArgs,
        );
        cleanup(0);
      } catch (e) {
        process.stderr.write(`[${firstToken}] ${e instanceof Error ? e.message : String(e)}\n`);
        cleanup(1);
      }
      return;
    }
  }

  const prompt = argv.prompt;
  // 一次性执行判定（P1.2）：显式 -p / 有位置参数 prompt / 非 TTY —— 三者任一。
  // 此处提前求值供 [resume] 提示分流（stdout/stderr）用，实际分支在下方 print-mode 段。
  const printMode = argv.print || !!prompt || !isTTY;

  if (argv.cont && !resumeId) {
    const note = '[resume] 当前目录无历史会话，新开';
    // print 模式 stdout 只放最终答案 → 提示走 stderr
    if (printMode) process.stderr.write(`${note}\n`);
    else process.stdout.write(`${DIM}${note}${RESET}\n`);
  }

  // subagent-visibility P1.3：常驻消费「非用户轮」事件（CLI 自动续话轮 + task_* 状态）。
  // 放在此处 = 覆盖一次性 / 非 TTY / TTY 三条路径；pump 本体仍懒启动（首次 send 才读流，
  // 否则 resume 会被 SDK 误判为「读历史」请求）。
  void pumpIdleEvents();
  // subagent-visibility P2.3：常驻消费「子代理事件」（旁路保留进视图日志，不渲染）。
  void pumpSubagentEvents();
  // subagent-visibility P2.7：Agent 子代理完成探测。**主信号 = CLI 主会话 jsonl 的
  // teammate 完成注入**（`readTeammateReports`：子代理交付才写，确定性）——2026-10-07
  // 会话 01a1168e 实证：旧判据（落盘 settled + 静止 5s）会被「思考间隙」（全配对 +
  // 静止 13s，模型长考）骗到 → 提前 12s 误判完成、真报告被丢。回退判据 settle 提到
  // 20s（`DONE_SETTLE_MS` 注释），只兜「CLI 无注入」边角。
  // 僵尸（`isSubagentZombie`）：工具调用悬空超 5min → `✗` 告警卡。
  // 保活：有未配对 function_call = 在工具里 → 无条件 touch（长命令期间 jsonl 不写也正常）。
  // 3s 轮询；无活跃 Agent 任务时立即返回（零开销）。
  setInterval(() => {
    // P2 修订：先同步 journal（实时进度源）。必须放在下方 Agent 早退之前 —— workflow 任务
    // 不产 Agent 事件，deep-research 跑起来时 omc 侧只有 1 个 local_workflow 任务。
    syncWorkflowJournals();
    // workflow 终态 → 报告回流（一次性；record 完成时才写，故靠轮询重试）
    for (const t of taskRegistry.all()) {
      if (t.type === 'local_workflow' && isTerminalTaskState(t.state)) announceWorkflowDone(t);
    }
    // Workflow Hub 聚焦中 → 按 `lastEventAt` 变化重绘
    if (currentView.startsWith('task:')) {
      const wid = currentView.slice('task:'.length);
      const we = taskRegistry.all().find((t) => t.id === wid);
      if (we && we.type === 'local_workflow' && workflowViewPulses.get(wid) !== we.lastEventAt) {
        workflowViewPulses.set(wid, we.lastEventAt);
        switchWorkflowView(we);
      }
    }
    const agents = taskRegistry.active().filter((t) => t.type === 'Agent');
    if (agents.length === 0) return;
    const cwd = process.cwd();
    const sid = session.sessionId;
    const now = Date.now();
    // 主信号缓存：主会话 jsonl mtime 变了才重读（一次读取供本轮全部 agents）
    try {
      const mt = statSync(mainSessionLogPath(cwd, sid)).mtimeMs;
      if (mt !== mainLogMtime) {
        mainLogMtime = mt;
        mainLogReports = readMainSessionTeammateReports(cwd, sid);
      }
    } catch {
      // 主会话 jsonl 尚未生成（首会话早期）→ 沿用空缓存
    }
    let changed = false;
    for (const t of agents) {
      // ① 确定性完成：teammate 交付注入（报告正文直接做卡片内容）。
      // ⚠️ 必须 timestamp >= startedAt：CLI 对同类型子代理**重用名字**（都叫 general-purpose-1），
      // 主会话 jsonl 里上一个同名报告会让新任务「秒判完成、贴错报告」
      // （2026-10-07 会话 01a116f3 实证：第二个任务 0.6s 被秒杀，贴的是第一个的报告）。
      const rep = mainLogReports.get(t.name);
      if (rep && rep.timestamp >= t.startedAt) {
        if (taskRegistry.markCompleted(t.id, now)) {
          changed = true;
          announceSubagentDone(t, now, rep.text ? rep.text : undefined);
          taskDebug(`DONE id=${t.id} name=@${t.name} via=${rep.system ? 'system-note' : 'report'}`);
        }
        continue;
      }
      const st = subagentStatus(cwd, sid, t.id);
      if (!st.exists) continue;
      if (isSubagentDone(st, now)) {
        // ② 回退完成（CLI 无注入的边角）：无 pending + 静止 > 20s
        if (taskRegistry.markCompleted(t.id, now)) {
          changed = true;
          announceSubagentDone(t, now);
          taskDebug(`DONE id=${t.id} name=@${t.name} via=settle`);
        }
      } else if (isSubagentZombie(st, now)) {
        // ③ 僵尸：工具调用悬空 N 分钟无结果（子代理进程很可能已死/挂死）→ 告警卡 + `✗`
        if (taskRegistry.markFailed(t.id, now)) {
          changed = true;
          announceSubagentZombie(t, now);
          taskDebug(`ZOMBIE id=${t.id} name=@${t.name}`);
        }
      } else if (!st.settled || now - st.mtimeMs < 25_000) {
        // 仍在跑：未配对 function_call = 在工具里（长命令期间 jsonl 静止也保活）；
        // 或记录仍在写 → 刷新活跃时间，免被 stale 误移除
        if (taskRegistry.touch(t.id, now)) changed = true;
      }
      // Agent Hub（CLI 记录视图）聚焦中 → jsonl 有新行即重读重绘（否则视图冻结在聚焦时刻）
      if (currentView === t.id && agentViewMtimes.get(t.id) !== st.mtimeMs) {
        agentViewMtimes.set(t.id, st.mtimeMs);
        const records = readSubagentRecords(cwd, sid, t.id);
        if (records && records.length > 0) {
          app?.switchView(records, `Agent Hub · @${t.name}（CLI 记录 · Esc 返回主视图）`);
        }
      }
    }
    if (changed) refreshTaskPanel();
  }, 3_000);

  // ---------- print-mode / 非 TTY 一次性执行（P1.2 三段判定） ----------
  // 三者任一都走「一次性」：显式 -p / 有位置参数 prompt / 非 TTY（对齐 omp `autoPrint`）。
  // 不装配 pi-tui（app 保持 null → 输出走无 TUI 落点），完事显式退出；绝不进 readline
  // 交互循环（P0 定论 5/6：readline 的 `close→cleanup(0)` 会抢杀 runTurn，且是旧
  // 「stdin 会挂住事件循环」警告的真凶）。
  if (printMode) {
    const input = resolvePrintInput(prompt);
    if (input === null) {
      // 无 prompt 且无 stdin 输入（TTY 交互式启动 `omc -p` / 空管道）→ 用法提示 + 非 0
      process.stderr.write(PRINT_USAGE);
      cleanup(1);
      return;
    }
    const renderer = new PrintRenderer(outputFormat, () => session.sessionId);
    printRenderer = renderer;
    logUserMessage(input); // D7：默认落盘 transcript（与交互会话同链路，--resume 可续）
    await runTurn(input);
    printRenderer = null;
    writePrintEmission(renderer.finish()); // 兜「既无 result 也无 error」的静默失败（P0 定论 2）
    cleanup(renderer.failed ? 1 : 0); // P1.5：成功 0 / 失败非 0
    return;
  }

  // TTY REPL：pi-tui 装配
  // plugin P2：插件已在 main() 入口加载（见上），此处仅确保命令已并入 currentSlashCommands（下方）
  // skill-invoke P2：启动收集 skill 注册表（补全条目 + chip 折叠钩子共用）；
  // P6 热更新原地重填 skillMap
  refillSkillMap(process.cwd(), skillMap);
  lastSkillRefresh = Date.now(); // 启动即新鲜，打开 / 不立刻重扫
  // Shift+Tab 循环权限模式（照抄 codebuddy chat:cycleMode）：算 next → 落 session +
  // 清 always（对齐 /mode 语义）。返回新模式，app 侧据此刷新提示行；状态栏模式段此处更新
  const cyclePermissionMode = (): string => {
    const next = nextPermissionMode(currentMode);
    permBridge.clearAlways();
    // plan-mode P1.1（入口 3）：Shift+Tab 循环到/离开 plan 也要维护 prePlanMode（与 /mode 同一收口）
    applyUserPermissionMode(next);
    void session.setPermissionMode(next).catch((e: unknown) => {
      infoLines([
        `${YELLOW}[mode] 切换失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
      ]);
    });
    return next;
  };
  app = createPiTuiApp({
    cwd: process.cwd(),
    statusline,
    composerShape,
    permissionMode: currentMode,
    onCyclePermissionMode: cyclePermissionMode,
    getModel: () => currentModel,
    getVerbose: () => verbose,
    getToolsExpanded: () => toolsExpanded,
    onToggleToolsExpand: () => (toolsExpanded = !(toolsExpanded ?? false)),
    onToggleToolActivity: () => (toolActivityHidden = !toolActivityHidden),
    getThinkingVisible: () => thinkingVisible,
    // cancel-stops-turn P1.3：拒绝回执分场景 —— plan 取消（仍在 plan）vs 退出计划模式
    getPermissionMode: () => currentMode,
    // todo-hud P1 修订：thinking 显隐由 ctrl+o 直接置位（与工具卡展开同一手势）
    onSetThinkingVisible: (visible) => (thinkingVisible = visible),
    onSubmit,
    onCtrlC,
    onEscape,
    // input-interactions P4：Ctrl+Y 复制最近一条 AI 回复（复用 /copy 同一逻辑/文案）
    onCopyLastReply: () => {
      const outcome = copyLastReply(lastAssistantText, writeClipboardText);
      infoLines([`${outcome.kind === 'fail' ? YELLOW : DIM}${copyLastOutcomeText(outcome)}${RESET}`]);
    },
    onDequeue: dequeueToEditor,
    onFocusTask: focusTaskView,
    // todo-hud P1：贴底待办行 meta 的两段数据（当前工具名 / 本轮增量 tokens）
    getCurrentTool: () => currentToolName,
    getTurnTokens: () => (turnTokens > 0 ? turnTokens : undefined),
    // detail-view P1.3：F2 与会话详情同源（都走 ctx.openDetail，命令/键位一份实现）
    onOpenDetail: () => cmdCtx.openDetail(),
    permBridge,
    historyFile: historyFile(),
    slashCommands: currentSlashCommands(),
    // command-usage P1.3：补全候选的使用次数权重（同文本匹配分时的次级排序）
    getCommandUsage,
    skillFilePath: (n) => skillMap.get(n)?.filePath,
  });
  // P6：装惰性重扫钩子（打开 / 时距上次刷新 >1500ms 则重扫）
  app.setSkillSlashCommands(currentSlashCommands(), refreshSkillsIfStale);
  // P3.4：启动时应用持久化的 vim 配置（setVimMode 幂等，默认关）
  app.setVimMode(vimMode);
  // P6.3：启动欢迎页先于历史重放打印 —— omp 版式欢迎页居顶，
  // resume 的历史接在其后，不会被顶走（决策：欢迎页=启动横幅，非会话内容）
  // 注意：必须 join 成单个 Text 组件——TranscriptContainer 块间插入空行
  // （transcript-container.ts:997），逐行 addChild 会把卡片行距撑开、边框断线
  infoLines([
    renderWelcome({
      version: pkg.version,
      model: currentModel,
      sessions: SessionLog.list(process.cwd()),
      width: process.stdout.columns || 80,
    }).join('\n'),
  ]);
  // plugin P2：已加载插件提示（无插件不打印）
  const loadedPlugins = pluginHost.loadedNames();
  if (loadedPlugins.length > 0) {
    infoLines([
      `${DIM}[plugin] 已加载 ${loadedPlugins.length} 个插件：${loadedPlugins.join(', ')}${RESET}`,
    ]);
  }
  // 状态栏配置里的未知段：**只跳过该段**（不丢弃整块 statusline 配置），这里给一行告警
  const unknownSegments = statusline.unknownSegments();
  if (unknownSegments.length > 0) {
    infoLines([
      `${YELLOW}[statusline] 忽略未知段：${unknownSegments.join(', ')}（内置段或 plugin:<id>；插件未安装/已卸载时请从配置移除）${RESET}`,
    ]);
  }
  replayLog();
  // resume-state P1.1：`--resume <id>` 启动即恢复标题 —— 与 rebuildSession 同一口径
  // （statusline 只从 system_init 拿 id，而 resume 路径不发 system_init）。
  statusline.setSessionId(session.sessionId);
  // P1.2：队列变更 → band 刷新（一次性/非 TTY 分支无 app，onSubmit 才有入队）
  queue.setOnChange(() => app?.updateQueueBand(queue.list()));
  resumeHintOnExit = true; // 退出时打印恢复提示（cleanup → printResumeHint）
  app.start();
  // P6 触发 1：SDK commands 频道订阅（权威热更新；失败内部降级 warning）
  subscribeCommandsChannel();
}

main().catch(fatal);
