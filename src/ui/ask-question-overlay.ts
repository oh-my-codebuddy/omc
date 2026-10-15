/**
 * ask-question-overlay.ts（M4.6 立项；ask-dialog-surface P1.2 改写）。
 *
 * AskUserQuestion 弹窗从「bottom-center 浮层（压住输入框 + 非 fullscreen 拼接中文错行）」
 * 改为 **omp 式单文件对话表面**：弹出时换掉输入框、占据它在 dock 的位置（`editorContainer`），
 * statusline 保留在下方；交互层**直接用 pi-tui 内置 `AskDialogComponent`**（不再自研）。
 *
 * 生命周期（唯一拥有者 = `attachPermissionOverlay` 的 `sync()`）：
 *   mount()   → container.clear() → addChild(askDialog) → setFocus(askDialog)
 *   dispose() → askDialog.dispose() → clear() → addChild(editor) → setFocus(editor)
 * `dispose()` **幂等**（重复调用只还原一次），因为 `sync()` 在 permission↔ask 切换、
 * detach、pending 清空三条路径上都会调它。
 *
 * 两个数据映射纯函数独立导出，便于表驱动单测：
 *   toExtensionQuestions  omc `AskQuestionItem[]` → pi-tui `ExtensionAskDialogQuestion[]`
 *   toAnswers             pi-tui `results[]`       → CLI `answers`（**键 = question 原文**）
 *
 * 双世界（AGENTS.md）：`overlays/*` 子路径的 `types` 落 `dist/types/*.d.ts`（dist 世界），
 * 主入口 `@oh-my-pi/pi-tui` 是 src 世界；运行时同一套实现，故**类型一律用
 * `ConstructorParameters<typeof AskDialogComponent>[n]` 取**（深路径 import 类型会落回 dist 世界）。
 */
import type { Component } from '@oh-my-pi/pi-tui';
import type { Container } from '@oh-my-pi/pi-tui';
import { AskDialogComponent } from '@oh-my-pi/pi-tui/overlays/ask-dialog';
import { HookEditorComponent } from '@oh-my-pi/pi-tui/overlays/hook-editor';
import type { AskQuestionItem } from '../permission/bridge';

/** `AskDialogComponent` 的构造签名（types 落 dist 世界，故全部由此派生） */
type DialogCtor = ConstructorParameters<typeof AskDialogComponent>;
/** 题目模型 */
export type DialogQuestions = DialogCtor[0];
type DialogCallbacks = DialogCtor[1];
/** 构造第三参可省略 → 类型上是 `AskDialogOptions | undefined`，取非空 */
type DialogOptions = NonNullable<DialogCtor[2]>;
/** 内置 dialog 的提交回调载荷 */
export type DialogSubmitResult = Parameters<DialogCallbacks['onSubmit']>[0];
/** 内置 dialog 的单题结果 */
export type DialogResultItem = DialogSubmitResult['results'][number];
/** 宿主 TUI（dist 世界类型；app.ts 侧 `as unknown as` 一次） */
export type AskSurfaceTui = NonNullable<DialogOptions['tui']>;
type HostTui = AskSurfaceTui;
/** 容器/焦点槽位认的组件类型（dist 世界） */
type DistComponent = Parameters<HostTui['setFocus']>[0];

/** 备注是否折叠进答案（D7，2026-10-12 按计划推荐落地：CLI `answers` 只收字符串，丢弃用户输入更糟） */
const NOTE_INLINE = true;

/**
 * omc 展示模型 → pi-tui 内置题目模型。
 * - `id`：内置组件必填，omc 侧无 id → 用下标合成
 * - `header` / `description` 空串 → `undefined`（避免渲染出空行）
 * - `recommended`：**不传** —— 内置默认光标落首项（P0 实证 recommended 只影响初始光标）
 */
export function toExtensionQuestions(items: readonly AskQuestionItem[]): DialogQuestions {
  return items.map((q, index) => ({
    id: String(index),
    question: q.question,
    header: q.header ? q.header : undefined,
    options: q.options.map((o) => ({ label: o.label, description: o.description ? o.description : undefined })),
    multi: q.multiSelect,
  }));
}

/**
 * pi-tui 结果 → CLI `answers`。
 *
 * | 场景 | 值 |
 * |---|---|
 * | 单选 + 选中 | `selectedOptions[0]` |
 * | 单选 + 自定义 | `customInput`（内置组件在单选走 Other 时会 clear 掉 selectedOptions） |
 * | 多选 | `selectedOptions.join(', ')`，选中 Other 时追加 `Other: "<自定义>"` |
 * | `note`（`n` 备注） | 折叠为 `值 （备注：<note>）`（D7） |
 * | 该题两者皆空 | **跳过该题** |
 * | 全部为空 | 返回 `null` → 调用方**必须** `cancelAsk()` |
 *
 * **为什么全空要返回 null**：CLI `AskUserQuestion.execute()` 里
 * `if (t.answers && Object.keys(t.answers).length > 0) i = t.answers;`
 * —— 空对象等价于「没给答案」，CLI 侧 `hasAskAnswers` 抛错挂会话（2026-09-30 真机事故同源）。
 *
 * P0 实测补充：**多选 tab 的 Enter 只「确认并前进」，空格才 toggle** → 全程回车会得到
 * `selectedOptions: []` 的空结果，故「跳过该题 / 全空 → null」这条路径是真实可达的。
 */
export function toAnswers(results: readonly DialogResultItem[]): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const r of results) {
    const parts = [...r.selectedOptions];
    const custom = r.customInput?.trim();
    if (custom) parts.push(`Other: "${custom}"`);
    if (parts.length === 0) continue; // 该题两者皆空 → 跳过（不产生空串答案）
    let value = parts.join(', ');
    const note = r.note?.trim();
    if (NOTE_INLINE && note) value = `${value} （备注：${note}）`;
    answers[r.question] = value;
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

/** 表面宿主接线（app.ts 提供） */
export interface AskSurfaceHost {
  /** 宿主 TUI（用 `setFocus` / `requestRender` / `terminal.rows`） */
  tui: HostTui;
  /** 编辑器所在容器（`app.ts` 的 `editorContainer`）——换子件只发生在容器内部 */
  container: Container;
  /** 被换下的编辑器组件（src 世界组件，直接用） */
  editor: Component;
  /** 激活位变化（app 层据此让位全局抢键监听，同 `planInlineActive`） */
  onActiveChange?: (active: boolean) => void;
  /** 当前 dialog 组件变化（null = 已拆）；app 层据此把 Ctrl+O 转给 `toggleQuestionExpansion` */
  onChange?: (dialog: { toggleQuestionExpansion(): boolean } | null) => void;
}

/** 提交结果的共享消费逻辑（表面与兜底浮层共用） */
export interface AskSubmitHooks {
  decide(answers: Record<string, string>): void;
  cancel(): void;
}

/**
 * 消费内置 dialog 的提交载荷：`chat` → `_action` 三分支之一；否则映射 answers，**全空 ⇒ cancel**。
 *
 * `chat` 分支是**防御性**的：内置组件当前没有任何代码路径产出 `{kind:'chat'}`
 * （全文只有类型声明，`ask-dialog.ts:65`；P0 实证），但 CLI 侧确实消费
 * `_action: 'chat_about_this'`（D6 实证），故保留以免上游补上该路径时静默丢事件。
 */
export function submitAskResult(result: DialogSubmitResult, hooks: AskSubmitHooks): void {
  if ((result as { kind?: string }).kind === 'chat') {
    hooks.decide({ _action: 'chat_about_this' });
    return;
  }
  const answers = toAnswers(result.results);
  if (!answers) {
    hooks.cancel(); // 全空 ⇒ cancelAsk（= deny）：空 answers 会让 CLI `hasAskAnswers` 抛错挂会话
    return;
  }
  hooks.decide(answers);
}

/** dialog 的宿主钩子（`onPrompt` 缺省 → 内置组件放弃自定义输入） */
export interface AskDialogHooks extends AskSubmitHooks {
  onPrompt?(title: string, prefill?: string): Promise<string | undefined>;
}

/**
 * 构造内置问答 dialog（表面与兜底浮层共用；`tui` 必须传，否则内部状态变化不重绘）。
 */
export function createAskDialog(
  questions: readonly AskQuestionItem[],
  tui: HostTui,
  hooks: AskDialogHooks,
): AskDialogComponent {
  return new AskDialogComponent(
    toExtensionQuestions(questions),
    {
      onSubmit: (result) => submitAskResult(result, hooks),
      onCancel: () => hooks.cancel(),
      // `onPrompt` 在回调类型里必填；缺省时返回 undefined = 放弃本次输入（`#promptForCustomInput` 直接 return）
      onPrompt: hooks.onPrompt ?? (async () => undefined),
    },
    { tui },
  );
}

/**
 * AskUserQuestion 的「单文件对话表面」。
 * 不实现 `Component`（它是 dock 槽位的**替换器**，不是被渲染的组件本身）。
 */
export class AskSurface {
  #dialog: AskDialogComponent | undefined;
  #active = false;

  constructor(
    private readonly host: AskSurfaceHost,
    private readonly questions: readonly AskQuestionItem[],
    private readonly decide: (answers: Record<string, string>) => void,
    private readonly cancel: () => void,
  ) {}

  /** 换掉输入框、装上内置问答 dialog。重复调用无副作用。 */
  mount(): void {
    if (this.#active) return;
    this.#active = true;
    const dialog = createAskDialog(this.questions, this.host.tui, {
      decide: (answers) => this.decide(answers),
      cancel: () => this.cancel(),
      onPrompt: (title, prefill) => this.#prompt(title, prefill),
    });
    this.#dialog = dialog;
    this.#swap(dialog);
    this.host.onActiveChange?.(true);
    this.host.onChange?.(dialog);
  }

  /** 透传 Ctrl+O：无内容可展开时返回 false，让全局监听继续走工具卡展开（镜像 pi-tui `:642-648`） */
  toggleQuestionExpansion(): boolean {
    return this.#dialog?.toggleQuestionExpansion() ?? false;
  }

  /** 还原输入框 + 还焦。**幂等**（`sync()` 在三条路径上都会调）。 */
  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#dialog?.dispose();
    this.#dialog = undefined;
    this.#swap(this.host.editor);
    this.host.onChange?.(null);
    this.host.onActiveChange?.(false);
  }

  /**
   * `Other (type your own)` 与 `n`（备注）的输入框：**在同一 container 内再换一次表面**
   * （照 omp `controllers/extension-ui-controller.ts:705-722`），提交/取消后换回 dialog 并还焦。
   * 返回 `undefined` 表示用户取消输入。
   */
  async #prompt(title: string, prefill?: string): Promise<string | undefined> {
    const { tui, container } = this.host;
    let settle: ((value: string | undefined) => void) | undefined;
    const answered = new Promise<string | undefined>((resolve) => {
      settle = resolve;
    });
    const rows = tui.terminal?.rows ?? 40;
    const prompt = new HookEditorComponent(
      tui,
      title,
      prefill,
      (value) => settle?.(value),
      () => settle?.(undefined),
      // `promptStyle: true` = ask 风格（Enter 提交 / Shift+Enter 换行）；高度留出 dialog chrome。
      { promptStyle: true, maxHeight: Math.max(3, rows - 12) },
    );
    container.clear();
    container.addChild(prompt as unknown as Component);
    tui.setFocus(prompt as unknown as DistComponent);
    tui.requestRender();
    const value = await answered;
    // 换回问答 dialog 并还焦；若期间 dialog 已收盘（Esc 打断 prompt / pending 被清），不再装回。
    if (this.#dialog) this.#swap(this.#dialog);
    return value;
  }

  /** 把容器内容换成 `child` 并接管焦点（唯一的「换表面」动作） */
  #swap(child: DistComponent | Component): void {
    const { tui, container } = this.host;
    container.clear();
    container.addChild(child as unknown as Component);
    tui.setFocus(child as unknown as DistComponent);
    tui.requestRender();
  }
}
