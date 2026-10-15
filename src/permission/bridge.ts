/**
 * bridge.ts — canUseTool → 交互确认 的桥接层（P5.1/5.3）。
 *
 * 数据流：SDK 调 canUseTool → 桥接层挂起 Promise、登记 pending → UI 渲染弹窗 →
 * 用户按 y/n/a → decide() resolve Promise → SDK 继续。
 *
 * 设计要点：
 * - 单 pending：SDK 工具调用是串行的，最多一个挂起；并发到达的请求排队（防御）
 * - always 白名单按**授权键**记忆（见 `permissionAlwaysKey`）：一般工具用工具名
 *   （不按 bash 命令文本——「总是允许 bash」意味着放行任意命令，这是用户显式让渡的
 *   安全边界；按命令文本记忆会制造「这条命令安全」的错觉，且容易因空白/引号差异漏判），
 *   Skill 例外：按**目标 skill 名**分键（`skill:<名>`，对齐 CLI `Skill:<稳定名>`），
 *   避免「批准一个 skill 静默放行全部 skill」
 * - interrupt 联动：SDK 侧 abort signal 触发 → 统一 deny 挂起请求（防 Promise 悬挂）；
 *   本地 Esc 中断时由 app 层调 denyPending() 双保险
 * - /mode 切换时 app 层调 clearAlways() 清空白名单
 */
import type { CanUseTool } from '@tencent-ai/agent-sdk';
import { appendFileSync } from 'node:fs';
import { summarizeInput } from '../agent/normalize';
import { isMemoryToolName } from '../app/memory-store';
import type { PlanSnapshot } from '../agent/plan';

export type PermissionDecision = 'allow' | 'deny' | 'always';

/**
 * ExitPlanMode 三选项的决策（plan-mode P1.3；文案与语义照 codebuddy）：
 * - `yes`  批准 → allow（CLI 退出 plan 并执行计划）
 * - `keep` 拒绝但**留在 plan**（cancel-stops-turn D3：**一停到底** —— `denyStop` 立即停轮，
 *   不再主动续轮；「保持 plan 模式，只是需要停下来」）
 * - `exit` 退出 plan 模式且拒绝（先切回 `prePlanMode` 再 `denyStop`）
 * - `abort` 中断/换会话等**非用户选择**的收口（`denyStop`，立即停轮）
 *
 * 三者的差异只在「退出后状态」（是否解钉）与回执文案；共同动作都是 `deny + interrupt + toolUseID`。
 */
export type PlanChoice = 'yes' | 'keep' | 'exit' | 'abort';

/** 弹窗展示模型：tui 组件只认这个，不认 SDK 类型 */
export interface PermissionPrompt {
  toolName: string;
  /** 单行摘要（复用 P4 per-tool 摘要） */
  summary: string;
  /** 附加展示行：bash 完整命令 / write·edit 路径+行数 / skill 目标+args */
  details: string[];
}

/** AskUserQuestion 的单道题（展示模型） */
export interface AskQuestionItem {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/**
 * Plan 审批的展示模型（plan-approval P1.3）。
 * `ExitPlanMode` 的 `canUseTool` 入参**恒为 `{}`**（P1.1 探针实证），计划全文不随入参下发，
 * 故内容由注入的 `planProvider`（`AgentSession.planSnapshot()`）提供。
 */
export interface PlanApproval {
  /** 计划文件路径（可能缺省） */
  planFilePath?: string;
  /** 计划全文（读不到为空串） */
  content: string;
  /** ExitPlanMode 原始入参（allow 时作 updatedInput 回传） */
  input: Record<string, unknown>;
}

/** 挂起请求展示模型（权限确认 / 问答收集 / 计划审批） */
export type BridgePending =
  | { kind: 'permission'; prompt: PermissionPrompt }
  | { kind: 'ask'; questions: AskQuestionItem[] }
  | { kind: 'plan'; plan: PlanApproval };

/**
 * 挂起请求的单行标签（herdr P1：`permission/pending.label`）。
 * permission → 单行摘要；ask → 首题题干；plan → 计划标题行（首个非空行）。
 */
export function pendingLabel(pending: BridgePending): string {
  if (pending.kind === 'permission') return pending.prompt.summary;
  if (pending.kind === 'plan') {
    const first = pending.plan.content.split('\n').find((l) => l.trim().length > 0) ?? '';
    return first.replace(/^#+\s*/, '').trim() || '计划待批准';
  }
  return pending.questions[0]?.question ?? '';
}

/**
 * 解析一次工具调用的**有效目标名**（穿透 `DeferExecuteTool` 包装，对齐 CLI
 * `resolveEffectiveToolName`，见 `cli/.../tool-protocol.d.ts:588-604`）。
 * `ExitPlanMode` 可能经 `DeferExecuteTool({toolName:'ExitPlanMode', params})` 派发，
 * 此时 `canUseTool` 顶层名是 `DeferExecuteTool`，真名藏在 `input.toolName`。
 */
export function effectiveToolName(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'DeferExecuteTool') {
    const t = input.toolName;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return toolName;
}

/**
 * 拆出一次 **Skill 调用**的目标（skill-system P1：权限弹窗与 always 粒度）。
 *
 * P1.1 探针（`scripts/probe-skill-permission.ts`）实证：模型首次用 Skill 时会经
 * `DeferExecuteTool({toolName:'Skill', params:{skill,args}})` 派发（Skill 属延迟加载工具），
 * 故 `canUseTool` 顶层名是 `DeferExecuteTool`、目标藏在 `input.params`；而 Skill 已加载后
 * 的**直调不经 `canUseTool`**（CLI 放行）。故这里穿透包装，两种形态统一取目标。
 *
 * 非 Skill 调用返回 `undefined`。目标名缺失时 `name` 为空串（调用方退回粗粒度键）。
 */
export function skillInvocation(
  toolName: string,
  input: Record<string, unknown>,
): { name: string; args: string } | undefined {
  if (effectiveToolName(toolName, input) !== 'Skill') return undefined;
  const params = toolName === 'DeferExecuteTool' ? input.params : input;
  const rec = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const rawName = rec.skill ?? rec.command ?? '';
  return {
    name: typeof rawName === 'string' ? rawName.trim() : '',
    args: typeof rec.args === 'string' ? rec.args : '',
  };
}

/**
 * always 白名单键（skill-system P1.2）：Skill 按**目标名**分键（对齐 CLI 的
 * `Skill:<稳定名>`，见 `cli/.../tool-always-approval-service.d.ts`——「批准一个 Skill
 * 不得静默放行其它 Skill」），其余工具按工具名。
 *
 * 键只影响 `always` 记忆，不改 allow/deny 语义；无目标信息时退回粗粒度 `'skill'`
 * 是**安全侧**选择（等于旧行为，不会放大授权）。
 */
export function permissionAlwaysKey(toolName: string, input: Record<string, unknown>): string {
  const skill = skillInvocation(toolName, input);
  if (skill) return skill.name ? `skill:${skill.name}` : 'skill';
  return toolName.toLowerCase();
}

/**
 * 权限桥的 allow/deny 结果（与 SDK `CanUseToolPermissionResult` 对齐）。
 * `interrupt` 是 SDK 原生字段：`deny` 时置 true = **取消整轮**（`SdkPermissionDeniedError.interrupt`
 * 决定外层 `shouldInterrupt`），而不是「把拒绝结果回给模型、继续本轮」。
 * `toolUseID` 让 CLI 把拒绝匹配到具体工具调用（不带会留下永久转圈的工具卡）。
 */
type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string };

/**
 * 「取消/拒绝 = 立即停轮」的**唯一构造点**（cancel-stops-turn D1–D3）。
 *
 * 凡会挡在模型执行路径上的弹窗（工具权限确认 / 问答 / 计划审批），其取消或拒绝一律返回
 * `deny + interrupt:true + toolUseID` —— 与工具权限确认那条已验证通路逐字同构（permission-surface
 * P2.4）；P0 探针实证（g1/g3/g4）：这才是真·整轮中断，模型零续写、本轮正常收尾、无 `[error:execution]`。
 * **不带 `interrupt` 的 deny 是错的**：CLI 会当普通工具失败回给模型（模型自行继续）或静默挂住。
 *
 * 各场景差异只在「回执文案」（见 `ui/bridge.ts`）与「退出后状态处理」（plan 取消不解钉 / 选项 3 解钉）。
 */
function denyStop(message: string, toolUseID: string): PermissionResult {
  return { behavior: 'deny', message, interrupt: true, toolUseID };
}

interface PendingRequest {
  prompt: PermissionPrompt;
  resolve: (d: PermissionDecision) => void;
}

interface PendingAsk {
  questions: AskQuestionItem[];
  /** 原始 input（decide 时合并 answers 回传） */
  input: Record<string, unknown>;
  /** 本次 AskUserQuestion 的 tool_use id（取消走 denyStop 时必须带，见 `denyStop`） */
  toolUseID: string;
  resolve: (r: PermissionResult) => void;
}

interface PendingPlan {
  plan: PlanApproval;
  /** ExitPlanMode 的 tool_use id（CanUseToolOptions.toolUseID；R1 用它匹配拒绝回执） */
  toolUseID: string;
  resolve: (r: PermissionResult) => void;
}

/**
 * plan 拒绝时回给 CLI 的文案（cancel-stops-turn 后走 `denyStop`：带 `interrupt`，本轮立即停）。
 * 保留一句「用户拒绝了该计划」作 CLI 侧展示；omc 侧回执行文案按场景自绘（见 `ui/bridge.ts`）。
 */
const PLAN_DENY_MESSAGE = '用户拒绝了该计划';

/** 构造弹窗的 details 行（bash 全量命令；write/edit 路径+行数；skill 目标+args） */
function buildDetails(toolName: string, input: Record<string, unknown>): string[] {
  // Skill 调用（含 DeferExecuteTool 包装）：展示目标名与 args
  const skill = skillInvocation(toolName, input);
  if (skill) {
    const out = [`  skill: ${skill.name || '(未指定)'}`];
    if (skill.args) out.push(`  args: ${skill.args}`);
    return out;
  }
  const name = toolName.toLowerCase();
  // active-memory P1.6：记忆工具的详情行 —— 明示通道与目标（shared 会改项目 AGENTS.md）。
  // private 已被 canUseTool 自动放行，正常不会到这里，保底也给可读文案。
  if (isMemoryToolName(toolName)) {
    const scope = input.scope === 'shared' ? '共享记忆（追加到项目 AGENTS.md）' : '私有记忆';
    return [`  ${scope}：${String(input.name ?? '')}`];
  }
  if (name === 'bash') {
    const cmd = String(input.command ?? '');
    return cmd.split('\n').map((l) => `  ${l}`);
  }
  if (name === 'write') {
    const lines = String(input.content ?? '').split('\n').length;
    return [`  ${String(input.file_path ?? '')} (+${lines} 行)`];
  }
  if (name === 'edit') {
    const oldLines = String(input.old_string ?? '').split('\n').length;
    const newLines = String(input.new_string ?? '').split('\n').length;
    return [`  ${String(input.file_path ?? '')} (-${oldLines}/+${newLines} 行)`];
  }
  return [];
}

export class PermissionBridge {
  /** 本会话 always 白名单（工具名） */
  private always = new Set<string>();
  private queue: PendingRequest[] = [];
  /** AskUserQuestion 挂起（与权限队列互斥：SDK 串行，最多一个挂起） */
  private pendingAsk: PendingAsk | null = null;
  /** ExitPlanMode 挂起（plan-approval P1.3，与上面同理互斥） */
  private pendingPlan: PendingPlan | null = null;
  /**
   * 计划内容提供者（P1.3）：`ExitPlanMode` 入参不含计划内容，由注入方（main.ts 接
   * `AgentSession.planSnapshot()`）提供。未注入时计划内容为空串。
   */
  private planProvider: (() => PlanSnapshot | undefined) | null = null;
  /** 计划审批结果回调（P1.3）：宿主据此处理**状态差异**（当前只有 `yes` 批准要解钉；
   *  `keep`/`exit`/`abort` 的停轮由 `denyStop` 完成、无需宿主续跑）。 */
  onPlanDecided: ((choice: PlanChoice) => void) | null = null;
  /**
   * 「退出 plan 模式」选项（P2.3）：把权限模式切回非 plan（main.ts 接
   * `session.setPermissionMode`）。CLI 在 ExitPlanMode 被 deny 时**按当前模式**选拒绝模板
   * （仍 plan → keep planning；已非 plan → exited）→ 先切模式再 deny 即得「退出且不执行」。
   */
  onPlanExitMode: (() => Promise<void> | void) | null = null;
  /**
   * pending 变化监听（herdr P1：单槽 `onChange` → 多监听）。
   * 多个消费者并存：UI 弹窗重绘（permission-overlay）+ 宿主事件派发（main 的
   * `permission/pending`/`permission/resolved`）；单槽会被后者覆盖 → 弹窗失灵。
   */
  readonly #changeListeners = new Set<() => void>();
  /** 测试可观测性：OMC_DEBUG_PERM=<path> 时追加 OPEN/DECIDE/AUTO/DENYALL 事件行 */
  private debugPath = process.env.OMC_DEBUG_PERM;

  /** 登记 pending 变化监听，返回解绑函数（可叠加多个，互不覆盖） */
  addChangeListener(fn: () => void): () => void {
    this.#changeListeners.add(fn);
    return () => {
      this.#changeListeners.delete(fn);
    };
  }

  /** 通知全部监听者（单个抛错被隔离，不影响其余与主流程） */
  private notifyChange(): void {
    for (const fn of [...this.#changeListeners]) {
      try {
        fn();
      } catch {
        // 单个监听者异常不影响派发链
      }
    }
  }

  /** 测试可观测性：当前 pending 变化监听者数 */
  get listenerCount(): number {
    return this.#changeListeners.size;
  }

  private dbg(line: string): void {
    if (!this.debugPath) return;
    try {
      appendFileSync(this.debugPath, line + '\n');
    } catch {
      // 调试通道失败不影响主流程
    }
  }

  /**
   * UI 层埋点入口（ask-dialog-surface P2.2）：与内部 `OPEN`/`DECIDE` 走**同一条**
   * `OMC_DEBUG_PERM` 通道，供冒烟脚本断言 UI 侧时序（如 `ASK-SURFACE on/off`）。
   * 为什么放在这里：调试通道的唯一实现点在此（`debugPath` 读取 + 容错写盘），
   * 冒烟断言要求三类事件落在**同一文件**里可交叉排序。
   */
  debug(line: string): void {
    this.dbg(line);
  }

  /** 当前挂起请求的展示模型（无则 null） */
  get pending(): BridgePending | null {
    if (this.pendingAsk) return { kind: 'ask', questions: this.pendingAsk.questions };
    if (this.pendingPlan) return { kind: 'plan', plan: this.pendingPlan.plan };
    const p = this.queue[0]?.prompt;
    return p ? { kind: 'permission', prompt: p } : null;
  }

  /** 注入计划内容提供者（P1.3；main.ts 接 `AgentSession.planSnapshot`） */
  setPlanProvider(fn: (() => PlanSnapshot | undefined) | null): void {
    this.planProvider = fn;
  }

  /** SDK 回调：白名单命中直接放行，否则挂起等用户决定 */
  canUseTool: CanUseTool = (toolName, input, options) => {
    // ExitPlanMode 走计划审批通道（plan-approval P1.3，D1）：不落通用 y/n/a 弹窗，
    // 而是挂起等 P2 计划浮层决策（携带计划全文）。入参恒 `{}`，内容由 planProvider 给。
    // 用**有效目标名**判定以兼容 `DeferExecuteTool` 包装（同 CLI resolveEffectiveToolName）。
    if (effectiveToolName(toolName, input) === 'ExitPlanMode') {
      return this.planApproval(input, options);
    }
    // AskUserQuestion 走问答收集通道（M4.6）：CLI 硬性要求 allow 必须带
    // updatedInput.answers（hasAskAnswers，无答案 allow 会被 throw 并挂起会话）；
    // 且必须绕过 always 白名单——历史 'a' 记忆若命中会产出无答案 allow，同样挂
    if (toolName === 'AskUserQuestion') {
      return this.askUser(input, options);
    }
    // active-memory P1.6（用户拍板 2026-10-14）：记忆工具按 scope 分流 ——
    // `private` 只写 omc 自己的记忆目录（`~/.omc/projects/<escaped>/memory/`）→ **自动放行**；
    // `shared` 会改项目 `AGENTS.md` → 仍走弹窗确认（复用下方通用 y/n/a 通道）。
    // 判定走 `isMemoryToolName`（归一化 `-`/`_`）—— 实测 canUseTool 收到的名字与
    // `system/init.tools` 里的名字在 `-`/`_` 上不一致（见 memory-store 常量注释）。
    if (isMemoryToolName(toolName) && input.scope === 'private') {
      this.dbg(`AUTO ${toolName} scope=private`);
      return Promise.resolve({ behavior: 'allow' });
    }
    if (this.always.has(permissionAlwaysKey(toolName, input))) {
      this.dbg(`AUTO ${toolName}`);
      return Promise.resolve({ behavior: 'allow' });
    }
    return new Promise((resolve) => {
      const skill = skillInvocation(toolName, input);
      const prompt: PermissionPrompt = skill
        ? {
            // 展示为 Skill（穿透 DeferExecuteTool 包装），摘要 = 目标 skill 名
            toolName: 'Skill',
            summary: skill.name || 'Skill',
            details: buildDetails(toolName, input),
          }
        : {
            toolName,
            summary: summarizeInput(toolName, input),
            details: buildDetails(toolName, input),
          };
      this.queue.push({
        prompt,
        resolve: (d) => {
          if (d === 'deny') {
            // 走唯一构造点：拒绝 = 立即停轮（与问答 / 计划审批同构）
            resolve(
              denyStop(
                '用户拒绝了该工具调用（未执行）。请停下当前操作，等待用户说明期望的做法。',
                options.toolUseID,
              ),
            );
          } else {
            if (d === 'always') {
              const key = permissionAlwaysKey(toolName, input);
              this.always.add(key);
              this.dbg(`ALWAYS ${key}`);
            }
            resolve({ behavior: 'allow', updatedInput: input });
          }
        },
      });
      this.dbg(`OPEN ${toolName}`);
      // SDK 侧 abort（interrupt 等）：统一 deny 防悬挂
      options.signal.addEventListener('abort', () => this.denyPending(), { once: true });
      this.notifyChange();
    });
  };

  /** AskUserQuestion 挂起等答案（input 结构非法直接停机 deny，防 CLI 空等） */
  private askUser(
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult> {
    const questions = parseAskQuestions(input);
    if (!questions) {
      this.dbg('ASK-REJECT 非法 questions');
      return Promise.resolve(denyStop('AskUserQuestion 参数无法解析', options.toolUseID ?? ''));
    }
    return new Promise((resolve) => {
      this.pendingAsk = { questions, input, toolUseID: options.toolUseID ?? '', resolve };
      this.dbg(`ASK-OPEN x${questions.length}`);
      options.signal.addEventListener('abort', () => this.denyPending(), { once: true });
      this.notifyChange();
    });
  }

  /** 问答完成：answers = question → 选中 label（多选 ", " 连接） */
  decideAsk(answers: Record<string, string>): void {
    const ask = this.pendingAsk;
    if (!ask) return;
    this.pendingAsk = null;
    this.dbg(`ASK-DECIDE ${Object.keys(answers).length}`);
    ask.resolve({ behavior: 'allow', updatedInput: { ...ask.input, answers } });
    this.notifyChange();
  }

  /**
   * 问答取消 = **立即停轮**（cancel-stops-turn D1/主诉修复点）：走 `denyStop`
   * （`deny + interrupt:true + toolUseID`）。P0 实证：不带 interrupt 时 CLI 把取消当普通工具
   * 失败回给模型 → 模型继续思考/追问（用户 bug）；带上后 SDK 抛 `ExecutionError` 取消整轮。
   */
  cancelAsk(): void {
    const ask = this.pendingAsk;
    if (!ask) return;
    this.pendingAsk = null;
    this.dbg('ASK-CANCEL');
    ask.resolve(denyStop('用户取消了提问', ask.toolUseID));
    this.notifyChange();
  }

  /**
   * ExitPlanMode 挂起等计划审批（P1.3）。
   * 计划内容来自注入的 `planProvider`（入参恒 `{}`，见 PlanApproval 注释）。
   * 批准 → allow（CLI 退出 plan 并执行）；非批准 → `denyStop`（立即停轮，留在 plan 或先解钉）。
   */
  private planApproval(
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult> {
    const snap = this.planProvider?.() ?? {};
    const plan: PlanApproval = { planFilePath: snap.planFilePath, content: snap.content ?? '', input };
    return new Promise((resolve) => {
      this.pendingPlan = {
        plan,
        toolUseID: options.toolUseID ?? '',
        resolve,
      };
      this.dbg(`PLAN-OPEN len=${plan.content.length}`);
      options.signal.addEventListener('abort', () => this.denyPending(), { once: true });
      this.notifyChange();
    });
  }

  /**
   * 计划审批落定（唯一出口）：resolve 挂起 Promise + 通知 UI + 回调宿主。
   *
   * **三通道统一**（cancel-stops-turn D1–D3，与普通权限拒绝同构）：非批准一律走 `denyStop`
   * —— `deny + interrupt:true + toolUseID` → **立即停轮**（模型零续写）。各出口的差异只在
   * **退出后状态**：选项 2 / 取消**不解钉**（留在 plan）、选项 3 先解钉（`onPlanExitMode`）再 deny。
   *
   * ⚠️ 已**反转** plan-mode D2（当时刻意不带 interrupt）：`No, keep planning` 不再续轮，
   * codebuddy 的 keep-planning 语义被放弃（用户 2026-10-14 拍板）；omc 侧不再有任何主动续轮。
   */
  private settlePlan(choice: PlanChoice, approve: boolean): void {
    const p = this.pendingPlan;
    if (!p) return;
    this.pendingPlan = null;
    this.dbg(`PLAN-DECIDE ${choice}`);
    p.resolve(approve ? { behavior: 'allow', updatedInput: p.plan.input } : denyStop(PLAN_DENY_MESSAGE, p.toolUseID));
    this.notifyChange();
    this.onPlanDecided?.(choice);
  }

  /** 选项 1（批准）/ 选项 2（留在 plan，停下）：approve=true → allow；false → `denyStop`（保留 plan 模式） */
  decidePlan(approve: boolean): void {
    this.settlePlan(approve ? 'yes' : 'keep', approve);
  }

  /**
   * 选项 3「Exit plan mode」：退出 plan 模式**且不执行**计划。
   * 先把权限模式切回非 plan（`onPlanExitMode`，缺失则不切），**再** `denyStop` —— 差异只在
   * 「解钉」这个状态处理（cancel-stops-turn P0 A3：interrupt 通路下 CLI 的 `exited` 模板不再送达
   * 模型 ⇒ 「已退出计划模式」由 omc 回执文案补，见 `ui/bridge.ts`）。
   * 二次调用安全（pendingPlan 已被首次清空 → 后续 settlePlan 空操作）。
   */
  async decidePlanExit(): Promise<void> {
    if (!this.pendingPlan) return;
    try {
      await this.onPlanExitMode?.();
    } catch {
      // 切模式失败仍继续 deny（至少不悬挂）
    }
    this.settlePlan('exit', false);
  }

  /** 用户对当前挂起请求做出决定 */
  decide(d: PermissionDecision): void {
    const req = this.queue.shift();
    if (!req) return;
    this.dbg(`DECIDE ${d} ${req.prompt.toolName}`);
    req.resolve(d);
    this.notifyChange();
  }

  /** deny 所有挂起/排队请求（interrupt、退出前兜底）—— 全部走 `denyStop`（立即停轮，防悬挂） */
  denyPending(): void {
    const hadAsk = this.pendingAsk !== null;
    if (hadAsk) {
      const ask = this.pendingAsk!;
      this.pendingAsk = null;
      ask.resolve(denyStop('用户中断了提问', ask.toolUseID));
    }
    const hadPlan = this.pendingPlan !== null;
    if (hadPlan) {
      const plan = this.pendingPlan!;
      this.pendingPlan = null;
      // 中断/换会话的收口（非用户选择）→ `abort`：立即停轮（与「取消」同为 `denyStop`）
      plan.resolve(denyStop(PLAN_DENY_MESSAGE, plan.toolUseID));
      this.onPlanDecided?.('abort');
    }
    if (this.queue.length === 0 && !hadAsk && !hadPlan) return;
    const pending = this.queue.splice(0);
    this.dbg(`DENYALL ${pending.length}${hadAsk ? '+ask' : ''}${hadPlan ? '+plan' : ''}`);
    for (const req of pending) req.resolve('deny');
    this.notifyChange();
  }

  /** /mode 切换时清空白名单 */
  clearAlways(): void {
    this.always.clear();
  }

  /** 当前白名单（/help 或调试展示用） */
  get alwaysAllowed(): readonly string[] {
    return [...this.always];
  }
}

/** 解析 AskUserQuestionInput.questions 为展示模型；结构不符返回 null */
function parseAskQuestions(input: Record<string, unknown>): AskQuestionItem[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const out: AskQuestionItem[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') return null;
    const { question, header, options, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== 'string' || !Array.isArray(options) || options.length < 2) return null;
    const opts: AskQuestionItem['options'] = [];
    for (const o of options) {
      if (!o || typeof o !== 'object') return null;
      const { label, description } = o as Record<string, unknown>;
      if (typeof label !== 'string' || label.trim() === '') return null;
      opts.push({ label, description: typeof description === 'string' ? description : '' });
    }
    out.push({
      question,
      header: typeof header === 'string' ? header : '',
      options: opts,
      multiSelect: multiSelect === true,
    });
  }
  return out;
}
