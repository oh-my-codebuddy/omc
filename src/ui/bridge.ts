/**
 * EventBridge（M1.2）：UIEvent 流 → pi-tui chat 组件树的桥接累积器。
 *
 * 设计见 docs/plan/pi-tui/m1-skeleton.md「核心设计」表：
 * - text/thinking delta 累积进伪 AssistantMessage POJO，喂 AssistantMessageComponent
 * - tool_start 定稿当前 assistant 块并挂 ToolExecutionComponent
 * - tool_result 定向更新卡片；孤立 result 落 dim 行
 * - text_final / result 定稿；result 兜底 seal 中断残留工具卡
 * - status 连续更新最后一行；error 红色行
 */
import { theme } from '@oh-my-pi/pi-tui';
import { getMarkdownTheme } from '@oh-my-pi/pi-tui';
import { AssistantMessageComponent } from '@oh-my-pi/pi-tui/chat/assistant-message.js';
import type { CustomMessage, SkillPromptDetails } from '@oh-my-pi/pi-tui/chat/messages.js';
import { SkillMessageComponent } from '@oh-my-pi/pi-tui/chat/skill-message.js';
import { ToolExecutionComponent, type ToolExecutionUi } from '@oh-my-pi/pi-tui/chat/tool-execution.js';
import { UserMessageComponent } from '@oh-my-pi/pi-tui/chat/user-message.js';
import type { TranscriptContainer } from '@oh-my-pi/pi-tui/chrome/transcript-container.js';
import { Box } from '@oh-my-pi/pi-tui/components/box';
import { Markdown } from '@oh-my-pi/pi-tui/components/markdown';
import { Text } from '@oh-my-pi/pi-tui';
import type { AssistantMessage } from '@oh-my-pi/pi-ai';
import type { ToolDiff, ToolResult, UIEvent, TextFinal, ToolStart } from '../agent/types';
import { COMPACT_SUMMARY_MARKER } from '../agent/normalize';
import { deniedToolKind, parseDeniedTools } from '../agent/errors';
import { isPlanFilePath, readPlanFile } from '../agent/plan';
import { isTaskListTool, parseCreatedId, parseUpdateArgs, TaskStore } from '../app/task-list';
import type { TaskItem } from '../app/task-list';
import { CompactSummaryCard, stripCompactSummaryWrapper } from './compact-summary-card';
import { CommandMessageCard } from './command-message-card';
import { DiffCard } from './diff-card';
import { PlanMarkdownCard } from './plan-markdown-card';
import { SkillCallCard } from './skill-call-card';
import { skillInvocation } from '../permission/bridge';
import { formatGoalUpdate } from '../app/goal-state';
import type { CustomCommandDetails } from '../app/command-invoke';
import { appendFileSync } from 'node:fs';

/** 测试可观测性：OMC_DEBUG_FOLD=<path> 时追加 FOLD/ACT 事件行
 * （OMC_DEBUG_QUEUE 同款，scripts/smoke-fold-pty.sh 断言用） */
const foldDebugPath = process.env.OMC_DEBUG_FOLD;

export function foldDebug(line: string): void {
  if (!foldDebugPath) return;
  try {
    appendFileSync(foldDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/** 测试可观测性：OMC_DEBUG_SUGGEST=<path> 时追加 SET/TAB/ENTER 事件行
 *（prompt-suggestion 阶段，scripts/smoke-suggest-pty.sh 断言用） */
const suggestDebugPath = process.env.OMC_DEBUG_SUGGEST;

export function suggestDebug(line: string): void {
  if (!suggestDebugPath) return;
  try {
    appendFileSync(suggestDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

export interface BridgeDeps {
  /** TUI 实例（实现 ToolExecutionUi 三方法 + 30fps 节流重绘）。
   * imageBudget 除外：主入口 d.ts 与 src TS 双世界同名类结构不兼容（私有字段），
   * TUI 直接赋值 ToolExecutionUi 会炸；组件侧该字段 optional，缺省可赋值。 */
  ui: Omit<ToolExecutionUi, 'imageBudget'> & { requestRender(): void };
  container: TranscriptContainer;
  cwd: string;
  /** 伪消息 model 字段（system_init 后更新） */
  getModel: () => string;
  /** verbose：新工具卡默认展开（/verbose 命令切换） */
  getVerbose?: () => boolean;
  /** ux-port P2.2 / tool-render P1：ctrl+o 全局展开位（会话内运行期状态，app 层维护）。
   *  undefined = 用户尚未操作过（新卡用自身默认：原生工具卡折叠、DiffCard 展开） */
  getToolsExpanded?: () => boolean | undefined;
  /** ux-port-v2 P3：终端视口行数（摘要卡展开限高按视口动态计算，缺省落固定 24 行） */
  getViewportRows?: () => number;
  /** ux-port-v2 P4：ctrl+t thinking 显示位（会话运行期；新组件初始化用，缺省=false=折叠） */
  getThinkingVisible?: () => boolean;
  /**
   * todo-hud P1（D8）：待办快照变化回调 —— 每次 `Task*` 结果（含 reset 清空）推当前快照，
   * 由 app 侧渲染**贴底常驻行**。**仅在真变化时**回调（沿 TaskStore.apply* 的返回值判定）。
   */
  onTodoChange?: (items: TaskItem[]) => void;
  /**
   * cancel-stops-turn P1.3：当前权限模式读取位（`'plan'` = 仍在计划模式）。
   * 用于区分 plan 拒绝的**两条回执措辞**（取消/留在 plan vs 已退出 plan）——
   * CLI 合成的拒绝回执只给工具名，场景只能靠模式推断（退出时 `exitPlanMode()` 已同步改值）。
   * 缺省视为非 plan。
   */
  getPermissionMode?: () => string;
}

type AssistantContent = AssistantMessage['content'];

/** 工具卡特化联合（原生卡 / DiffCard / 模型侧 SkillCallCard），鸭子面同口径 */
type ToolCard = ToolExecutionComponent | DiffCard | SkillCallCard;

/** 伪 AssistantMessage 工厂：api/provider 伪造无类型障碍（catalog/types.ts:25/138） */
function makeAssistantMessage(content: AssistantContent, model: string): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic',
    provider: 'codebuddy',
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** tool_start 的 detail 是截断 JSON 字符串，尽量还原 args 对象喂卡片 */
function parseArgs(detail: string | undefined, summary: string): unknown {
  if (detail) {
    try {
      return JSON.parse(detail);
    } catch {
      // 截断导致非法 JSON：落 summary
    }
  }
  return { summary };
}

/** 同上，但保证返回对象（Task 状态机读入参字段用） */
function parseArgsObject(detail: string | undefined, summary: string): Record<string, unknown> {
  const v = parseArgs(detail, summary);
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * ux-port P2.1：鸭子类型批量调用（omp isExpandable 范式，input-controller.ts:114）。
 * 跨边界禁 instanceof（双世界，AGENTS.md）——只认「对象上有同名函数」。
 * 返回实际调用的组件数（测试断言用）。
 */
export function duckCallBool(children: readonly unknown[], method: string, value: boolean): number {
  let called = 0;
  for (const child of children) {
    const fn = (child as Record<string, unknown> | null | undefined)?.[method];
    if (typeof fn === 'function') {
      (fn as (this: unknown, v: boolean) => void).call(child, value);
      called++;
    }
  }
  return called;
}

export class EventBridge {
  #deps: BridgeDeps;
  /** 当前活动 assistant 组件（null = 无，下个 delta 新建） */
  #active: AssistantMessageComponent | null = null;
  #textBuf = '';
  #thinkingBuf = '';
  /** 工具卡登记表（普通卡 / diff 特化卡 / Skill 卡，鸭子面同口径） */
  #tools = new Map<string, ToolCard>();
  /**
   * 「下一张工具卡直接封口」（permission-surface P2.4）：拒绝回执 `permission_denied`
   * 与 `tool_start` 的到达顺序不稳定 → 回执先到时用它兜住随后到来的卡。
   * 用户发下一条消息时清零（那时拒绝轮早已结束，不会误伤新卡）。
   */
  #sealNextToolStart = false;
  /** 本轮**已 start、还没有 result** 的工具调用 id（拒绝回执要拿它补「已拒绝」结果） */
  #unresolved = new Set<string>();
  /** 连续 status 复用最后一行（非追加） */
  #lastStatus: Text | null = null;
  /**
   * ux-port-v2 P3：compact 摘要窗口（compact_boundary 已见、summary 未到的区间；
   * 或文本前缀兜底——SDK 0.3.267 manual /compact 不发 boundary，summary 只能靠
   * `<conversation_history_summary>` 前缀识别，2026-10-02 探针实证）。
   * 窗口内 delta 只缓冲不建组件，text_final 渲染为可折叠摘要卡片（omp
   * CompactionSummaryMessageComponent 分隔条样式，ctrl+o 展开），result 兜底清窗。
   * byPrefix=true 表示前缀兜底窗：缓冲分叉（确认不是摘要）时须释放回正常路径。
   */
  #pendingCompactSummary: {
    trigger?: 'manual' | 'auto';
    preTokens?: number;
    byPrefix?: boolean;
  } | null = null;

  /**
   * tool-render P2：待办 / 任务列表状态机与「start 已见、result 未到」的调用暂存。
   *
   * 为什么状态在 bridge 而非 normalize：`TaskCreate` 的 id **只在 result 文本**里
   * （P2.0 实证），必须跨消息按 `toolUseId` 配对，而 normalize 是逐消息纯函数；
   * bridge 本就同时消费 tool_start / tool_result 且已按 id 建表。
   * resume 重放免适配：落盘记录就是 tool_start/tool_result（均带 toolUseId），
   * 按同序回放即自动重建。
   */
  #taskStore = new TaskStore();
  #pendingTaskCalls = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  /**
   * plan-approval P2.1：计划文件写入暂存。start 期**不建 diff 卡**（计划不该以 `+/-`
   * 呈现），result 期读盘用 PlanMarkdownCard 落 markdown 计划卡（Task* 同款暂存范式）。
   */
  #pendingPlanWrites = new Map<string, { toolName: string; input: Record<string, unknown>; filePath: string }>();

  /** 计划卡正文限高（视口感知，同 DiffCard 口径） */
  #planCardMaxRows(): number | (() => number) | undefined {
    return this.#deps.getViewportRows ? () => Math.max(6, this.#deps.getViewportRows!() - 14) : undefined;
  }

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  /** 命令输出等信息行（内容可自带 ANSI，原样呈现） */
  addInfoLines(lines: string[]): void {
    this.#lastStatus = null;
    for (const line of lines) {
      this.#deps.container.addChild(new Text(line, 0, 0));
    }
    this.#deps.ui.requestRender();
  }

  /**
   * 信息卡（子代理完成卡等）：head/hint 纯文本行 + **Markdown 渲染**的正文。
   * 单 Box 组件承载（TranscriptContainer 块间插空行，逐行 addChild 会断卡）。
   * 2026-10-07 用户反馈：交付报告按纯文本打印（`##`/`**` 原样外露）不可接受 ——
   * 报告是 markdown 交付物，必须渲染。
   */
  addInfoCard(head: string[], markdown: string, tail: string[] = []): void {
    this.#lastStatus = null;
    const box = new Box(1, 0);
    for (const l of head) box.addChild(new Text(l, 0, 0));
    box.addChild(
      new Markdown(markdown, 0, 0, getMarkdownTheme(), {
        color: (t: string) => theme.fg('customMessageText', t),
      }),
    );
    for (const l of tail) box.addChild(new Text(l, 0, 0));
    this.#deps.container.addChild(box);
    this.#deps.ui.requestRender();
  }

  /** 用户提交回显（imageLinks 让 [Image #N] chip 可点击，omp 终端范式） */
  addUserMessage(text: string, options?: { imageLinks?: readonly (string | undefined)[] }): void {
    this.#lastStatus = null;
    // 新的一轮开始：清掉「封口下一张卡」的标记（拒绝轮已结束，避免误伤新卡）
    this.#sealNextToolStart = false;
    this.#deps.container.addChild(new UserMessageComponent(text, { imageLinks: options?.imageLinks }));
    this.#deps.ui.requestRender();
  }

  /**
   * skill 调用回显（skill-invoke P4.2）：omp SkillMessageComponent——行首 token
   * 渲成左轨 callout（chip + 路径行数，ctrl+o 展开 prompt 全文），句中 token
   * 渲成普通气泡内联 chip。组件本身是 Container，天然满足 transcript 单组件约束。
   */
  addSkillMessage(
    message: CustomMessage<SkillPromptDetails>,
    imageLinks?: readonly (string | undefined)[],
  ): void {
    this.#lastStatus = null;
    this.#deps.container.addChild(new SkillMessageComponent(message, imageLinks));
    this.#deps.ui.requestRender();
  }

  /**
   * 自定义命令回显（custom-commands P3）：CommandMessageCard（Disclosure 折叠 +
   * CappedMarkdown 限高，防超高退休冻结）。与本地 `/skill:` 的 SkillMessageComponent
   * 是两条路径（后者 chip 硬编码 `skill:` 前缀）。命令不带图（与 skill 同限制）。
   */
  addCommandMessage(details: CustomCommandDetails): void {
    this.#lastStatus = null;
    const comp = new CommandMessageCard({
      details,
      // 视口感知限高（同 CompactSummaryCard）：视口 − 14，下限 6
      maxDetailRows: this.#deps.getViewportRows
        ? () => Math.max(6, this.#deps.getViewportRows!() - 14)
        : undefined,
    });
    // 展开初始化与工具卡同口径（verbose 持久默认 ∨ ctrl+o 运行期全局位）
    if (this.#deps.getVerbose?.() || this.#deps.getToolsExpanded?.()) comp.setExpanded(true);
    this.#deps.container.addChild(comp);
    this.#deps.ui.requestRender();
  }

  /**
   * 挂载外部构造的 transcript 子组件（input-interactions P1）。
   *
   * 为什么不让 bridge 自己造：`!` bash 卡片复用 pi-tui `BashExecutionComponent`，它需要
   * **真实 TUI**（`terminal` / `imageBudget` / `requestComponentRender`），而 bridge 的 `deps.ui`
   * 只是最小渲染口。故由 main（有 `app.tui`）构造，再在此挂载。
   */
  addTranscriptComponent(comp: Parameters<TranscriptContainer['addChild']>[0]): void {
    this.#lastStatus = null;
    this.#deps.container.addChild(comp);
    this.#deps.ui.requestRender();
  }

  /** 换会话 / 清屏：全部重置（容器清空由调用方负责） */
  reset(): void {
    this.#active = null;
    this.#textBuf = '';
    this.#thinkingBuf = '';
    this.#tools.clear();
    this.#sealNextToolStart = false;
    this.#unresolved.clear();
    this.#lastStatus = null;
    this.#pendingCompactSummary = null;
    this.#taskStore.clear();
    this.#pendingTaskCalls.clear();
    this.#pendingPlanWrites.clear();
    // todo-hud P1：切视图 / 换会话 / 清屏 → 贴底待办行同步清空（否则残留旧会话的清单）
    this.#deps.onTodoChange?.([]);
  }

  /**
   * 待办快照读取（custom-commands P5 `/todos` 命令用）。
   * 只读取值，不参与渲染 —— 展示由 app 侧**贴底常驻行**负责（todo-hud P1，已不落转录卡）。
   */
  taskSnapshot(): TaskItem[] {
    return this.#taskStore.snapshot();
  }

  handleEvent(ev: UIEvent): void {
    switch (ev.type) {
      case 'text_delta':
        this.#onDelta(ev.text, 'text');
        break;
      case 'thinking_delta':
        this.#onDelta(ev.text, 'thinking');
        break;
      case 'text_final':
        this.#onTextFinal(ev);
        break;
      case 'tool_start':
        this.#onToolStart(ev);
        break;
      case 'tool_result':
        this.#onToolResult(ev);
        break;
      case 'result':
        this.#onResult();
        break;
      case 'status':
        this.#addStatus(ev.status);
        break;
      case 'compact_boundary':
        this.#onCompactBoundary(ev.trigger, ev.preTokens);
        break;
      case 'error':
        // permission-surface P2.4：拒绝工具调用时 CLI 发的是**合成的错误回执**，不是执行错误
        // → 渲染中文拒绝行（`[error:execution]` 红字会让人以为出错）。
        if (ev.kind === 'permission_denied') this.#onPermissionDenied(ev.message);
        else this.#addLine(theme.fg('error', `[error:${ev.kind}] ${ev.message}`));
        break;
      case 'system_init':
        // model/mode 由 main.ts 状态栏路径消费，转录区不落行
        break;
      case 'goal_update': {
        // goal P1.4：block 复用 #lastStatus 覆盖显示「续跑 #N」（同轮内进度可见）；
        // satisfied 落回执行（回执两行）；halted 安全阀告警（红色）。
        const lines = formatGoalUpdate(ev);
        if (ev.kind === 'block') {
          this.#addStatus(lines[0] ?? '');
        } else if (ev.kind === 'halted') {
          for (const l of lines) this.#addLine(theme.fg('error', `[goal] ${l}`));
        } else {
          for (const l of lines) this.#addLine(theme.fg('dim', `[goal] ${l}`));
        }
        break;
      }
    }
  }

  // ---------- 内部 ----------

  /** 有活动组件则更新，无则新建（turn 内每个 tool_start 后开新块） */
  #ensureActive(): AssistantMessageComponent {
    if (!this.#active) {
      // M4.2：hideThinkingBlock 默认 true（omp 观感：thinking 折叠为流式 "Thinking…"
      // 脉冲 + 定稿 "Thought for Ns"，解决 M1 遗留「区分度不明显」）；
      // ux-port-v2 P4：getThinkingVisible=true（ctrl+t 开）时新组件直接全文渲染。
      // onImageUpdate 必接——脉冲帧推进、图片异步转换完成的重绘全靠它
      // （interactive-context-helpers.ts:110 同款 requestRender）
      this.#active = new AssistantMessageComponent(
        undefined,
        !(this.#deps.getThinkingVisible?.() ?? false),
        () => this.#deps.ui.requestRender(),
      );
      this.#deps.container.addChild(this.#active);
    }
    return this.#active;
  }

  #buildMessage(transient: true): AssistantMessage {
    const content: AssistantContent = [];
    if (this.#thinkingBuf) content.push({ type: 'thinking', thinking: this.#thinkingBuf });
    if (this.#textBuf) content.push({ type: 'text', text: this.#textBuf });
    return makeAssistantMessage(content, this.#deps.getModel());
  }

  #onDelta(delta: string, kind: 'text' | 'thinking'): void {
    this.#lastStatus = null;
    if (kind === 'text') this.#textBuf += delta;
    else this.#thinkingBuf += delta;
    // P3：摘要窗口内 delta 只缓冲不建组件，等 text_final 出卡片。
    if (this.#pendingCompactSummary) {
      // 前缀兜底窗：缓冲分叉（确认不是摘要）→ 释放回正常路径；
      // t 已覆盖完整前缀（startsWith 反向）= 确认摘要，继续缓冲
      const t = this.#textBuf.trimStart();
      const stillCandidate = COMPACT_SUMMARY_MARKER.startsWith(t) || t.startsWith(COMPACT_SUMMARY_MARKER);
      if (this.#pendingCompactSummary.byPrefix && !stillCandidate) {
        this.#pendingCompactSummary = null;
      } else {
        return;
      }
    } else if (kind === 'text') {
      // 无 boundary（SDK 0.3.267 manual /compact 即如此）：文本前缀是摘要唯一信号。
      // 命中候选（含部分前缀）先压住缓冲；正常文本以 '<' 开头最多被压 1-2 个 delta
      // 即分叉释放，影响可忽略。
      const t = this.#textBuf.trimStart();
      if (t.length > 0 && COMPACT_SUMMARY_MARKER.startsWith(t)) {
        if (this.#active) {
          // compact 轮 thinking 先行已建组件（✻ Thinking 脉冲）：摘要文本不混入——
          // 定稿 thinking-only 块（"Thought for Ns" 保留）再开窗。此时组件必无文本
          // （有文本则 t 早已分叉，到不了这里），finalize 安全；
          // 候选文本暂存后恢复：不落进 thinking 块，留缓冲等 text_final/分叉
          const pendingText = this.#textBuf;
          this.#textBuf = '';
          this.#finalizeAssistant();
          this.#textBuf = pendingText;
        }
        this.#pendingCompactSummary = { byPrefix: true };
        return;
      }
    }
    const comp = this.#ensureActive();
    comp.updateContent(this.#buildMessage(true), { transient: true });
    this.#deps.ui.requestRender();
  }

  /** compact_boundary：开启摘要窗口（带精确 trigger/preTokens；卡片即分隔条，不另画线） */
  #onCompactBoundary(trigger: 'manual' | 'auto', preTokens: number): void {
    if (this.#active) this.#finalizeAssistant();
    this.#pendingCompactSummary = { trigger, preTokens };
    this.#deps.ui.requestRender();
  }

  /** 压缩摘要卡（CompactSummaryCard：omp 观感 + 展开限高，防超高退休冻结） */
  #renderCompactSummaryCard(meta: { trigger?: 'manual' | 'auto'; preTokens?: number }, text: string): void {
    this.#lastStatus = null;
    const comp = new CompactSummaryCard({
      summary: stripCompactSummaryWrapper(text),
      tokensBefore: meta.preTokens,
      // 视口感知限高：视口行数 − 14（编辑器/状态栏/分隔条/Box 留白开销），
      // 下限 10 行；超高截断是折叠可视与完整展示的折中（退休冻结约束，
      // 见 compact-summary-card.ts 头注），全文出口 /export
      maxDetailRows: this.#deps.getViewportRows
        ? () => Math.max(10, this.#deps.getViewportRows!() - 14)
        : undefined,
    });
    // 展开初始化与工具卡同口径（P2.2：verbose 持久默认 ∨ ctrl+o 运行期全局位）
    if (this.#deps.getVerbose?.() || this.#deps.getToolsExpanded?.()) comp.setExpanded(true);
    this.#deps.container.addChild(comp);
    this.#deps.ui.requestRender();
  }

  /** text_final 入口：摘要窗口 / 打标事件走卡片，否则正常定稿 */
  #onTextFinal(ev: TextFinal): void {
    const pending = this.#pendingCompactSummary;
    if (!pending && !ev.compactSummary) {
      this.#finalizeAssistant(ev.text, ev.thinking);
      return;
    }
    this.#pendingCompactSummary = null;
    const meta = {
      trigger: pending?.trigger ?? ev.trigger,
      preTokens: pending?.preTokens ?? ev.preTokens,
    };
    const text = (ev.text.trim() ? ev.text : this.#textBuf).trim();
    this.#textBuf = '';
    this.#thinkingBuf = '';
    if (text) this.#renderCompactSummaryCard(meta, text);
  }

  /** text_final：完整文本权威覆盖 delta 累积并定稿（摘要窗口由 #onTextFinal 先行接管）。
   * finalThinking（ux-port-v2 P4.4）：落盘/重放携带的定稿 thinking，与 finalText 同语义
   * 权威覆盖 thinkingBuf；live 恒 undefined（thinking 走 thinking_delta 累积）。
   * thinking-only 记录（text 空、thinking 非空，compact 轮 thinking 单列）也能成块。 */
  #finalizeAssistant(finalText?: string, finalThinking?: string): void {
    if (!this.#active) {
      // 无 delta 直接来 text_final（resume 重放 / 非流式路径）
      if (finalText?.trim() || finalThinking?.trim()) {
        this.#textBuf = finalText ?? '';
        if (finalThinking?.trim()) this.#thinkingBuf = finalThinking;
        this.#ensureActive();
      } else {
        return;
      }
    } else {
      if (finalText !== undefined && finalText.trim()) this.#textBuf = finalText;
      if (finalThinking?.trim()) this.#thinkingBuf = finalThinking;
    }
    const comp = this.#active!;
    const msg = makeAssistantMessage(
      [
        ...(this.#thinkingBuf ? [{ type: 'thinking', thinking: this.#thinkingBuf } as const] : []),
        { type: 'text', text: this.#textBuf } as const,
      ],
      this.#deps.getModel(),
    );
    comp.updateContent(msg, { transient: false });
    comp.markTranscriptBlockFinalized();
    this.#active = null;
    this.#textBuf = '';
    this.#thinkingBuf = '';
    this.#deps.ui.requestRender();
  }

  /**
   * 工具卡工厂：带结构化 diff 的编辑类工具走 DiffCard；模型自主调用 `Skill`
   * 走 SkillCallCard（skill-system P4.1）；其余走 pi-tui 原生卡（回落路径不变）。
   */
  #newToolCard(
    toolName: string,
    input: unknown,
    toolUseId: string,
    diff?: ToolDiff,
  ): ToolCard {
    if (diff) {
      return new DiffCard({
        toolName,
        diff,
        cwd: this.#deps.cwd,
        // 视口感知限高（同摘要卡口径：视口行数 − 14，下限 6），
        // 保证展开块远小于一屏——超屏会整块退休进 scrollback 后折不动
        maxDetailRows: this.#deps.getViewportRows
          ? () => Math.max(6, this.#deps.getViewportRows!() - 14)
          : undefined,
        // 默认展开（diff 就是这张卡的正文）；用户 ctrl+o 折过则跟随运行期位
        expanded: this.#deps.getToolsExpanded?.() ?? true,
      });
    }
    // 模型侧 Skill 通道（含 DeferExecuteTool 包装拆解，见 permission/bridge.ts）：
    // 专用卡替代「整篇 SKILL.md 灌进通用卡」；默认折叠（正文次要，且防超高冻结）
    const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const skill = skillInvocation(toolName, rec);
    if (skill) {
      return new SkillCallCard({
        skillName: skill.name,
        args: skill.args,
        maxDetailRows: this.#deps.getViewportRows
          ? () => Math.max(6, this.#deps.getViewportRows!() - 14)
          : undefined,
        expanded: this.#deps.getToolsExpanded?.() ?? false,
      });
    }
    return new ToolExecutionComponent(
      toolName,
      input,
      { showImages: true },
      undefined,
      this.#deps.ui,
      this.#deps.cwd,
      toolUseId,
    );
  }

  /** 工具结果回填卡片（原生卡 / DiffCard / SkillCallCard 鸭子面同口径） */
  #updateToolResult(comp: ToolCard, ev: ToolResult): void {
    const text = ev.detail ?? ev.summary;
    comp.updateResult(
      {
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...(ev.images ?? []).map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
        ],
        isError: ev.isError,
      },
      false,
      ev.toolUseId,
    );
  }

  #onToolStart(ev: ToolStart): void {
    this.#lastStatus = null;
    // 摘要窗口内出现工具调用 = 误判（摘要轮无工具），清窗走正常路径
    this.#pendingCompactSummary = null;
    // 定稿前置 assistant 块（omp 范式：工具卡与后续文本分段成独立组件）
    if (this.#active) this.#finalizeAssistant();

    // tool-render P2：Task* 工具族的**状态机更新**放在 result 期 —— TaskCreate 的 id 只在
    // result 文本里，start 期快照不完整。此处只暂存入参（不落任何转录组件）
    if (isTaskListTool(ev.toolName)) {
      this.#pendingTaskCalls.set(ev.toolUseId, {
        toolName: ev.toolName,
        input: parseArgsObject(ev.detail, ev.summary),
      });
      this.#deps.ui.requestRender();
      return;
    }

    // plan-approval P2.1：写计划文件（`~/.codebuddy/plans/*.md`）不建 diff 卡 —— 暂存，
    // result 时读盘落 markdown 计划卡（codebuddy 式「计划进正文」）。filePath 取自 diff
    // （来自完整 input，不受 detail 2000 字符截断影响）。
    if (ev.diff && isPlanFilePath(ev.diff.filePath)) {
      this.#pendingPlanWrites.set(ev.toolUseId, {
        toolName: ev.toolName,
        input: parseArgsObject(ev.detail, ev.summary),
        filePath: ev.diff.filePath,
      });
      this.#deps.ui.requestRender();
      return;
    }

    const comp = this.#newToolCard(ev.toolName, parseArgs(ev.detail, ev.summary), ev.toolUseId, ev.diff);
    comp.setArgsComplete(ev.toolUseId);
    comp.setExecutionStarted(ev.toolUseId);
    // ux-port P2.2 新卡展开初始化（pi-tui interactive-context-helpers.ts:118
    // setExpanded(ctx.toolOutputExpanded) 同款范式）。两者优先级：
    // - verbose（配置 / /verbose）= 持久默认：开启时新卡一律展开，ctrl+o 管不了新卡
    // - 全局展开位（ctrl+o）= 会话内运行期覆盖：verbose 关闭时新卡跟随最近一次切换
    // 取或即可同时满足「verbose 只决定初始值」与「ctrl+o 运行期覆盖存量卡」
    if (this.#deps.getVerbose?.() || this.#deps.getToolsExpanded?.()) comp.setExpanded(true);
    this.#deps.container.addChild(comp);
    this.#tools.set(ev.toolUseId, comp);
    // 被拒绝调用的迟到卡：就地补「已拒绝」结果（否则永久转圈，见 `#sealNextToolStart`）
    if (this.#sealNextToolStart) {
      this.#sealNextToolStart = false;
      this.#updateToolResult(comp, {
        type: 'tool_result',
        toolUseId: ev.toolUseId,
        isError: true,
        summary: '用户拒绝了该调用（未执行）— 请直接说明你期望的做法',
      });
    } else {
      this.#unresolved.add(ev.toolUseId);
    }
    this.#deps.ui.requestRender();
  }

  /**
   * tool-render P2：Task* 调用收尾 —— 更新状态机并把快照推给 app 的**贴底常驻行**
   * （todo-hud P1：已不再落转录卡）。形态不符（错误结果 / `TaskCreate` 没回 `#N` /
   * `TaskUpdate` 缺 id）则回落原生工具卡，错误文本与入参详情不丢。
   *
   * 为什么推快照而不是让 app 轮询：快照变化只有这里知道（`apply*` 的返回值），
   * 变化即推 → 无变化不重绘（D8）。
   */
  #onTaskToolResult(pending: { toolName: string; input: Record<string, unknown> }, ev: ToolResult): void {
    const name = pending.toolName.toLowerCase();
    const resultText = ev.detail ?? ev.summary;

    let handled = false;
    let changed = false;
    if (!ev.isError) {
      if (name === 'taskcreate') {
        // id 只能从 result 文本解析（P2.0）：解析不到视为异常，不污染状态机
        handled = parseCreatedId(resultText) !== undefined;
        if (handled) changed = this.#taskStore.applyCreate(pending.input, resultText);
      } else if (name === 'taskupdate') {
        handled = parseUpdateArgs(pending.input) !== undefined;
        if (handled) changed = this.#taskStore.applyUpdate(pending.input);
      } else if (name === 'tasklist') {
        // 权威全量快照，空列表也照实呈现（「无任务」是有意义的信息）
        changed = this.#taskStore.applyList(resultText);
        handled = true;
      }
    }

    if (!handled) {
      const comp = this.#newToolCard(pending.toolName, pending.input, ev.toolUseId);
      comp.setArgsComplete(ev.toolUseId);
      comp.setExecutionStarted(ev.toolUseId);
      if (this.#deps.getVerbose?.() || this.#deps.getToolsExpanded?.()) comp.setExpanded(true);
      this.#deps.container.addChild(comp);
      this.#updateToolResult(comp, ev);
      this.#deps.ui.requestRender();
      return;
    }

    if (changed) this.#deps.onTodoChange?.(this.#taskStore.snapshot());
    this.#deps.ui.requestRender();
  }

  #onToolResult(ev: ToolResult): void {
    this.#unresolved.delete(ev.toolUseId);
    // plan-approval P2.1：计划文件写入收尾 → 读盘落 markdown 计划卡（读不到则回落原生卡）
    const planWrite = this.#pendingPlanWrites.get(ev.toolUseId);
    if (planWrite) {
      this.#pendingPlanWrites.delete(ev.toolUseId);
      // 定稿前置 assistant 块，保证计划卡落在正确位置（同工具卡范式）
      if (this.#active) this.#finalizeAssistant();
      const markdown = ev.isError ? undefined : readPlanFile(planWrite.filePath);
      if (markdown && markdown.trim()) {
        this.#deps.container.addChild(
          new PlanMarkdownCard({ markdown, maxDetailRows: this.#planCardMaxRows() }),
        );
        this.#deps.ui.requestRender();
        return;
      }
      // 读不到 / 写失败：回落原生工具卡，错误文本与入参详情不丢
      const comp = this.#newToolCard(planWrite.toolName, planWrite.input, ev.toolUseId);
      comp.setArgsComplete(ev.toolUseId);
      comp.setExecutionStarted(ev.toolUseId);
      if (this.#deps.getVerbose?.() || this.#deps.getToolsExpanded?.()) comp.setExpanded(true);
      this.#deps.container.addChild(comp);
      this.#updateToolResult(comp, ev);
      this.#deps.ui.requestRender();
      return;
    }
    const comp = this.#tools.get(ev.toolUseId);
    if (comp) {
      this.#updateToolResult(comp, ev);
    } else {
      const pending = this.#pendingTaskCalls.get(ev.toolUseId);
      if (pending) {
        this.#pendingTaskCalls.delete(ev.toolUseId);
        this.#onTaskToolResult(pending, ev);
        return;
      }
      // 孤立 result（resume 重放半截等）：dim 行兜底
      this.#addLine(theme.fg('dim', `[tool:${ev.isError ? 'error' : 'ok'}] ${ev.summary}`));
    }
    this.#deps.ui.requestRender();
  }

  /** result 事件：定稿活动块 + seal 中断残留工具卡 */
  #onResult(): void {
    // P3：compact 后无 summary 文本直接 result（auto 无摘要消息等）——只留分隔线，清窗
    this.#pendingCompactSummary = null;
    if (this.#active) this.#finalizeAssistant();
    // 被中断的 Task* 调用（tool_start 无 result）：补原生卡，别让调用凭空消失
    for (const [toolUseId, pending] of this.#pendingTaskCalls) {
      const comp = this.#newToolCard(pending.toolName, pending.input, toolUseId);
      comp.setArgsComplete(toolUseId);
      comp.setExecutionStarted(toolUseId);
      this.#deps.container.addChild(comp);
      this.#tools.set(toolUseId, comp);
    }
    this.#pendingTaskCalls.clear();
    for (const comp of this.#tools.values()) comp.seal();
    this.#tools.clear();
    this.#unresolved.clear();
    this.#deps.ui.requestRender();
  }

  /**
   * cancel-stops-turn P1.2/P1.3：用户取消/拒绝的回执渲染（权限确认 / 问答 / 计划审批**统一**走
   * 「拒绝即停轮」通路，差异只在文案）。
   *
   * 拒绝走 SDK `interrupt: true` 当场取消本轮 → 该次调用**永远没有 result 回来**。
   * `tool_start` 与回执的到达顺序不稳定，两条都要收口（否则留下永久转圈的空卡）：
   * - 回执先到：记 `#sealNextToolStart`，迟到的那张卡就地补一条「已拒绝」结果；
   * - 卡先到：它还在 `#unresolved` 里 → 直接补结果。
   *
   * 文案按被拒工具场景分三类（`deniedToolKind`）：普通工具 / 问答 / 计划审批；plan 再按
   * 「是否仍在 plan 模式」分「取消（留在 plan）」与「退出计划模式」两条。
   */
  #onPermissionDenied(message: string): void {
    const reason = this.#denyReason(message);
    // 只认**最近一次** start 且没有 result 的卡：被拒调用必定是本轮最后一个 tool_start
    // （拒绝发生在它执行之前）。这样不会误伤更早的、仍在跑的工具（如后台任务）。
    const ids = [...this.#unresolved];
    const target = ids[ids.length - 1];
    const comp = target ? this.#tools.get(target) : undefined;
    if (comp) {
      this.#updateToolResult(comp, { type: 'tool_result', toolUseId: target!, isError: true, summary: reason });
    }
    this.#unresolved.clear();
    this.#sealNextToolStart = true;
    // 没有对应卡片（tool_start 还没到 / 丢了）→ 至少留一行提示，别让拒绝凭空消失
    if (!comp) this.#addLine(theme.fg('warning', `⏺ ${reason}`));
  }

  /**
   * 拒绝回执文案（cancel-stops-turn P1.3）：场景差异的唯一落点。
   * - 普通工具 → 现状（`No, and tell CodeBuddy what to do differently` 的 omc 中文形态）
   * - 问答 → 「取消了提问」
   * - plan → 仍在 plan = 「取消了计划审批（仍在 plan 模式）」；已解钉 = 「退出了计划模式」
   */
  #denyReason(message: string): string {
    const kind = deniedToolKind(message);
    if (kind === 'ask') return '用户取消了提问 — 已停下，请等用户说明';
    if (kind === 'plan') {
      return this.#deps.getPermissionMode?.() === 'plan'
        ? '用户取消了计划审批 — 已停下（仍在 plan 模式）'
        : '用户退出了计划模式 — 已停下';
    }
    const tools = parseDeniedTools(message);
    const who = tools.length > 0 ? tools.join('、') : '该工具';
    return `用户拒绝了 ${who} 的调用（未执行）— 请直接说明你期望的做法`;
  }

  #addStatus(status: string): void {
    const line = theme.fg('dim', `[status] ${status}`);
    if (this.#lastStatus) {
      this.#lastStatus.setText(line);
    } else {
      this.#lastStatus = new Text(line, 0, 0);
      this.#deps.container.addChild(this.#lastStatus);
    }
    this.#deps.ui.requestRender();
  }

  #addLine(styled: string): void {
    this.#lastStatus = null;
    this.#deps.container.addChild(new Text(styled, 0, 0));
    this.#deps.ui.requestRender();
  }
}
