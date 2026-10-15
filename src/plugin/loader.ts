/**
 * loader.ts — 插件加载/卸载（plugin 阶段 P2.3）。
 *
 * 加载流程：
 *   1. 建唯一槽位 `~/.omc/.slots/<name>-<ts>-<rand>/`
 *   2. 把插件目录**复制**进槽位（排除 node_modules / .git）
 *   3. 若插件有 node_modules → 在槽位内 symlink 指向它（依赖共享，宿主不代管）
 *   4. `import(fileURL(slot/entry))` → `apply(ctx)` → 收集 disposer
 *
 * ⚠️ 为什么是「复制」而不是「symlink 插件目录」：Bun 按模块 **realpath** 缓存，
 * 目录/文件 symlink 与 `?v=` query 都不能可靠重置插件自身模块图（2026-10-05 实证：
 * symlink 两次 import 共享同一实例；`?v=` 只重置入口、相对依赖状态仍串）。
 * 唯一可靠的重载法 = 每次新路径 + 独立副本（槽位）。
 *
 * `import.meta.dir` 禁用（编译二进制不可靠）；槽位路径从 `pluginSlotsDir()`（os.homedir）出发。
 */
import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginSlotsDir } from '../config/paths';
import type { PluginCapabilities } from './capabilities';
import type { PluginManifest } from './types';
import type { Disposer, PluginContext, PluginModule } from './types';

/** 加载成功后的插件句柄 */
export interface LoadedPlugin {
  name: string;
  /** 源目录（插件安装处） */
  dir: string;
  /** 本次加载的槽位（独立副本） */
  slot: string;
  /** 槽位内入口文件绝对路径 */
  entry: string;
  /** 逆序调用所有 disposer；单个失败仅告警，不影响其余 */
  dispose: () => Promise<void>;
}

export interface LoadPluginOptions {
  /** 权威插件名（manifest.name） */
  name: string;
  /** 插件源目录（绝对路径） */
  pluginDir: string;
  manifest: PluginManifest;
  capabilities: PluginCapabilities;
  /** disposer 失败时的告警出口（缺省 stderr） */
  warn?: (message: string) => void;
}

/** 复制时排除的目录名（依赖共享、版本控制元数据不搬） */
const COPY_EXCLUDE = new Set(['node_modules', '.git']);

/** 建槽位 + 复制插件 + symlink 依赖，返回槽位路径 */
export function createSlot(name: string, pluginDir: string): string {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const slot = join(pluginSlotsDir(), `${name}-${unique}`);
  mkdirSync(slot, { recursive: true });
  cpSync(pluginDir, slot, {
    recursive: true,
    dereference: false,
    filter: (src) => !COPY_EXCLUDE.has(basename(src)),
  });
  const srcModules = join(pluginDir, 'node_modules');
  if (existsSync(srcModules)) {
    try {
      symlinkSync(srcModules, join(slot, 'node_modules'), 'dir');
    } catch {
      // symlink 失败（极少见）→ 依赖走 run 时从原目录解析，不阻塞加载
    }
  }
  return slot;
}

/** 把 apply 返回值归一成 disposer 数组 */
function normalizeReturn(ret: void | Disposer | Disposer[]): Disposer[] {
  if (typeof ret === 'function') return [ret];
  if (Array.isArray(ret)) return ret.filter((f): f is Disposer => typeof f === 'function');
  return [];
}

/** 逆序 + 逐个 catch 的 disposer 执行器 */
function makeDisposer(list: Disposer[], warn: (m: string) => void, name: string): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return; // 幂等：reload = unload + load，防重复释放
    done = true;
    for (const dispose of [...list].reverse()) {
      try {
        await dispose();
      } catch (e) {
        warn(`[plugin] ${name} 卸载回调失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
}

/**
 * 加载单个插件：槽位复制 → 动态 import → apply(ctx)。
 * 任一环节抛错即向上抛（host 层 catch 成一行 warning，不阻塞启动）。
 */
export async function loadPlugin(opts: LoadPluginOptions): Promise<LoadedPlugin> {
  const { name, pluginDir, manifest, capabilities } = opts;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  const slot = createSlot(name, pluginDir);
  const entry = join(slot, manifest.entry);

  const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  if (typeof mod.apply !== 'function') {
    throw new Error(`入口未导出 apply(ctx) 函数（${manifest.entry}）`);
  }

  const ctx: PluginContext = capabilities.forPlugin(name, manifest.version);
  const ret = await (mod.apply as PluginModule['apply'])(ctx);

  // disposer 顺序：ctx 内部登记序（register/onDispose）在前，apply 返回值在后；
  // 卸载时整体逆序（后注册的先释放）。
  const impl = ctx as unknown as { disposers: Disposer[] };
  const disposers = [...(impl.disposers ?? []), ...normalizeReturn(ret)];

  return {
    name,
    dir: pluginDir,
    slot,
    entry,
    dispose: makeDisposer(disposers, warn, name),
  };
}
