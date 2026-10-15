/**
 * cli.ts — `omc plugin <子命令>` 命令面（plugin 阶段 P5.2/P5.3）。
 *
 * 分发层与渲染分两层：本模块只做「参数解析 + 动作编排」，返回文本行数组；
 * 真正的 stdout 输出在 main.ts 的内置子命令注册里（走 P4 的 `SubcommandRegistry`）。
 * 由此可脱离 TTY/进程做单测（P5.5）。
 *
 * 子命令：
 *   list                            列状态表（读注册表 + 宿主加载状态）
 *   add <path|github:owner/repo>    安装（github 源需 --yes：插件 = 进程内全权限代码）
 *   remove <name>                   卸载（github 删托管目录 / 本地只解链）
 *   enable <name>                   置启用 + 立即加载
 *   disable <name>                  置停用 + 立即卸载
 *   reload [name]                   重载（缺省全部已启用）
 *
 * install 动作复用 P3 `installer.ts`；生命周期动作复用 P2 `PluginHost`（经 `host` 注入）。
 * 失败一律抛 `PluginCliError`（人话 message），由 main.ts 分发 catch 成 `[plugin] <msg>` + exit 1。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { addGithub, addLocal, disable, enable, remove } from './installer';
import { formatPluginTable, pluginStatuses } from './manage';
import { readRegistry } from './registry';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** 命令面可预期失败（调用方给 `[plugin] <msg>` + exit 1，而非崩栈） */
export class PluginCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCliError';
  }
}

/** `omc plugin` 详细帮助正文（不含首行用法）；供宿主 `omc plugin help` 与 run 回退共用 */
export const PLUGIN_HELP = `子命令：
  list                                列出已安装插件（名称/版本/状态/来源）
  add <path|github:owner/repo[#ref]>  安装插件（github 源需 --yes 确认）
  remove <name>                       卸载插件
  enable <name>                       启用（写入注册表并立即加载）
  disable <name>                      停用（卸载并从注册表标记停用）
  reload [name]                       重载（缺省重载全部已启用插件）

选项：
  -y, --yes       github 源安装确认（插件 = 进程内全权限代码）
      --ref <ref> github 源分支/标签/commit（等价于 #<ref>）`;

export const PLUGIN_USAGE = `用法：omc plugin <子命令>\n\n${PLUGIN_HELP}`;

/** 宿主生命周期注入面（由 main.ts 的 PluginHost 适配；便于单测用假 host） */
export interface PluginControlHost {
  /** 当前已加载插件名（列表加载状态列） */
  loadedNames(): string[];
  /** 卸载（disable/remove 后） */
  unload(name: string): Promise<void>;
  /** 重载：卸载后按注册表重新加载（enable 后 / 显式 reload）；返回是否成功 */
  reload(name: string): Promise<boolean>;
}

export interface PluginCliDeps {
  host: PluginControlHost;
  /** 注册表文件覆盖（测试） */
  registryFile?: string;
  /** github 安装 env 注入（测试缺工具场景） */
  env?: NodeJS.ProcessEnv;
}

/** 命令面入口：解析并执行，返回待打印的文本行 */
export async function runPluginCli(args: string[], deps: PluginCliDeps): Promise<string[]> {
  const [action, ...rest] = args;
  switch (action) {
    case 'list':
      return listCmd(deps);
    case 'add':
      return addCmd(rest, deps);
    case 'remove':
      return removeCmd(rest, deps);
    case 'enable':
      return enableCmd(rest, deps);
    case 'disable':
      return disableCmd(rest, deps);
    case 'reload':
      return reloadCmd(rest, deps);
    case 'help':
    case '--help':
    case '-h':
      return [PLUGIN_USAGE];
    case undefined:
      throw new PluginCliError(PLUGIN_USAGE);
    default:
      throw new PluginCliError(`未知子命令：plugin ${action}\n\n${PLUGIN_USAGE}`);
  }
}

function listCmd(deps: PluginCliDeps): string[] {
  const data = readRegistry(deps.registryFile);
  return formatPluginTable(pluginStatuses(data, deps.host.loadedNames()));
}

interface AddArgs {
  source: string;
  ref?: string;
  yes: boolean;
}

/** 解析 add 的位置参数 + `--yes/-y` + `--ref <ref>`/`--ref=<ref>` */
function parseAdd(rest: string[]): AddArgs {
  let source = '';
  let ref: string | undefined;
  let yes = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === '-y' || a === '--yes') {
      yes = true;
    } else if (a === '--ref') {
      const v = rest[++i];
      if (v === undefined || !v.trim()) throw new PluginCliError('--ref 缺参数');
      ref = v.trim();
    } else if (a.startsWith('--ref=')) {
      const v = a.slice('--ref='.length).trim();
      if (!v) throw new PluginCliError('--ref 缺参数');
      ref = v;
    } else if (a.startsWith('-')) {
      throw new PluginCliError(`未知选项：${a}`);
    } else if (!source) {
      source = a;
    } else {
      throw new PluginCliError(`多余参数：${a}`);
    }
  }
  if (!source) {
    throw new PluginCliError(`缺少安装来源（本地路径或 github:owner/repo）\n\n${PLUGIN_USAGE}`);
  }
  return { source, ref, yes };
}

/** 来源分类：`github:` / 既非现存路径又非相对·绝对 → github（对齐 installer.resolveUrl 判定） */
function isLocalSource(source: string): boolean {
  if (source.startsWith('github:')) return false;
  return isAbsolute(source) || source.startsWith('.') || existsSync(resolve(source));
}

async function addCmd(rest: string[], deps: PluginCliDeps): Promise<string[]> {
  const parsed = parseAdd(rest);
  let result;
  if (isLocalSource(parsed.source)) {
    result = addLocal(parsed.source);
  } else {
    if (!parsed.yes) {
      const spec = `${parsed.source}${parsed.ref ? `#${parsed.ref}` : ''}`;
      const flag = parsed.ref ? ` --ref ${parsed.ref} --yes` : ' --yes';
      throw new PluginCliError(
        `github 源安装需显式确认（插件为进程内全权限代码）：\n  来源：${spec}\n  确认后重跑：omc plugin add ${parsed.source}${flag}`,
      );
    }
    result = await addGithub(parsed.source, parsed.ref, { env: deps.env });
  }
  const lines = [
    `已安装插件 ${result.name}`,
    `  目录 ${result.dir}`,
    `  来源 ${result.source}${result.commit ? ` @ ${result.commit.slice(0, 7)}` : ''}`,
  ];
  const loaded = await deps.host.reload(result.name);
  lines.push(loaded ? '  已加载（本次会话生效）' : '  未加载（详见上方警告）');
  return lines;
}

/** 取单个必填 name 参数（多参/缺参 → 用法错误） */
function requireName(rest: string[], action: string): string {
  const name = rest[0];
  if (!name || name.startsWith('-')) throw new PluginCliError(`用法：omc plugin ${action} <name>`);
  if (rest.length > 1) throw new PluginCliError(`多余参数：${rest.slice(1).join(' ')}`);
  return name;
}

async function removeCmd(rest: string[], deps: PluginCliDeps): Promise<string[]> {
  const name = requireName(rest, 'remove');
  const res = remove(name);
  await deps.host.unload(name);
  return [
    `已卸载插件 ${res.name}${res.removedDir ? `（删除托管目录 ${res.removedDir}）` : '（源目录保留，仅解链）'}`,
  ];
}

async function enableCmd(rest: string[], deps: PluginCliDeps): Promise<string[]> {
  const name = requireName(rest, 'enable');
  enable(name);
  const loaded = await deps.host.reload(name);
  return [`已启用插件 ${name}${loaded ? '（已加载）' : '（加载失败，详见上方警告）'}`];
}

async function disableCmd(rest: string[], deps: PluginCliDeps): Promise<string[]> {
  const name = requireName(rest, 'disable');
  disable(name);
  await deps.host.unload(name);
  return [`已停用插件 ${name}`];
}

async function reloadCmd(rest: string[], deps: PluginCliDeps): Promise<string[]> {
  if (rest[0] !== undefined && !rest[0].startsWith('-')) {
    const name = requireName(rest, 'reload');
    const ok = await deps.host.reload(name);
    return [`已重载插件 ${name}${ok ? '' : '（加载失败，详见上方警告）'}`];
  }
  const data = readRegistry(deps.registryFile);
  const names = Object.entries(data.plugins)
    .filter(([, e]) => e.enabled !== false)
    .map(([n]) => n);
  if (names.length === 0) return [`${DIM}（无已启用插件）${RESET}`];
  const lines = [`已重载 ${names.length} 个插件：`];
  for (const n of names) {
    const ok = await deps.host.reload(n);
    lines.push(`  ${ok ? '✓' : '✗'} ${n}`);
  }
  return lines;
}
