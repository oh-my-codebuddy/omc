/**
 * types.ts — 斜杠命令契约（P5.4）。
 *
 * ctx 由 app 层组装，暴露命令需要的最小面：session 控制、输出、权限白名单、
 * 清屏、退出。命令不 import tui 组件，输出统一走 ctx.print（定稿入 history）。
 */
import type { AgentSession } from '../agent/session';
import type { RawLanguageModel } from '@tencent-ai/agent-sdk';
import type { TaskItem } from '../app/task-list';
import type { TaskEntry } from '../app/task-registry';
import type { WorkflowEntry } from '../app/workflow-data';
import type { VariantId, VariantState, WriteVariantResult } from '../app/model-variants';
import type { McpConfigResult } from '../app/mcp-config';
import type { PromptCommandDef } from './prompt-templates';
import type { CommandRegistry } from './registry';

export interface CommandContext {
  session: AgentSession;
  registry: CommandRegistry;
  /** 定稿行写入 scrollback */
  print(lines: string[]): void;
  /** 清屏 + 重置显示（不动 SDK 会话） */
  clearScreen(): void;
  /**
   * 开始新对话（clear 阶段）：关旧会话 → 新会话（清空模型上下文）+ 清转录；
   * 旧对话仍可通过 `/resume` 找回；继承当前模型 / 权限模式。运行中拒绝。
   */
  clearConversation(): void;
  /** 清空 always 白名单（/mode 切换用） */
  clearAlways(): void;
  /** 打开 /resume 会话选择浮层（P6.3） */
  openResume(): void;
  /** 打开 /rewind 检查点回退浮层（rewind P1.3；无可回退检查点时打印提示） */
  openRewind(): void;
  /** /rewind 候选文本列表（rewind P1.3，`/rewind list`） */
  rewindList(): string[];
  /**
   * /rewind 直接执行（rewind P1.3，`/rewind <编号> [scope]`）：
   * 编号为 1-based 候选序号；不存在的编号 / 生成中 / 失败都返回可打印的说明行。
   */
  rewindTo(n: number, scope?: string): Promise<string[]>;
  /** 打开 /model 交互式模型选择浮层（无参 /model；非 TTY 回退文本列表） */
  openModel(): void;
  /**
   * 打开**场景变体**交互选择浮层（无参 `/model:lite` / `/model:reasoning`，P1）。
   * 变体模式：无 Global/Session 页签（固定写用户级 settings），首行多一条「继承主模型」
   * 条目（`INHERIT_SENTINEL`）。非 TTY 时回退为文本列表（同 `list` 分支输出）。
   */
  openVariant(variantId: VariantId): void;
  /** 打开 /mode 权限模式选择浮层（无参 /mode；非 TTY 回退文本列表） */
  openMode(): void;
  /** 打开 /usage 用量 dashboard（ux-port P4.4） */
  openUsage(): void;
  /** 打开最近一次压缩摘要全文浮层（ux-port-v2 P3；无摘要时提示） */
  openSummary(): void;
  /**
   * 打开**会话详情全屏视图**（detail-view P1.3）：可滚动只读的会话全文，
   * 含 thinking 全文 + 工具 input/output（数据源 = 已落盘记录，同 `/export`）。
   * 非 TTY 打印提示（改走 `/export`）；无落盘记录时提示先对话。
   */
  openDetail(): void;
  /** 打开 /plugin 插件管理浮层（列表 + 启停/重载；非 TTY 回退文本列表，plugin P5.4） */
  openPlugins(): void;
  /** 经正常 turn 管线发一条文本给 agent（/compact 用，P6.6） */
  sendToAgent(text: string): void;
  /** 会话统计（/cost 用，P6.6） */
  stats(): { turns: number; inputTokens: number; outputTokens: number; costUsd: number };
  /** 切换工具详情全显，返回新状态（/verbose 用，P6.6） */
  toggleVerbose(): boolean;
  /** 切换 vim 编辑模式 + 写用户配置，返回新状态（/vim 用，ux-port P3.4） */
  toggleVim(): boolean;
  /** 输入框浅色「提问建议」开关当前值（/suggest / /status 用，prompt-suggestion 阶段） */
  suggestEnabled(): boolean;
  /** 设置建议开关 + 写用户配置（/suggest on|off 用，prompt-suggestion 阶段） */
  setSuggestEnabled(enabled: boolean): void;
  /** 打开 /shape 输入区形状选择浮层（无参 /shape；非 TTY 回退文本列表，composer-shape 阶段） */
  openShape(): void;
  /** 切换输入区形状 + 写用户配置（/shape <id>；composer-shape 阶段） */
  setComposerShape(shape: string): void;
  /** /context 上下文构成报告（ux-port-v2 P1.3）；expand = /context all 展开 memory 明细 */
  contextReport(expand: boolean): string[];
  /** 打开 /skills 只读 skill 列表浮层（按来源分组，含隐藏项；非 TTY 回退文本列表） */
  openSkills(): void;
  /** statusline session_name 段重解析 + 重绘（/rename 写 sidecar 后调用，statusline 阶段） */
  refreshSessionName(): void;
  /** 当前模型（system_init 或 /model 切换后更新） */
  currentModel(): string;
  /**
   * 原始模型列表（model-variants P1 的 `/model:lite` 等用；`/model` 浮层同源）。
   * 需 CLI 已连接，故是异步。
   */
  availableModelsRaw(): Promise<RawLanguageModel[]>;
  /**
   * 模型场景变体当前解析态（`/status` 用；settings → 主模型 relatedModels → 继承）。
   * `relatedModels` 取 main 侧缓存的模型表（`refreshContextWindow` 顺带刷新，首轮后即热）。
   */
  variantStates(): VariantState[];
  /**
   * 保守写变体（`/model:lite <id>` 用）：写 `~/.codebuddy/settings.json#variantModels`，
   * `value === INHERIT_SENTINEL` → 删键；失败不破坏原文件并返回原因。
   */
  writeVariantModel(variantId: VariantId, value: string): WriteVariantResult;
  /** 当前会话加载的工具名列表（system_init 口径；未初始化 → []，ux-port-v2 P5.3） */
  currentTools(): string[];
  /** 待办列表快照（Task* 工具状态机；/todos，custom-commands P5 T4） */
  taskSnapshot(): TaskItem[];
  /** 子代理 / 后台任务列表（task_* 状态机；/tasks，custom-commands P5 T4） */
  tasks(): TaskEntry[];
  /**
   * 动态工作流可用清单（三源合并：project > user > builtin；/workflows，
   * model-variants-and-workflows P2）。数据源 = 自读磁盘（commands 频道不含 workflow 命令）。
   * 编译态内置目录不可得 → 内置段降级为常量（详见 workflow-data.ts）。
   */
  workflows(): WorkflowEntry[];
  /** MCP server 名单（system_init 口径；/mcp，custom-commands P5 T5） */
  mcpServers(): Array<{ name: string; status: string }>;
  /**
   * 本会话构造时读定的 MCP 配置（user + project 合并 + 来源；/mcp，mcp-console P1）。
   * 会话重建会重算 → 改 `.mcp.json` 需重启会话生效（与 `mcpServers()` 的运行时状态互补）。
   */
  mcpConfig(): McpConfigResult | null;
  /**
   * omc 自管 MCP 禁用集（实时读 `~/.omc/config.json#mcp.disabled`；/mcp 展示标 `⊘`，
   * mcp-console P3）。与 `mcpConfig().disabled`（会话构造时快照）不同：此处反映最新写入。
   */
  mcpDisabled(): string[];
  /** 写 omc 自管 MCP 禁用集（保留其他配置键；/mcp enable|disable 用，mcp-console P3） */
  setMcpDisabled(names: string[]): void;
  /** 最近一条 assistant 定稿文本（/copy 数据源；无 → ''，custom-commands P5 T5） */
  lastAssistantText(): string;
  /** 写系统剪贴板，返回是否成功（/copy，custom-commands P5 T5） */
  copyToClipboard(text: string): boolean;
  /**
   * 执行 prompt 型内置命令（custom-commands P5 T6）：把模板渲染成用户消息投递，
   * 走与自定义命令同一条路径（命令卡回显 + 排队 / 落盘 / 中断语义全白拿）。
   * `args` = `/name` 之后的参数文本（喂 `$ARGUMENTS` 管道）。
   */
  runPromptCommand(def: PromptCommandDef, args: string): void;
  /**
   * 转发执行一个 workflow（model-variants-and-workflows P2 T3/T4）：生成「调用 Workflow
   * 工具」指令消息并投递（同 `submitWorkflowCommand`，走 QueuedInput/命令卡）。
   * `name` 查 saved workflow 表，未命中回退内置常量（如 `deep-research`）。
   * `/deep-research` 用；未知 name 打印提示不投递。
   */
  runWorkflow(name: string, args: string): void;
  setCurrentModel(id: string): void;
  /** 当前权限模式 */
  currentMode(): string;
  setCurrentMode(mode: string): void;
  exit(): void;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  run(ctx: CommandContext, args: string): void | Promise<void>;
}
