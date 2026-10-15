/**
 * app.ts（M1.3 装配，M4.1 迁移 Composer）：pi-tui 装配。
 * initThemeSync → Composer（自带 TUI + CustomEditor + frameProvider）→
 * setRuntimeChildren(transcript + statusline Text + chipsBand + editor)。
 *
 * 为什么用 Composer：TUI 的历史退休（transcript → 原生 scrollback 的
 * history batch）由 frameProvider 驱动，而 coding-agent 路径下 frameProvider
 * 就是 Composer（composer.ts:301 ui.setFrameProvider(this)）。M1-M3 直接
 * tui.addChild 绕过了它 → 历史永不落 scrollback，滚动看不到完整消息列表
 * （M4.1 验收发现）。stdin 所有权仍归 pi-tui（composer.start() 全接管）。
 *
 * Composer 构造时的接线改造（均为 omp InteractiveMode 接管前的"应急控制"）：
 * - editor.disableSubmit=false：omp 用 InputController 拦 Enter，我们用 onSubmit
 * - editor.onClear/onExit=undefined：ctrl+c 已被全局 listener 消费；ctrl+d
 *   空草稿退出不是我们的语义（退出走 /exit + 空闲双击 Ctrl-C）
 * - options.exit 传 noop：上述两回调已摘除，#requestExit 无触发路径
 */
import { Container, Text, getComposerStyle, initThemeSync, theme } from '@oh-my-pi/pi-tui';
import { CombinedAutocompleteProvider, type AutocompleteProvider, type CombinedAutocompleteOptions, type SlashCommand as PiSlashCommand } from '@oh-my-pi/pi-tui/autocomplete.js';
import { TranscriptContainer } from '@oh-my-pi/pi-tui/chrome/transcript-container.js';
import { Composer } from '@oh-my-pi/pi-tui/prompt/composer.js';
import { AttachmentChipsBand } from '@oh-my-pi/pi-tui/prompt/attachment-chips.js';
import { QueuedMessagesBand } from '@oh-my-pi/pi-tui/prompt/queued-messages.js';
// 注意：components/* 的 exports 映射不带 .js（"./*.js" 只管顶层通配）
import { Loader, SPINNER_ADVANCE_MS } from '@oh-my-pi/pi-tui/components/loader';
import { matchesKey } from '@oh-my-pi/pi-tui/keys.js';
import { HistorySearchComponent } from '@oh-my-pi/pi-tui/overlays/history-search.js';
import type { Statusline } from '../app/statusline';
import { formatSuggestionPlaceholder } from '../app/prompt-suggestion';
import { editorDebug, getEditorCommand, openInEditor, type OpenInEditorOutcome } from '../app/external-editor';
import type { PermissionBridge } from '../permission/bridge';
import type { QueuedInput } from '../queue';
import { echoText } from '../queue';
import { EventBridge, duckCallBool, foldDebug, suggestDebug } from './bridge';
import { bashExecutionFromDetails, type BashExecutionHost } from './bash-execution';
import { FileHistoryStorage } from './history-storage';
import { installOmcKeybindings } from './keybindings';
import { PasteController } from './paste';
import { attachPermissionOverlay } from './permission-overlay';
import { composerBottomLines, composerTopBorder } from './status-source';
import { editorBorderColor } from './composer-preview';
import {
  renderModeIndicator,
  renderShellModeIndicator,
  shellModeBorderColorizer,
  shellModeDebug,
  type ShellInputMode,
  type ShellModeTrigger,
} from './mode-indicator';
import { needsTicking, renderTaskPanel, visibleTasks } from './task-panel';
import type { TaskEntry } from '../app/task-registry';
import type { TaskItem } from '../app/task-list';
import { hasActiveTodos, renderTodoBody, renderTodoHeader } from './todo-row';
import { createSwitcher, enterSwitcher, moveSwitcher, syncSwitcher } from '../app/task-switcher';
import type { ViewRecord } from '../app/view-log';

/**
 * skill-invoke P6.2：稳定外壳 autocomplete provider（热更新可换内层）。
 *
 * pi-tui CombinedAutocompleteProvider 持构造时命令快照（autocomplete.ts:559-577），
 * 不能原地改数组；但 editor.setAutocompleteProvider 只应装一次（避免「刷新恰在
 * getSuggestions 途中把 provider 换掉」的竞态）。故常驻本外壳，刷新时整体替换
 * #inner（对齐 omp「整份重建」语义，稳定外壳实现）。
 *
 * refreshHook（main 侧惰性重扫，内部自带节流）：在 getSuggestions /
 * trySyncSlashCompletion / getForceFileSuggestions 三个查询入口前同步调用。
 * 要求 hook 同步完成（refreshSkills 纯同步 fs 扫描）——trySyncSlashCompletion
 * 是同步接口，异步 hook 无法 await，会让「打开 / 立即看到新 skill」变成竞态。
 */
export class RefreshableAutocompleteProvider implements AutocompleteProvider {
  #inner: CombinedAutocompleteProvider;
  #cwd: string;
  #options?: CombinedAutocompleteOptions;
  #refreshHook?: () => void;

  constructor(commands: PiSlashCommand[], cwd: string, options?: CombinedAutocompleteOptions) {
    this.#cwd = cwd;
    this.#options = options;
    this.#inner = new CombinedAutocompleteProvider(commands, cwd, options);
  }

  /** 整体替换内层（命令数组重建后调用）。**必须带 `#options`**，否则热刷新一次权重失效。 */
  setCommands(commands: PiSlashCommand[]): void {
    this.#inner = new CombinedAutocompleteProvider(commands, this.#cwd, this.#options);
  }

  /** 惰性重扫钩子（查询入口前同步触发；main 侧负责节流） */
  setRefreshHook(hook: (() => void) | undefined): void {
    this.#refreshHook = hook;
  }

  async getSuggestions(
    ...args: Parameters<AutocompleteProvider['getSuggestions']>
  ): ReturnType<AutocompleteProvider['getSuggestions']> {
    this.#refreshHook?.();
    return this.#inner.getSuggestions(...args);
  }

  applyCompletion(
    ...args: Parameters<AutocompleteProvider['applyCompletion']>
  ): ReturnType<AutocompleteProvider['applyCompletion']> {
    return this.#inner.applyCompletion(...args);
  }

  getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
    return this.#inner.getInlineHint(lines, cursorLine, cursorCol);
  }

  trySyncSlashCompletion(textBeforeCursor: string): ReturnType<
    NonNullable<AutocompleteProvider['trySyncSlashCompletion']>
  > {
    this.#refreshHook?.();
    return this.#inner.trySyncSlashCompletion(textBeforeCursor);
  }

  async getForceFileSuggestions(
    ...args: Parameters<NonNullable<AutocompleteProvider['getForceFileSuggestions']>>
  ): ReturnType<NonNullable<AutocompleteProvider['getForceFileSuggestions']>> {
    this.#refreshHook?.();
    return this.#inner.getForceFileSuggestions(...args);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.#inner.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

export interface PiTuiAppDeps {
  cwd: string;
  statusline: Statusline;
  getModel: () => string;
  /** verbose：新工具卡默认展开（/verbose 命令切换） */
  getVerbose?: () => boolean;
  /** ux-port P2.2 / tool-render P1：ctrl+o 全局展开位（新卡初始化用，与 verbose 取或）。
   *  undefined = 用户尚未按过 ctrl+o（新卡用自身默认：原生卡折叠、DiffCard 展开） */
  getToolsExpanded?: () => boolean | undefined;
  /** ux-port P2.1：ctrl+o 按下时翻转全局展开位，返回新值 */
  onToggleToolsExpand: () => boolean;
  /** ux-port P2.3：ctrl+shift+o 按下时翻转工具活动区显隐，返回新值（true = 隐藏） */
  onToggleToolActivity: () => boolean;
  /** ux-port-v2 P4：thinking 显示位（**新组件初始化**用，会话运行期；与 ctrl+o 同一全局位） */
  getThinkingVisible?: () => boolean;
  /**
   * cancel-stops-turn P1.3：当前权限模式（`'plan'` = 仍在计划模式）—— 供 EventBridge 区分
   * plan 拒绝的两条回执措辞（取消/留在 plan vs 已退出 plan）。
   */
  getPermissionMode?: () => string;
  /**
   * todo-hud P1 修订：ctrl+o 按下时**直接置位** thinking 显隐（true = 全文渲染）。
   * 与工具卡展开同向——两者是同一个「展开/折叠」手势，不再各占一个键。
   */
  onSetThinkingVisible: (visible: boolean) => void;
  /** 编辑器提交（slash 解析在 main 侧） */
  onSubmit: (text: string) => void;
  /** Ctrl-C（双击退出/中断逻辑在 main 侧） */
  onCtrlC: () => void;
  /** slash 命令补全源（main 侧从 CommandRegistry 映射） */
  slashCommands: PiSlashCommand[];
  /**
   * command-usage 阶段：slash 命令使用次数查表（补全候选**次级排序**权重）。
   * pi-tui `CombinedAutocompleteProvider` 的 `commandUsage` 回调——同文本匹配分时才按
   * 次数降序，精确匹配不受影响。必须**同步且廉价**（每次按键对每个候选各调一次）。
   */
  getCommandUsage?: (name: string) => number;
  /** skill-invoke P2：composer chip 折叠钩子——返回 skill 的 SKILL.md 路径（未知名 undefined） */
  skillFilePath?: (name: string) => string | undefined;
  /** 历史持久化文件路径（JSONL） */
  historyFile: string;
  /** Esc（生成中=中断；空闲语义在 main 侧） */
  onEscape: () => void;
  /**
   * input-interactions P4：Ctrl+Y 复制最近一条 AI 回复到剪贴板（main 侧实现 = 复用 /copy 逻辑）。
   * **有意覆盖 pi-tui 默认 Emacs yank**（`tui.editor.yank` 默认绑 ctrl+y）——全局监听先于
   * 焦点组件并 consume，编辑器收不到该键。这是对齐 codebuddy 的取舍。
   */
  onCopyLastReply: () => void;
  /** 权限桥（M3.1：弹窗 overlay 挂 addChangeListener） */
  permBridge: PermissionBridge;
  /** ux-port P1.3：Alt+↑ dequeue（band 的 Edit 与键位同路径，main 侧弹队尾恢复草稿） */
  onDequeue: () => void;
  /** composer-shape 阶段：初始输入区形状（缺省 band；main 侧从 config 传入） */
  composerShape?: string;
  /** 初始权限模式（权限模式提示行初值；main 侧从 CLI/config 传入） */
  permissionMode?: string;
  /** Shift+Tab 循环权限模式：返回新模式（main 侧算 next + 落 session，已同步 currentMode） */
  onCyclePermissionMode: () => string;
  /**
   * subagent-visibility P2.2：面板键盘导航选中某任务并回车 → main 侧切换视图（P2.4 接线）。
   * 缺少此回调时回车仅退出导航态（不报错）。
   */
  onFocusTask?: (taskId: string) => void;
  /** todo-hud P1：当前执行的工具名（贴底待办行 meta 段；main 侧按 tool_start/tool_result 维护） */
  getCurrentTool?: () => string | undefined;
  /** todo-hud P1：本轮累计 output tokens（贴底待办行 meta 段；main 侧按 context_usage 累加） */
  getTurnTokens?: () => number | undefined;
  /**
   * detail-view P1.3：`F2` 打开**会话详情全屏视图**（含 thinking 全文 + 工具输出）。
   * 入口同时有 `/detail` 命令（任何终端可达）；F 键被所有终端**原样投递**（pi-tui 给
   * `app.retry` 选 `f5` 的同款理由），不像 alt 组合会被 macOS Option 吃掉。
   */
  onOpenDetail?: () => void;
}

export interface PiTuiApp {
  tui: Composer['ui'];
  bridge: EventBridge;
  editor: Composer['editor'];
  paste: PasteController;
  transcript: TranscriptContainer;
  /** 状态栏内容刷新（usage/model/mode/git 变化时调用） */
  refreshStatusline: () => void;
  /** 权限模式提示行刷新（/mode、Shift+Tab、system_init 后调用；default 隐藏该行）。
   *  `prePlanMode`（plan-mode P1.4）非空时 plan 行带 `+ <prePlanMode>` 后缀（D5）。 */
  setPermissionMode: (mode: string, prePlanMode?: string | null) => void;
  /** composer-shape 阶段：切换输入区形状（热切 chrome + 状态栏换位；/shape 命令调用） */
  setComposerShape: (shape: string) => void;
  /**
   * prompt-suggestion 阶段：设置输入框浅色「提问建议」（null/空 = 清除）。
   * 以 pi-tui `placeholder` 形式展示（编辑器为空时浅色显示）；Tab 落实为真实输入，Enter 直发。
   */
  setSuggestion: (text: string | null) => void;
  /** ux-port P3.3：vim 模式开关（/vim 命令与启动配置共用；切换必回 Insert，pi-tui 内建） */
  setVimMode: (enabled: boolean) => void;
  /** 生成中 loading 行开关（M4.2：omp statusContainer Loader 范式） */
  setWorking: (on: boolean) => void;
  /**
   * subagent-visibility P1.5：子代理/后台任务面板（权限模式行**下方**，对标 codebuddy）。
   * 传活跃任务快照（空数组即隐藏）；耗时由 app 内 1s ticker 自更新。
   */
  setTaskPanel: (entries: readonly TaskEntry[]) => void;
  /**
   * todo-hud P1：待办快照 → **贴底常驻行**（编辑器正上方 `workingRow`，对标 codebuddy CLI）。
   * 有任务即常驻、生成中顶掉「生成中…」Loader（保证不出现两行）；`ctrl+t` 展开/折叠。
   */
  setTodoPanel: (items: readonly TaskItem[]) => void;
  /**
   * subagent-visibility P2.4：切换 transcript 视图（焦点导航「真·视图切换」）。
   * 清空 transcript + 复位 bridge + 重放 `records` + 清终端 scrollback；`title` 为视图头
   * （子代理视图显示 `Agent Hub · @<name>`，主视图不传）。
   */
  switchView: (records: readonly ViewRecord[], title?: string) => void;
  /** skill-invoke P6.2：热更新替换 slash 命令数组（整体换 provider 内层）；
   *  before 为惰性重扫钩子（只首装时设置一次，内部自带节流，须同步完成） */
  setSkillSlashCommands: (cmds: PiSlashCommand[], before?: () => void) => void;
  /** ux-port P1.2：排队消息带内容刷新（队列变更回调里调用） */
  updateQueueBand: (items: readonly QueuedInput[]) => void;
  start: () => void;
  stop: () => void;
}

export function createPiTuiApp(deps: PiTuiAppDeps): PiTuiApp {
  // 必须在任何组件构造之前（theme/theme.ts:158）
  initThemeSync();
  // 键位对齐 codebuddy：Ctrl+P / Ctrl+N ≡ ↑ / ↓（须在 Composer 构造前，见 keybindings.ts）
  installOmcKeybindings();

  const composer = new Composer({
    preferences: {
      // 不要 omp welcome 场景（我们的欢迎行进转录区，main.ts 发）
      quiet: true,
      // 关 macOS 拼写/词补全（代码 CLI 场景纯干扰）
      spellingTypoDetection: false,
      spellingAutocorrect: false,
      spellingAutocomplete: 'off',
      // resizeScrollback 留默认 "rebuild"（omp 同款）：resize 后 ED3 + frameProvider
      // 全量重放历史，滚动缓冲与视口始终一致
      // composer-shape 阶段：输入区形状（缺省 band；可 /shape 运行期热切）
      composerShape: deps.composerShape ?? 'band',
    },
    exit: () => {}, // #requestExit 的触发回调已摘除（见头注释），此处不会触达
  });
  const tui = composer.ui;
  const editor = composer.editor;
  // ask-dialog-surface P1.1：编辑器外层容器（平时只装 editor）。ask 弹窗弹出时
  // `clear() → addChild(askDialog)` **换掉输入框**、占据它在 dock 的位置（照 omp
  // `interactive-mode.ts:1863` 的 `editorContainer`）；statusline 组件挂在容器**之后**
  // → 天然保留在下方（用户 2026-10-12 要求）。
  // 为什么用容器而不是直接 addChild/removeChild：dock children 由 setRuntimeChildren
  // 一次性挂载（`composer.ts:900`），运行期增删根子件会破「首挂移除 bootstrap editor」
  // 的记账；容器是稳定根，换子件只发生在容器内部。
  const editorContainer = new Container();
  editorContainer.addChild(editor);

  // Composer 应急控制摘除（omp 由 InteractiveMode 覆盖，我们显式语义化）
  editor.disableSubmit = false;
  editor.onClear = undefined;
  editor.onExit = undefined;

  // prompt-suggestion 阶段：输入框浅色「提问建议」（复用 pi-tui placeholder：浅色、每帧重算）。
  // main 侧在轮结束后生成并调 setSuggestion；Tab 落实为真实输入 / Enter 直发（见下方）。
  let currentSuggestion: string | null = null;
  const setSuggestion = (text: string | null): void => {
    currentSuggestion = text && text.trim() ? text.trim() : null;
    suggestDebug(`SET ${currentSuggestion ?? '(null)'}`);
    tui.requestRender();
  };
  // input-interactions P1.6：输入区 shell 模式（`!` / `!!`）状态。**必须先于 placeholder /
  // refreshModeLine 声明**（两处都要读它）。
  let shellMode: ShellInputMode = 'none';
  /** 上一次编辑框文本（判断 sigil 是否「在空草稿上刚敲下」） */
  let lastDraft = '';
  /** 防重入：剥 sigil 的 setText 会再次触发 onChange */
  let shellSyncing = false;
  /**
   * 已从草稿剥掉、待提交时补回的 sigil（`!` / `!!`）。
   * 为什么不能在 `editor.onSubmit` 里直接读 `shellMode`：`#submitValue` **先**做一次
   * 空 onChange（editor.ts:3253）—— 那一步已让模式退出，等 onSubmit 回调时模式已丢。
   */
  let pendingSigil = '';
  /** 生成中标志（setWorking 同步）：Esc 在生成中仍归中断，见 onEscape */
  let working = false;

  // 自己包 ANSI：placeholder 由 pi-tui 原样拼接（editor.ts:1376-1389），不做着色。
  // 文本 = `<建议>  ⏎ send`（对齐 CLI 输入框右侧的「回车发送」提示，随建议同生同灭）。
  // shell 模式（`!`/`!!`）下不显示建议（codebuddy：本地模式下 Tab 不把命令加入消息队列）。
  editor.placeholder = () =>
    shellMode !== 'none' || !currentSuggestion
      ? undefined
      : theme.fg('dim', formatSuggestionPlaceholder(currentSuggestion));

  // slash + @文件 + Tab 补全（RefreshableAutocompleteProvider 稳定外壳包
  // CombinedAutocompleteProvider：P6 热更新整体替换内层，editor 侧只装一次）
  const autocomplete = new RefreshableAutocompleteProvider(deps.slashCommands, deps.cwd, {
    commandUsage: deps.getCommandUsage,
  });
  editor.setAutocompleteProvider(autocomplete);
  // skill-invoke P2：chip 折叠宿主钩子（custom-editor.ts:596 默认 ()=>undefined，
  // :621 #collapseSkillTokens 靠它判已知 skill 并把 /skill:xxx 塌成原子 chip）。
  // 包一层 deps 回调：skillMap 原地重填时（P6 热更新）闭包不漂移
  editor.skillFilePath = (n) => deps.skillFilePath?.(n);
  // autocomplete 弹窗重绘接线（omp interactive-mode.ts:1432-1438 范式）：
  // show/cancel 只调这两个回调、自身不触发渲染——缺了会导致 debounce 刷新后的
  // 新列表永不绘制（画面停在按键回显时的旧列表，M2 遗留#2「slash 补全不过滤」根因）
  editor.viewportRowsProvider = () => tui.terminal.rows;
  editor.onAutocompleteCancel = () => tui.requestRender(true);
  editor.onAutocompleteUpdate = () => tui.requestRender();
  // 历史：JSONL 持久化适配器（↑/↓ 导航 pi-tui 内建；同一实例兼作 ctrl+r 搜索源）
  const historyStorage = new FileHistoryStorage(deps.historyFile);
  editor.setHistoryStorage(historyStorage);
  // input-interactions P1.6：**空闲**时 Esc 先退出 shell 模式（对齐 codebuddy：Esc 移除输入模式
  // 状态）；生成中（`working`）仍走原中断语义，避免抢掉「Esc 中断」这个主用途。
  editor.onEscape = () => {
    if (shellMode !== 'none' && !working) {
      applyShellMode('none', 'esc');
      return;
    }
    deps.onEscape();
  };
  // ux-port P1.3：Alt+↑ dequeue（editor 内建 app.message.dequeue 键位 → onDequeue 钩子，
  // custom-editor.ts:1524；与 band 的 Edit 按钮同路径）
  editor.onDequeue = () => deps.onDequeue();
  editor.onSubmit = (text) => {
    const t = text.trim();
    // input-interactions P1.6：shell 模式下 sigil 不在缓冲区（由 gutter 承担），提交时补回，
    // main 才能按 `!` / `!!` 前缀解析（也让历史记录保留完整命令）。
    const sigil = shellMode === 'none' ? pendingSigil : SIGIL[shellMode];
    const raw = sigil ? `${sigil}${t ? ` ${t}` : ''}` : t;
    pendingSigil = '';
    applyShellMode('none', 'submit');
    if (!raw) {
      // prompt-suggestion：空输入 + 有建议 → 直接发送该建议（对齐 CLI promptSuggestion）
      if (currentSuggestion) {
        const s = currentSuggestion;
        setSuggestion(null);
        suggestDebug(`ENTER send ${s}`);
        deps.onSubmit(s);
      }
      return;
    }
    // 先交 main 收集图片（读 pendingImages），再清草稿
    deps.onSubmit(raw);
    editor.clearDraft(raw);
  };

  const transcript = new TranscriptContainer();
  // 状态栏：statusline.ts 逻辑保留，外包 Text 组件呈现。
  // composer-shape 阶段：形状决定状态栏落点（行 → 槽位映射见 status-source.ts）——顶 chrome
  // 由 editor.setTopBorderProvider 注入 row0（chip 形状取 row0 右组），其余行落此 Text（编辑器下方）。
  let activeShape = deps.composerShape ?? 'band';
  const statusText = new Text('', 0, 0);
  /**
   * ask-dialog-surface P1.4：ask **单文件对话表面**激活位（与下方 `planInlineActive` 并列）。
   * 为什么必须新增：换表面后**没有 overlay**（不再 showOverlay）→ 原有 `tui.hasOverlay()`
   * 护栏全部失效，弹窗内按键会被全局抢键监听吞掉。统一谓词见下方 `modalOwnsKeys()`。
   * 声明位置较早：paste 护栏与 `refreshStatusline` 都要读它。
   */
  let askSurfaceActive = false;
  /**
   * permission-surface P1.3：**权限审批表面**激活位（与 `askSurfaceActive` 同款理由 ——
   * 换表面后无 overlay，`tui.hasOverlay()` 护栏失效）。两者共用同一 `editorContainer`。
   */
  let permSurfaceActive = false;
  /**
   * plan-mode P1.2：**plan 审批表面**激活位（同款理由 —— ExitPlanMode 三选项也换掉输入框，
   * 从内联卡改为表面卡后不再有 overlay/内联激活位可用）。
   */
  let planSurfaceActive = false;
  /** 任一「单文件对话表面」激活（statusline 口径 / paste 护栏共用） */
  const anySurfaceActive = (): boolean => askSurfaceActive || permSurfaceActive || planSurfaceActive;
  /**
   * 状态栏刷新。**注意表面激活时的特殊口径**：omc 的 statusline 第 0 行挂在
   * **editor 顶边框**上（`composerTopBorder` → `editor.setTopBorderProvider`），而表面
   * 会把 editor 整体换掉 → 那行会跟着消失。故激活期间把「顶 chrome 行 + 下方块行」
   * 合并落到下方 `statusText`，保证状态栏仍在弹窗**下方**（用户 2026-10-12 要求）；
   * 拆表后回到原口径（顶行随 editor 回来）。
   */
  const refreshStatusline = (): void => {
    const cols = tui.terminal.columns;
    const style = getComposerStyle(activeShape);
    const lines = anySurfaceActive()
      ? [
          composerTopBorder(deps.statusline, style, cols)?.content ?? '',
          ...composerBottomLines(deps.statusline, style, cols),
        ].filter((l) => l !== '')
      : composerBottomLines(deps.statusline, style, cols);
    if (statusText.setText(lines.join('\n'))) {
      tui.requestRender();
    }
  };

  // 权限模式提示行（照抄 codebuddy）：固定在状态栏行下方，default 隐藏。
  // 文案/配色见 mode-indicator.ts；随 /mode、Shift+Tab、system_init 刷新
  let currentMode = deps.permissionMode ?? 'default';
  /** plan-mode P1.4（D5）：进 plan 前的模式（`⏸ plan + <prePlanMode>` 后缀；不在 plan 时 null） */
  let currentPrePlanMode: string | null = null;
  // input-interactions P1.6：输入区 shell 模式（`!` / `!!`）—— 按 codebuddy 的做法把权限
  // 模式提示行**顶掉**，改显 shell 模式；同时给输入框边框/提示符着色。
  // （`shellMode` 状态声明见上方；此处只定义渲染。）
  const modeText = new Text('', 0, 0);
  const refreshModeLine = (): void => {
    const line = renderShellModeIndicator(shellMode) ?? renderModeIndicator(currentMode, currentPrePlanMode);
    if (modeText.setText(line ?? '')) {
      tui.requestRender();
    }
  };
  const setPermissionMode = (mode: string, prePlanMode?: string | null): void => {
    currentMode = mode;
    currentPrePlanMode = prePlanMode ?? null;
    refreshModeLine();
  };

  /** `!` / `!!` / `#` 三个前缀（补回提交文本用） */
  const SIGIL: Record<ShellInputMode, string> = { none: '', bash: '!', local: '!!', memory: '#' };

  /**
   * 输入框 shell 模式外观（input-interactions P1.6，照抄 codebuddy `!` 模式的观感）：
   *   · 提示符：`! ` / `!! ` 顶掉形状默认 gutter（band 的 `╰─ `）并由 `borderColor` 上色；
   *   · 边框/输入区：`!` 品红 / `!!` 青（codebuddy bashMode / bashLocalMode 同色）；
   *   · 提示行：权限模式行被 `! for bash mode …` 顶掉。
   * 退出（草稿不再处于 shell 模式）时逐项还原。
   */
  const applyShellMode = (mode: ShellInputMode, trigger: ShellModeTrigger): void => {
    if (mode !== shellMode) {
      shellModeDebug(`MODE ${mode} ${trigger}`);
      shellMode = mode;
      editor.setPromptGutter(mode === 'none' ? undefined : `${SIGIL[mode]} `);
      editor.borderColor = shellModeBorderColorizer(mode) ?? editorBorderColor;
      refreshModeLine();
      tui.requestRender();
    }
    // sigil 只在非 none 时更新；退出（none）时**保留**给本次提交补回（见 pendingSigil 注释）
    if (mode !== 'none') pendingSigil = SIGIL[mode];
  };

  /** 切换 bash ↔ local（Shift+Tab 用，trigger='key'）：草稿与 `pendingSigil` 同步换 sigil */
  const toggleShellMode = (): void => {
    applyShellMode(shellMode === 'bash' ? 'local' : 'bash', 'key');
  };
  /**
   * `!` / `!!` 的识别：**sigil 只在草稿为空时敲下才被接管** —— 剥进 gutter（提示符变色），
   * 缓冲区只留命令本体，故不会出现 `! ! ll` 重复。非空草稿里补敲 `!` 不改模式（不劫持普通文本）。
   * 草稿被清空（含提交后 `clearDraft`）→ 退出模式（`pendingSigil` 留给当次提交补回）。
   */
  const handleDraftChange = (text: string): void => {
    if (shellSyncing) return;
    const prevEmpty = lastDraft === '';
    lastDraft = text;
    if (text === '') {
      // 清空：退出视觉模式；`pendingSigil` 不在此清（`#submitValue` 会先发一次空 onChange，
      // 提交时还要用它补回 sigil —— 见 editor.onSubmit）
      if (shellMode !== 'none' && !prevEmpty) applyShellMode('none', 'clear');
      return;
    }
    if (prevEmpty && text.startsWith('!')) {
      const excluded = text.startsWith('!!');
      const sink: ShellInputMode = excluded || shellMode === 'bash' ? 'local' : 'bash';
      // 剥 sigil + 紧随的一个空格（`! ls` → `ls`，避免 gutter 已有 `! ` 后出现双空格）
      const rest = (excluded ? text.slice(2) : text.slice(1)).replace(/^ /, '');
      shellSyncing = true;
      try {
        editor.setText(rest);
      } finally {
        shellSyncing = false;
      }
      lastDraft = editor.getText();
      applyShellMode(sink, 'sigil');
      return;
    }
    // input-interactions P2：`#` 记忆快捷 —— 同样只在空草稿里「刚敲下 `#`」时接管，
    // 剥进 gutter（提示符变 `# `，色 = codebuddy brand #28B894），缓冲区只留记忆内容。
    if (prevEmpty && text.startsWith('#')) {
      const rest = text.slice(1).replace(/^ /, '');
      shellSyncing = true;
      try {
        editor.setText(rest);
      } finally {
        shellSyncing = false;
      }
      lastDraft = editor.getText();
      applyShellMode('memory', 'sigil');
      return;
    }
    // shell 模式下吞掉命令前的首个空格（gutter 已含分隔空格，否则出现 `!  ls` 双空格）
    if (shellMode !== 'none' && prevEmpty && text.startsWith(' ')) {
      shellSyncing = true;
      try {
        editor.setText(text.replace(/^ +/, ''));
      } finally {
        shellSyncing = false;
      }
      lastDraft = editor.getText();
      return;
    }
    // 普通草稿（非 shell）：作废可能残留的 sigil
    if (shellMode === 'none') pendingSigil = '';
  };
  editor.onChange = (text) => handleDraftChange(text);

  // ux-port P3.3：vim 模式状态同步（omp interactive-mode.ts:4638-4656 #syncVimStatus
  // 范式：状态栏 vim 段 + 硬件光标形状；边框变色不抄）。Esc 语义：vim Insert/pending
  // 时 Esc 归 editor（vimConsumesEscape，custom-editor.ts:1476-1483），quiet Normal
  // 时单 Esc 中断仍可用；主中断通道一直是全局 Ctrl-C（app.ts ctrl+c listener），
  // 与 vim 路径无冲突。onClear/onExit 已摘除（头注释），app.clear 无回调不触发
  const syncVimStatus = (): void => {
    deps.statusline.setVimStatus(editor.vimEnabled ? { mode: editor.vimMode, pending: editor.vimPending } : undefined);
    tui.terminal.setCursorShape?.(
      editor.vimEnabled && editor.vimMode !== 'insert' ? 'block' : editor.vimEnabled ? 'bar' : 'default',
    );
    refreshStatusline();
  };
  editor.onVimModeChange = () => syncVimStatus();
  const setVimMode = (enabled: boolean): void => {
    editor.setVimMode(enabled);
    syncVimStatus();
    tui.requestRender();
  };
  // composer-shape 阶段：热切输入区形状（/shape 命令与启动配置共用）。setPreferences 内部
  // editor.setBorderStyle + requestRender；随后按 shape 的 statusAttachment 设/清顶 chrome
  // provider（composerTopBorder 对 none 返回 undefined），并重算编辑器下方块。
  const setComposerShape = (shape: string): void => {
    activeShape = shape;
    composer.setPreferences({ composerShape: shape });
    // setPreferences 内部 editor.setTheme(getEditorTheme()) 会把 borderColor 重置回主题默认
    // （editor.ts:788-791），故每次切形状后重设：默认边框 = borderAccent（青，用户拍板）；
    // shell 模式（`!`/`!!`）下保持模式色（P1.6）
    editor.borderColor = shellModeBorderColorizer(shellMode) ?? editorBorderColor;
    const style = getComposerStyle(shape);
    editor.setTopBorderProvider((w) => composerTopBorder(deps.statusline, style, w));
    refreshStatusline();
    tui.requestRender();
  };
  // 草稿附件 chip 缩略图带（omp interactive-mode.ts:1460-1463 范式，编辑器正上方）
  // imageBudget 强转：主入口 d.ts 与 src TS 双世界同名类（私有字段）结构不兼容，同 bridge.ts 注释；
  // 类型取构造签名本身，避免深路径 import 落回 dist 世界
  type ChipsBudget = ConstructorParameters<typeof AttachmentChipsBand>[1];
  const chipsBand = new AttachmentChipsBand(editor, tui.imageBudget as unknown as ChipsBudget, () =>
    tui.requestRender(),
  );

  // omp interactive-mode.ts:1708-1735 范式：editor 标 transient（多行草稿/弹窗
  // 按最小高度计退休额度，不把瞬时行压进 scrollback，#11007）
  // workingRow：生成中 loading 行的常驻容器（空容器零行；M4.2，编辑器正上方）
  // queueBandRow：排队消息带常驻容器（ux-port P1.2；位置同 omp
  //   interactive-mode.ts:1711 pendingMessagesContainer——transcript 之下、输入区之上）
  const workingRow = new Container();
  const queueBandRow = new Container();
  // composer-shape 阶段：statusText 移到最后（编辑器下方底栏位）；顶部状态经 editor 顶 chrome 注入
  // 权限模式提示行 modeText 紧随 statusText（状态栏行下方，用户指定固定位）
  // subagent-visibility P1.5：tasksText 再往下（权限模式行下方）——子代理/后台任务面板
  const tasksText = new Text('', 0, 0);
  /**
   * 面板内容 = 活跃任务快照。耗时每秒走字 → 有活跃任务时挂 1s ticker 重绘
   * （codebuddy 同款“实时耗时”；无活跃任务即停表，不空转）。
   */
  let taskEntries: readonly TaskEntry[] = [];
  let taskTicker: ReturnType<typeof setInterval> | null = null;
  /**
   * subagent-visibility P2.2：面板键盘导航态（对齐 codebuddy「成员焦点导航」）：
   * 空输入框按 `↓` 进入 → `↑`/`↓` 移动选中 → `Enter` 聚焦该任务 → `Esc` 退出。
   * `index` 是**可见任务数组**（`visibleTasks`）的下标；纯状态机在 `app/task-switcher.ts`。
   */
  const switcher = createSwitcher();
  /**
   * ticker 只在「耗时确实会随墙钟变」时开（P1.6）：自报耗时/陈旧/终态都是冻结值，
   * 逐秒重绘纯属空转（`needsTicking`）。有任务在跑但仍需 Ticker 变化时，每次渲染后重判。
   * P2.2：导航选中态随可视任务集变化收敛（可见集变空 → 退出导航；下标越界 → 夹紧）。
   */
  const renderTasks = (): void => {
    const now = Date.now();
    const visible = visibleTasks(taskEntries, now);
    syncSwitcher(switcher, visible.length);
    const lines = renderTaskPanel(taskEntries, {
      now,
      columns: tui.terminal.columns,
      fg: (token, s) => theme.fg(token as Parameters<typeof theme.fg>[0], s),
      ...(switcher.active ? { selectedIndex: switcher.index } : {}),
    });
    if (tasksText.setText(lines.join('\n'))) {
      tui.requestRender();
    }
    if (taskTicker && !needsTicking(taskEntries, now)) {
      clearInterval(taskTicker);
      taskTicker = null;
    }
  };
  /** 面板可见任务（导航用；与 renderTasks 同口径） */
  const taskSwitcherItems = (): TaskEntry[] => visibleTasks(taskEntries, Date.now());
  const moveTaskSelection = (delta: number): void => {
    moveSwitcher(switcher, delta, taskSwitcherItems().length);
    renderTasks();
  };
  const focusSelectedTask = (): boolean => {
    const t = taskSwitcherItems()[switcher.index];
    switcher.active = false;
    renderTasks();
    if (!t) return false;
    deps.onFocusTask?.(t.id);
    return true;
  };
  const setTaskPanel = (entries: readonly TaskEntry[]): void => {
    taskEntries = entries;
    renderTasks();
    if (!taskTicker && needsTicking(entries, Date.now())) {
      taskTicker = setInterval(renderTasks, 1000);
    }
  };
  /**
   * subagent-visibility P2.4：切换 transcript 视图（焦点导航「真·视图切换」）。
   *
   * 照 omp `renderInitialMessages` 范式（`coding-agent/src/modes/utils/ui-helpers.ts:923`）：
   * ① `transcript.clear()` 清空已渲染块 ② `bridge.reset()` 复位渲染状态机（active 缓冲 /
   * 工具卡表 / taskStore）③ 重放目标视图事件 ④ 清终端 scrollback
   * （pi-tui 唯一入口 = `requestRender(true, {clearScrollback:true})`，ED3 序列）。
   *
   * 说明：已退休进原生 scrollback 的行靠 ④ 清掉；重放只走 `bridge`（不触发 main 的簿记
   * 副作用——状态栏 / usage / task 表），故子代理视图不会污染主会话状态。
   */
  const switchView = (records: readonly ViewRecord[], title?: string): void => {
    transcript.clear();
    bridge.reset();
    if (title) bridge.addInfoLines([theme.fg('accent', title)]);
    for (const r of records) {
      if (r.kind === 'user') bridge.addUserMessage(r.text);
      else if (r.kind === 'info') bridge.addInfoLines(r.lines);
      else if (r.kind === 'info_md') bridge.addInfoCard(r.lines, r.markdown, r.tail ?? []);
      else if (r.kind === 'bash')
        bridge.addTranscriptComponent(
          bashExecutionFromDetails(tui as unknown as BashExecutionHost, r.details),
        );
      else bridge.handleEvent(r.ev);
    }
    tui.requestRender(true, { clearScrollback: true });
  };
  // ask-dialog-surface P1.1：dock 第 5 位由 `editor` 换成 `editorContainer`（内含 editor）。
  // `transient` 也换成容器：ask 弹窗高峰高度**不计入退休计费** → 关闭后转录可回填，
  // 不留顶部空白带（pi-tui `composer.ts:348-432` 用 `#transientChromeFloor` 按最小高度计费）。
  composer.setRuntimeChildren(
    [transcript, queueBandRow, chipsBand, workingRow, editorContainer, statusText, modeText, tasksText],
    { transient: [editorContainer] },
  );

  // ux-port P1.2：排队消息带刷新（omp ui-helpers.ts:1090 updatePendingMessagesDisplay
  // 范式）。band 构造即渲染、无增量 API → 变更时清空重建
  const updateQueueBand = (items: readonly QueuedInput[]): void => {
    queueBandRow.clear();
    if (items.length > 0) {
      // dequeueKey/onEdit 类型取构造签名本身，避免深路径 import 落回 dist 世界（双世界）
      type BandArgs = ConstructorParameters<typeof QueuedMessagesBand>;
      const groups: BandArgs[0] = [
        // band 行文本：echo 优先（skill 卡片取草稿 prompt，echoText 统一口径）；
        // sendToAgent 路径（/compact 等提交时已回显）回退 msg
        { label: '排队中', messages: items.map((i) => (i.echo ? echoText(i.echo) : typeof i.msg === 'string' ? i.msg : '[图片]')) },
      ];
      queueBandRow.addChild(new QueuedMessagesBand(groups, 'alt+up' as BandArgs[1], () => deps.onDequeue()));
    }
    tui.requestRender();
  };

  // 生成中 loading（omp interactive-mode.ts:6606 Loader 范式）：挂即自动画，
  // 摘即清空。Loader 构造自启动（loader.ts:154）
  // todo-hud P1：`workingRow` 此后有**两个互斥占用者** —— 无待办时是 Loader（现状），
  // 有待办时是贴底待办行 `todoText`（生成中顶掉 Loader，保证同一槽位不出现两行，D6）
  let loader: Loader | undefined;
  /** workingRow 当前占用者（互斥记账：避免重复 addChild / 残留空行） */
  let workingRowKind: 'none' | 'loader' | 'todo' = 'none';

  /** 摘掉 Loader（幂等） */
  const disposeLoader = (): void => {
    loader?.dispose();
    loader = undefined;
    if (workingRowKind === 'loader') {
      workingRow.clear();
      workingRowKind = 'none';
    }
  };

  /** 挂「生成中…」Loader（无待办时的现有路径） */
  const mountLoader = (): void => {
    if (workingRowKind === 'loader') return;
    workingRow.clear();
    loader = new Loader(
      tui,
      (s) => theme.fg('accent', s),
      (s) => theme.fg('muted', s),
      '生成中…（Esc 中断）',
    );
    workingRow.addChild(loader);
    workingRowKind = 'loader';
  };

  // ---- todo-hud P1：贴底待办行（编辑器正上方，对标 codebuddy CLI 的 dock 待办）----
  /** 待办快照（bridge 的 TaskStore 变化时经 `onTodoChange` 推来） */
  let todoItems: readonly TaskItem[] = [];
  /** 展开/折叠（D4：`ctrl+t`；默认展开 —— CLI 首屏也是全表） */
  let todosExpanded = true;
  /** 本轮起点（生成中 meta 的耗时基准；空闲态不显示耗时） */
  let todoStartedAt = 0;
  /** spinner 帧推进定时器（仅「生成中 + 有待办」时开，同 Loader 的 SPINNER_ADVANCE_MS） */
  let todoSpinnerTimer: ReturnType<typeof setInterval> | null = null;
  let todoSpinnerIndex = 0;
  const TODO_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  /** 贴底行组件（`workingRow` 的可选子件；单组件多行 —— 逐行 addChild 会被块间插空行断行） */
  const todoText = new Text('', 0, 0);
  const fgToken = (token: string, s: string): string =>
    theme.fg(token as Parameters<typeof theme.fg>[0], s);

  /**
   * 渲染 workingRow（唯一出口：setWorking / setTodoPanel / spinner 帧推进都走它）。
   * - 有待办 → 常驻待办行（空闲也显示，D2），生成中顶掉 Loader
   * - 无待办（清空 / 全完成）→ 回到 Loader 口径：生成中显示 Loader、空闲零行
   */
  const renderWorkingRow = (): void => {
    if (hasActiveTodos(todoItems)) {
      if (workingRowKind === 'loader') disposeLoader();
      if (workingRowKind !== 'todo') {
        workingRow.clear();
        workingRow.addChild(todoText);
        workingRowKind = 'todo';
      }
      const columns = tui.terminal.columns;
      const header = renderTodoHeader(todoItems, {
        fg: fgToken,
        columns,
        working,
        spinnerFrame: TODO_SPINNER_FRAMES[todoSpinnerIndex % TODO_SPINNER_FRAMES.length],
        // 耗时/工具/tokens 只在生成中有意义（空闲是冻结值，会误导；纯函数侧也会省略）
        elapsedMs: working && todoStartedAt > 0 ? Date.now() - todoStartedAt : undefined,
        tool: working ? deps.getCurrentTool?.() : undefined,
        turnTokens: working ? deps.getTurnTokens?.() : undefined,
        expanded: todosExpanded,
      });
      const body = renderTodoBody(todoItems, { fg: fgToken, columns: columns, expanded: todosExpanded });
      todoText.setText([header, ...body].join('\n'));
    } else {
      if (workingRowKind === 'todo') {
        workingRow.clear();
        workingRowKind = 'none';
      }
      if (working) mountLoader();
      else disposeLoader();
    }
    tui.requestRender();
  };

  /** spinner 只在「生成中 + 有待办」时走字（同 task-panel 的 needsTicking 口径：空闲不空转） */
  const syncTodoSpinner = (): void => {
    const need = working && hasActiveTodos(todoItems);
    if (need && !todoSpinnerTimer) {
      todoSpinnerTimer = setInterval(() => {
        todoSpinnerIndex = (todoSpinnerIndex + 1) % TODO_SPINNER_FRAMES.length;
        renderWorkingRow();
      }, SPINNER_ADVANCE_MS);
    } else if (!need && todoSpinnerTimer) {
      clearInterval(todoSpinnerTimer);
      todoSpinnerTimer = null;
    }
  };

  const setTodoPanel = (items: readonly TaskItem[]): void => {
    todoItems = items;
    renderWorkingRow();
    syncTodoSpinner();
  };

  const setWorking = (on: boolean): void => {
    working = on;
    if (on) todoStartedAt = Date.now();
    renderWorkingRow();
    syncTodoSpinner();
  };

  const bridge = new EventBridge({
    // 强转：Composer['ui'] 是 src 世界 TUI，BridgeDeps.ui 经 ToolExecutionUi 落在
    // 另一世界（私有字段不兼容，bridge.ts:22-24 注释）——运行时同一对象
    ui: tui as unknown as ConstructorParameters<typeof EventBridge>[0]['ui'],
    container: transcript,
    cwd: deps.cwd,
    getModel: deps.getModel,
    getVerbose: deps.getVerbose,
    getToolsExpanded: deps.getToolsExpanded,
    getViewportRows: () => tui.terminal.rows,
    getThinkingVisible: deps.getThinkingVisible,
    // cancel-stops-turn P1.3：拒绝回执分场景（plan 取消 vs 退出）读当前权限模式
    getPermissionMode: deps.getPermissionMode,
    // todo-hud P1：Task* 状态机快照变化 → 贴底待办行（**不落转录卡**，同一清单不再重复打印）
    onTodoChange: (items) => setTodoPanel(items),
  });

  // ask-dialog-surface P1.4：ask 表面激活位声明见上方 `statusText` 旁（paste 护栏与
  // `refreshStatusline` 都要读它，故早于本处声明）。permission-surface P1.3 同处。

  // 图片粘贴（onPasteImage/onPasteImagePath 钩子 + 5522 重组器）
  const paste = new PasteController({
    editor,
    // 强转：PasteDeps.tui 取主入口 d.ts 世界 TUI，同上双世界问题
    tui: tui as unknown as ConstructorParameters<typeof PasteController>[0]['tui'],
    info: (lines) => bridge.addInfoLines(lines),
  });
  // 表面（ask / 权限）激活时**不把按键交给 paste 监听**：editor 已被换出容器，图片会粘到已
  // 摘下的 editor 上（P1.4）；表面拆掉后自动恢复。
  tui.addInputListener((data) => (anySurfaceActive() ? undefined : paste.inputListener(data)));

  // Ctrl-C 全局拦截（消费掉，不落编辑器/overlay）。
  // 语义在 main 侧 onCtrlC：空闲首按清空草稿（整段，对齐 omp）+ 武装双击退出；生成中中断。
  // M3.2：改 matchesKey —— Kitty 键盘协议下 Ctrl-C 是 CSI u 序列（\x1b[99;5u）
  // 而非裸 \x03（M1 遗留 bug），matchesKey 两种形态都匹配（keys.ts:551）
  tui.addInputListener((data) => (matchesKey(data, 'ctrl+c') ? (deps.onCtrlC(), { consume: true }) : undefined));

  // plan-approval P2.4：内联计划审批激活位（attachPermissionOverlay 的 onInlineActiveChange
  // 置位）。全局 input 监听先于焦点组件（tui.ts:2559），故激活时须让 ↓/Shift+Tab 等抢键监听
  // 放行给内联三选项组件。
  let planInlineActive = false;
  // ask-dialog-surface P1.4：当前 ask dialog 组件引用（Ctrl+O 转发给 `toggleQuestionExpansion`）
  let askDialogRef: { toggleQuestionExpansion(): boolean } | null = null;
  /**
   * 模态让位谓词：**任一激活即让位**全局抢键监听。
   * - `tui.hasOverlay()`：权限回落浮层 / 历史搜索等浮层（焦点栈自带模态，但全局监听先于焦点组件）
   * - `planInlineActive`：内联计划审批（无 overlay，靠激活位）
   * - `anySurfaceActive()`：ask / 权限 / **plan**「单文件对话表面」（同上，无 overlay）
   *   （plan-mode P1.2 起 plan 审批也走表面 → 激活位并入 `anySurfaceActive`）
   */
  const modalOwnsKeys = (): boolean => tui.hasOverlay() || planInlineActive || anySurfaceActive();

  // subagent-visibility P2.2：任务面板键盘导航（对齐 codebuddy 成员焦点导航）。
  //   空输入框 + ↓ → 进入面板选择模式；↑/↓ 环绕移动；Enter 聚焦（main 侧切视图）；Esc 退出。
  //   仅在「输入框为空」时抢 ↓（不破坏编辑器内光标下移与历史导航）；overlay 模态时不抢键
  //   （与 ctrl+o 同款护栏）。导航态下非导航键退出并放行（开始打字即回到编辑）。
  //   plan-approval P2.4：**内联计划审批**激活时让位（全局监听先于焦点组件，否则 ↓/↑ 会被
  //   这里抢走，内联三选项收不到键）。
  tui.addInputListener((data) => {
    if (modalOwnsKeys()) return undefined;
    if (switcher.active) {
      if (matchesKey(data, 'escape')) {
        switcher.active = false;
        renderTasks();
        return { consume: true };
      }
      if (matchesKey(data, 'down')) {
        moveTaskSelection(1);
        return { consume: true };
      }
      if (matchesKey(data, 'up')) {
        moveTaskSelection(-1);
        return { consume: true };
      }
      if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
        focusSelectedTask();
        return { consume: true };
      }
      switcher.active = false; // 非导航键：退出导航并放行给编辑器
      renderTasks();
      return undefined;
    }
    if (!matchesKey(data, 'down')) return undefined;
    if (editor.getText().length > 0) return undefined; // 有草稿时不抢 ↓
    if (!enterSwitcher(switcher, taskSwitcherItems().length)) return undefined; // 无可聚焦任务
    renderTasks();
    return { consume: true };
  });

  // prompt-suggestion 阶段：Tab 全局落实「提问建议」（对齐 CLI onTabKey）。
  // 仅「有建议 + 输入框为空」时抢 Tab 把建议填入编辑器；否则放行给编辑器原补全行为。
  // 全局 input 监听先于焦点组件（tui.ts:2559）→ 浮层/内联审批/vim 非插入态须让位。
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'tab') && data !== '\t') return undefined;
    if (modalOwnsKeys()) return undefined;
    if (editor.vimEnabled && editor.vimMode !== 'insert') return undefined;
    // shell 模式（`!`/`!!`）不放行建议落实（codebuddy：本地模式下 Tab 不入消息队列）
    if (shellMode !== 'none') return undefined;
    if (!currentSuggestion || editor.getText().length > 0) return undefined;
    const s = currentSuggestion;
    // 对齐 CLI onTabKey：只 setValue（+光标到末尾），**不清建议** ——
    // 建议保留在 currentSuggestion 里，用户清空输入框后 placeholder 立刻复现。
    editor.setText(s); // setText 光标自动落末尾（editor.ts:2816/1060）
    tui.requestRender();
    suggestDebug(`TAB fill ${s}`);
    return { consume: true };
  });

  // ux-port P2.1：ctrl+o 全局工具卡展开/折叠（omp input-controller.ts:2457-2468
  // setToolsExpanded 范式）。须在任意焦点下生效（omp #7837：审批弹窗等持有焦点时
  // 截断卡片仍可展开）；overlay 模态时不抢键（omp :388 hasOverlay 同款）。
  // 已知限制（omp :2465 注释同款）：退休进原生 scrollback 的旧块保持提交时形态，
  // 全局 toggle 对其无效——验收预期行为，非 bug
  //
  // todo-hud P1 修订（2026-10-12 用户拍板改口）：**thinking 显隐并入同一手势** ——
  // 原方案把 thinking 迁给 alt+t，真机实测 Kitty / Ghostty **都**发 `†`（macOS Option
  // 被终端当打字，alt 组合不可达）→ 撤销 alt+t，ctrl+o 一次按键同时翻转
  // 「工具卡 setExpanded」与「thinking setHideThinkingBlock」（同向，全局位唯一）。
  // 退休块语义**不变**（只影响当前视口内的块，不 resetDisplay）：整屏重写代价高、
  // 且展开全部工具卡会让 scrollback 暴涨；读全文的出口是全屏详情视图。
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'ctrl+o')) return undefined;
    // ask-dialog-surface P1.4：ask 表面激活时 Ctrl+O 先给**弹窗内容展开**（截断的题干/描述），
    // 未处理时才继续走下面的工具卡展开 —— 镜像 pi-tui `ask-dialog.ts:642-648` 的语义
    // （`toggleQuestionExpansion()` 返回 false = 无可展开内容）。
    if (askSurfaceActive && askDialogRef?.toggleQuestionExpansion()) return { consume: true };
    if (modalOwnsKeys()) return undefined;
    const expanded = deps.onToggleToolsExpand();
    // 鸭子类型遍历（跨边界禁 instanceof，双世界见 AGENTS.md）：ToolExecution /
    // UserMessage / AssistantMessage 等有 setExpanded 的组件统一翻转
    const affected = duckCallBool(transcript.children, 'setExpanded', expanded);
    // thinking 同向跟随（传反值：组件方法名是 setHideThinkingBlock）；新块的初始
    // 显隐也读同一全局位（bridge 的 getThinkingVisible），故「开一次就一直开」
    deps.onSetThinkingVisible(expanded);
    const thinkAffected = duckCallBool(transcript.children, 'setHideThinkingBlock', !expanded);
    foldDebug(`FOLD expanded=${expanded} affected=${affected}`);
    foldDebug(`THINK visible=${expanded} affected=${thinkAffected}`);
    // requestRender(true) 强制视口全量重绘：展开态批量变化超 diff 优化范围（omp :2467 同款）
    tui.requestRender(true);
    bridge.addInfoLines([
      theme.fg(
        'dim',
        `[tools] 已全局${expanded ? '展开' : '折叠'}（工具卡 + thinking；Ctrl+O 切换）· 读历史全文 F2 / /detail`,
      ),
    ]);
    return { consume: true };
  });

  // detail-view P1.3：F2 打开会话详情全屏视图（含 thinking 全文 + 工具输出；同 `/detail`）。
  // 为什么用 F 键：终端会把 F 键**原样投递**（pi-tui 给 app.retry 选 f5 的同款理由），
  // 不会像 alt 组合那样被 macOS Option 吞掉（真机实测 alt+t 在两台终端都出 `†`）。
  // 两种上报形态都认（实测 `matchesKey(data,'f2')` 只认 legacy `\x1bOQ` 与 `\x1b[12~`，
  // **不认** Kitty 协议 disambiguate 下的 `CSI 1;1Q` —— 而 omc 正开着该协议，故补一条显式字节匹配）
  // `modalOwnsKeys()` 护栏：已有浮层/内联审批时让位，避免层叠浮层的焦点锁死
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'f2') && data !== '\x1b[1;1Q') return undefined;
    if (modalOwnsKeys()) return undefined;
    deps.onOpenDetail?.();
    return { consume: true };
  });

  // ux-port P2.3：ctrl+shift+o 工具活动区整体显隐（omp toggleToolActivity 范式，
  // input-controller.ts:2440-2456）。键位可达性：pi-tui 推 Kitty 键盘 flags
  // （terminal.ts:1475 \x1b[>5u / :1480 \x1b[>7u，disambiguate 位在），Kitty/Ghostty
  // 下 ctrl+shift+o 以 CSI u（\x1b[111;6u）送达，matchesKey 可辨（tree-selector.ts:1214
  // 先例）；非 Kitty 协议终端 shift 丢失退化为 ctrl+o（matchesKey 严格匹配修饰键，
  // 不会误触本 handler）。新卡隐藏态由 TranscriptContainer.addChild 自动继承
  // （transcript-container.ts:209），无需额外接线
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'ctrl+shift+o')) return undefined;
    if (modalOwnsKeys()) return undefined;
    const hidden = deps.onToggleToolActivity();
    // omp 同款：assistant 消息内嵌的工具结果图片同步显隐（鸭子类型，禁 instanceof）
    duckCallBool(transcript.children, 'setToolResultImagesVisible', !hidden);
    transcript.setToolActivityVisible(!hidden);
    foldDebug(`ACT hidden=${hidden}`);
    // 隐藏时清掉已发放的内联图片额度（omp :2452 clearInlineImages 同款）
    if (hidden) (tui as unknown as { clearInlineImages(): void }).clearInlineImages();
    tui.requestRender(true);
    bridge.addInfoLines([theme.fg('dim', `[tools] 工具活动区已${hidden ? '隐藏' : '显示'}（Ctrl+Shift+O 切换）`)]);
    return { consume: true };
  });

  // todo-hud P1：ctrl+t 展开/折叠**待办行**（对齐 codebuddy CLI `ctrl+t: app:toggleTodos`）。
  // 空列表（无待办 / 全部完成）**不消费**——放行给编辑器/其它监听，避免静默吞键；
  // overlay / 内联审批 / ask 表面激活时让位（同 ctrl+o 护栏）。
  // 注意：本组件**不实现 `setExpanded`**（E12）——否则会被 ctrl+o 的 `duckCallBool` 当工具卡折掉。
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'ctrl+t')) return undefined;
    if (modalOwnsKeys()) return undefined;
    if (!hasActiveTodos(todoItems)) return undefined;
    todosExpanded = !todosExpanded;
    renderWorkingRow();
    // requestRender(true) 强制视口全量重绘（展开态行数变化超出 diff 优化范围，同 ctrl+o 口径）
    tui.requestRender(true);
    return { consume: true };
  });

  // ux-port P3.2：ctrl+r 历史搜索 overlay（omp selector-controller.ts:496-509 范式：
  // onSelect → done + editor.setText + requestRender）。hasOverlay 守卫防与权限弹窗
  // 抢键（omp input-controller.ts:331 同款）；matchesKey 双形态（Kitty CSI u）同 ctrl+c
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'ctrl+r')) return undefined;
    if (modalOwnsKeys()) return undefined;
    // 强转：overlays/* 子路径 types 落 dist d.ts 世界，showOverlay 参数是 src 世界
    // Component（私有字段不兼容，双世界见 AGENTS.md）——运行时同一套 src 类
    type SrcComponent = Parameters<typeof tui.showOverlay>[0];
    let handle: { hide(): void };
    const component = new HistorySearchComponent(
      historyStorage,
      (prompt) => {
        handle.hide();
        editor.setText(prompt);
        tui.requestRender();
      },
      () => {
        handle.hide();
        tui.requestRender();
      },
    );
    handle = tui.showOverlay(component as unknown as SrcComponent);
    return { consume: true };
  });

  // input-interactions P3：Ctrl+G 打开外部编辑器编辑当前草稿（照搬 omp
  // input-controller.ts:2811 `openExternalEditor` 范式：`ui.stop()` → `openInEditor()`
  // → `ui.start()`；退出后把结果写回编辑器）。全局 listener 先于焦点组件，故此处抢先消费；
  // overlay / 内联审批激活时让位（同 ctrl+r/ctrl+o 护栏）。keybindings 未装 app 表，
  // 编辑器自身也不消费 ctrl+g → 无冲突。
  const openExternalEditor = async (): Promise<void> => {
    // 先做降级判定（**必须在 tui.stop() 之前**，否则提前 return 会留下未恢复的终端）
    const cmd = getEditorCommand();
    if (!cmd) {
      bridge.addInfoLines([theme.fg('warning', '[editor] 未配置外部编辑器：请设置 $VISUAL 或 $EDITOR')]);
      tui.requestRender();
      return;
    }
    if (!process.stdin.isTTY) {
      bridge.addInfoLines([theme.fg('warning', '[editor] 外部编辑器需要交互式终端（当前非 TTY）')]);
      tui.requestRender();
      return;
    }
    const draft = editor.getText();
    editorDebug(`OPEN cmd=${cmd} draftLen=${draft.length}`);
    // try/finally 保证无论 spawn 抛错都恢复终端（stop 交出终端 → 编辑器渲染到可见窗格）
    let outcome: OpenInEditorOutcome;
    try {
      tui.stop();
      outcome = await openInEditor(cmd, draft);
    } catch (err) {
      outcome = { text: null, exitCode: null, tmpFile: '', error: err instanceof Error ? err.message : String(err) };
    } finally {
      tui.start();
    }
    if (outcome.text !== null) {
      editor.setText(outcome.text);
      lastDraft = editor.getText();
      editorDebug(`RESULT exit=${outcome.exitCode} textLen=${outcome.text.length} applied=1`);
      tui.requestRender(true);
      return;
    }
    // 非 0 退出 / spawn 失败：**保留原草稿不动**，只提示
    editorDebug(
      `RESULT exit=${outcome.exitCode ?? 'null'} applied=0${outcome.error ? ` err=${outcome.error}` : ''}`,
    );
    bridge.addInfoLines([
      theme.fg(
        'warning',
        outcome.error
          ? `[editor] 打开失败：${outcome.error}`
          : `[editor] 编辑器以非 0 退出（${outcome.exitCode}），草稿未改`,
      ),
    ]);
    tui.requestRender(true);
  };
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'ctrl+g')) return undefined;
    if (modalOwnsKeys()) return undefined;
    // 交异步 fire-and-forget（停/启终端在 openExternalEditor 内 try/finally 完成）
    void openExternalEditor();
    return { consume: true };
  });

  // input-interactions P4：Ctrl+Y 复制最近一条 AI 回复（对齐 codebuddy）。
  // **有意覆盖 pi-tui 默认 Emacs yank**（`tui.editor.yank` 默认 ctrl+y，keybindings.ts:119）：
  // 全局监听先于焦点组件并 consume → 编辑器收不到 → Emacs yank 在 omc 失效（取舍，已在
  // /keybindings 注明）。无输入框语义依赖，故首版**不设浮层护栏**（浮层内也可复制）。
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'ctrl+y')) return undefined;
    deps.onCopyLastReply();
    return { consume: true };
  });

  // Shift+Tab 循环权限模式（照抄 codebuddy chat:cycleMode）。全局 listener 先于焦点
  // 组件（tui.ts:2559），故会覆盖 pi-tui 编辑器内建的 shift+tab=thinking cycle 绑定
  // （custom-editor.ts:109）——本项目取 codebuddy 语义。旧终端 shift+tab 为 CSI Z
  // (\x1b[Z)，Kitty 协议下为 CSI u，matchesKey 覆盖前者不足故显式并判（plan-review-overlay.ts:578 先例）
  tui.addInputListener((data) => {
    if (!matchesKey(data, 'shift+tab') && data !== '\x1b[Z') return undefined;
    if (modalOwnsKeys()) return undefined;
    // input-interactions P1.6：**shell 模式下 Shift+Tab 切 bash ↔ local**，不循环权限模式
    // （照抄 codebuddy `chat:cycleMode` 的前两分支：BASH→BASH_LOCAL、BASH_LOCAL→BASH）
    // P2：`#` 记忆模式无子模式 → Shift+Tab 不动作（consume 掉，也不循环权限模式）
    if (shellMode === 'memory') return { consume: true };
    if (shellMode !== 'none') {
      toggleShellMode();
      return { consume: true };
    }
    setPermissionMode(deps.onCyclePermissionMode());
    tui.requestRender();
    return { consume: true };
  });

  // input-interactions P1.6：**空草稿里退格 → 退出 shell 模式**（codebuddy 文档同款：
  // 「在空输入下按退格键可直接退出 Bash / 本地 shell 模式」）。有内容时不抢键（正常删字符）。
  tui.addInputListener((data) => {
    if (shellMode === 'none') return undefined;
    if (data !== '\x7f' && data !== '\b') return undefined;
    if (modalOwnsKeys()) return undefined;
    if (editor.getText().length > 0) return undefined;
    applyShellMode('none', 'backspace');
    return { consume: true };
  });

  // M3.1 权限弹窗：pending 出现 → 装机，消失 → 拆机。
  // plan-approval P2.2：计划审批走**内联三选项**（addChild + setFocus；无 transcript 回落浮层）。
  // ask-dialog-surface P1.3 / permission-surface P1.2：ask 与 permission 都走**单文件对话表面**
  // （换掉 editorContainer 里的 editor；无容器时各自回落浮层）。
  const detachPermission = attachPermissionOverlay(tui, deps.permBridge, {
    transcript,
    restoreFocus: () => tui.setFocus(editor),
    onInlineActiveChange: (active) => {
      planInlineActive = active;
    },
    editorContainer,
    editor,
    onAskSurfaceActiveChange: (active) => {
      askSurfaceActive = active;
      // P2.2 埋点：与 bridge 的 OPEN/DECIDE 同文件，冒烟据此断言换表面时序（on/off 成对）
      deps.permBridge.debug(`ASK-SURFACE ${active ? 'on' : 'off'}`);
      // 顶 chrome 行随 editor 一起被换掉 → 重新按表面口径算状态栏（见 refreshStatusline）
      refreshStatusline();
      tui.requestRender();
    },
    onAskDialogChange: (dialog) => {
      askDialogRef = dialog;
    },
    // permission-surface P1.3：权限审批表面（换掉 editorContainer 里的 editor）激活位变化
    onPermSurfaceActiveChange: (active) => {
      permSurfaceActive = active;
      // 与 ASK-SURFACE 同款埋点：冒烟据此断言换表面时序（on/off 成对）
      deps.permBridge.debug(`PERM-SURFACE ${active ? 'on' : 'off'}`);
      // 顶 chrome 行随 editor 一起被换掉 → 重新按表面口径算状态栏
      refreshStatusline();
      tui.requestRender();
    },
    // plan-mode P1.2：plan 审批表面（ExitPlanMode 三选项换掉输入框）激活位变化
    onPlanSurfaceActiveChange: (active) => {
      planSurfaceActive = active;
      // 与 PERM/ASK-SURFACE 同款埋点：冒烟据此断言换表面时序（on/off 成对）
      deps.permBridge.debug(`PLAN-SURFACE ${active ? 'on' : 'off'}`);
      // 顶 chrome 行随 editor 一起被换掉 → 重新按表面口径算状态栏
      refreshStatusline();
      tui.requestRender();
    },
  });

  setComposerShape(activeShape); // 首帧接线：设顶 chrome provider + 下方块
  refreshModeLine(); // 首帧权限模式提示行
  deps.statusline.start(refreshStatusline);

  return {
    tui,
    bridge,
    editor,
    paste,
    transcript,
    refreshStatusline,
    setPermissionMode,
    setComposerShape,
    setSuggestion,
    setVimMode,
    setWorking,
    setTaskPanel,
    setTodoPanel,
    switchView,
    setSkillSlashCommands: (cmds, before) => {
      if (before) autocomplete.setRefreshHook(before);
      autocomplete.setCommands(cmds);
    },
    updateQueueBand,
    start: () => {
      composer.start(); // 内含 ui.start()；构造时已 setFocus(editor)
      tui.requestRender();
    },
    stop: () => {
      deps.statusline.stop();
      detachPermission();
      loader?.dispose();
      if (taskTicker) {
        clearInterval(taskTicker);
        taskTicker = null;
      }
      if (todoSpinnerTimer) {
        clearInterval(todoSpinnerTimer);
        todoSpinnerTimer = null;
      }
      composer.stop(); // 内含 ui.stop() → beginHistoryFlush 退休全部历史进 scrollback
    },
  };
}
