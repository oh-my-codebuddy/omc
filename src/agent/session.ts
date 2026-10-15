/**
 * AgentSession：对 SDK Session 的封装，UI 层只面对 UIEvent 流。
 *
 * 要点：
 * - 双源 abort：外部 AbortController + SDK session.interrupt() 双通道
 * - for-await 可能「干净 break」，退出后必须显式检查 signal.aborted，
 *   否则会把中断伪装成空成功
 * - **唯一常驻消费者（pump）**（subagent-visibility P1.3）：见下方 pumpLoop 注释
 */
import {
  unstable_v2_createSession as createSession,
  unstable_v2_resumeSession as resumeSession,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type McpServerConfig,
  type Message,
  type PermissionMode,
  type SessionOptions,
  type StopHookInput,
  type UserMessage,
  type RawLanguageModel,
} from '@tencent-ai/agent-sdk';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { classifyError } from './errors';
import { normalize } from './normalize';
import { EventQueue, WakeSignal } from './event-queue';
import { isPlanFilePath, latestPlanFilePath, readPlanFile, type PlanSnapshot } from './plan';
import type { LaunchPermissionMode, SwitchablePermissionMode } from '../permission/modes';
import { VARIANT_ENV_KEYS, VARIANT_IDS, readVariantMap, variantEnvOverrides } from '../app/model-variants';
import type { GoalState, GoalVerdict } from '../app/goal-state';
import { reduceStopHook } from '../app/goal-state';
import { makeEventId, type GoalUpdateEvent, type PlanUpdateEvent, type ResultEvent, type SubagentEvent, type UIEvent } from './types';

/** 变体 env 白名单（放行穿过 sanitizeHostEnv，见其注释） */
const VARIANT_ENV_WHITELIST = new Set<string>(Object.values(VARIANT_ENV_KEYS));

/** commands 频道通知 handler 类型（双世界规避：从 SDK 构造签名取型，不深路径 import） */
export type CommandsHandler = Parameters<ReturnType<typeof createSession>['subscribeToCommands']>[0];

export interface AgentSessionOptions {
  cwd?: string;
  model?: string;
  /** 启动权限模式（启动集：可切换集 + fullAccess；含 SDK 公开类型漏掉的 auto，见 permission/modes.ts） */
  permissionMode?: LaunchPermissionMode;
  /**
   * -y：跳过权限确认。SDK v2 `SessionOptions` 无此字段（只在 transport/Options 层），
   * 故走 extraArgs 透传 CLI `--dangerously-skip-permissions`；CLI 侧跳过提示、
   * 高危工具仍可能回调 canUseTool。
   */
  skipPermissions?: boolean;
  /** 权限确认回调；缺省时 SDK 会拒绝一切需授权的工具 */
  canUseTool?: CanUseTool;
  /** 恢复既有会话（P6.2）：走 SDK resumeSession，sessionId 沿用且带会话锁 */
  resume?: string;
  /**
   * 追加/覆盖传给 CLI 子进程的 env（叠加在 sanitizeHostEnv 之后，同名键覆盖宿主值）。
   * 切账户（P4.5）注入 CODEBUDDY_API_KEY 用；不传则纯清理宿主污染变量。
   */
  env?: Record<string, string | undefined>;
  /** 透传给 SDK 的额外选项（如 executable） */
  extra?: Partial<SessionOptions>;
  /**
   * MCP server 表（mcp-console P1）：omc 自读 `.mcp.json` 后**显式注入**。
   * 为什么必须显式注入：omc 恒传 `settingSources: []` → CLI 侧 settings scope = none
   * → `.mcp.json` 完全不加载（探针 `scripts/probe-sdk-mcp.ts` 实证）；注入 `mcpServers`
   * 是保住隔离前提下让 MCP 可用的唯一低风险出路。配置在**构造会话（spawn CLI）时读定**
   * → 改配置需重启会话生效。
   */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * 宿主环境收口：SDK spawn CLI 子进程时 `{...process.env, ...options.env}` 全量透传。
 * 当本程序被 codebuddy 宿主（IDE/CLI/本 AI 的 Bash 工具）拉起时，宿主注入的
 * CODEBUDDY_SERVICE_PROXY_URL / CODEBUDDY_SESSION_ID 等会夺走 CLI 控制权，
 * 表现为握手挂起零事件（2026-09-29 实测）。
 * 2026-09-29 晚二分定位：**SERVER__PORT 单独即可致挂**——CLI 见到它会把模型
 * 请求路由到宿主本地服务端口，该路径对子进程挂死（initialize 不需模型故正常）。
 * 策略：除白名单（API Key 类 + 产品环境选择）外剔除所有 CODEBUDDY_* / CLAUDE_* / SERVER__* / GALILEO_*，
 * 以及 tracing 头 TRACEPARENT / BAGGAGE。
 * 参考 codebuddy-api src/session/cli-env.ts 的实测结论。
 *
 * 白名单 CODEBUDDY_INTERNET_ENVIRONMENT（2026-10-04）：它是用户级「国内/国际版」
 * 选择器（internal→国内版端点 16 模型，external/缺省→国际版目录；端点域名见
 * AGENTS.md「内部标识对照」），不是宿主路由变量；误剔后 CLI 按 V3 下发解析环境，账号一旦切到
 * 国际版目录，omc 模型列表与直连 codebuddy（看到 =internal）不一致。
 *
 * 白名单 CODEBUDDY_SMALL_FAST_MODEL / CODEBUDDY_BIG_SLOW_MODEL（2026-10-09，
 * model-variants-and-workflows P1）：场景变体 lite / reasoning 的 env 覆盖层。
 * 变体解析链里 env 是**第 1 优先**，且实测**可穿透 `settingSources: []``（omc 隔离下
 * settings#variantModels 读不到，env 读得到）——这正是 D1-b 让变体在 omc 内生效的通道。
 * 用户 shell 自己 export 时按 CLI「env > settings」语义原样透传（`variantEnvOverrides`
 * 会检测到并让位，不重复注入）。
 */
function sanitizeHostEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(base)) {
    if (
      key === 'CODEBUDDY_API_KEY' ||
      key.startsWith('CODEBUDDY_API_KEY_') ||
      key === 'CODEBUDDY_INTERNET_ENVIRONMENT' ||
      VARIANT_ENV_WHITELIST.has(key)
    ) {
      continue;
    }
    if (
      key.startsWith('CODEBUDDY_') ||
      key.startsWith('CLAUDE_') ||
      key.startsWith('SERVER__') ||
      key.startsWith('GALILEO_') ||
      key === 'TRACEPARENT' ||
      key === 'BAGGAGE' ||
      key === 'CLIENT_INFO_PRODUCT_VERSION'
    ) {
      env[key] = undefined;
    }
  }
  return env;
}

/**
 * 组装传给 SDK 的子进程 env 覆盖：宿主污染清理 → 叠加调用方覆盖（切账户注入 KEY，P4.5）。
 * 导出以便单测（纯函数，base 可注入）。
 */
export function buildChildEnv(
  override?: Record<string, string | undefined>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return { ...sanitizeHostEnv(base), ...override };
}

/**
 * 变体 env 覆盖（model-variants-and-workflows P1，用户拍板的 D1-b 生效通道）：
 * 把 CLI settings#variantModels 翻译成 `CODEBUDDY_SMALL_FAST_MODEL` / `CODEBUDDY_BIG_SLOW_MODEL`。
 * 为什么需要：omc 会话恒 `settingSources: []` → CLI 侧 settings scope = `none` →
 * `variantModels` 加载不到；而 env 是解析链第 1 优先且实测穿透该隔离（探针 case G）。
 * 用户 shell 已设同键时 `variantEnvOverrides` 会让位（对齐 CLI「env > settings」）。
 * 导出以便单测（settingsFile / shellEnv 可注入）。
 */
export function variantEnvFromSettings(
  settingsFile?: string,
  shellEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return variantEnvOverrides(readVariantMap(settingsFile), shellEnv);
}

/**
 * goal 调试口（goal P1）：`OMC_DEBUG_GOAL=<path>` 时把 Stop hook 触发 / 状态 / 判定 / 决策
 * 追加成行。用于排查「hook 是否触发 / 裁判是否失败被静默放行」这类看不出来的事。
 */
const goalDebugPath = process.env.OMC_DEBUG_GOAL;
function goalDebug(line: string): void {
  if (!goalDebugPath) return;
  try {
    appendFileSync(goalDebugPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // 调试通道失败不影响主流程
  }
}

/**
 * 原始流调试口（subagent-visibility P1.5）：`OMC_DEBUG_STREAM=<path>` 时把每条 SDK 消息
 * 压成一行追加（type/subtype/session_id/块形状）。用于排查「子代理内部消息是否混入主流」
 * 这类无法从 UIEvent 看出的事（UIEvent 不带 session_id）。未设置时零开销。
 */
const streamDebugPath = process.env.OMC_DEBUG_STREAM;function streamDebugLine(msg: Message): string {
  const m = msg as unknown as Record<string, unknown>;
  const content = (m.message as { content?: unknown } | undefined)?.content;
  let blocks = '';
  if (Array.isArray(content)) {
    blocks = content
      .map((raw) => {
        const b = raw as Record<string, unknown>;
        if (b.type === 'text') return `text(${String(b.text ?? '').length})`;
        if (b.type === 'thinking') return `thinking(${String(b.thinking ?? '').length})`;
        if (b.type === 'tool_use') return `tool_use(${String(b.name)})`;
        if (b.type === 'tool_result') return `tool_result`;
        return String(b.type);
      })
      .join('+');
  } else if (typeof content === 'string') {
    blocks = `str(${content.length})`;
  }
  return `[${new Date().toISOString()}] ${String(m.type)}${m.subtype ? '/' + String(m.subtype) : ''} session=${String(m.session_id ?? '-')} sessionId=${String(m.sessionId ?? '-')} parent=${String(m.parent_tool_use_id ?? 'null')} ${blocks}`;
}

/**
 * CLI `rewind`（scope='Code'）响应（rewind P1.1）。
 *
 * 字段子集取自 CLI control-signal 协议的 `ControlRewindResponse`
 * （`cli/dist-server/types/node/control-signal/control-signal-protocol.d.ts:483`）。
 * 语义（对齐协议注释）：
 * - `canRewind:true` 且无 `fileRewindError` → 文件全部回退成功；
 * - `canRewind:true` 且有 `fileRewindError` → **部分成功**：历史已回退、文件回退失败；
 * - `canRewind:false` → 前置校验失败（目标非 user 消息 / 无对应 checkpoint / 无会话），
 *   文件与历史均未改动。
 * 本方法只用 `scope:'Code'`，故 `historyRewound` 恒 false。
 */
export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  historyRewound?: boolean;
  fileRewindError?: string;
}

/** pump 待发消息（由 pump 在「安全点」代为调用 SDK send，原因见 pumpLoop 注释） */
interface OutboxItem {
  message: string | UserMessage;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * 子代理内部消息判定（subagent-visibility P1.5）。
 *
 * 2026-10-07 取证（`scripts/repro-subagent-leak.sh` + `OMC_DEBUG_STREAM` 逐条 dump，275 条）：
 * 子代理在**同一个 SDk 流**里回传自己的消息，混进主转录区，两个判据都实测存在：
 * - `parent_tool_use_id` = 发起它的 `Agent` 工具 tool_use id（实测 27 条 stream_event 带它）
 *   → 这些是子代理的流式 delta：混入主 delta 缓冲，flush 时合成出与主文本雷同的
 *   `text_final`（用户截图里那段重复文本的真凶）
 * - `session_id` 是**子会话 id**（实测 2 条 `system/init`，主会话 `…-1571-…` vs 子会话 `…-302f-…`）
 *   → 落到 handleEvent 的 system_init 分支会污染 currentModel / currentTools
 *
 * 主会话消息两个字段都是「parent=null + session=本会话」（同批取证），故判据不会误伤。
 * 导出以便单测（纯函数）。
 */
export function isSubagentMessage(
  msg: { parent_tool_use_id?: string | null; session_id?: string },
  ownSessionId: string,
): boolean {
  const parent = msg.parent_tool_use_id;
  if (typeof parent === 'string' && parent.length > 0) return true;
  const sid = msg.session_id;
  if (typeof sid === 'string' && sid.length > 0 && ownSessionId.length > 0 && sid !== ownSessionId) {
    return true;
  }
  return false;
}

/**
 * 子代理事件的父级 key（subagent-visibility P2.3，纯函数便于单测）。
 *
 * 子代理消息的归属统一用 `parent_tool_use_id`（= 发起它的 `Agent` 工具 id，2026-10-07 实测）；
 * 纯子会话 `system/init`（`parent_tool_use_id` 为空、只有子会话 `session_id`）用
 * `session:<id>` 兜底标记 —— 这类事件在视图重放时是空操作（bridge 不渲染 system_init），
 * 兜底只为让它们不混入主视图。
 */
export function subagentViewKey(
  parentToolUseId: string | null | undefined,
  sessionId: string | undefined,
): string {
  return typeof parentToolUseId === 'string' && parentToolUseId.length > 0
    ? parentToolUseId
    : `session:${String(sessionId ?? 'unknown')}`;
}

/** plan 态跟踪器（plan-approval P1.2，纯数据便于单测） */
export interface PlanTracker {  /** 上次观察到的权限模式（流里 system/init.permissionMode） */
  permissionMode: string | null;
  /** 已认领的计划文件路径（plan 目录的 Write/Edit） */
  planFilePath: string | null;
}

/**
 * 从一条**主会话** SDK 消息推导 plan 态（P1.2 纯函数，导出供单测）。
 *
 * 两个信号源（P1.1 探针实证）：
 * - `system/init.permissionMode` 跳变 → plan 进入/退出（进入 = 'plan'）；模式判据**只信这里**
 *   （`session.getPermissionMode()` 对 CLI 内部切换不同步）。
 * - assistant 的 `Write`/`Edit`/`MultiEdit` 落到 `~/.codebuddy/plans/` → 认领计划文件路径。
 *
 * 返回：新 tracker + 需外发的 `plan_update`（无变化时 event=null）。
 */
export function reducePlanTracker(
  prev: PlanTracker,
  msg: Message,
  /** plan 目录的 home 基准（默认真实 homedir；注入以便单测） */
  home: string = homedir(),
): { tracker: PlanTracker; event: Omit<PlanUpdateEvent, 'id' | 'timestamp'> | null } {
  if (msg.type === 'system' && msg.subtype === 'init') {
    const mode = (msg as unknown as { permissionMode?: string }).permissionMode ?? '';
    if (!mode || mode === prev.permissionMode) return { tracker: prev, event: null };
    const tracker: PlanTracker = { ...prev, permissionMode: mode };
    return {
      tracker,
      event: {
        type: 'plan_update',
        permissionMode: mode,
        active: mode === 'plan',
        ...(tracker.planFilePath ? { planFilePath: tracker.planFilePath } : {}),
      },
    };
  }
  if (msg.type === 'assistant') {
    let planFilePath = prev.planFilePath;
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'Write' && block.name !== 'Edit' && block.name !== 'MultiEdit') continue;
      const fp = (block.input as Record<string, unknown> | undefined)?.file_path;
      if (typeof fp === 'string' && fp !== planFilePath && isPlanFilePath(fp, home)) planFilePath = fp;
    }
    if (planFilePath === prev.planFilePath) return { tracker: prev, event: null };
    const tracker: PlanTracker = { ...prev, planFilePath };
    const mode = tracker.permissionMode ?? 'plan';
    return {
      tracker,
      event: { type: 'plan_update', permissionMode: mode, active: mode === 'plan', planFilePath: planFilePath! },
    };
  }
  return { tracker: prev, event: null };
}

/**
 * `/goal` 裁判回调（goal P1.2 接线点）：读 `StopHookInput`（含 `transcript_path`）+ 当前状态，
 * 返回判定 `GoalVerdict`。真实现见 P1.3（常驻轻量裁判会话）经 `setGoalJudge` 注入；
 * **未注入时 Stop hook 即使激活也放行**（安全默认，防误锁会话）。
 */
export type GoalJudge = (input: StopHookInput, state: GoalState) => Promise<GoalVerdict>;

/** Stop hook 超时（秒，对齐 P0 探针 `timeout:30`；裁判冷启动 ≈5s / 暖态 ≈3s，留足余量） */
const STOP_HOOK_TIMEOUT_S = 30;

/**
 * 在既有 hooks 之上追加**恒定**的 Stop hook（P1.2）。
 * P0 硬约束 1：会话初始化时未注册的事件，运行中 `setHooks` 加不了 → Stop 必须构造即挂，
 * `/goal` 设/清只翻状态标志（见 `onStopHook`）。调用方自带 Stop（`options.extra.hooks`）时并存。
 */
export function withStopHook(
  existing: SessionOptions['hooks'],
  hook: HookCallback,
): SessionOptions['hooks'] {
  return {
    ...(existing ?? {}),
    Stop: [...(existing?.Stop ?? []), { hooks: [hook], timeout: STOP_HOOK_TIMEOUT_S }],
  };
}

export class AgentSession {
  private session: ReturnType<typeof createSession>;
  private abortController: AbortController | null = null;
  private closed = false;
  /**
   * **本会话 spawn 时实际生效的变体 env**（model-variants P1：`envKey → 值`，未生效的键不出现）。
   * 用途 = 让 UI 判断「settings 里的变体值是否已落后于运行中的子进程」（改值需重启）——
   * `AgentSession` 每次重建（/resume、watchdog、对话回退）都会重算，故按实例持有。
   * 取值口径 = 合并后的最终子进程 env（含 shell 透传值），与 CLI 子进程看到的一致。
   */
  readonly variantEnvAtSpawn: Record<string, string>;

  /** 唯一常驻消费者任务（懒启动：首轮 send 之前不读流，否则 resume 会被误判为「读历史」） */
  private pumpTask: Promise<void> | null = null;
  /** pump 已判定流终止（CLI 进程没了）→ 不再重启，避免忙循环 */
  private pumpDead = false;
  /** 用户轮事件 sink（pump 在用户轮期间投这里；轮结束置 null） */
  private turnSink: EventQueue<UIEvent> | null = null;
  /** 非用户轮事件 sink（CLI 自动续话轮 + task_* 状态），常驻不替换、不关闭直到 close() */
  private readonly idleSink = new EventQueue<UIEvent>();
  /**
   * 子代理事件 sink（P2.3）：子代理（`Agent` 工具）在自己会话里产生的事件走此**独立通道**，
   * 附父级工具 id 投递。与 turnSink/idleSink 物理隔离 → 不串主 delta 缓冲、不触发 CLI 自发轮
   * （P1.5 的两个真机 bug 根因）。常驻不关闭直到 close()。UI 侧按 `parentToolUseId` 分桶。
   */
  private readonly subagentSink = new EventQueue<SubagentEvent>();
  /** 待发消息队列 + 唤醒信号（pump 在挂起读时必须让位给 send，否则挂起读会被 reset 变孤儿） */
  private outbox: OutboxItem[] = [];
  private readonly wake = new WakeSignal<'send' | 'close'>();
  /** 被过滤掉的子代理内部消息计数（P1.5；调试口可见，便于冒烟断言与回归观察） */
  private subagentDropped = 0;
  /**
   * plan 态跟踪（plan-approval P1.2）：流里 `system/init.permissionMode` 跳变 +
   * plan 目录的 Write/Edit 捕获。替代已死的 SDK `onPlanModeEnter/Exit` 回调。
   */
  private planTracker: PlanTracker = { permissionMode: null, planFilePath: null };
  /**
   * `/goal` 会话级停止条件状态（goal P1）。只在本实例内存活；`/goal` 设/清只翻此标志，
   * Stop hook 恒注册（见 P0 硬约束 1：运行中 setHooks 加不了新事件）。P1.2 起 hook 回调读它。
   */
  private goalState: GoalState | null = null;
  /**
   * `/goal` 裁判（P1.3 注入真实现）。`null` = 未注入 → Stop hook 即使激活也放行
   * （P1.2 默认安全；接线正确性靠探针注入固定判据验证）。
   */
  private goalJudge: GoalJudge | null = null;

  private constructor(options: AgentSessionOptions) {
    const variantEnv = variantEnvFromSettings();
    const childEnv = buildChildEnv({ ...variantEnv, ...options.env });
    // 未出现在 childEnv（= sanitize 后的增量表）里的键是**从宿主 process.env 继承**的
    // （白名单透传，如用户 shell 自己 export 的变体 env）→ 回退到 process.env 才是真实生效值。
    this.variantEnvAtSpawn = {};
    for (const id of VARIANT_IDS) {
      const key = VARIANT_ENV_KEYS[id];
      const v = childEnv[key] ?? process.env[key];
      if (typeof v === 'string' && v.trim().length > 0) this.variantEnvAtSpawn[key] = v.trim();
    }
    const sdkOptions: SessionOptions = {
      cwd: options.cwd ?? process.cwd(),
      model: options.model,
      // 跨边界强转：SDK 公开类型 PermissionMode 缺 'auto'（运行期控制信号实际接受），
      // 启动集已保证值为 CLI_PROCESS_PERMISSION_MODES 子集，SDK 侧透传字符串本身不校验
      permissionMode: (options.permissionMode ?? 'default') as PermissionMode,
      canUseTool: options.canUseTool,
      includePartialMessages: true,
      settingSources: [],
      // mcp-console P1：显式注入 MCP server（保住 settingSources: [] 隔离，见选项注释）
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      // 变体 env（D1-b，见 variantEnvFromSettings 注释）先铺底，调用方 override（切账户等）居上
      env: childEnv,
      // -y：透传 CLI 原生 flag（布尔 flag 值传 null）
      ...(options.skipPermissions ? { extraArgs: { 'dangerously-skip-permissions': null } } : {}),
      ...options.extra,
      // goal P1.2：Stop hook **恒定注册**（P0 硬约束 1 —— 运行中 setHooks 加不了新事件）。
      // 回调恒在，未激活/暂停时直返 approve（≈0 开销）；`/goal` 只翻 `goalState` 标志。
      hooks: withStopHook(options.extra?.hooks, (input) =>
        this.onStopHook(input as StopHookInput),
      ),
    };
    // v2 SessionImpl 的 resume 是构造参数（options.resume 字段不生效，见 session.js L101）
    this.session = options.resume ? resumeSession(options.resume, sdkOptions) : createSession(sdkOptions);
  }

  static create(options: AgentSessionOptions = {}): AgentSession {
    return new AgentSession(options);
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  /**
   * 发送一条用户消息，返回 UIEvent 异步迭代器。
   * 迭代结束即**本轮**结束（该轮的首个 result / error / 中断）。
   * 接受纯文本或完整 UserMessage（含 image content blocks，P3.7）。
   *
   * P1.3 起事件不再直接来自 SDK 流，而由常驻 pump 投递（原因：SDK 的 `stream()`
   * 遇 result 即 break，且 `send()` 会清空未消费队列——详见 pumpLoop 注释）。
   * 调用不变式：**同一时刻只有一个用户轮在跑**（main.ts 的队列保证）。
   */
  async *send(text: string | UserMessage): AsyncGenerator<UIEvent> {
    if (this.closed) {
      yield {
        id: makeEventId(),
        timestamp: Date.now(),
        type: 'error',
        kind: 'unknown',
        message: 'session already closed',
      };
      return;
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const sink = new EventQueue<UIEvent>();
    this.turnSink = sink;

    try {
      await this.dispatchSend(text);
      for await (const ev of sink) {
        if (ev.type === 'result') {
          // 本地已 abort 时 SDK 可能回报空 success，须改判为中断
          yield signal.aborted ? interruptedResult() : ev;
          return;
        }
        yield ev;
      }
      // sink 结束但没 result：pump 异常退出（SDK 流终止）
      if (signal.aborted) {
        yield interruptedResult();
      }
    } catch (e) {
      const err = classifyError(e);
      if (err.kind === 'abort') {
        yield interruptedResult();
      } else {
        yield err;
      }
    } finally {
      if (this.turnSink === sink) this.turnSink = null;
      sink.end();
      this.abortController = null;
    }
  }

  /**
   * 非用户轮事件流（P1.3）：CLI 在自己的一轮 result 之后仍可能发消息——
   * - CLI 收到后台任务完成通知后**自动续话**（新 assistant 文本 + 第二个 result）
   * - `task_*` 状态（started/progress/updated/notification）
   * 消费方在 main.ts 常驻等待（pumpIdleEvents）；未消费时事件在队列里排队，
   * 不会像直接读 SDK 流那样被下一轮 `send()` 丢弃。
   */
  idleEvents(): AsyncIterable<UIEvent> {
    return this.idleSink;
  }

  /**
   * 子代理事件流（P2.3）：独立于主对话的旁路通道，事件带父级 `Agent` 工具 id。
   * 消费方在 main.ts 常驻等待，按 `parentToolUseId` 分桶存「视图事件日志」，
   * 供 P2.4 的焦点导航切换视图时重放。未消费时在队列里排队（同 idleSink 语义）。
   */
  subagentEvents(): AsyncIterable<SubagentEvent> {
    return this.subagentSink;
  }

  /** 把用户消息排队交给 pump 发送，等 pump 真正写出后再返回（保证后续事件不早于消息） */
  private dispatchSend(message: string | UserMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.outbox.push({ message, resolve, reject });
      // 新的一轮 = 新的机会：上一轮若因传输层错误退出过 pump，这里重新启动
      // （SDK 的 send() 会 reset 掉粘性错误状态；CLI 真死则新 reader 立刻 done 再退出）
      this.pumpDead = false;
      this.startPump();
      this.wake.fire('send');
    });
  }

  private startPump(): void {
    if (this.pumpTask || this.pumpDead || this.closed) return;
    this.pumpTask = this.pumpLoop().finally(() => {
      this.pumpTask = null;
    });
  }

  /**
   * 唯一常驻消费者。
   *
   * 为什么必须「唯一」且「常驻」（2026-10-06 源码 + 探针实证）：
   * - SDK transport 的消息流是**单消费者队列**（`lib/utils/stream.js:17-23` 只能迭代一次，
   *   `enqueue` 只resolve 一个挂起读）→ 并发两个读者会各拿一半消息；
   * - `session.stream()` 生成器**遇 result 即 break**，无法「在同一次迭代里继续读」；
   * - `session.send()` 每次都 `messageIterator = null` + `discardPendingMessages()`（清队列）
   *   → 未被消费的迟到消息（后台完成通知）在下一轮 send 时被**物理丢弃**。
   * 所以：pump 把 SDK 流读到自己的 EventQueue 里再分派，轮边界（首个 result）只影响
   * **投递目标**，不影响 pump 继续读——`task_*` 与自动续话轮因此不再丢失。
   *
   * 挂起读的让位约定：`send()` 的 reset 会让「正在挂起的读」的 promise 永久悬空
   * （reset 只清 readResolve，不 resolve 它）。故 pump 在发消息前**丢弃当前 reader**
   * 再调用 `session.send()`；被丢弃的挂起 promise 由随后的 reset 一并作废（无副作用）。
   */
  private async pumpLoop(): Promise<void> {
    let reader: AsyncIterator<Message> | null = null;
    /** 当前 reader 是否产出过消息（区分「轮边界后生成器自然结束」与「传输终止」） */
    let readerProduced = false;
    while (!this.closed) {
      // A) 有待发消息：先让位（丢弃挂起读）再发，见上方让位约定
      const pending = this.outbox.shift();
      if (pending) {
        reader = null;
        readerProduced = false;
        try {
          await this.session.send(pending.message);
          pending.resolve();
        } catch (e) {
          pending.reject(e);
        }
        continue;
      }

      // B) 读一条消息（与「有待发/关闭」信号赛跑，以便随时让位）
      if (!reader) reader = this.session.stream()[Symbol.asyncIterator]() as AsyncIterator<Message>;
      let raced: { msg: IteratorResult<Message, void> } | { signal: 'send' | 'close' };
      try {
        raced = await Promise.race([
          reader.next().then((msg) => ({ msg })),
          this.wake.wait().then((signal) => ({ signal })),
        ]);
      } catch (e) {
        // 传输层异常（ExecutionError / 进程错误）→ 结束当前轮并退出 pump；
        // 下一轮 send() 会重新启动（SDK 的 send 会 reset 掉粘性错误状态）
        this.pumpDead = true;
        const err = classifyError(e);
        const ev = err.kind === 'abort' ? interruptedResult() : err;
        const sink = this.turnSink;
        if (sink) {
          this.turnSink = null;
          sink.push(ev);
          sink.end();
        } else {
          this.idleSink.push(ev);
        }
        return;
      }
      if ('signal' in raced) {
        if (raced.signal === 'close') return;
        continue; // 回到 A 处理待发消息
      }

      if (raced.msg.done) {
        // `session.stream()` 是**每轮一个**的生成器：遇 result 即 break（轮边界）——
        // 此时必须换新 reader 继续读（reader 换新不会重建 messageIterator，故不丢消息）。
        // 但若这个 reader 一条消息都没产出就结束，说明传输已终止（CLI 进程没了）。
        if (!readerProduced) {
          this.pumpDead = true;
          const sink = this.turnSink;
          if (sink) {
            this.turnSink = null;
            sink.end();
          }
          return;
        }
        reader = null;
        readerProduced = false;
        continue;
      }
      readerProduced = true;
      this.dispatchMessage(raced.msg.value);
    }
  }

  /** 消息分派：用户轮内 → turnSink；否则 → idleSink（result 作为轮边界结束当前 sink） */
  private dispatchMessage(msg: Message): void {
    const raw = msg as unknown as { parent_tool_use_id?: string | null; session_id?: string };
    // P2.3：子代理消息（自己的流式 delta / 子会话消息）**不再丢弃** —— 改走独立通道，
    // normalize 后附父级工具 id 投 `subagentSink`（与 turnSink/idleSink 物理隔离）。
    // 隔离是 P1.5 两个真机 bug 的根治手段，此处保留隔离、只把「丢弃」换成「旁路保留」，
    // 故主转录区不大会回流子代理内容、也不触发 CLI 自发轮。
    if (isSubagentMessage(raw, this.sessionId)) {
      this.subagentDropped += 1;
      // 父级 `Agent` 工具 id：优先 parent_tool_use_id（子代理流式 delta 实测带它）；
      // 纯子会话 init（parent=null）用 `session:<id>` 兜底标记（视图重放时是空操作）。
      const parentToolUseId = subagentViewKey(raw.parent_tool_use_id, raw.session_id);
      for (const ev of normalize(msg)) {
        this.subagentSink.push({ ...ev, parentToolUseId });
      }
      if (streamDebugPath) {
        try {
          appendFileSync(
            streamDebugPath,
            `[${new Date().toISOString()}] SUBAGENT routed=${this.subagentDropped} parent=${String(raw.parent_tool_use_id ?? 'null')} session=${String(raw.session_id ?? '-')}\n`,
          );
        } catch {
          // 调试通道失败不影响主流程
        }
      }
      return;
    }
    if (streamDebugPath) {
      try {
        appendFileSync(streamDebugPath, `${streamDebugLine(msg)}\n`);
      } catch {
        // 调试通道失败不影响主流程
      }
    }
    const events = normalize(msg);
    // plan-approval P1.2：plan 态跟踪（流信号，替代已死的 SDK 回调）
    const planEv = this.trackPlan(msg);
    if (planEv) events.push(planEv);
    for (const ev of events) {
      if (this.turnSink) this.turnSink.push(ev);
      else this.idleSink.push(ev);
    }
    if (msg.type === 'result') {
      const sink = this.turnSink;
      if (sink) {
        this.turnSink = null;
        sink.end();
      }
    }
  }

  /**
   * plan 态跟踪（plan-approval P1.2）：委托纯函数 `reducePlanTracker` 更新状态，
   * 有变化则产出 `plan_update` 事件（补 id/timestamp）。详见该函数注释。
   */
  private trackPlan(msg: Message): PlanUpdateEvent | null {
    const { tracker, event } = reducePlanTracker(this.planTracker, msg);
    this.planTracker = tracker;
    return event ? { ...event, id: makeEventId(), timestamp: Date.now() } : null;
  }

  /** 本次会话认领的计划文件路径（P1.2；未捕获为 null） */
  get currentPlanFilePath(): string | null {
    return this.planTracker.planFilePath;
  }

  /**
   * 计划快照（P1.2）：路径优先取**会话捕获**的计划文件，兜底取 `~/.codebuddy/plans/`
   * 目录最新 `.md`；随后读全文。供权限桥在 `ExitPlanMode` 审批时展示（Plan 内容不随
   * `canUseTool` 入参下发 —— 探针实测 input 恒 `{}`）。
   */
  planSnapshot(): PlanSnapshot {
    const path = this.planTracker.planFilePath ?? latestPlanFilePath();
    if (!path) return {};
    return { planFilePath: path, content: readPlanFile(path) };
  }

  /** 中断当前生成（双通道：本地 abort + SDK interrupt） */
  async interrupt(): Promise<void> {
    this.abortController?.abort();
    try {
      await this.session.interrupt();
    } catch {
      // interrupt 失败不致命（可能当前没有在跑的任务）
    }
  }

  async setModel(model: string): Promise<void> {
    await this.session.setModel(model);
  }

  async setPermissionMode(mode: SwitchablePermissionMode): Promise<void> {
    // 跨边界强转：同上，SDK 公开类型漏 'auto'，但 set_permission_mode 控制信号接受它
    await this.session.setPermissionMode(mode as PermissionMode);
  }

  /** 当前 goal 状态（`/goal` 显示用；无 → null） */
  getGoal(): GoalState | null {
    return this.goalState;
  }

  /**
   * 写入/清除 goal 状态（`/goal` 命令用）。**只翻标志**，不碰 hooks（P0 硬约束 1）——
   * Stop hook 在会话构造时恒定注册（P1.2），回调按需读 `getGoal()` 判断是否判定。
   */
  setGoalState(state: GoalState | null): void {
    this.goalState = state;
  }

  /** 注入 `/goal` 裁判（P1.3；main 侧在会话构建后调用）。传 null 撤销 → 激活也放行。 */
  setGoalJudge(judge: GoalJudge | null): void {
    this.goalJudge = judge;
  }

  /**
   * Stop hook 回调（goal P1.2）：把当前状态 + 裁判判定交给纯函数 `reduceStopHook`，
   * 再翻译成 SDK `HookJSONOutput`。
   *
   * 时序要点（P0 硬约束 2）：**判 ok 后不得在回调内退会话** —— 此处只 `approve`，
   * 退出由消费方在本轮 `result` 到达后再做。裁判异常按「无结论」放行，不锁死会话。
   */
  private async onStopHook(input: StopHookInput): Promise<HookJSONOutput> {
    const state = this.goalState;
    goalDebug(
      `stop hook: goal=${state ? `"${state.condition.slice(0, 40)}" paused=${state.paused} turn=${state.turnCount}` : 'none'} transcript=${input.transcript_path}`,
    );
    let verdict: GoalVerdict | null = null;
    if (state && !state.paused && this.goalJudge) {
      try {
        verdict = await this.goalJudge(input, state);
      } catch (e) {
        goalDebug(`judge error: ${e instanceof Error ? e.message : String(e)}`);
        verdict = null;
      }
    }
    const outcome = reduceStopHook(state, verdict, { now: Date.now() });
    this.goalState = outcome.state;
    goalDebug(
      `decision=${outcome.decision} verdict=${JSON.stringify(verdict)} notice=${JSON.stringify(outcome.notice ?? null)}`,
    );
    // P1.4：进度 / 达标 / 熔断回执（续跑在**同一轮内**，不能靠 result 计数 → 事件驱动 UI）
    if (state && outcome.notice) {
      this.emitGoalEvent(
        'halted',
        state.condition,
        outcome.state?.turnCount ?? state.turnCount,
        outcome.notice.message,
      );
    } else if (state && outcome.decision === 'block') {
      this.emitGoalEvent(
        'block',
        state.condition,
        outcome.state?.turnCount ?? state.turnCount,
        outcome.reason ?? '',
      );
    } else if (state && verdict?.ok) {
      this.emitGoalEvent(
        'satisfied',
        state.condition,
        state.turnCount,
        verdict.reason,
        state.exitOnMet,
      );
    }
    return outcome.decision === 'block'
      ? { decision: 'block', reason: outcome.reason }
      : { decision: 'approve' };
  }

  /** 投递 `/goal` 事件到当前轮（续跑在用户轮内 → turnSink；否则 idle 兜底） */
  private emitGoalEvent(
    kind: 'block' | 'satisfied' | 'halted',
    condition: string,
    turnCount: number,
    reason: string,
    exitOnMet = false,
  ): void {
    const ev: GoalUpdateEvent = {
      id: makeEventId(),
      timestamp: Date.now(),
      type: 'goal_update',
      kind,
      condition,
      turnCount,
      reason,
      exitOnMet,
    };
    if (this.turnSink) this.turnSink.push(ev);
    else this.idleSink.push(ev);
  }

  /**
   * 文件回退（rewind P1.1）：把工作区文件恢复到 `<messageId>` 那条 user 消息**之前**的状态。
   *
   * 机制（2026-10-08 P0 探针实证）：CLI 在 SDK stdio 下暴露 `rewind` 控制请求（`scope:'Code'`），
   * 但 SDK **公开 `Session` 接口没有对应方法** —— 走 SDK 通用通道
   * `transport().sendControlRequest(...)`（`lib/transport/index.d.ts:64`，其
   * `ControlRequestPayload` 联合已含 `ControlRewindRequest`）。
   *
   * ⚠️ **只用 `scope:'Code'`**：`scope:'Conversation'` / 默认 `'CodeAndConversation'` 在当前
   * CLI 下**语义错误**（活会话内把历史**清空**，且不持久）—— 对话回退一律走
   * `resumeAt` + 重启会话（见 `AgentSessionOptions.resumeAt`）。
   *
   * 参数 `dryRun=true` 只算预览（`filesChanged/insertions/deletions`），不改磁盘、不动历史。
   * 边界（对齐 codebuddy）：bash 类改动不被 checkpoint 跟踪；无文件改动的轮次无锚点。
   */
  async rewindFiles(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    // 跨边界强转：`transport()` 是 SDK `SessionImpl` 的**私有**方法（AGENTS.md 已登记为
    // CLI/SDK 耦合点）；它负责 connect+initialize 后再返回 transport，故必须经它而
    // 不是直接摸 `_transport`（后者可能尚未初始化）。
    const internal = this.session as unknown as {
      transport: () => Promise<{
        sendControlRequest: <T>(payload: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
      }>;
    };
    const t = await internal.transport();
    return t.sendControlRequest<RewindResult>(
      {
        subtype: 'rewind',
        user_message_id: userMessageId,
        scope: 'Code',
        dry_run: dryRun,
      },
      60_000,
    );
  }

  /**
   * skill-invoke P6.1：commands 频道订阅（热更新触发 1，权威通道）。
   * 订阅即 spawn/connect CLI 并立即推一次全量命令；标注 experimental，
   * 老版本 CLI 可能拒绝 —— 调用方须 catch 并降级（main.ts 打开 `/` 惰性重扫兜底）。
   * 通知只当「有变更」信号用：AvailableCommand 无 filePath，回调里走本地重扫。
   * handler 类型从构造签名取，避开主入口 d.ts vs src TS 双世界。
   */
  async subscribeCommands(handler: CommandsHandler): Promise<void> {
    await this.session.subscribeToCommands(handler);
  }

  unsubscribeCommands(handler: CommandsHandler): void {
    this.session.unsubscribeFromCommands(handler);
  }

  /** 原始模型列表（models 子命令用）：contextWindow / reasoning.supportedEfforts /
   *  supportsImages 等完整字段只在 raw 格式上有（简化格式没有） */
  async getAvailableModelsRaw(): Promise<RawLanguageModel[]> {
    await this.session.connect();
    return this.session.getAvailableModelsRaw();
  }

  /** 可用模型列表（需 CLI 已连接；P5 /model 用，调用前先 connect）。
   *  ux-port P4.1 起优先走 raw 格式以携带 contextWindow.defaultLength；
   *  CLI 不支持 raw 控制请求时退化到简化格式（contextWindow 缺省）。 */
  async getAvailableModels(): Promise<
    Array<{ modelId: string; name: string; description?: string; contextWindow?: number }>
  > {
    await this.session.connect();
    try {
      const raw = await this.session.getAvailableModelsRaw();
      return raw.map((m) => ({
        modelId: m.id,
        name: m.name ?? m.id,
        description: m.descriptionZh ?? m.descriptionEn,
        // contextWindow 字段 CLI 实测全空（2026-10-01，20 模型皆然）；
        // maxInputTokens 即上下文窗口（hy3=192000），逐级回退
        contextWindow: m.contextWindow?.defaultLength ?? m.maxInputTokens ?? m.maxAllowedSize,
      }));
    } catch {
      return this.session.getAvailableModels();
    }
  }

  close(): void {
    this.closed = true;
    // 唤醒挂起的 pump（让位关闭），并终结两侧 sink 让消费循环退出
    this.wake.fire('close');
    // 未发出的消息：直接兑现（否则 send() 的 dispatchSend await 永远悬挂）
    for (const item of this.outbox.splice(0)) item.resolve();
    if (this.turnSink) {
      this.turnSink.end();
      this.turnSink = null;
    }
    this.idleSink.end();
    this.subagentSink.end();
    this.session.close();
  }
}

function interruptedResult(): ResultEvent {
  return {
    id: makeEventId(),
    timestamp: Date.now(),
    type: 'result',
    success: false,
    interrupted: true,
  };
}
