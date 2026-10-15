/**
 * approval-card.ts（permission-surface P0.1 / P1.1；plan-mode P1.2 起含 plan 变体）：
 * **单文件对话表面**上的「四边框审批卡」。
 *
 * 背景：旧实现是 `showOverlay({anchor:'bottom-center'})` 浮层，`bottom-*` 锚点相对**整屏**算
 * （pi-tui `tui.ts:2748`），而整屏底部正是 composer dock → 弹窗被顶到输入框**下方**、
 * 只有 3 行、且非 fullscreen 拼接有中文错行（详见 permission-surface/README.md）。
 * 现改为 omp 式**单文件对话表面**：弹窗换掉 `editorContainer` 里的输入框、占据它的槽位。
 * 本文件只负责「卡片本身」（长什么样 + 怎么按键），换装/还原在 `permission-overlay.ts`
 * 的 `DockSurface`。
 *
 * 两个变体（plan-mode P1.2 起）共用同一骨架 `ChoiceCard<T>`：
 * - `ApprovalCard`：工具权限确认（`y/a/n` + `↑↓Enter`）
 * - `PlanApprovalCard`：ExitPlanMode 审批（`1/2/3` + `↑↓Enter`，文案照 codebuddy 三选项）
 *
 * 骨架照 pi-tui 内置 `AskDialogComponent`（`overlays/ask-dialog.ts:610-619,694-727`）：
 * `OverlayPanel(title)` + 三个 `PanelRows` region（header / body / footer）+ 两个 `PanelDivider`；
 * `render(width)` 里先 `setLines` 再 `return panel.render(width)`。
 *
 * 双世界（AGENTS.md）：`OverlayPanel`/`PanelRows`/`PanelDivider` 来自 `chrome/overlay-box`
 * 子路径（types 落 `dist/types/` 的 dist 世界），主入口是 src 世界；运行时同一套实现，
 * 故跨边界处一律 `as unknown as` 并注明。
 */
import type { Component } from '@oh-my-pi/pi-tui';
import { OverlayPanel, PanelDivider, PanelRows } from '@oh-my-pi/pi-tui/chrome/overlay-box';
import { matchesKey } from '@oh-my-pi/pi-tui/keys.js';
import { visibleWidth } from '@oh-my-pi/pi-tui/utils.js';
import { theme } from '@oh-my-pi/pi-tui/theme';
import type { PermissionDecision, PermissionPrompt, PlanApproval } from '../permission/bridge';
import type { PlanApprovalChoice } from './plan-approval-inline';

/** 权限确认卡片顶边框标题（用户已知语义：这是「权限确认」而非「问答」） */
export const PERMISSION_CARD_TITLE = '权限确认';

/** 权限卡底边框上方的快捷键提示（dim） */
export const PERMISSION_CARD_HINT = '↑/↓ 选择 · Enter 确认 · Esc 拒绝';

/** plan 审批卡片顶边框标题（plan-mode P1.2，D1） */
export const PLAN_CARD_TITLE = '计划待批准';

/**
 * plan 卡底提示（cancel-stops-turn D1）：`Esc` = **取消并停下**（不再映射成「继续规划」）。
 * 行为与选项 2 相同（停下且留在 plan）—— 选项 2 的文案按 D6 逐字照 codebuddy 不动，
 * 差异用这句提示讲清。
 */
export const PLAN_CARD_HINT = '↑/↓ 选择 · Enter 确认 · 1/2/3 直选 · Esc 取消（停下并留在 plan）';

/**
 * 详情最多显示行数（D-C）。取 omp `ApprovalDialogComponent` 的 `MAX_DETAIL_ROWS`
 * （= pi-tui `PREVIEW_LIMITS.COLLAPSED_ITEMS` = 8）同值。
 *
 * **为什么不接 `ScrollView`（P1 对 D-C 推荐的修订）**：`↑/↓` 已被**选项光标**占用（D3 用户拍板），
 * 再给详情滚动会撞键。且 omp 原注释给出了同款理由 —— 「prompt stays compact, the transcript
 * has the call in full」：完整命令/参数在**上方工具卡**里始终可见，卡片只需给足判断依据。
 */
const MAX_DETAIL_ROWS = 8;

/** 光标行的选择标记（非 CJK，宽度安全；与 pi-tui selector 同款） */
const CURSOR_MARKER = '❯';

/** 选项定义（`label` 里 `{tool}` 是运行时替换位） */
interface CardOption<T> {
  choice: T;
  label: string;
  key: string;
}

/**
 * 三个权限选项的静态定义（顺序 = `y / a / n`，2026-10-14 用户拍板）。
 *
 * `deny` 文案照 codebuddy `TOOL_REJECT_RESULT_DISPLAY`（`No (tell CodeBuddy what to do
 * differently)`）改写成 omc 的中文形态 —— 用户 2026-10-14 拍板：拒绝 = **停下本轮**，
 * 由用户自己说明期望的做法（见 `PermissionBridge` 的普通 deny 分支）。
 */
export const PERMISSION_OPTIONS = [
  { choice: 'allow', label: '允许一次', key: 'y' },
  { choice: 'always', label: '本会话总是允许 {tool}', key: 'a' },
  { choice: 'deny', label: '拒绝，并告诉 omc 应该怎么做', key: 'n' },
] as const satisfies readonly CardOption<PermissionDecision>[];

/**
 * 三个 plan 选项（plan-mode P1.2，D2）：文案**逐字照 codebuddy** ExitPlanMode ConfirmBox
 * （`1. Yes` / `2. No, keep planning` / `3. Exit plan mode`）—— 用户就是拿 codebuddy 的
 * 三选项截图提的需求，选项本体保持原样最好认；`key` 留空（编号已在 label 里，不再画 `[x]` 列）。
 */
export const PLAN_OPTIONS = [
  { choice: 'yes', label: '1. Yes', key: '' },
  { choice: 'keep', label: '2. No, keep planning', key: '' },
  { choice: 'exit', label: '3. Exit plan mode', key: '' },
] as const satisfies readonly CardOption<PlanApprovalChoice>[];

/** plan 卡的追问行（= codebuddy ConfirmBox 的 `confirmTitle`） */
export const PLAN_CARD_PROMPT = 'Would you like to proceed?';

/**
 * 单条选项行：`❯ 允许一次                         [y]`
 * `key` 列右对齐到 `width`；光标行整体 accent + bold（可见高亮）。
 * `key` 为空（plan 变体：编号已写进 label）→ 只画 label 本身。
 */
function optionLine(label: string, key: string, selected: boolean, width: number): string {
  const marker = selected ? CURSOR_MARKER : ' ';
  const left = `${marker} ${label}`;
  let line = left;
  if (key) {
    const k = `[${key}]`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(k));
    line = `${left}${' '.repeat(gap)}${k}`;
  }
  return selected ? theme.bold(theme.fg('accent', line)) : theme.fg('dim', line);
}

/**
 * 选择型审批卡的共用骨架（permission / plan 两变体共享，plan-mode P1.2）：
 * 卡片结构 = `╭─ title ─╮ / │ header │ / ├───┤ / │ ❯ 选项… │ / ├───┤ / │ hint │ / ╰─╯`；
 * 光标（↑↓ 夹紧）与 `Enter 确认光标项` 由本类实现；**单键直通道**（`y/n/a` 或 `1/2/3`）
 * 由子类 `pickSpecialKey` 给出（优先于光标通道，保留既有肌肉记忆）。
 */
abstract class ChoiceCard<T> implements Component {
  #cursor = 0;
  readonly #panel: OverlayPanel;
  readonly #headerRegion: PanelRows;
  readonly #optionRegion: PanelRows;
  readonly #footerRegion: PanelRows;

  protected constructor(
    title: string,
    id: string,
    private readonly onPick: (choice: T) => void,
    /** 光标移动后重绘（缺省不崩：单测/探针无需真 TUI） */
    private readonly requestRender?: () => void,
  ) {
    this.#panel = new OverlayPanel(title, id);
    this.#headerRegion = new PanelRows();
    this.#optionRegion = new PanelRows();
    this.#footerRegion = new PanelRows();
    this.#footerRegion.setHeight(1);
    this.#panel.addChild(this.#headerRegion);
    this.#panel.addChild(new PanelDivider());
    this.#panel.addChild(this.#optionRegion);
    this.#panel.addChild(new PanelDivider());
    this.#panel.addChild(this.#footerRegion);
  }

  /** 选项表（子类给静态表；`{tool}` 之类的替换位由子类在 getter 里展开） */
  protected abstract get options(): readonly CardOption<T>[];
  /** header 区内容行（子类自绘：工具名/详情，或计划路径/提示） */
  protected abstract headerLines(innerWidth: number): readonly string[];
  /** footer 区的快捷键提示（dim） */
  protected abstract get hint(): string;
  /** 单键直通道（无匹配返回 undefined → 落光标/Enter 通道） */
  protected abstract pickSpecialKey(data: string): T | undefined;

  /** 当前光标所在选项（单测/探针可读） */
  get cursorIndex(): number {
    return this.#cursor;
  }

  render(width: number): readonly string[] {
    // 与 OverlayPanel.render 同口径：内容区宽 = width - 4（两侧 `│ ` + ` │`）
    const innerWidth = Math.max(1, width - 4);
    const opts = this.options;
    this.#headerRegion.setLines([...this.headerLines(innerWidth)]);
    this.#optionRegion.setLines(opts.map((o, i) => optionLine(o.label, o.key, i === this.#cursor, innerWidth)));
    this.#footerRegion.setLines([theme.fg('dim', this.hint)]);
    return this.#panel.render(width);
  }

  /**
   * 双通道按键（用户 2026-10-14 拍板；plan 变体沿用）：
   *   ① 单键直通道 —— **优先级最高**，保留既有肌肉记忆（`Esc` 必须能收口，防悬挂）
   *   ② 光标通道 `↑/↓` 移动 + `Enter` 确认光标项（`Enter` 三写法都判，照 `ask-dialog.ts:1217`）
   * 无关键**不吞**（不 return consume 语义由焦点组件模型天然成立：焦点在卡片上即独占）。
   */
  handleInput(data: string): void {
    const special = this.pickSpecialKey(data);
    if (special !== undefined) return this.#pick(special);
    if (matchesKey(data, 'up')) this.#cursor = Math.max(0, this.#cursor - 1);
    else if (matchesKey(data, 'down')) this.#cursor = Math.min(this.options.length - 1, this.#cursor + 1);
    else if (matchesKey(data, 'enter') || matchesKey(data, 'return') || data === '\n') {
      const opt = this.options[this.#cursor];
      if (opt) return this.#pick(opt.choice);
      return;
    } else return; // 无关键：不吞、不重绘
    this.requestRender?.();
  }

  #pick(choice: T): void {
    this.onPick(choice);
  }

  dispose(): void {
    this.#panel.dispose();
  }

  invalidate(): void {
    this.#panel.invalidate();
  }
}

/**
 * 工具权限确认卡（pi-tui `Component`）。
 *
 * 结构：`╭─ 权限确认 ─╮ / │ ⏺ <tool> 请求权限 │ │   <details> │ / ├───┤ / │ ❯ 选项… │ / ├───┤ /
 * │ ↑/↓ … │ / ╰─╯`
 */
export class ApprovalCard extends ChoiceCard<PermissionDecision> {
  readonly #options: readonly CardOption<PermissionDecision>[];

  constructor(
    private readonly prompt: PermissionPrompt,
    decide: (d: PermissionDecision) => void,
    requestRender?: () => void,
  ) {
    super(PERMISSION_CARD_TITLE, 'omp.overlay.permission', decide, requestRender);
    this.#options = PERMISSION_OPTIONS.map((o) => ({
      choice: o.choice,
      label: o.label.replace('{tool}', prompt.toolName),
      key: o.key,
    }));
  }

  protected get options(): readonly CardOption<PermissionDecision>[] {
    return this.#options;
  }

  protected headerLines(innerWidth: number): readonly string[] {
    void innerWidth;
    const header: string[] = [theme.fg('warning', `⏺ ${this.prompt.toolName} 请求权限`)];
    // 与旧浮层同口径：details 为空才回落显示 summary（避免重复）
    const details =
      this.prompt.details.length > 0 ? this.prompt.details : this.prompt.summary ? [this.prompt.summary] : [];
    for (const d of details.slice(0, MAX_DETAIL_ROWS)) header.push(theme.fg('dim', `  ${d}`));
    const hidden = details.length - MAX_DETAIL_ROWS;
    if (hidden > 0) header.push(theme.fg('dim', `  …（还有 ${hidden} 行，完整内容见上方工具卡）`));
    return header;
  }

  protected get hint(): string {
    return PERMISSION_CARD_HINT;
  }

  protected pickSpecialKey(data: string): PermissionDecision | undefined {
    if (matchesKey(data, 'y')) return 'allow';
    if (matchesKey(data, 'n')) return 'deny';
    if (matchesKey(data, 'a')) return 'always';
    if (matchesKey(data, 'escape')) return 'deny';
    return undefined;
  }
}

/**
 * ExitPlanMode 审批卡（plan-mode P1.2，D1/D-D）：与权限卡同款四边框/光标/键框架，
 * 只给「标题 + 计划文件 + 一句提示 + 三选项」——**计划全文留在转录区** `PlanMarkdownCard`
 * （表面卡限高，避免超高内容被 transcript 退休机制冻结）。
 */
export class PlanApprovalCard extends ChoiceCard<PlanApprovalChoice> {
  constructor(
    private readonly plan: PlanApproval,
    decide: (choice: PlanApprovalChoice) => void,
    requestRender?: () => void,
  ) {
    super(PLAN_CARD_TITLE, 'omp.overlay.plan-approval', decide, requestRender);
  }

  protected get options(): readonly CardOption<PlanApprovalChoice>[] {
    return PLAN_OPTIONS;
  }

  protected headerLines(): readonly string[] {
    const out: string[] = [theme.fg('warning', '⏺ 计划待批准')];
    if (this.plan.planFilePath) out.push(theme.fg('dim', `  ${this.plan.planFilePath}`));
    // codebuddy ConfirmBox 的追问行（逐字）→ 冒烟/真机按它定位表面卡
    out.push(theme.fg('muted', `  ${PLAN_CARD_PROMPT}`));
    out.push(theme.fg('dim', '  计划全文见上方计划卡（转录区）'));
    return out;
  }

  protected get hint(): string {
    return PLAN_CARD_HINT;
  }

  protected pickSpecialKey(data: string): PlanApprovalChoice | undefined {
    // cancel-stops-turn D1：`Esc` = 取消（停下并留在 plan）—— 与选项 2 行为相同
    // （D3 后选项 2 也一停到底），故直接复用 `keep`（不解钉 + denyStop）。
    if (matchesKey(data, 'escape')) return 'keep';
    if (matchesKey(data, '1')) return 'yes';
    if (matchesKey(data, '2')) return 'keep';
    if (matchesKey(data, '3')) return 'exit';
    return undefined;
  }
}
