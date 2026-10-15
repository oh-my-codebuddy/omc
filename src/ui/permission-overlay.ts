/**
 * permission-overlay.ts（M3.1）：canUseTool 权限确认弹窗。
 *
 * PermissionOverlay implements pi-tui Component：
 * - render 复刻 MVP PermissionDialog 行内容（工具名 + summary/details + y/n/a 提示），
 *   theme.fg 上色；先截断后上色（native truncate 对未上色纯文本最安全）
 * - handleInput 用 pi-tui matchesKey：y=allow / n=deny / a=always / Esc=deny（防悬挂）
 *
 * 挂接（attachPermissionOverlay）：permBridge.addChangeListener 里 pending 出现 → 装机、消失 → 拆机。
 * - permission → **「单文件对话表面」**（permission-surface P1.2）：换掉输入框、占据 dock 槽位，
 *   装上四边框 `ApprovalCard`（`y/n/a/Esc` + `↑↓Enter`）；无 `editorContainer` 时回落旧 `PermissionOverlay` 浮层
 * - **ask → 「单文件对话表面」**（ask-dialog-surface P1.3）：换掉输入框、占据 dock 槽位，
 *   不再走浮层（旧自研 `AskQuestionOverlay` 已删）
 * - **plan → 「单文件对话表面」**（plan-mode P1.2）：换掉输入框、装 `PlanApprovalCard` 三选项；
 *   无表面宿主时回落内联三选项卡（再缺回落浮层）
 */
import type { Component, Container, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import type { TranscriptContainer } from '@oh-my-pi/pi-tui/chrome/transcript-container.js';
import { matchesKey } from '@oh-my-pi/pi-tui/keys.js';
import { truncateToWidth } from '@oh-my-pi/pi-tui/utils.js';
import { theme } from '@oh-my-pi/pi-tui/theme';
import type { PermissionBridge, PermissionDecision, PermissionPrompt, PlanApproval } from '../permission/bridge';
import { ApprovalCard, PlanApprovalCard } from './approval-card';
import { AskSurface, createAskDialog, type AskSurfaceTui } from './ask-question-overlay';
import { PlanApprovalInline, type PlanApprovalChoice } from './plan-approval-inline';

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export class PermissionOverlay implements Component {
  constructor(
    private prompt: PermissionPrompt,
    private decide: (d: 'allow' | 'deny' | 'always') => void,
  ) {}

  render(width: number): readonly string[] {
    const w = Math.max(1, width);
    const lines: string[] = [];
    lines.push(theme.fg('warning', truncateToWidth(`⏺ ${this.prompt.toolName} 请求权限`, w)));
    if (this.prompt.summary && this.prompt.details.length === 0) {
      lines.push(theme.fg('dim', truncateToWidth(`  ${this.prompt.summary}`, w)));
    }
    for (const d of this.prompt.details) {
      lines.push(theme.fg('dim', truncateToWidth(d, w)));
    }
    // 选项文案与 `ApprovalCard` 同序同文（`y / a / n`）；拒绝项是「停下本轮，由用户说明」，
    // 与 codebuddy `No, and tell CodeBuddy what to do differently` 同义（omc 中文形态）。
    // 整行可能超宽（窄终端）→ 最后统一截断（pi-tui truncateToWidth 认 ANSI）。
    lines.push(
      truncateToWidth(
        `${BOLD}[y]${RESET}${theme.fg('dim', ' 允许一次  ')}${BOLD}[a]${RESET}${theme.fg('dim', ` 本会话总是允许 ${this.prompt.toolName}  `)}${BOLD}[n]${RESET}${theme.fg('dim', ' 拒绝，并告诉 omc 应该怎么做')}`,
        w,
      ),
    );
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'y')) this.decide('allow');
    else if (matchesKey(data, 'n')) this.decide('deny');
    else if (matchesKey(data, 'a')) this.decide('always');
    else if (matchesKey(data, 'escape')) this.decide('deny');
  }
}

/**
 * 权限确认的「单文件对话表面」宿主接线（照 `AskSurface` 同构）。
 *
 * 只做「换子件 + 还焦」两件事：`container` 平时只装 `editor`，表面激活期换成审批卡。
 * 换装/还原由 `sync()` 统一驱动（同 ask 表面）。
 */
export interface PermissionSurfaceHost {
  /** 宿主 TUI（只用到 `setFocus` / `requestRender`；`unknown` 形参避免双世界类型纠缠） */
  tui: { setFocus(component: unknown): void; requestRender(): void };
  /** 编辑器所在容器（`app.ts` 的 `editorContainer`）——换子件只发生在容器内部 */
  container: Container;
  /** 被换下的编辑器组件 */
  editor: Component;
  /** 表面激活位变化（app 层据此让位全局抢键监听 + 重算状态栏） */
  onActiveChange?: (active: boolean) => void;
}

/**
 * 「单文件对话表面」宿主（permission-surface P1.2；plan-mode P1.2 起泛化）：
 * 激活时**换掉输入框**、装上给定卡片，占据 dock 里原本属于输入框的位置（不再被顶到下方）。
 * 不实现 `Component`（它是 dock 槽位的**替换器**，不是被渲染的组件本身）。
 *
 * 卡片由 `createCard` 工厂给出 —— permission 装 `ApprovalCard`、plan 装 `PlanApprovalCard`，
 * 换装/还焦/幂等逻辑完全共用（D-C：泛化而非新造机制）。
 */
export class DockSurface {
  #card: Component | undefined;
  #active = false;

  constructor(
    private readonly host: PermissionSurfaceHost,
    private readonly createCard: () => Component,
  ) {}

  /** 换掉输入框、装上卡片。重复调用无副作用。 */
  mount(): void {
    if (this.#active) return;
    this.#active = true;
    const card = this.createCard();
    this.#card = card;
    this.#swap(card);
    this.host.onActiveChange?.(true);
  }

  /** 还原输入框 + 还焦。**幂等**（`sync()` 在 permission↔ask↔plan 切换 / pending 清空 / detach 都会调）。 */
  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    (this.#card as { dispose?: () => void } | undefined)?.dispose?.();
    this.#card = undefined;
    this.#swap(this.host.editor);
    this.host.onActiveChange?.(false);
  }

  /** 把容器内容换成 `child` 并接管焦点（唯一的「换表面」动作） */
  #swap(child: Component): void {
    const { tui, container } = this.host;
    container.clear();
    // 强转：`Container` 来自主入口（dist 世界），card/editor 是 src 世界组件；运行时同一套（AGENTS.md 双世界）
    container.addChild(child as unknown as Parameters<Container['addChild']>[0]);
    tui.setFocus(child);
    tui.requestRender();
  }
}

/** 工具权限确认表面（`DockSurface` + `ApprovalCard`；保留具名类供探针/单测直接使用） */
export class PermissionSurface extends DockSurface {
  constructor(
    host: PermissionSurfaceHost,
    prompt: PermissionPrompt,
    decide: (d: PermissionDecision) => void,
  ) {
    super(host, () => new ApprovalCard(prompt, decide, () => host.tui.requestRender()));
  }
}

/** ExitPlanMode 审批表面（`DockSurface` + `PlanApprovalCard`；plan-mode P1.2） */
export class PlanSurface extends DockSurface {
  constructor(
    host: PermissionSurfaceHost,
    plan: PlanApproval,
    decide: (choice: PlanApprovalChoice) => void,
  ) {
    super(host, () => new PlanApprovalCard(plan, decide, () => host.tui.requestRender()));
  }
}

/**
 * Plan 审批浮层（plan-approval P1.3，**最小可用版**）：展示计划全文前若干行 + 批准/拒绝。
 * 高度限 `MAX_LINES`（对齐项目教训：非 fullscreen 浮层 + 超高会被退休冻结）；
 * P2 将替换为专用可滚动浮层（含 `allowedPrompts`、`/plan` 查看）。
 */
const PLAN_PREVIEW_LINES = 14;

export class PlanApprovalOverlay implements Component {
  constructor(
    private plan: PlanApproval,
    private decide: (approve: boolean) => void,
  ) {}

  render(width: number): readonly string[] {
    const w = Math.max(1, width);
    const lines: string[] = [];
    lines.push(theme.fg('warning', truncateToWidth('⏺ 计划待批准（Plan 模式）', w)));
    if (this.plan.planFilePath) {
      lines.push(theme.fg('dim', truncateToWidth(`  ${this.plan.planFilePath}`, w)));
    }
    const body = this.plan.content ? this.plan.content.split('\n') : ['（未取到计划内容）'];
    for (const l of body.slice(0, PLAN_PREVIEW_LINES)) {
      lines.push(truncateToWidth(`  ${l}`, w));
    }
    if (body.length > PLAN_PREVIEW_LINES) {
      lines.push(theme.fg('dim', truncateToWidth(`  …（共 ${body.length} 行，全部内容见计划文件）`, w)));
    }
    lines.push(
      `${BOLD}[y]${RESET}${theme.fg('dim', ' 批准并执行  ')}${BOLD}[n]${RESET}${theme.fg('dim', ' 拒绝（留在 plan 模式）')}`,
    );
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'y')) this.decide(true);
    else if (matchesKey(data, 'n')) this.decide(false);
    else if (matchesKey(data, 'escape')) this.decide(false);
  }
}

/** 内联计划审批的宿主接线（P2.2；缺 transcript 时回落浮层） */
export interface PlanInlineOptions {
  /** 转录区容器（有则计划审批走内联 addChild + setFocus） */
  transcript?: TranscriptContainer;
  /** 决策后还焦输入框（内联无 overlay 焦点栈，必须手动还焦） */
  restoreFocus?: () => void;
  /** 内联审批激活位（app 层据此让位全局 ↓ / Shift+Tab 抢键） */
  onInlineActiveChange?: (active: boolean) => void;
  /**
   * ask 表面宿主（ask-dialog-surface P1.3）：`app.ts` 的 `editorContainer`（内含 editor）。
   * 两者缺一 → ask 回落「浮层 + 内置 dialog」（老调用方 / 测试路径，不会挂会话）。
   */
  editorContainer?: Container;
  editor?: Component;
  /** ask 表面激活位（app 层据此让位全局抢键监听，与 `onInlineActiveChange` 并列） */
  onAskSurfaceActiveChange?: (active: boolean) => void;
  /** ask dialog 组件变化（null = 已拆）；app 层据此把 Ctrl+O 转给 `toggleQuestionExpansion` */
  onAskDialogChange?: (dialog: { toggleQuestionExpansion(): boolean } | null) => void;
  /** 权限表面激活位（permission-surface P1.3；app 层据此让位全局抢键 + 重算状态栏） */
  onPermSurfaceActiveChange?: (active: boolean) => void;
  /** plan 表面激活位（plan-mode P1.2；同上 —— 换表面后无 overlay，护栏必须靠激活位） */
  onPlanSurfaceActiveChange?: (active: boolean) => void;
}

/**
 * addChangeListener 挂接：pending 出现/变化 → 装（先拆旧的），消失 → 拆。
 * pending.kind 分派：
 *   - permission → y/n/a 浮层（焦点栈自动恢复）；
 *   - ask → **单文件对话表面**（换掉输入框；无 container 时回落浮层）；
 *   - plan → **内联三选项**（有 `opts.transcript`，P2.2，复刻 codebuddy）；无则回落浮层。
 * 返回 detach（测试与 stop 路径用）。
 *
 * **拆机统一在 sync() 顶部**：`handle`（overlay）/ `askSurface` / `permSurface` 都先无条件拆
 * （各自幂等），再按新 pending 装 —— 这一条规则同时覆盖「permission↔ask↔plan 切换 / pending
 * 清空 / detach」，避免多套拆机逻辑分叉（也是「表面唯一拥有者 = sync」的落地）。
 */
export function attachPermissionOverlay(
  tui: TUI,
  permBridge: PermissionBridge,
  opts: PlanInlineOptions = {},
): () => void {
  let handle: OverlayHandle | null = null;
  /** 已挂的内联计划卡（避免 sync 重复 addChild） */
  let inline: PlanApprovalInline | null = null;
  /** 已挂的 ask 表面（ask-dialog-surface P1.3） */
  let askSurface: AskSurface | null = null;
  /** 已挂的权限表面（permission-surface P1.2） */
  let permSurface: PermissionSurface | null = null;
  /** 已挂的 plan 表面（plan-mode P1.2） */
  let planSurface: PlanSurface | null = null;
  const sync = (): void => {
    const pending = permBridge.pending;
    if (handle) {
      handle.hide();
      handle = null;
    }
    // 先统一拆 ask 表面（幂等）：dispose 会把 editor 装回 container 并还焦 → 天然处理
    // 「上一轮 ask 的 editor 还留在 container 里」的残留
    askSurface?.dispose();
    askSurface = null;
    // 同理拆权限表面（幂等）
    permSurface?.dispose();
    permSurface = null;
    // 同理拆 plan 表面（幂等）
    planSurface?.dispose();
    planSurface = null;
    if (pending?.kind === 'permission') {
      const container = opts.editorContainer;
      const editor = opts.editor;
      if (container && editor) {
        // permission-surface P1.2：omp 式**单文件对话表面** —— 换掉输入框、占据它的 dock 槽位
        // （不再 `showOverlay({anchor:'bottom-center'})` 被顶到 dock 之下）
        const surface = new PermissionSurface(
          {
            tui,
            container,
            editor,
            onActiveChange: opts.onPermSurfaceActiveChange,
          },
          pending.prompt,
          (d) => permBridge.decide(d),
        );
        permSurface = surface;
        surface.mount();
      } else {
        // 回落：无表面宿主（老调用方 / 单测 / 小屏）→ 旧浮层，行为不变
        handle = tui.showOverlay(new PermissionOverlay(pending.prompt, (d) => permBridge.decide(d)), {
          anchor: 'bottom-center',
          width: '80%',
        });
      }
    } else if (pending?.kind === 'ask') {
      const container = opts.editorContainer;
      const editor = opts.editor;
      if (container && editor) {
        const surface = new AskSurface(
          {
            // 强转：`AskSurfaceTui` 是 `overlays/*` 子路径的 dist d.ts 世界，tui 是 src 世界
            // （运行时同一套实现，双世界见 AGENTS.md）
            tui: tui as unknown as AskSurfaceTui,
            container,
            editor,
            onActiveChange: opts.onAskSurfaceActiveChange,
            onChange: opts.onAskDialogChange,
          },
          pending.questions,
          (answers) => permBridge.decideAsk(answers),
          () => permBridge.cancelAsk(),
        );
        askSurface = surface;
        surface.mount();
      } else {
        // 回落：无表面宿主（老调用方 / 小屏）→ 浮层装**同一个内置 dialog**（不再自研）。
        // `onPrompt` 缺省 → `Other` / `n` 输入被忽略（降级），但不会挂会话。
        type SrcComponent = Parameters<typeof tui.showOverlay>[0];
        handle = tui.showOverlay(
          createAskDialog(pending.questions, tui as unknown as AskSurfaceTui, {
            decide: (answers) => permBridge.decideAsk(answers),
            cancel: () => permBridge.cancelAsk(),
          }) as unknown as SrcComponent,
          { anchor: 'bottom-center', width: '80%' },
        );
      }
    } else if (pending?.kind === 'plan') {
      if (inline || planSurface) return; // 已挂，等决策
      const container = opts.editorContainer;
      const editor = opts.editor;
      if (container && editor) {
        // plan-mode P1.2（D1）：与权限确认同款**单文件对话表面** —— 换掉输入框、装上
        // `PlanApprovalCard`（三选项）；计划正文仍在转录区（`PlanMarkdownCard`）
        const surface = new PlanSurface(
          {
            tui,
            container,
            editor,
            onActiveChange: opts.onPlanSurfaceActiveChange,
          },
          pending.plan,
          (choice) => onInlinePick(choice),
        );
        planSurface = surface;
        surface.mount();
      } else if (opts.transcript) {
        // 回落：无表面宿主 → 内联三选项（老调用方 / 单测路径，行为不变）
        const card = new PlanApprovalInline((choice) => onInlinePick(choice));
        inline = card;
        opts.transcript.addChild(card);
        tui.setFocus(card);
        opts.onInlineActiveChange?.(true);
        tui.requestRender();
      } else {
        // 兜底浮层（无 transcript / 小屏）
        handle = tui.showOverlay(new PlanApprovalOverlay(pending.plan, (approve) => permBridge.decidePlan(approve)), {
          anchor: 'bottom-center',
          width: '80%',
        });
      }
    } else {
      // pending 清空：内联卡已在决策时自封，仅清引用
      inline = null;
    }
  };

  /**
   * 三选项选择（plan-mode P1.3）：先复位宿主侧状态（还焦 / 激活位），再下发决策。
   * 表面路径的「还原 editor + 还焦」由 `sync()` 顶部统一拆机完成（`decidePlan*` → `notifyChange`
   * → `sync()`），此处只需处理内联路径与激活位。
   */
  const onInlinePick = (choice: PlanApprovalChoice): void => {
    inline = null;
    opts.restoreFocus?.();
    opts.onInlineActiveChange?.(false);
    if (choice === 'yes') permBridge.decidePlan(true);
    else if (choice === 'exit') void permBridge.decidePlanExit();
    else permBridge.decidePlan(false);
    tui.requestRender();
  };

  const detach = permBridge.addChangeListener(sync);
  return () => {
    detach();
    if (handle) {
      handle.hide();
      handle = null;
    }
    // stop / 重挂路径：**必须**拆 ask 表面 —— 否则 editor 留在 container 外，
    // 重挂后（或 stop 后）输入框永久消失且焦点锁在已 dispose 的 dialog 上。
    askSurface?.dispose();
    askSurface = null;
    // 同理：权限表面不拆 → 输入框同样永久消失（且 pending 悬挂）
    permSurface?.dispose();
    permSurface = null;
    // 同理：plan 表面不拆 → 输入框同样永久消失
    planSurface?.dispose();
    planSurface = null;
    inline = null;
  };
}
