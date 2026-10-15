/**
 * types.ts — 插件系统对外契约（plugin 阶段 P2）。
 *
 * 插件 = 一个目录 + `package.json#omc`（复用 npm 生态，少一个文件）：
 *   { "name": "omc-xxx", "type": "module",
 *     "omc": { "api": 1, "entry": "index.ts", "engines": { "omc": ">=0.2.0" } } }
 * 入口契约：`export const name` + `export const inject?` + `export function apply(ctx)`
 * （可返回 disposer 或 disposer 数组）。
 *
 * 本文件只放跨模块共享的类型；能力对象的实现在 capabilities.ts。
 */
import type { SlashCommand } from '../commands/types';
import type { AccountTarget } from '../agent/account';
import type { AppConfig } from '../config';

/** 宿主支持的插件 API 版本；manifest.api 不等即拒载。破坏性变更时 +1。 */
export const HOST_API = 1;

/** 解析后的插件 manifest（来自 `package.json#omc`，见 manifest.ts） */
export interface PluginManifest {
  /** 权威插件名（omc.name → package.json#name → 目录名） */
  name: string;
  /** 已校验 === HOST_API */
  api: number;
  /** 相对插件目录的入口文件 */
  entry: string;
  version?: string;
  engines?: { omc?: string };
}

/** 清理回调（同步或异步）；插件卸载时逆序调用。 */
export type Disposer = () => void | Promise<void>;

/** `/` 命令能力（P2）；注册可逆 */
export interface PluginCommandsCapability {
  /** 注册一个斜杠命令，返回移除它的 disposer（可逆注册） */
  register(cmd: SlashCommand): Disposer;
}

/** 子命令执行上下文（`omc <name> ...` 的非 TUI 环境；P4.3） */
export interface PluginSubcommandContext {
  cwd: string;
  /** 朴素 stdout 输出（子命令在 TUI 装配前执行，定稿一行一个元素） */
  print(lines: string[]): void;
}

/** CLI 子命令定义（`ctx.subcommands.register`） */
export interface PluginSubcommand {
  name: string;
  description: string;
  usage?: string;
  /** 多行详细帮助（`omc <name> help` / `omc <name> --help` 显示）；缺省仅 description+usage */
  help?: string;
  run(ctx: PluginSubcommandContext, args: string[]): void | Promise<void>;
}

/** CLI 子命令能力（宿主内置子命令优先） */
export interface PluginSubcommandsCapability {
  /** 注册子命令，返回移除它的 disposer（可逆；与内置重名抛错） */
  register(sub: PluginSubcommand): Disposer;
}

/** 浮层选择项 */
export interface PluginSelectItem {
  value: string;
  label: string;
  description?: string;
  /**
   * 结构化字段列（与 `PluginSelectOptions.columns` 配对）：
   * `columns[0]` 是 label（名称）列的列头，`columns[1..]` 依次对应 `fields[0..]`。
   * 长度不齐宿主容忍：少了补空、多了截断。
   * 仅在 `opts.columns` 存在时参与渲染（渲染时 `description` 不显示）；
   * **`description` 建议照填**——旧宿主与窄终端退回时仍走双列路径显示它。
   */
  fields?: string[];
}

/** 浮层选择请求 */
export interface PluginSelectOptions {
  title: string;
  items: PluginSelectItem[];
  /** 预选项 value（当前值高亮 + ✓） */
  current?: string;
  /** 底部提示行；缺省「Enter 选择 · Esc 取消」 */
  hint?: string;
  /**
   * 列头（如 `['名称', '手机号', '积分']`）。存在 → 结构化列模式：
   * 表头行（title 与列表之间，不滚动）+ 各行 `fields` 按宽对齐，`description` 不渲染。
   * 缺省 → 现有 label+description 双列路径，行为不变。
   */
  columns?: string[];
}

/** UI 能力（浮层 + 输出；非 TTY / 未装配 → select 恒 null、print 落 stdout） */
export interface PluginUiCapability {
  /** 浮层单选：返回选中 value；取消或无 TUI → null */
  select(opts: PluginSelectOptions): Promise<string | null>;
  /** 输出信息行（有 TUI → transcript；否则 stdout） */
  print(lines: string[]): void;
}

/** 配置能力：宿主合并配置 + 插件自有配置区（用户级 config.json `plugins.<name>`） */
export interface PluginConfigCapability {
  /** 合并后的宿主配置（用户 ← 项目 ← env） */
  read(): AppConfig;
  /** 读插件自有配置区某键 */
  get<T = unknown>(key: string): T | undefined;
  /** 写插件自有配置区某键（保留其他键） */
  set(key: string, value: unknown): void;
}

/** 会话能力（P4.5）：切账户 = 注入 KEY 后 resume 重建（CLI 重启一次） */
export interface PluginSessionsCapability {
  /** 切账户；生成中 / 空 key → 抛错（人话） */
  switchAccount(target: AccountTarget): Promise<void>;
  /**
   * 当前生效模型 id（通用查询；会话极早期待 system_init 到达前可能为空串）。
   * 旧宿主无此能力（可选链调用即得 undefined）→ 插件应按「未知」降级，勿用空模型去查业务表。
   */
  currentModel(): string;
}

/**
 * 路径能力（P6 追加）：宿主为插件提供的落点。
 * 惯例对齐 VS Code `globalStorageUri`——宿主给**目录**，插件自管其内文件。
 */
export interface PluginPathsCapability {
  /** omc 用户根目录（`~/.omc` 或 `OMC_CONFIG_DIR` 结果） */
  configDir(): string;
  /** 插件专属数据目录（`~/.omc/plugin-data/<name>`）；调用即确保目录存在 */
  dataDir(): string;
}

/**
 * statusline 段（P6 追加）：插件向状态栏贡献字段。
 * 宿主统一补 `plugin:` 前缀 —— 配置里写 `plugin:<id>`（如 `plugin:codebuddy:account`）。
 */
export interface PluginStatuslineSegment {
  /** 段 id（**不含** `plugin:` 前缀）；建议 `<插件短名>:<字段>`，如 `codebuddy:account` */
  id: string;
  /** 说明（供帮助/补全提示） */
  description?: string;
  /**
   * 渲染：**同步且廉价**（状态栏每帧调用，禁 IO）；返回纯文本，`null` = 当前隐藏。
   * 抛错 → 当帧隐藏（宿主隔离，不影响其它段）。
   */
  render(): string | null;
}

/** statusline 段能力：可逆注册（返回的 disposer 并入插件卸载链）+ 主动刷新 */
export interface PluginStatuslineCapability {
  /** 注册段；id 非法 / 与已注册段冲突 → 抛错（宿主兜成一行 warning） */
  register(seg: PluginStatuslineSegment): Disposer;
  /**
   * 主动请求重绘状态栏。插件改了段 `render()` 读取的状态后调用它即可实时刷新。
   * 命令路径已有宿主兜底（`/xxx` 返回后宿主刷一次）；**非命令路径**（事件回调 / 浮层
   * 回调 / 异步完成后）需插件自行调用，否则要等下一轮对话才刷。空实现兜底（非 TTY / 旧宿主）。
   */
  refresh(): void;
}

/** 权限/问答/计划挂起类型（herdr P1：`permission/pending` 载荷 kind；plan = plan-approval P1.3） */
export type HostPendingKind = 'permission' | 'ask' | 'plan';

/** 宿主事件 → 载荷映射（P4.6；typed events，随宿主能力扩展） */
export interface HostEvents {
  /** 新建 SDK 会话前（含初始会话与 resume 重建） */
  'session/before-create': { model: string; resume: string | null };
  /** UIEvent error 到达（kind 见 agent/types.ts）；model = 错误发生时的当前模型（通用上下文） */
  'session/error': { message: string; kind: string; model: string };
  /** 一轮对话开始（herdr P1：→ working） */
  'turn/start': {};
  /** 一轮对话结束（herdr P1：→ idle）；interrupted = 被用户中断 */
  'turn/end': { interrupted?: boolean };
  /** 权限弹窗 / 问答挂起（herdr P1：→ blocked）；label 取 prompt.summary / 首个 question */
  'permission/pending': { kind: HostPendingKind; label: string };
  /** 挂起解除（herdr P1：→ 解除 blocked） */
  'permission/resolved': { kind: HostPendingKind };
  /** 会话身份落位（herdr P1：→ agent-session-id + resume argv）；仅 id 变化时派发，新会话可能要等 system_init */
  'session/identity': { sessionId: string; resumed: string | null };
  /** 宿主退出（herdr P1：→ 释放口；best-effort，退出不等待） */
  'host/shutdown': {};
}

/** 事件能力：可逆订阅（返回的 disposer 并入插件卸载链） */
export interface PluginEventsCapability {
  on<K extends keyof HostEvents>(type: K, handler: (payload: HostEvents[K]) => void): Disposer;
}

/** `session/before-create` 钩子入参（只读） */
export interface SessionBeforeCreateInfo {
  model: string;
  resume: string | null;
}

/** `session/before-create` 钩子可返回的 patch（缺省 = 不改动） */
export interface SessionBeforeCreatePatch {
  /**
   * 叠加到 CLI 子进程 env（在 `sanitizeHostEnv` 之后生效）。
   * 优先级：**调用方显式 env > 钩子 patch**（切账户显式注入的 key 不会被钩子盖掉）。
   */
  env?: Record<string, string | undefined>;
}

/** `session/after-create` 钩子载荷（通知，无返回值） */
export interface SessionAfterCreateInfo {
  /** 新会话 id（新会话可能要等 system_init 才有 → undefined） */
  sessionId: string | undefined;
  /** 本次恢复的会话 id（新会话为 null） */
  resumed: string | null;
}

/** 宿主钩子 → {入参, 返回值} 映射（P6 追加） */
export interface HostHooks {
  /** 会话创建前；返回 patch 可改 env（同步） */
  'session/before-create': { info: SessionBeforeCreateInfo; result: SessionBeforeCreatePatch | void };
  /** 会话创建后（通知） */
  'session/after-create': { info: SessionAfterCreateInfo; result: void };
}

/**
 * 钩子能力（P6 追加）：**可介入**宿主生命周期 —— 与 `events`（纯通知、无返回值）区分。
 *
 * 规则：同步（`newSession` 保持同步）；按注册（插件加载）序执行；
 * `session/before-create` 的 patch **后者覆盖前者**；单个钩子抛错 → 跳过（不阻塞创建）。
 */
export interface PluginHooksCapability {
  on<K extends keyof HostHooks>(
    type: K,
    handler: (info: HostHooks[K]['info']) => HostHooks[K]['result'],
  ): Disposer;
}

/**
 * `apply(ctx)` 拿到的能力上下文，按插件实例化（`caps.forPlugin(name)`）。
 */
export interface PluginContext {
  readonly name: string;
  readonly version?: string;
  /** `/` 命令注册（可逆） */
  readonly commands: PluginCommandsCapability;
  /** CLI 子命令注册（可逆；`omc <name> ...`） */
  readonly subcommands: PluginSubcommandsCapability;
  /** 浮层选择器 + 输出 */
  readonly ui: PluginUiCapability;
  /** 宿主配置 + 插件自有配置区 */
  readonly config: PluginConfigCapability;
  /** 会话能力（switchAccount） */
  readonly sessions: PluginSessionsCapability;
  /** 宿主事件订阅 */
  readonly events: PluginEventsCapability;
  /** 宿主生命周期钩子（可介入；如创建会话前注入 env） */
  readonly hooks: PluginHooksCapability;
  /** 状态栏段注册（`plugin:<id>`；可逆） */
  readonly statusline: PluginStatuslineCapability;
  /** 路径能力（configDir / dataDir；插件私有数据的落点） */
  readonly paths: PluginPathsCapability;
  /** 输出一行信息到宿主（激活期走 stderr；不阻塞启动） */
  log(message: string): void;
  /** 手动登记一个清理回调（与 register 的 disposer 一起在卸载时逆序调用） */
  onDispose(fn: Disposer): void;
}

/** 插件模块导出契约（动态 import 后按此校验） */
export interface PluginModule {
  /** 插件自报名（可选；权威名取 manifest） */
  name?: string;
  /** 依赖的服务名（cordis 风格；P2 不解析，仅保留字段） */
  inject?: string[];
  apply: (ctx: PluginContext) => void | Disposer | Disposer[];
}
