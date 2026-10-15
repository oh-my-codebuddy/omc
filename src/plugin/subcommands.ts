/**
 * subcommands.ts — CLI 子命令注册表（plugin 阶段 P4.3）。
 *
 * 两种来源：
 *   - **内置**：宿主注册（`models` 等，从 main.ts 硬编码归位），优先级最高；
 *   - **插件**：`ctx.subcommands.register()`，与内置/已注册重名 → 抛错（host 失败隔离成一行 warning）。
 *
 * 分发在 main.ts：argv 首个位置参数命中 `get(name)` → 执行并退出（在 prompt 处理之前）。
 */
import type { PluginSubcommand } from './types';

/** `omc <子命令> help` / `--help` / `-h` 视为「详细帮助」请求（宿主统一拦截，不下发插件 run） */
export function isHelpArg(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h';
}

/**
 * 归一化 usage 为「参数部分」——容忍两种写法：
 *   usage = '<子命令>'                （推荐，仅参数）
 *   usage = 'omc codebuddy <子命令>'  （历史写法，含前缀）
 * 去掉可能的 `omc ` 前缀与重复的子命令名前缀。
 */
export function subcommandUsageArgs(sub: { name: string; usage?: string }): string {
  let u = (sub.usage ?? '').trim();
  if (!u) return '';
  u = u.replace(/^omc\s+/i, '');
  u = u.replace(new RegExp(`^${sub.name}\\s+`, 'i'), '');
  return u.trim();
}

/** 子命令用法行：`omc <name> [args]`（单行，`omc --help` 列表用） */
export function subcommandUsageLine(sub: { name: string; usage?: string }): string {
  const args = subcommandUsageArgs(sub);
  return `omc ${sub.name}${args ? ` ${args}` : ''}`;
}

/**
 * 子命令详细帮助文本行（宿主统一生成，`omc <name> help` / `--help` 用）：
 *   <description>
 *   用法：omc <name> [args]
 *   （空行 + 自定义 help 多行，若声明）
 */
export function subcommandHelpLines(sub: PluginSubcommand): string[] {
  const lines = [sub.description, `用法：${subcommandUsageLine(sub)}`];
  if (sub.help) lines.push('', ...sub.help.replace(/\s+$/, '').split('\n'));
  return lines;
}

export class SubcommandRegistry {
  readonly #builtins = new Map<string, PluginSubcommand>();
  readonly #plugins = new Map<string, PluginSubcommand>();

  /** 注册内置子命令（宿主调用；同名覆盖内置旧值，不改插件表） */
  registerBuiltin(sub: PluginSubcommand): void {
    this.#builtins.set(sub.name.toLowerCase(), { ...sub, name: sub.name.toLowerCase() });
  }

  /**
   * 插件注册；与内置或已注册插件重名 → 抛错（调用方据「内置优先」不变则报冲突）。
   */
  register(sub: PluginSubcommand): void {
    const name = sub.name.toLowerCase();
    if (this.#builtins.has(name)) throw new Error(`子命令名与内置冲突：${name}`);
    if (this.#plugins.has(name)) throw new Error(`子命令名已被占用：${name}`);
    this.#plugins.set(name, { ...sub, name });
  }

  /** 移除插件子命令（内置不可移除）；返回是否确实存在 */
  unregister(name: string): boolean {
    return this.#plugins.delete(name.toLowerCase());
  }

  /** 查命令：内置优先，其次插件 */
  get(name: string): PluginSubcommand | undefined {
    const n = name.toLowerCase();
    return this.#builtins.get(n) ?? this.#plugins.get(n);
  }

  /** 内置序 + 插件注册序 */
  list(): PluginSubcommand[] {
    return [...this.#builtins.values(), ...this.#plugins.values()];
  }

  /** 仅内置子命令（注册序；供帮助文档「子命令」节用） */
  builtinSubcommands(): PluginSubcommand[] {
    return [...this.#builtins.values()];
  }

  /** 仅插件注册的子命令（注册序；供帮助文档「插件子命令」节用） */
  pluginSubcommands(): PluginSubcommand[] {
    return [...this.#plugins.values()];
  }
}
