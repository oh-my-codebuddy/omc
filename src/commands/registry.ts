/**
 * registry.ts — 斜杠命令注册表 + 解析（P5.4 / custom-commands P2）。
 *
 * parseSlash：仅当输入以 `/` 开头且命令名非空时命中；
 * `/` 单独或 `//` 不算命令。命令名小写归一。
 *
 * custom-commands P2：命令名放宽为 `:` 分段（`a:b:name`），对齐 CLI 子目录命令
 * （`parseCommandFile` 把相对目录段 `join(":")`）。**但 `skill:` 前缀是 omc 保留
 * 命名空间**——由 `parseSkillInvocation` 专管（`/skill:foo`），此处主动排除，
 * 以免未知 skill 从「保持字面发给模型」变成「未知命令」提示（omp 语义）。
 */
import type { SlashCommand } from './types';

/** 命令名：`:` 分段，每段 `[a-z0-9_-]+`（小写归一后校验） */
const COMMAND_NAME_RE = /^[a-z0-9_-]+(?::[a-z0-9_-]+)*$/;

/** omc 保留命名空间前缀（交 `parseSkillInvocation`；parseSlash 不认） */
const RESERVED_NAMESPACE_PREFIX = 'skill:';

/** slash 命令路由来源（custom-commands P4：覆盖语义固化；P2 追加 workflow） */
export type SlashCommandSource = 'builtin' | 'custom' | 'workflow';

/**
 * custom-commands P4：slash 命令路由优先级 —— **内置优先于自定义**。
 *
 * 对齐 CLI 执行层实证：`executeSlashCommand` 先 `await tryExecuteBuiltinCommand(...)`，
 * **命中即 return**，未命中才查 custom command 渲染（bundle `codebuddy.js`；见
 * `docs/plan/custom-commands/p4-coverage-permission.md` E1）。CLI 的 `isOverriddenByCustom`
 * 只是列表判定 API（bundle 内无调用者），**不代表执行覆盖**。
 *
 * model-variants-and-workflows P2 T3：追加第三来源 **saved workflow**，排在 custom 之后
 * → 优先级 **内置 > custom > workflow**。理由：custom 是用户显式维护的 `.md`（可读可改），
 * saved workflow 是 CLI 保存的 `.js`（用户改 md 更直接）；CLI 自身 `injectSavedWorkflowCommands`
 * 也是 `if (eA.has(name)) continue`（已存在命令不被 workflow 覆盖，bundle ~5.395M）。
 *
 * 入参为三处的查找结果（未命中传 `undefined`）：同名时按上述优先级返回。
 * 返回 `null` = 皆未命中（调用方报「未知命令」）。
 */
export function routeSlashCommand(
  builtin: unknown,
  custom: unknown,
  workflow?: unknown,
): SlashCommandSource | null {
  if (builtin !== undefined) return 'builtin';
  if (custom !== undefined) return 'custom';
  if (workflow !== undefined) return 'workflow';
  return null;
}

export interface ParsedSlash {
  name: string;
  args: string;
}

export function parseSlash(input: string): ParsedSlash | null {
  const t = input.trim();
  if (!t.startsWith('/') || t.length < 2 || t[1] === '/') return null;
  const sp = t.indexOf(' ');
  const name = (sp === -1 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
  if (!COMMAND_NAME_RE.test(name)) return null;
  if (name.startsWith(RESERVED_NAMESPACE_PREFIX)) return null;
  return { name, args: sp === -1 ? '' : t.slice(sp + 1).trim() };
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  /** 移除命令（插件可逆注册用，P2）；返回是否确实存在 */
  unregister(name: string): boolean {
    return this.commands.delete(name.toLowerCase());
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name.toLowerCase());
  }

  /** 注册序 */
  list(): SlashCommand[] {
    return [...this.commands.values()];
  }

  /** 前缀匹配（命令补全用），按注册序 */
  matchPrefix(prefix: string): SlashCommand[] {
    const p = prefix.toLowerCase();
    return this.list().filter((c) => c.name.startsWith(p));
  }
}
