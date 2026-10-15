/**
 * capabilities.ts — 插件能力上下文（plugin 阶段 P2 最小版 → P4 完整面）。
 *
 * 每个插件拿到一份独立的 `PluginContext`（`caps.forPlugin(name)`），
 * 内部维护自己的 disposer 列表；卸载时由 loader 逆序调用（对齐 Cordis `ctx.effect`）。
 *
 * 能力面（P4）：`commands` / `subcommands` / `ui` / `config` / `sessions` / `events`。
 * 宿主侧可注入对应 host（未注入时给安全缺省：注册类仍可用，UI/会话退化为 no-op/抛错），
 * 便于单测与一次性（非 TTY）场景。
 */
import type { CommandRegistry } from '../commands/registry';
import type { SlashCommand } from '../commands/types';
import type { AppConfig } from '../config';
import { pluginDataDir, userRoot } from '../config/paths';
import type { AccountTarget } from '../agent/account';
import { mkdirSync } from 'node:fs';
import { PluginEventBus } from './events';
import { PluginHooks } from './hooks';
import { SubcommandRegistry } from './subcommands';
import type {
  Disposer,
  HostEvents,
  HostHooks,
  PluginCommandsCapability,
  PluginConfigCapability,
  PluginContext,
  PluginEventsCapability,
  PluginHooksCapability,
  PluginPathsCapability,
  PluginSelectOptions,
  PluginSessionsCapability,
  PluginStatuslineCapability,
  PluginStatuslineSegment,
  PluginSubcommandsCapability,
  PluginSubcommand,
  PluginUiCapability,
} from './types';

/** 宿主侧配置实现（读合并配置 + 插件自有配置区读写） */
export interface PluginConfigHost {
  read(): AppConfig;
  get(pluginName: string, key: string): unknown;
  set(pluginName: string, key: string, value: unknown): void;
}

/** 宿主侧 UI 实现（浮层 select + 信息输出） */
export interface PluginUiHost {
  select(opts: PluginSelectOptions): Promise<string | null>;
  print(lines: string[]): void;
}

/** 宿主侧会话实现（switchAccount 原语接线 + 当前模型查询） */
export interface PluginSessionHost {
  switchAccount(target: AccountTarget): Promise<void>;
  /** 当前生效模型 id（可选：旧宿主 / 测试宿主可不提供 → 缺省空串） */
  currentModel?(): string;
}

/** 宿主侧路径实现（插件私有数据落点） */
export interface PluginPathsHost {
  /** omc 用户根（`~/.omc`） */
  configDir(): string;
  /** 某插件的专属数据目录（实现负责创建） */
  dataDir(pluginName: string): string;
}

/** 宿主侧 statusline 段实现（注册返回注销 disposer；由 main.ts 接线到段注册表） */
export interface PluginStatuslineHost {
  register(pluginName: string, seg: PluginStatuslineSegment): Disposer;
  /** 主动重绘状态栏（缺省 no-op：非 TTY / 单测 / 旧宿主） */
  refresh?(): void;
}

export interface PluginCapabilitiesOptions {
  /** 宿主命令注册表（插件命令并入 `/` 补全与派发） */
  registry: CommandRegistry;
  /** CLI 子命令注册表（缺省新建一份；宿主应共享同一实例以便分发） */
  subcommands?: SubcommandRegistry;
  /** 宿主配置读写（缺省：read→{}，get/set→无操作） */
  config?: PluginConfigHost;
  /** 宿主 UI（缺省：select→null，print→stderr） */
  ui?: PluginUiHost;
  /** 宿主会话（缺省：switchAccount 抛「未装配」） */
  sessions?: PluginSessionHost;
  /** 宿主路径（缺省：真实 omc 路径 `~/.omc` / `~/.omc/plugin-data/<name>`；测试可注入 tmp） */
  paths?: PluginPathsHost;
  /** 宿主事件总线（缺省新建一份；宿主应共享以派发） */
  events?: PluginEventBus;
  /** 宿主生命周期钩子总线（缺省新建一份；宿主应共享以派发） */
  hooks?: PluginHooks;
  /** 宿主 statusline 段实现（缺省：丢弃注册——非 TTY / 测试环境） */
  statusline?: PluginStatuslineHost;
  /** 日志出口（缺省 stderr；宿主可换成 UI 提示） */
  log?: (pluginName: string, message: string) => void;
}

const NOOP_CONFIG: PluginConfigHost = {
  read: () => ({}),
  get: () => undefined,
  set: () => {},
};

const NOOP_UI: PluginUiHost = {
  select: async () => null,
  print: (lines) => {
    for (const l of lines) process.stderr.write(`${l}\n`);
  },
};

const NOOP_SESSIONS: PluginSessionHost = {
  switchAccount: async () => {
    throw new Error('宿主未装配会话能力（sessions）');
  },
  // 未装配 → 模型未知（空串）；插件据此降级，勿用空模型查业务表
  currentModel: () => '',
};

/** 缺省路径宿主：真实 omc 路径（`~/.omc` + `plugin-data/<name>`） */
const DEFAULT_PATHS: PluginPathsHost = {
  configDir: () => userRoot(),
  dataDir: (pluginName) => pluginDataDir(pluginName),
};

/** 缺省 statusline 宿主：丢弃注册（非 TTY / 测试环境无状态栏） */
const NOOP_STATUSLINE: PluginStatuslineHost = {
  register: () => () => {},
  refresh: () => {},
};

/** 单个插件的能力上下文实现（disposers 收集给 loader 逆序卸载） */
export class PluginContextImpl implements PluginContext {
  readonly name: string;
  readonly version?: string;
  readonly commands: PluginCommandsCapability;
  readonly subcommands: PluginSubcommandsCapability;
  readonly ui: PluginUiCapability;
  readonly config: PluginConfigCapability;
  readonly sessions: PluginSessionsCapability;
  readonly events: PluginEventsCapability;
  readonly hooks: PluginHooksCapability;
  readonly statusline: PluginStatuslineCapability;
  readonly paths: PluginPathsCapability;
  readonly log: (message: string) => void;
  /** 卸载时逆序调用的清理回调（登记序） */
  readonly disposers: Disposer[] = [];

  constructor(name: string, version: string | undefined, opts: PluginCapabilitiesOptions) {
    this.name = name;
    this.version = version;
    const log = opts.log ?? ((n: string, m: string) => process.stderr.write(`[plugin:${n}] ${m}\n`));
    const subcommands = opts.subcommands ?? new SubcommandRegistry();
    const configHost = opts.config ?? NOOP_CONFIG;
    const uiHost = opts.ui ?? NOOP_UI;
    const sessionHost = opts.sessions ?? NOOP_SESSIONS;
    const pathsHost = opts.paths ?? DEFAULT_PATHS;
    const bus = opts.events ?? new PluginEventBus();
    const hooksBus = opts.hooks ?? new PluginHooks();
    const statuslineHost = opts.statusline ?? NOOP_STATUSLINE;

    /** 统一收口：登记 disposer + 返回它（loader 逆序释放） */
    const track = (dispose: Disposer): Disposer => {
      this.disposers.push(dispose);
      return dispose;
    };

    this.commands = {
      register: (cmd: SlashCommand): Disposer => {
        opts.registry.register(cmd);
        return track(() => {
          opts.registry.unregister(cmd.name);
        });
      },
    };
    this.subcommands = {
      register: (sub: PluginSubcommand): Disposer => {
        subcommands.register(sub);
        return track(() => {
          subcommands.unregister(sub.name);
        });
      },
    };
    this.ui = {
      select: (o) => uiHost.select(o),
      print: (lines) => uiHost.print(lines),
    };
    this.config = {
      read: () => configHost.read(),
      get: <T = unknown>(key: string): T | undefined => configHost.get(name, key) as T | undefined,
      set: (key: string, value: unknown) => configHost.set(name, key, value),
    };
    this.sessions = {
      switchAccount: (target) => sessionHost.switchAccount(target),
      currentModel: () => sessionHost.currentModel?.() ?? '',
    };
    this.paths = {
      configDir: () => pathsHost.configDir(),
      dataDir: () => {
        const dir = pathsHost.dataDir(name);
        mkdirSync(dir, { recursive: true }); // 调用即确保存在
        return dir;
      },
    };
    this.events = {
      on: <K extends keyof HostEvents>(type: K, handler: (payload: HostEvents[K]) => void): Disposer => {
        const off = bus.on(type, handler);
        return track(() => off());
      },
    };
    this.hooks = {
      on: <K extends keyof HostHooks>(
        type: K,
        handler: (info: HostHooks[K]['info']) => HostHooks[K]['result'],
      ): Disposer => {
        const off = hooksBus.on(type, handler);
        return track(() => off());
      },
    };
    this.statusline = {
      register: (seg: PluginStatuslineSegment): Disposer => track(statuslineHost.register(name, seg)),
      refresh: () => statuslineHost.refresh?.(),
    };
    this.log = (message: string) => log(name, message);
  }

  onDispose(fn: Disposer): void {
    this.disposers.push(fn);
  }
}

/** 能力工厂：宿主创建一次，按插件实例化上下文 */
export class PluginCapabilities {
  constructor(private readonly opts: PluginCapabilitiesOptions) {}

  forPlugin(name: string, version?: string): PluginContextImpl {
    return new PluginContextImpl(name, version, this.opts);
  }
}
